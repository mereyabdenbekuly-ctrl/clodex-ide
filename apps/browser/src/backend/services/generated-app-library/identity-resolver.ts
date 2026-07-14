import { createHash, type Hash } from 'node:crypto';
import {
  constants as fsConstants,
  type BigIntStats,
  type Dirent,
} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import {
  GENERATED_APP_MANIFEST_FILE,
  canonicalizeGeneratedAppManifest,
  generatedAppManifestSchema,
  type GeneratedAppIdentity,
  type GeneratedAppManifest,
} from '@shared/generated-app-manifest';
import {
  artifactBridgeContextSchema,
  type ArtifactBridgeContext,
} from '@shared/artifact-bridge';
import { getAgentsDir } from '@/utils/paths';

export const GENERATED_APP_TREE_HASH_VERSION = 1 as const;
export const GENERATED_APP_MANIFEST_HASH_VERSION = 1 as const;
export const GENERATED_APP_AUTHORITY_PROFILE = 'whole-tree-v1' as const;

export type GeneratedAppIdentityLimits = Readonly<{
  maxFiles: number;
  maxEntries: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxManifestBytes: number;
  maxDepth: number;
  maxRelativePathBytes: number;
}>;

export const DEFAULT_GENERATED_APP_IDENTITY_LIMITS: GeneratedAppIdentityLimits =
  Object.freeze({
    maxFiles: 5_000,
    maxEntries: 10_000,
    maxTotalBytes: 50 * 1024 * 1024,
    maxFileBytes: 20 * 1024 * 1024,
    maxManifestBytes: 256 * 1024,
    maxDepth: 64,
    maxRelativePathBytes: 4_096,
  });

export type AgentGeneratedAppIdentityProvenance = {
  kind: 'agent';
  agentId: string;
  appId: string;
  appRoot: string;
  manifestPath: string;
  authorityProfile: typeof GENERATED_APP_AUTHORITY_PROFILE;
  treeHashVersion: typeof GENERATED_APP_TREE_HASH_VERSION;
  manifestHashVersion: typeof GENERATED_APP_MANIFEST_HASH_VERSION;
};

export type ResolvedGeneratedAppIdentity = {
  manifest: GeneratedAppManifest;
  identity: GeneratedAppIdentity;
  provenance: AgentGeneratedAppIdentityProvenance;
};

/**
 * A file returned from the exact bounded tree snapshot that produced
 * `identity.assetHash`. Callers must serve these bytes directly rather than
 * reopening `provenance.appRoot`, otherwise an H -> M -> H filesystem race can
 * place bytes that were never hashed under H's authority.
 */
export type ResolvedGeneratedAppAsset = ResolvedGeneratedAppIdentity & {
  asset: {
    relativePath: string;
    bytes: Uint8Array;
  };
};

export type GeneratedAppIdentityResolverOptions = {
  agentsDir?: string;
  limits?: Partial<GeneratedAppIdentityLimits>;
};

type CanonicalDirectory = {
  logicalPath: string;
  realPath: string;
};

type FileSnapshot = {
  relativePath: string;
  absolutePath: string;
  content: Buffer;
  stat: BigIntStats;
};

type DirectorySnapshot = {
  absolutePath: string;
  entries: string[];
  stat: BigIntStats;
};

type AppTreeSnapshot = {
  files: FileSnapshot[];
  directories: DirectorySnapshot[];
};

type ResolvedGeneratedAppSnapshot = ResolvedGeneratedAppIdentity & {
  tree: AppTreeSnapshot;
};

const TREE_HASH_DOMAIN = 'clodex.generated-app.authority-tree';
const MANIFEST_HASH_DOMAIN = 'clodex.generated-app.manifest';

function isSafeIdentityPart(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value === value.normalize('NFC')
  );
}

function isSafeTreeEntryName(value: string): boolean {
  return isSafeIdentityPart(value);
}

function canonicalRelativeAssetPath(
  value: string,
  limits: GeneratedAppIdentityLimits,
): string | null {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value !== value.normalize('NFC') ||
    Buffer.byteLength(value, 'utf8') > limits.maxRelativePathBytes
  ) {
    return null;
  }
  const parts = value.split('/');
  if (
    parts.length > limits.maxDepth + 1 ||
    parts.some((part) => !isSafeTreeEntryName(part))
  ) {
    return null;
  }
  return parts.join('/') === value ? value : null;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalFilesystemNameKey(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

function findExactUnambiguousEntry(
  entries: readonly Dirent[],
  expectedName: string,
): Dirent | null {
  const expectedKey = canonicalFilesystemNameKey(expectedName);
  const aliases = entries.filter(
    (entry) => canonicalFilesystemNameKey(entry.name) === expectedKey,
  );
  return aliases.length === 1 && aliases[0]?.name === expectedName
    ? aliases[0]
    : null;
}

function normalizedLimits(
  overrides: Partial<GeneratedAppIdentityLimits> | undefined,
): GeneratedAppIdentityLimits {
  const limits = {
    ...DEFAULT_GENERATED_APP_IDENTITY_LIMITS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Generated app identity limit ${name} is invalid`);
    }
  }
  if (limits.maxManifestBytes > limits.maxFileBytes) {
    throw new TypeError(
      'Generated app manifest limit cannot exceed the per-file limit',
    );
  }
  return Object.freeze(limits);
}

function statRevisionMatches(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readExactDirectoryEntries(directory: string): Promise<Dirent[]> {
  return await fs.readdir(directory, { withFileTypes: true });
}

async function resolveTrustedRoot(
  configuredPath: string,
): Promise<CanonicalDirectory | null> {
  const logicalPath = path.resolve(configuredPath);
  const parent = path.dirname(logicalPath);
  const basename = path.basename(logicalPath);
  const parentEntries = await readExactDirectoryEntries(parent);
  const exactEntry = findExactUnambiguousEntry(parentEntries, basename);
  if (!exactEntry || exactEntry.isSymbolicLink() || !exactEntry.isDirectory()) {
    return null;
  }

  const stat = await fs.lstat(logicalPath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  return { logicalPath, realPath: await fs.realpath(logicalPath) };
}

async function resolveExactChildDirectory(
  parent: CanonicalDirectory,
  childName: string,
): Promise<CanonicalDirectory | null> {
  if (!isSafeIdentityPart(childName)) return null;
  const entries = await readExactDirectoryEntries(parent.logicalPath);
  const exactEntry = findExactUnambiguousEntry(entries, childName);
  if (!exactEntry || exactEntry.isSymbolicLink() || !exactEntry.isDirectory()) {
    return null;
  }

  const logicalPath = path.join(parent.logicalPath, childName);
  const stat = await fs.lstat(logicalPath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  const realPath = await fs.realpath(logicalPath);
  if (
    !isPathInside(parent.realPath, realPath) ||
    realPath === parent.realPath
  ) {
    return null;
  }
  return { logicalPath, realPath };
}

async function readStableRegularFile(
  absolutePath: string,
  expected: BigIntStats,
  maxBytes: number,
): Promise<FileSnapshot['content'] | null> {
  if (
    expected.isSymbolicLink() ||
    !expected.isFile() ||
    expected.nlink !== 1n ||
    expected.size > BigInt(maxBytes)
  ) {
    return null;
  }

  const noFollowFlag = (
    fsConstants as Readonly<Record<string, number | undefined>>
  ).O_NOFOLLOW;
  // O_NOFOLLOW is not exposed on every supported platform. The invariant does
  // not depend on it: lstat -> fstat -> lstat revision checks below reject a
  // symlink substitution even when the open flag is unavailable.
  const openFlags =
    fsConstants.O_RDONLY |
    (typeof noFollowFlag === 'number' && Number.isInteger(noFollowFlag)
      ? noFollowFlag
      : 0);

  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(absolutePath, openFlags);
    const openedBefore = await handle.stat({ bigint: true });
    if (
      !openedBefore.isFile() ||
      openedBefore.nlink !== 1n ||
      !statRevisionMatches(expected, openedBefore)
    ) {
      return null;
    }

    const content = await handle.readFile();
    if (content.byteLength !== Number(openedBefore.size)) return null;

    const openedAfter = await handle.stat({ bigint: true });
    if (!statRevisionMatches(openedBefore, openedAfter)) return null;

    const pathAfter = await fs.lstat(absolutePath, { bigint: true });
    if (!statRevisionMatches(openedAfter, pathAfter)) return null;
    return content;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function captureAppTree(
  appRoot: string,
  limits: GeneratedAppIdentityLimits,
): Promise<AppTreeSnapshot | null> {
  const files: FileSnapshot[] = [];
  const directories: DirectorySnapshot[] = [];
  const canonicalPathKeys = new Set<string>();
  let totalBytes = 0;
  let totalEntries = 0;

  const visit = async (
    directory: string,
    relativeParts: string[],
    depth: number,
  ): Promise<boolean> => {
    if (depth > limits.maxDepth) return false;
    const before = await fs.lstat(directory, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) return false;

    const entries = (await readExactDirectoryEntries(directory)).sort((a, b) =>
      compareUtf8(a.name, b.name),
    );
    const entryNames = entries.map((entry) => entry.name);
    directories.push({
      absolutePath: directory,
      entries: entryNames,
      stat: before,
    });

    for (const entry of entries) {
      totalEntries += 1;
      if (totalEntries > limits.maxEntries) return false;
      if (!isSafeTreeEntryName(entry.name)) return false;
      const nextParts = [...relativeParts, entry.name];
      const relativePath = nextParts.join('/');
      if (
        Buffer.byteLength(relativePath, 'utf8') > limits.maxRelativePathBytes
      ) {
        return false;
      }
      const canonicalKey = canonicalFilesystemNameKey(relativePath);
      if (canonicalPathKeys.has(canonicalKey)) return false;
      canonicalPathKeys.add(canonicalKey);

      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.lstat(absolutePath, { bigint: true });
      if (stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        if (!(await visit(absolutePath, nextParts, depth + 1))) return false;
        continue;
      }
      if (!stat.isFile() || files.length >= limits.maxFiles) return false;
      const content = await readStableRegularFile(
        absolutePath,
        stat,
        limits.maxFileBytes,
      );
      if (!content) return false;
      totalBytes += content.byteLength;
      if (totalBytes > limits.maxTotalBytes) return false;
      files.push({ relativePath, absolutePath, content, stat });
    }

    const after = await fs.lstat(directory, { bigint: true });
    if (!statRevisionMatches(before, after)) return false;
    const entriesAfter = (await readExactDirectoryEntries(directory))
      .map((entry) => entry.name)
      .sort(compareUtf8);
    return (
      entriesAfter.length === entryNames.length &&
      entriesAfter.every((entry, index) => entry === entryNames[index])
    );
  };

  if (!(await visit(appRoot, [], 0))) return null;
  files.sort((left, right) =>
    compareUtf8(left.relativePath, right.relativePath),
  );

  for (const file of files) {
    const current = await fs.lstat(file.absolutePath, { bigint: true });
    if (!statRevisionMatches(file.stat, current)) return null;
  }
  for (const directory of directories) {
    const current = await fs.lstat(directory.absolutePath, { bigint: true });
    if (!statRevisionMatches(directory.stat, current)) return null;
    const currentEntries = (
      await readExactDirectoryEntries(directory.absolutePath)
    )
      .map((entry) => entry.name)
      .sort(compareUtf8);
    if (
      currentEntries.length !== directory.entries.length ||
      currentEntries.some((entry, index) => entry !== directory.entries[index])
    ) {
      return null;
    }
  }

  return { files, directories };
}

function updateUint64(hash: Hash, value: number): void {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(BigInt(value));
  hash.update(encoded);
}

function updateLengthPrefixed(hash: Hash, value: Buffer): void {
  updateUint64(hash, value.byteLength);
  hash.update(value);
}

/**
 * SHA-256(
 *   lp(domain) || u64(version) || lp(purpose) || u64(fileCount) ||
 *   for each UTF-8-byte-sorted file: lp(relativePathUtf8) || lp(content)
 * )
 *
 * `lp` is an unsigned 64-bit big-endian byte length followed by the bytes.
 */
function hashAuthorityTree(
  files: readonly FileSnapshot[],
  purpose: 'executable' | 'asset',
): string {
  const hash = createHash('sha256');
  updateLengthPrefixed(hash, Buffer.from(TREE_HASH_DOMAIN, 'utf8'));
  updateUint64(hash, GENERATED_APP_TREE_HASH_VERSION);
  updateLengthPrefixed(hash, Buffer.from(purpose, 'utf8'));
  updateUint64(hash, files.length);
  for (const file of files) {
    updateLengthPrefixed(hash, Buffer.from(file.relativePath, 'utf8'));
    updateLengthPrefixed(hash, file.content);
  }
  return hash.digest('hex');
}

/** SHA-256(lp(domain) || u64(version) || lp(canonicalManifestUtf8)). */
function hashManifest(manifest: GeneratedAppManifest): string {
  const hash = createHash('sha256');
  updateLengthPrefixed(hash, Buffer.from(MANIFEST_HASH_DOMAIN, 'utf8'));
  updateUint64(hash, GENERATED_APP_MANIFEST_HASH_VERSION);
  updateLengthPrefixed(
    hash,
    Buffer.from(canonicalizeGeneratedAppManifest(manifest), 'utf8'),
  );
  return hash.digest('hex');
}

function findTreeFile(
  tree: AppTreeSnapshot,
  relativePath: string,
): FileSnapshot | null {
  return tree.files.find((file) => file.relativePath === relativePath) ?? null;
}

export class GeneratedAppIdentityResolver {
  private readonly agentsDir: string;
  private readonly limits: GeneratedAppIdentityLimits;

  public constructor(options: GeneratedAppIdentityResolverOptions = {}) {
    this.agentsDir = path.resolve(options.agentsDir ?? getAgentsDir());
    this.limits = normalizedLimits(options.limits);
  }

  /**
   * Resolve an authority-bearing identity from canonical agent-owned files.
   * Plugin and package contexts are deliberately unsupported until their
   * independent trust roots are wired and verified by the backend.
   */
  public async resolve(
    rawContext: ArtifactBridgeContext,
  ): Promise<ResolvedGeneratedAppIdentity | null> {
    const resolved = await this.resolveSnapshot(rawContext);
    if (!resolved) return null;
    return {
      manifest: resolved.manifest,
      identity: resolved.identity,
      provenance: resolved.provenance,
    };
  }

  /**
   * Resolve one file and its authority identity atomically from a single
   * in-memory tree snapshot. The returned byte array is a defensive copy of
   * the captured file and is never read again from the live filesystem.
   */
  public async resolveAsset(
    rawContext: ArtifactBridgeContext,
    rawRelativePath: string,
  ): Promise<ResolvedGeneratedAppAsset | null> {
    const relativePath = canonicalRelativeAssetPath(
      rawRelativePath,
      this.limits,
    );
    if (!relativePath) return null;

    const resolved = await this.resolveSnapshot(rawContext);
    if (!resolved) return null;
    const file = findTreeFile(resolved.tree, relativePath);
    if (!file) return null;

    return {
      manifest: resolved.manifest,
      identity: resolved.identity,
      provenance: resolved.provenance,
      asset: {
        relativePath,
        bytes: Uint8Array.from(file.content),
      },
    };
  }

  private async resolveSnapshot(
    rawContext: ArtifactBridgeContext,
  ): Promise<ResolvedGeneratedAppSnapshot | null> {
    const parsed = artifactBridgeContextSchema.safeParse(rawContext);
    if (
      !parsed.success ||
      parsed.data.kind !== 'agent' ||
      parsed.data.pluginId !== undefined ||
      !isSafeIdentityPart(parsed.data.agentId) ||
      !isSafeIdentityPart(parsed.data.appId)
    ) {
      return null;
    }

    try {
      const agentsRoot = await resolveTrustedRoot(this.agentsDir);
      if (!agentsRoot) return null;
      const agentRoot = await resolveExactChildDirectory(
        agentsRoot,
        parsed.data.agentId,
      );
      if (!agentRoot) return null;
      const appsRoot = await resolveExactChildDirectory(agentRoot, 'apps');
      if (!appsRoot) return null;
      const appRoot = await resolveExactChildDirectory(
        appsRoot,
        parsed.data.appId,
      );
      if (!appRoot) return null;

      const tree = await captureAppTree(appRoot.realPath, this.limits);
      if (!tree) return null;
      const manifestFile = findTreeFile(tree, GENERATED_APP_MANIFEST_FILE);
      const entrypointFile = findTreeFile(tree, 'index.html');
      if (
        !manifestFile ||
        !entrypointFile ||
        manifestFile.content.byteLength > this.limits.maxManifestBytes
      ) {
        return null;
      }

      let manifestJson: unknown;
      try {
        manifestJson = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            manifestFile.content,
          ),
        );
      } catch {
        return null;
      }
      const manifestResult = generatedAppManifestSchema.safeParse(manifestJson);
      if (
        !manifestResult.success ||
        manifestResult.data.id !== parsed.data.appId ||
        manifestResult.data.entrypoint !== entrypointFile.relativePath
      ) {
        return null;
      }

      const manifest = manifestResult.data;
      const identity = {
        manifestSchemaVersion: manifest.schemaVersion,
        appVersion: manifest.version,
        manifestHash: hashManifest(manifest),
        // Safe initial profile: every regular file is authority-bearing. Both
        // domain-separated digests cover the complete, identical file set.
        executableHash: hashAuthorityTree(tree.files, 'executable'),
        assetHash: hashAuthorityTree(tree.files, 'asset'),
      } satisfies GeneratedAppIdentity;

      return {
        manifest,
        identity,
        provenance: {
          kind: 'agent',
          agentId: parsed.data.agentId,
          appId: parsed.data.appId,
          appRoot: appRoot.realPath,
          manifestPath: manifestFile.absolutePath,
          authorityProfile: GENERATED_APP_AUTHORITY_PROFILE,
          treeHashVersion: GENERATED_APP_TREE_HASH_VERSION,
          manifestHashVersion: GENERATED_APP_MANIFEST_HASH_VERSION,
        },
        tree,
      };
    } catch {
      return null;
    }
  }
}
