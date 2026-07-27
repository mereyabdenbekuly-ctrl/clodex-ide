import { describe, expect, it } from 'vitest';
import type { HostPaths } from '../../host';
import { resolveToolMountPrefix, resolveToolPath } from './path-resolution';
import type {
  UniversalToolboxDeps,
  UniversalToolboxMountManager,
} from './types';

const WORKSPACE_PREFIX = 'w0123456789abcdef';

function makeHostPaths(): HostPaths {
  return {
    plansDir: () => '/host/plans',
    logsDir: () => '/host/logs',
    memoryDir: () => '/host/memory',
    agentAppsDir: (agentId) => `/host/agents/${agentId}/apps`,
    agentAttachmentsDir: (agentId) => `/host/agents/${agentId}/attachments`,
    agentShellLogsDir: (agentId) => `/host/agents/${agentId}/shells`,
    pluginsDir: () => '/host/plugins',
  } as HostPaths;
}

function makeMountManager(
  mounts: ReadonlyArray<{ prefix: string; root: string }>,
): UniversalToolboxMountManager {
  const roots = new Map(mounts.map((mount) => [mount.prefix, mount.root]));
  return {
    getMountPrefixes: () => [...roots.keys()],
    getWorkspacePathForPrefix: (prefix) => roots.get(prefix),
    getMountPermissionsForPrefix: () => ['read', 'write', 'create', 'delete'],
    findWorkspaceForFile: () => undefined,
  };
}

function makeDeps(
  mounts: ReadonlyArray<{ prefix: string; root: string }> = [],
): UniversalToolboxDeps {
  return {
    agentInstanceId: 'agent-1',
    hostPaths: makeHostPaths(),
    mountManager: makeMountManager(mounts),
    staticMounts: [
      {
        prefix: 'wposix',
        absolutePath: '/workspace',
        permissions: ['read', 'write', 'create', 'delete'],
      },
    ],
  };
}

function captureError(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected operation to throw');
}

describe('resolveToolPath Windows guidance', () => {
  it('returns the exact registered alias for a drive-absolute path', () => {
    const deps = makeDeps([
      { prefix: WORKSPACE_PREFIX, root: 'C:\\Users\\Alice\\Repo' },
    ]);

    const message = captureError(() =>
      resolveToolPath(deps, 'C:\\Users\\Alice\\Repo\\src\\app.ts'),
    );

    expect(message).toContain(`registered mount "${WORKSPACE_PREFIX}"`);
    expect(message).toContain(`"${WORKSPACE_PREFIX}/src/app.ts"`);
    expect(message).toContain(
      `mount_prefix arguments, use "${WORKSPACE_PREFIX}"`,
    );
    expect(message).not.toContain('Mount C: not found');
  });

  it('matches Windows paths case-insensitively and accepts slash drive syntax', () => {
    const deps = makeDeps([
      { prefix: WORKSPACE_PREFIX, root: 'C:\\Users\\Alice\\Repo' },
    ]);

    const message = captureError(() =>
      resolveToolPath(deps, '/c:/users/alice/repo/src/app.ts'),
    );

    expect(message).toContain(`"${WORKSPACE_PREFIX}/src/app.ts"`);
  });

  it('uses the longest registered root for nested Windows mounts', () => {
    const deps = makeDeps([
      { prefix: 'wouter0000000000', root: 'C:\\Users\\Alice\\Repo' },
      {
        prefix: 'winner0000000000',
        root: 'C:\\Users\\Alice\\Repo\\packages\\app',
      },
    ]);

    const message = captureError(() =>
      resolveToolPath(
        deps,
        'C:\\Users\\Alice\\Repo\\packages\\app\\src\\main.ts',
      ),
    );

    expect(message).toContain('registered mount "winner0000000000"');
    expect(message).toContain('"winner0000000000/src/main.ts"');
    expect(message).not.toContain('"wouter0000000000/src/main.ts"');
  });

  it('returns exact guidance for a registered UNC workspace', () => {
    const deps = makeDeps([
      {
        prefix: WORKSPACE_PREFIX,
        root: '\\\\server\\share\\repo',
      },
    ]);

    const message = captureError(() =>
      resolveToolPath(deps, '\\\\server\\share\\repo\\src\\main.ts'),
    );

    expect(message).toContain(`"${WORKSPACE_PREFIX}/src/main.ts"`);
  });

  it('fails closed when an absolute path is outside delegated workspaces', () => {
    const deps = makeDeps([
      { prefix: WORKSPACE_PREFIX, root: 'C:\\Users\\Alice\\Repo' },
    ]);

    const message = captureError(() =>
      resolveToolPath(deps, 'C:\\Users\\Alice\\Secrets\\token.txt'),
    );

    expect(message).toContain('not inside a workspace mounted for this agent');
    expect(message).toContain(`"${WORKSPACE_PREFIX}"`);
    expect(message).not.toContain(`${WORKSPACE_PREFIX}/token.txt`);
  });

  it('does not treat a traversal outside the registered root as aliasable', () => {
    const deps = makeDeps([
      { prefix: WORKSPACE_PREFIX, root: 'C:\\Users\\Alice\\Repo' },
    ]);

    const message = captureError(() =>
      resolveToolPath(deps, 'C:\\Users\\Alice\\Repo\\..\\Secrets\\token.txt'),
    );

    expect(message).toContain('not inside a workspace mounted for this agent');
    expect(message).not.toContain(`${WORKSPACE_PREFIX}/`);
  });

  it('fails closed when more than one registered alias matches the same root', () => {
    const deps = makeDeps([
      { prefix: 'wfirst0000000000', root: 'C:\\Users\\Alice\\Repo' },
      { prefix: 'wsecond000000000', root: 'c:\\users\\alice\\repo' },
    ]);

    const message = captureError(() =>
      resolveToolPath(deps, 'C:\\Users\\Alice\\Repo\\src\\app.ts'),
    );

    expect(message).toContain(
      'cannot be mapped to one unambiguous registered mount',
    );
    expect(message).not.toContain('For path arguments, retry with');
  });

  it.each([
    ['C:', 'Windows drive designator "C:" is not a mount prefix'],
    ['C:relative\\file.ts', 'Windows drive-relative paths'],
    ['\\\\?\\C:\\Users\\Alice\\Repo\\file.ts', 'Windows device paths'],
  ])('rejects non-addressable Windows syntax %s before mount splitting', (input, expected) => {
    const message = captureError(() => resolveToolPath(makeDeps(), input));
    expect(message).toContain(expected);
    expect(message).not.toContain('Mount C: not found');
  });

  it.each([
    '/wposix/src/app.ts',
    '\\wposix\\src\\app.ts',
    '/apps/generated/index.html',
    '\\apps\\generated\\index.html',
  ])('rejects a leading separator instead of reinterpreting %s as a mount path', (input) => {
    const message = captureError(() => resolveToolPath(makeDeps(), input));
    expect(message).toContain(
      'Paths beginning with "/" or "\\" are absolute/rooted paths',
    );
  });

  it.each([
    'CON',
    'con.txt',
    'PRN.json',
    'AUX   ',
    'NUL.',
    'CLOCK$.log',
    'CONIN$',
    'CONOUT$.txt',
    'COM1',
    'com9.log',
    'LPT1',
    'lpt9...',
    'src/PRN.json',
  ])('rejects Windows reserved device segment %s', (relativePath) => {
    const deps = makeDeps([
      { prefix: WORKSPACE_PREFIX, root: 'C:\\Users\\Alice\\Repo' },
    ]);

    expect(() =>
      resolveToolPath(deps, `${WORKSPACE_PREFIX}/${relativePath}`),
    ).toThrow('Windows reserved device name');
  });

  it.each([
    'file.txt:secret',
    'src:stream/file.ts',
    'C:relative\\file.ts',
  ])('rejects Windows alternate data stream syntax in %s', (relativePath) => {
    const deps = makeDeps([
      { prefix: WORKSPACE_PREFIX, root: 'C:\\Users\\Alice\\Repo' },
    ]);

    expect(() =>
      resolveToolPath(deps, `${WORKSPACE_PREFIX}/${relativePath}`),
    ).toThrow('Windows alternate data stream syntax');
  });

  it.each([
    'console.ts',
    'com10.txt',
    'lpt0.log',
    'auxiliary.md',
  ])('does not overmatch ordinary Windows filename %s', (relativePath) => {
    const deps = makeDeps([
      { prefix: WORKSPACE_PREFIX, root: 'C:\\Users\\Alice\\Repo' },
    ]);

    expect(
      resolveToolPath(deps, `${WORKSPACE_PREFIX}/${relativePath}`),
    ).toMatchObject({
      mountPrefix: WORKSPACE_PREFIX,
      relativePath,
    });
  });

  it('continues to resolve ordinary mount-prefixed paths with either separator', () => {
    const deps = makeDeps();

    expect(resolveToolPath(deps, 'wposix/src/app.ts')).toMatchObject({
      mountPrefix: 'wposix',
      relativePath: 'src/app.ts',
      absolutePath: '/workspace/src/app.ts',
    });
    expect(resolveToolPath(deps, 'wposix\\src\\app.ts')).toMatchObject({
      mountPrefix: 'wposix',
      relativePath: 'src/app.ts',
      absolutePath: '/workspace/src/app.ts',
    });
  });

  it('requires prefix-only tools to use one exact mount prefix', () => {
    const deps = makeDeps();

    expect(resolveToolMountPrefix(deps, 'wposix')).toMatchObject({
      mountPrefix: 'wposix',
      relativePath: '',
      absolutePath: '/workspace',
    });
    expect(() => resolveToolMountPrefix(deps, 'wposix/src')).toThrow(
      'mount_prefix must be one exact registered prefix',
    );
  });
});
