import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import * as yauzl from 'yauzl';
import {
  AGENT_OS_LIMITS,
  type SkillInstallPreview,
  type SkillInstallRecord,
} from '@shared/agent-os';
import { getInstalledSkillsDir } from '@/utils/paths';
import type { AgentOsStateStore } from './state-store';
import type { DebugInspectorService } from './debug-inspector';

const SUPPORTED_EXTENSIONS = new Set(['.skill', '.clodex-skill', '.md']);
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type PreparedPackage = {
  packageRoot: string;
  cleanup: () => Promise<void>;
};

type InspectedPackage = {
  preview: SkillInstallPreview;
  skillRoot: string;
};

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

function sanitizeSkillId(name: string): string {
  const id = name
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!SAFE_SKILL_ID_PATTERN.test(id)) {
    throw new Error('Skill name cannot be converted to a safe install ID');
  }
  return id;
}

function validateArchiveEntryName(fileName: string): string {
  if (
    fileName.includes('\\') ||
    fileName.includes('\0') ||
    path.posix.isAbsolute(fileName)
  ) {
    throw new Error(`Invalid archive path: ${fileName}`);
  }
  const normalized = path.posix.normalize(fileName);
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(`Archive traversal is not allowed: ${fileName}`);
  }
  return normalized;
}

function isZipBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(buffer[2] ?? -1)
  );
}

async function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return await new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error('Unable to open skill archive'));
        return;
      }
      resolve(zipFile);
    });
  });
}

async function openEntryStream(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<NodeJS.ReadableStream> {
  return await new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`Unable to read ${entry.fileName}`));
        return;
      }
      resolve(stream);
    });
  });
}

async function extractArchive(
  sourcePath: string,
  destination: string,
): Promise<void> {
  const zipFile = await openZip(sourcePath);
  let entryCount = 0;
  let totalBytes = 0;
  let extractedBytes = 0;

  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => {
      zipFile.close();
      reject(error);
    };

    zipFile.on('error', fail);
    zipFile.on('end', resolve);
    zipFile.on('entry', (entry) => {
      void (async () => {
        entryCount++;
        totalBytes += entry.uncompressedSize;
        if (entryCount > AGENT_OS_LIMITS.maxSkillPackageFiles) {
          throw new Error('Skill archive contains too many files');
        }
        if (totalBytes > AGENT_OS_LIMITS.maxSkillPackageBytes) {
          throw new Error('Skill archive is too large after extraction');
        }

        const normalized = validateArchiveEntryName(entry.fileName);
        const mode = entry.externalFileAttributes >>> 16;
        if ((mode & 0o170000) === 0o120000) {
          throw new Error('Skill archives may not contain symbolic links');
        }

        const destinationPath = path.join(destination, normalized);
        const relative = path.relative(destination, destinationPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error('Archive entry escapes the install directory');
        }

        if (normalized.endsWith('/')) {
          await fs.mkdir(destinationPath, { recursive: true });
          zipFile.readEntry();
          return;
        }

        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        const stream = await openEntryStream(zipFile, entry);
        const handle = await fs.open(destinationPath, 'wx', 0o600);
        try {
          for await (const chunk of stream) {
            const buffer = Buffer.from(chunk as Buffer);
            extractedBytes += buffer.length;
            if (extractedBytes > AGENT_OS_LIMITS.maxSkillPackageBytes) {
              throw new Error('Skill archive is too large after extraction');
            }
            await handle.write(buffer);
          }
        } finally {
          await handle.close();
        }
        zipFile.readEntry();
      })().catch(fail);
    });
    zipFile.readEntry();
  });
}

async function listPackageFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stat = await fs.lstat(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error('Skill packages may not contain symbolic links');
      }
      if (stat.isDirectory()) {
        await visit(entryPath);
      } else if (stat.isFile()) {
        files.push(entryPath);
      }
      if (files.length > AGENT_OS_LIMITS.maxSkillPackageFiles) {
        throw new Error('Skill package contains too many files');
      }
    }
  };
  await visit(root);
  return files;
}

export class SkillInstallerService {
  public constructor(
    private readonly store: AgentOsStateStore,
    private readonly debug: DebugInspectorService,
  ) {}

  public async inspect(filePath: string): Promise<SkillInstallPreview> {
    const sourcePath = path.resolve(filePath);
    const prepared = await this.prepare(sourcePath);
    try {
      return (await this.inspectPrepared(prepared.packageRoot, sourcePath))
        .preview;
    } finally {
      await prepared.cleanup();
    }
  }

  public async install(
    filePath: string,
    replaceExisting = false,
  ): Promise<SkillInstallRecord> {
    const sourcePath = path.resolve(filePath);
    const prepared = await this.prepare(sourcePath);
    try {
      const inspected = await this.inspectPrepared(
        prepared.packageRoot,
        sourcePath,
      );
      if (inspected.preview.conflict && !replaceExisting) {
        throw new Error(
          `Skill "${inspected.preview.name}" is already installed`,
        );
      }

      const installRoot = path.resolve(getInstalledSkillsDir());
      const installPath = path.resolve(installRoot, inspected.preview.id);
      if (
        installPath !== installRoot &&
        !installPath.startsWith(`${installRoot}${path.sep}`)
      ) {
        throw new Error('Resolved skill install path is unsafe');
      }

      const temporaryInstallPath = path.join(
        installRoot,
        `.${inspected.preview.id}.${randomUUID()}.tmp`,
      );
      const backupInstallPath = path.join(
        installRoot,
        `.${inspected.preview.id}.${randomUUID()}.backup`,
      );
      await fs.mkdir(installRoot, { recursive: true });
      await fs.rm(temporaryInstallPath, { recursive: true, force: true });
      let movedExistingInstall = false;
      try {
        await fs.cp(inspected.skillRoot, temporaryInstallPath, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        const installExists = await pathExists(installPath);
        if (installExists && !replaceExisting) {
          throw new Error(
            `Skill "${inspected.preview.name}" is already installed`,
          );
        }
        if (installExists) {
          await fs.rename(installPath, backupInstallPath);
          movedExistingInstall = true;
        }
        await fs.rename(temporaryInstallPath, installPath);
        if (movedExistingInstall) {
          await fs.rm(backupInstallPath, { recursive: true, force: true });
        }
      } catch (error) {
        await fs.rm(temporaryInstallPath, {
          recursive: true,
          force: true,
        });
        if (movedExistingInstall) {
          await fs.rm(installPath, { recursive: true, force: true });
          await fs.rename(backupInstallPath, installPath);
        }
        throw error;
      }

      const record: SkillInstallRecord = {
        id: inspected.preview.id,
        name: inspected.preview.name,
        description: inspected.preview.description,
        version: inspected.preview.version,
        sourcePath,
        installPath,
        installedAt: Date.now(),
        status: 'installed',
      };
      await this.store.update((draft) => {
        draft.installedSkills = draft.installedSkills.filter(
          (skill) => skill.id !== record.id,
        );
        draft.installedSkills.push(record);
      });
      this.debug.record({
        channel: 'agent',
        level: 'info',
        message: `Installed skill: ${record.name}`,
        payload: { skillId: record.id, version: record.version },
      });
      return record;
    } finally {
      await prepared.cleanup();
    }
  }

  public async uninstall(skillId: string): Promise<void> {
    if (!SAFE_SKILL_ID_PATTERN.test(skillId)) {
      throw new Error('Invalid skill ID');
    }
    const installRoot = path.resolve(getInstalledSkillsDir());
    const installPath = path.resolve(installRoot, skillId);
    if (!installPath.startsWith(`${installRoot}${path.sep}`)) {
      throw new Error('Resolved skill uninstall path is unsafe');
    }
    await fs.rm(installPath, { recursive: true, force: true });
    await this.store.update((draft) => {
      draft.installedSkills = draft.installedSkills.filter(
        (skill) => skill.id !== skillId,
      );
    });
  }

  public list(): SkillInstallRecord[] {
    return this.store
      .snapshot()
      .installedSkills.sort((a, b) => b.installedAt - a.installedAt);
  }

  private async prepare(sourcePath: string): Promise<PreparedPackage> {
    const stat = await fs.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      throw new Error('Skill package path may not be a symbolic link');
    }
    if (stat.isDirectory()) {
      return { packageRoot: sourcePath, cleanup: async () => undefined };
    }
    if (!stat.isFile()) throw new Error('Skill package is not a regular file');
    if (stat.size > AGENT_OS_LIMITS.maxSkillPackageBytes) {
      throw new Error('Skill package exceeds the size limit');
    }
    if (!SUPPORTED_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
      throw new Error('Unsupported skill package extension');
    }

    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'clodex-skill-'),
    );
    try {
      const headerHandle = await fs.open(sourcePath, 'r');
      const header = Buffer.alloc(4);
      try {
        await headerHandle.read(header, 0, header.length, 0);
      } finally {
        await headerHandle.close();
      }

      if (isZipBuffer(header)) {
        await extractArchive(sourcePath, temporaryRoot);
      } else {
        await fs.copyFile(sourcePath, path.join(temporaryRoot, 'SKILL.md'));
      }
      return {
        packageRoot: temporaryRoot,
        cleanup: () => fs.rm(temporaryRoot, { recursive: true, force: true }),
      };
    } catch (error) {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
  }

  private async inspectPrepared(
    packageRoot: string,
    sourcePath: string,
  ): Promise<InspectedPackage> {
    const files = await listPackageFiles(packageRoot);
    const skillFiles = files.filter(
      (file) => path.basename(file).toLocaleLowerCase() === 'skill.md',
    );
    if (skillFiles.length !== 1) {
      throw new Error('Skill package must contain exactly one SKILL.md');
    }
    const skillFile = skillFiles[0];
    if (!skillFile) throw new Error('Skill package has no SKILL.md');
    const content = await fs.readFile(skillFile, 'utf-8');
    const parsed = matter(content);
    const name =
      typeof parsed.data.name === 'string' ? parsed.data.name.trim() : '';
    const description =
      typeof parsed.data.description === 'string'
        ? parsed.data.description.trim()
        : '';
    const version =
      typeof parsed.data.version === 'string'
        ? parsed.data.version.trim()
        : '0.0.0';
    if (!name || !description) {
      throw new Error('SKILL.md requires name and description frontmatter');
    }
    if (!SEMVER_PATTERN.test(version)) {
      throw new Error('Skill version must use semantic versioning');
    }
    const id = sanitizeSkillId(name);
    const installRoot = path.resolve(getInstalledSkillsDir());
    const installPath = path.resolve(installRoot, id);
    if (!installPath.startsWith(`${installRoot}${path.sep}`)) {
      throw new Error('Resolved skill install path is unsafe');
    }
    const packageSize = (
      await Promise.all(files.map((file) => fs.stat(file)))
    ).reduce((sum, file) => sum + file.size, 0);
    if (packageSize > AGENT_OS_LIMITS.maxSkillPackageBytes) {
      throw new Error('Skill package exceeds the extracted size limit');
    }

    return {
      skillRoot: path.dirname(skillFile),
      preview: {
        id,
        name,
        description,
        version,
        sourcePath,
        packageSize,
        fileCount: files.length,
        conflict:
          this.store
            .snapshot()
            .installedSkills.some((skill) => skill.id === id) ||
          (await pathExists(installPath)),
      },
    };
  }
}
