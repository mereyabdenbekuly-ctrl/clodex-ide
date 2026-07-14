import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactBridgeContext } from '@shared/artifact-bridge';
import { GENERATED_APP_MANIFEST_FILE } from '@shared/generated-app-manifest';
import {
  GENERATED_APP_AUTHORITY_PROFILE,
  GENERATED_APP_MANIFEST_HASH_VERSION,
  GENERATED_APP_TREE_HASH_VERSION,
  GeneratedAppIdentityResolver,
  type GeneratedAppIdentityResolverOptions,
} from './identity-resolver';

const AGENT_ID = 'agent-a';
const APP_ID = 'dashboard';

function agentContext(
  overrides: Partial<Extract<ArtifactBridgeContext, { kind: 'agent' }>> = {},
): Extract<ArtifactBridgeContext, { kind: 'agent' }> {
  return {
    kind: 'agent',
    agentId: AGENT_ID,
    appId: APP_ID,
    ...overrides,
  };
}

function manifest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: APP_ID,
    name: 'Dashboard',
    version: '1.0.0',
    entrypoint: 'index.html',
    capabilities: [
      {
        type: 'agent:ask',
        reason: 'Summarize the current dashboard.',
      },
    ],
    ...overrides,
  };
}

describe('GeneratedAppIdentityResolver', () => {
  let root: string;
  let agentsDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'clodex-app-identity-'));
    agentsDir = path.join(root, 'agents');
    await fs.mkdir(agentsDir);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function resolver(
    options: Omit<GeneratedAppIdentityResolverOptions, 'agentsDir'> = {},
  ): GeneratedAppIdentityResolver {
    return new GeneratedAppIdentityResolver({ agentsDir, ...options });
  }

  async function writeApp(input?: {
    agentsRoot?: string;
    agentId?: string;
    appId?: string;
    manifestValue?: unknown;
    omitManifest?: boolean;
    omitEntrypoint?: boolean;
    files?: Array<[relativePath: string, content: string | Buffer]>;
  }): Promise<string> {
    const agentId = input?.agentId ?? AGENT_ID;
    const appId = input?.appId ?? APP_ID;
    const appRoot = path.join(
      input?.agentsRoot ?? agentsDir,
      agentId,
      'apps',
      appId,
    );
    await fs.mkdir(appRoot, { recursive: true });
    if (!input?.omitManifest) {
      const manifestValue =
        input && 'manifestValue' in input
          ? input.manifestValue
          : manifest({ id: appId });
      const encoded =
        typeof manifestValue === 'string'
          ? manifestValue
          : JSON.stringify(manifestValue, null, 2);
      await fs.writeFile(
        path.join(appRoot, GENERATED_APP_MANIFEST_FILE),
        encoded,
      );
    }
    if (!input?.omitEntrypoint) {
      await fs.writeFile(
        path.join(appRoot, 'index.html'),
        '<!doctype html><script src="app.js"></script>',
      );
    }
    for (const [relativePath, content] of input?.files ?? [
      ['app.js', 'globalThis.dashboard = true;'],
      ['styles.css', 'body { color: black; }'],
      ['assets/logo.bin', Buffer.from([0, 1, 2, 3])],
    ]) {
      const filePath = path.join(appRoot, ...relativePath.split('/'));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
    }
    return appRoot;
  }

  it('resolves a strict manifest and whole-tree identity from agent files', async () => {
    const appRoot = await writeApp();

    const result = await resolver().resolve(agentContext());

    expect(result).not.toBeNull();
    expect(result?.manifest).toMatchObject({
      schemaVersion: 1,
      id: APP_ID,
      version: '1.0.0',
      entrypoint: 'index.html',
    });
    expect(result?.identity).toMatchObject({
      manifestSchemaVersion: 1,
      appVersion: '1.0.0',
      manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      executableHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      assetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result?.identity.executableHash).not.toBe(
      result?.identity.assetHash,
    );
    expect(result?.provenance).toEqual({
      kind: 'agent',
      agentId: AGENT_ID,
      appId: APP_ID,
      appRoot: await fs.realpath(appRoot),
      manifestPath: path.join(
        await fs.realpath(appRoot),
        GENERATED_APP_MANIFEST_FILE,
      ),
      authorityProfile: GENERATED_APP_AUTHORITY_PROFILE,
      treeHashVersion: GENERATED_APP_TREE_HASH_VERSION,
      manifestHashVersion: GENERATED_APP_MANIFEST_HASH_VERSION,
    });
  });

  it('produces deterministic hashes independent of creation and enumeration order', async () => {
    const files: Array<[string, string | Buffer]> = [
      ['z-last.js', 'z'],
      ['nested/b.css', 'b'],
      ['nested/a.js', 'a'],
      ['assets/logo.bin', Buffer.from([9, 8, 7])],
    ];
    await writeApp({ agentId: 'agent-first', files });
    await writeApp({ agentId: 'agent-second', files: [...files].reverse() });

    const first = await resolver().resolve(
      agentContext({ agentId: 'agent-first' }),
    );
    const second = await resolver().resolve(
      agentContext({ agentId: 'agent-second' }),
    );

    expect(first?.identity).toEqual(second?.identity);
  });

  it.each([
    ['JavaScript', 'app.js', 'globalThis.dashboard = false;'],
    ['CSS', 'styles.css', 'body { color: red; }'],
    ['binary asset', 'assets/logo.bin', Buffer.from([4, 5, 6, 7])],
  ])('treats %s drift as authority-bearing', async (_label, relativePath, replacement) => {
    const appRoot = await writeApp();
    const before = await resolver().resolve(agentContext());

    await fs.writeFile(
      path.join(appRoot, ...relativePath.split('/')),
      replacement,
    );
    const after = await resolver().resolve(agentContext());

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after?.identity.manifestHash).toBe(before?.identity.manifestHash);
    expect(after?.identity.executableHash).not.toBe(
      before?.identity.executableHash,
    );
    expect(after?.identity.assetHash).not.toBe(before?.identity.assetHash);
  });

  it('returns requested bytes from the same snapshot that produced assetHash', async () => {
    const appRoot = await writeApp();
    const target = path.join(appRoot, 'app.js');
    const original = 'globalThis.dashboard = true;';
    const malicious = 'globalThis.stealAuthority = true;';
    const appResolver = resolver();

    const captured = await appResolver.resolveAsset(agentContext(), 'app.js');
    expect(captured).not.toBeNull();

    // A later live-filesystem mutation cannot alter the already-authorized
    // response body. The serving layer consumes `asset.bytes`, never `target`.
    await fs.writeFile(target, malicious);
    expect(Buffer.from(captured?.asset.bytes ?? []).toString('utf8')).toBe(
      original,
    );

    const mutated = await appResolver.resolveAsset(agentContext(), 'app.js');
    expect(mutated).not.toBeNull();
    expect(mutated?.identity.assetHash).not.toBe(captured?.identity.assetHash);
    expect(Buffer.from(mutated?.asset.bytes ?? []).toString('utf8')).toBe(
      malicious,
    );
  });

  it('rejects noncanonical, missing, and directory asset paths', async () => {
    await writeApp();
    const appResolver = resolver();

    for (const relativePath of [
      '',
      '/app.js',
      'app.js/',
      '../app.js',
      'assets/../app.js',
      'assets\\logo.bin',
      'missing.js',
      'assets',
      'cafe\u0301.txt',
    ]) {
      expect(
        await appResolver.resolveAsset(agentContext(), relativePath),
      ).toBeNull();
    }
  });

  it('fails closed when a previously read file mutates before final tree verification', async () => {
    const appRoot = await writeApp();
    const realAppRoot = await fs.realpath(appRoot);
    const target = path.join(realAppRoot, 'app.js');
    const laterFile = path.join(realAppRoot, 'styles.css');
    const originalOpen = fs.open.bind(fs);
    let mutated = false;
    const openSpy = vi
      .spyOn(fs, 'open')
      .mockImplementation(async (filePath, flags, mode) => {
        if (!mutated && filePath === laterFile) {
          mutated = true;
          await fs.writeFile(target, 'globalThis.dashboard = "mutated";');
        }
        return await originalOpen(filePath, flags, mode);
      });

    try {
      expect(await resolver().resolve(agentContext())).toBeNull();
      expect(mutated).toBe(true);
    } finally {
      openSpy.mockRestore();
    }
  });

  it('rejects missing, malformed, non-strict, and mismatched manifests', async () => {
    await writeApp({ omitManifest: true });
    expect(await resolver().resolve(agentContext())).toBeNull();

    await fs.writeFile(
      path.join(
        agentsDir,
        AGENT_ID,
        'apps',
        APP_ID,
        GENERATED_APP_MANIFEST_FILE,
      ),
      '{not-json',
    );
    expect(await resolver().resolve(agentContext())).toBeNull();

    await fs.writeFile(
      path.join(
        agentsDir,
        AGENT_ID,
        'apps',
        APP_ID,
        GENERATED_APP_MANIFEST_FILE,
      ),
      Buffer.from([0xff, 0xfe, 0xfd]),
    );
    expect(await resolver().resolve(agentContext())).toBeNull();

    await fs.writeFile(
      path.join(
        agentsDir,
        AGENT_ID,
        'apps',
        APP_ID,
        GENERATED_APP_MANIFEST_FILE,
      ),
      JSON.stringify(manifest({ unexpected: true })),
    );
    expect(await resolver().resolve(agentContext())).toBeNull();

    await fs.writeFile(
      path.join(
        agentsDir,
        AGENT_ID,
        'apps',
        APP_ID,
        GENERATED_APP_MANIFEST_FILE,
      ),
      JSON.stringify(manifest({ id: 'another-app' })),
    );
    expect(await resolver().resolve(agentContext())).toBeNull();
  });

  it('rejects missing and symlinked entrypoints', async () => {
    await writeApp({ omitEntrypoint: true });
    expect(await resolver().resolve(agentContext())).toBeNull();

    const entrypoint = path.join(
      agentsDir,
      AGENT_ID,
      'apps',
      APP_ID,
      'index.html',
    );
    const target = path.join(path.dirname(entrypoint), 'real-index.html');
    await fs.writeFile(target, '<!doctype html>');
    try {
      await fs.symlink(target, entrypoint);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'EACCES')
      ) {
        return;
      }
      throw error;
    }
    expect(await resolver().resolve(agentContext())).toBeNull();
  });

  it('rejects traversal identities before resolving filesystem paths', async () => {
    await writeApp();
    await fs.mkdir(path.join(root, 'outside', 'apps', APP_ID), {
      recursive: true,
    });

    expect(
      await resolver().resolve(agentContext({ agentId: '../outside' })),
    ).toBeNull();
    expect(
      await resolver().resolve(agentContext({ appId: '../dashboard' })),
    ).toBeNull();
    expect(
      await resolver().resolve(agentContext({ agentId: 'agent\\escape' })),
    ).toBeNull();
  });

  it('rejects symlinked roots, app directories, and nested files', async () => {
    const realAgentsDir = path.join(root, 'real-agents');
    await fs.mkdir(realAgentsDir);
    await writeApp({ agentsRoot: realAgentsDir });
    const linkedAgentsDir = path.join(root, 'linked-agents');
    await fs.symlink(realAgentsDir, linkedAgentsDir);
    expect(
      await new GeneratedAppIdentityResolver({
        agentsDir: linkedAgentsDir,
      }).resolve(agentContext()),
    ).toBeNull();

    const outsideApp = path.join(root, 'outside-app');
    await fs.mkdir(outsideApp);
    await fs.mkdir(path.join(agentsDir, AGENT_ID, 'apps'), { recursive: true });
    await fs.symlink(
      outsideApp,
      path.join(agentsDir, AGENT_ID, 'apps', APP_ID),
    );
    expect(await resolver().resolve(agentContext())).toBeNull();

    await fs.rm(path.join(agentsDir, AGENT_ID), {
      recursive: true,
      force: true,
    });
    const appRoot = await writeApp();
    await fs.symlink(
      path.join(appRoot, 'app.js'),
      path.join(appRoot, 'linked-script.js'),
    );
    expect(await resolver().resolve(agentContext())).toBeNull();
  });

  it('rejects hard-linked regular files even when they remain inside the app tree', async () => {
    const appRoot = await writeApp();
    const outside = path.join(root, 'outside-authority.js');
    await fs.writeFile(outside, 'globalThis.outside = true;');
    try {
      await fs.link(outside, path.join(appRoot, 'hard-linked.js'));
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EPERM' ||
          error.code === 'EACCES' ||
          error.code === 'ENOTSUP')
      ) {
        return;
      }
      throw error;
    }

    expect(await resolver().resolve(agentContext())).toBeNull();
  });

  it('requires exact case and Unicode spelling for canonical identity directories', async () => {
    await writeApp({ agentId: 'Agent-A' });
    expect(await resolver().resolve(agentContext())).toBeNull();

    await fs.rm(path.join(agentsDir, 'Agent-A'), {
      recursive: true,
      force: true,
    });
    const decomposed = 'cafe\u0301';
    const composed = 'caf\u00e9';
    await writeApp({ agentId: decomposed });
    expect(
      await resolver().resolve(agentContext({ agentId: composed })),
    ).toBeNull();
  });

  it('rejects ambiguous case-folded identity siblings', async () => {
    await writeApp();
    const aliasRoot = path.join(agentsDir, 'Agent-A');
    try {
      await writeApp({ agentId: 'Agent-A' });
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ) {
        return;
      }
      throw error;
    }
    const entries = await fs.readdir(agentsDir);
    if (
      entries.includes(AGENT_ID) &&
      entries.includes(path.basename(aliasRoot))
    ) {
      expect(await resolver().resolve(agentContext())).toBeNull();
    }
  });

  it('rejects case-folded and non-NFC aliases inside the authority tree', async () => {
    const appRoot = await writeApp();
    const upper = path.join(appRoot, 'Alias.js');
    const lower = path.join(appRoot, 'alias.js');
    await fs.writeFile(upper, 'upper');
    await fs.writeFile(lower, 'lower');
    const entries = await fs.readdir(appRoot);
    if (entries.includes('Alias.js') && entries.includes('alias.js')) {
      expect(await resolver().resolve(agentContext())).toBeNull();
    }

    await fs.rm(upper, { force: true });
    await fs.rm(lower, { force: true });
    await fs.writeFile(path.join(appRoot, 'cafe\u0301.txt'), 'alias');
    expect(await resolver().resolve(agentContext())).toBeNull();
  });

  it('enforces file-count and byte limits', async () => {
    await writeApp();
    expect(
      await resolver({ limits: { maxFiles: 2 } }).resolve(agentContext()),
    ).toBeNull();

    expect(
      await resolver({
        limits: {
          maxTotalBytes: 256,
          maxFileBytes: 512,
          maxManifestBytes: 256,
        },
      }).resolve(agentContext()),
    ).toBeNull();
  });

  it('fails closed for plugin and package contexts', async () => {
    await writeApp();

    expect(
      await resolver().resolve(agentContext({ pluginId: 'signed-plugin' })),
    ).toBeNull();
    expect(
      await resolver().resolve({
        kind: 'package',
        packageId: 'com.example.dashboard',
        appId: APP_ID,
      }),
    ).toBeNull();
  });
});
