import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertBundledAssetsSafe,
  DEFAULT_BUNDLED_ASSETS_POLICY,
  inspectBundledAssets,
  type BundledAssetsPolicy,
} from './bundled-assets';

let root: string;

function policy(
  overrides: Partial<BundledAssetsPolicy> = {},
): BundledAssetsPolicy {
  return {
    ...DEFAULT_BUNDLED_ASSETS_POLICY,
    ...overrides,
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'clodex-bundled-assets-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('bundled asset validation', () => {
  it('accepts a small regular bundled tree', async () => {
    await fs.mkdir(path.join(root, 'plugins', 'example'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'plugins', 'example', 'SKILL.md'),
      '# Example',
    );

    expect(assertBundledAssetsSafe(root)).toMatchObject({
      fileCount: 1,
      issues: [],
    });
  });

  it.each([
    '.git',
    '.venv',
    '__pycache__',
    'node_modules',
  ])('rejects forbidden runtime directory %s', async (directoryName) => {
    const forbiddenPath = path.join(root, 'plugins', 'runtime', directoryName);
    await fs.mkdir(forbiddenPath, { recursive: true });
    await fs.writeFile(path.join(forbiddenPath, 'artifact'), 'data');

    const report = inspectBundledAssets(root);

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: `plugins/runtime/${directoryName}`,
          message: expect.stringContaining('forbidden'),
        }),
      ]),
    );
  });

  it('enforces total size, per-file size, and file-count budgets', async () => {
    await fs.writeFile(path.join(root, 'first.bin'), '123456');
    await fs.writeFile(path.join(root, 'second.bin'), 'abcdef');

    const report = inspectBundledAssets(
      root,
      policy({
        maxFileBytes: 5,
        maxFiles: 1,
        maxTotalBytes: 10,
      }),
    );

    expect(report.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('per-file limit'),
        expect.stringContaining('File count'),
        expect.stringContaining('Total size'),
      ]),
    );
  });

  it.skipIf(process.platform === 'win32')(
    'rejects symbolic links',
    async () => {
      const target = path.join(root, 'target.txt');
      await fs.writeFile(target, 'target');
      await fs.symlink(target, path.join(root, 'linked.txt'));

      expect(() => assertBundledAssetsSafe(root)).toThrow(
        'Symbolic links are forbidden',
      );
    },
  );
});
