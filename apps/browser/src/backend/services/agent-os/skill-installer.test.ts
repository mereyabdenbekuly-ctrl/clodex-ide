import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_OS_LIMITS } from '@shared/agent-os';

const pathMock = vi.hoisted(() => ({
  installRoot: '',
}));

vi.mock('@/utils/paths', () => ({
  getInstalledSkillsDir: () => pathMock.installRoot,
}));

import { AgentOsStateStore } from './state-store';
import { DebugInspectorService } from './debug-inspector';
import { SkillInstallerService } from './skill-installer';

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(
  fileName: string,
  content: string,
  externalAttributes = 0,
): Buffer {
  const name = Buffer.from(fileName);
  const data = Buffer.from(content);
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(externalAttributes, 38);

  const centralDirectory = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);

  return Buffer.concat([local, name, data, centralDirectory, end]);
}

const SKILL_MARKDOWN = `---
name: Test Skill
description: Helps test native skill installation
version: 1.2.3
---

# Test Skill
`;

describe('SkillInstallerService', () => {
  let root: string;
  let sourcePath: string;
  let store: AgentOsStateStore;
  let service: SkillInstallerService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-os-skill-'));
    pathMock.installRoot = path.join(root, 'installed-skills');
    sourcePath = path.join(root, 'test.skill');
    await fs.writeFile(sourcePath, SKILL_MARKDOWN);
    store = await AgentOsStateStore.create(path.join(root, 'state.json'));
    service = new SkillInstallerService(
      store,
      new DebugInspectorService(store),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('previews and installs a single-markdown skill package', async () => {
    const preview = await service.inspect(sourcePath);

    expect(preview).toMatchObject({
      id: 'test-skill',
      name: 'Test Skill',
      version: '1.2.3',
      conflict: false,
      fileCount: 1,
    });

    const record = await service.install(sourcePath);
    expect(record.status).toBe('installed');
    await expect(
      fs.readFile(path.join(record.installPath, 'SKILL.md'), 'utf-8'),
    ).resolves.toContain('# Test Skill');
    expect(service.list()).toEqual([record]);
  });

  it('requires explicit replacement for an installed skill conflict', async () => {
    await service.install(sourcePath);

    await expect(service.install(sourcePath)).rejects.toThrow(
      'already installed',
    );
    await expect(service.install(sourcePath, true)).resolves.toMatchObject({
      id: 'test-skill',
      status: 'installed',
    });
  });

  it('does not overwrite an unmanaged install directory without replacement', async () => {
    const unmanagedPath = path.join(pathMock.installRoot, 'test-skill');
    await fs.mkdir(unmanagedPath, { recursive: true });
    await fs.writeFile(
      path.join(unmanagedPath, 'SKILL.md'),
      'unmanaged content',
    );

    await expect(service.inspect(sourcePath)).resolves.toMatchObject({
      conflict: true,
    });
    await expect(service.install(sourcePath)).rejects.toThrow(
      'already installed',
    );
    await expect(
      fs.readFile(path.join(unmanagedPath, 'SKILL.md'), 'utf-8'),
    ).resolves.toBe('unmanaged content');
  });

  it('rejects regular packages larger than the configured limit', async () => {
    const oversizedPath = path.join(root, 'oversized.skill');
    await fs.writeFile(oversizedPath, '');
    await fs.truncate(oversizedPath, AGENT_OS_LIMITS.maxSkillPackageBytes + 1);

    await expect(service.inspect(oversizedPath)).rejects.toThrow('size limit');
  });

  it('rejects archive path traversal', async () => {
    const archivePath = path.join(root, 'traversal.skill');
    await fs.writeFile(
      archivePath,
      createStoredZip('../SKILL.md', SKILL_MARKDOWN),
    );

    await expect(service.inspect(archivePath)).rejects.toThrow();
    await expect(fs.stat(path.join(root, 'SKILL.md'))).rejects.toThrow();
  });

  it('rejects symbolic links in directory packages', async () => {
    if (process.platform === 'win32') return;
    const packageRoot = path.join(root, 'directory-skill');
    await fs.mkdir(packageRoot);
    await fs.writeFile(path.join(packageRoot, 'SKILL.md'), SKILL_MARKDOWN);
    await fs.symlink(
      path.join(root, 'outside.txt'),
      path.join(packageRoot, 'linked.txt'),
    );

    await expect(service.inspect(packageRoot)).rejects.toThrow(
      'symbolic links',
    );
  });

  it('rejects symbolic links encoded in archives', async () => {
    const archivePath = path.join(root, 'symlink.skill');
    await fs.writeFile(
      archivePath,
      createStoredZip('SKILL.md', SKILL_MARKDOWN, (0o120777 << 16) >>> 0),
    );

    await expect(service.inspect(archivePath)).rejects.toThrow(
      'symbolic links',
    );
  });
});
