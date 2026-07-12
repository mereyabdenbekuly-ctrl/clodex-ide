import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  createRuntimeContextDomainAdapter,
  RUNTIME_CONTEXT_DOMAIN_ID,
} from './runtime-context';
import { createTestAgentHost } from '../../host/test-utils';
import type { HostPaths } from '../../host/paths';
import type { MountManager } from '../../services/mount-manager/mount-registry';
import { CORE_ENV_SCHEMA_VERSION } from './shared';

function makeHost(activeFilePath = 'w1/src/app.ts') {
  const p = (name: string) => () => `/host/${name}`;
  const paths: HostPaths = {
    agentAttachmentsDir: (id: string) => `/host/att/${id}`,
    agentShellLogsDir: (id: string) => `/host/shells/${id}`,
    pluginsDir: () => '/host/plugins',
    agentAppsDir: (id: string) => `/host/apps/${id}`,
    plansDir: p('plans'),
    logsDir: p('logs'),
    memoryDir: p('memory'),
    dataDir: p('data'),
    tempDir: p('tmp'),
    agentsDir: p('agents'),
    agentDir: () => '/host/agent',
    agentAttachmentPath: () => '/host/att-file',
    diffHistoryDir: p('diff'),
    diffHistoryDbPath: () => '/host/diff.db',
    diffHistoryBlobsDir: () => '/host/diff-blobs',
    agentDbPath: () => '/host/agent.db',
    fileReadCacheDbPath: () => '/host/frc.db',
    processedImageCacheDbPath: () => '/host/pic.db',
    userDataDir: p('udata'),
    builtinSkillsDir: p('builtin'),
    ripgrepBaseDir: p('rg'),
  };

  return createTestAgentHost({
    paths,
    environmentSources: {
      async getResolvedSkillsForAgent() {
        return [];
      },
      getWorkspaceAgentSettings() {
        return new Map();
      },
      getGlobalSkillsMounts() {
        return [];
      },
      getRuntimeContext() {
        return {
          osName: 'darwin',
          osArch: 'arm64',
          currentTime: '2026-07-08T00:00:00.000Z',
          activeFilePath,
        };
      },
    },
  });
}

function makeMountManager(
  workspaceMounts: Array<{ prefix: string; path: string }>,
): MountManager {
  return {
    getMountPrefixes: () => workspaceMounts.map((mount) => mount.prefix),
    getWorkspacePathForPrefix: (prefix: string) =>
      workspaceMounts.find((mount) => mount.prefix === prefix)?.path,
  } as unknown as MountManager;
}

describe('createRuntimeContextDomainAdapter', () => {
  it('reports the canonical contract metadata', () => {
    const adapter = createRuntimeContextDomainAdapter({
      host: makeHost(),
      mountManager: makeMountManager([]),
    });

    expect(adapter.domainId).toBe(RUNTIME_CONTEXT_DOMAIN_ID);
    expect(adapter.renderOrder).toBe(0.5);
    expect(adapter.schemaVersion).toBe(CORE_ENV_SCHEMA_VERSION);
    expect(adapter.promptSection).toContain('Runtime Context');
  });

  it('renders runtime context and project rules from workspace roots', async () => {
    const workspace = path.join(tmpdir(), `clodex-runtime-${Date.now()}`);
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, '.clodexrules'),
      'Use strict TypeScript.',
      'utf8',
    );
    await writeFile(
      path.join(workspace, '.cursorrules'),
      'Prefer existing components.',
      'utf8',
    );

    const adapter = createRuntimeContextDomainAdapter({
      host: makeHost('w1/src/app.ts'),
      mountManager: makeMountManager([{ prefix: 'w1', path: workspace }]),
    });

    const state = await adapter.getState('agent-1');
    const rendered = adapter.renderState(null, state);

    expect(rendered).toContain('<environment_context>');
    expect(rendered).toContain('OS: darwin (Arch: arm64)');
    expect(rendered).toContain('Active editor file: w1/src/app.ts');
    expect(rendered).toContain('<project_rules>');
    expect(rendered).toContain('path="w1/.clodexrules"');
    expect(rendered).toContain('Use strict TypeScript.');
    expect(rendered).toContain('path="w1/.cursorrules"');
    expect(rendered).toContain('Prefer existing components.');
  });

  it('emits changes for active file and project rule updates', async () => {
    const adapter = createRuntimeContextDomainAdapter({
      host: makeHost(),
      mountManager: makeMountManager([]),
    });

    const diff = adapter.renderState(
      {
        osName: 'darwin',
        osArch: 'arm64',
        currentTime: 'old',
        activeFilePath: 'w1/old.ts',
        workspaceRoots: [],
        projectRules: [
          {
            mountPrefix: 'w1',
            filename: '.clodexrules',
            content: 'old rule',
          },
        ],
      },
      {
        osName: 'darwin',
        osArch: 'arm64',
        currentTime: 'new',
        activeFilePath: 'w1/new.ts',
        workspaceRoots: [],
        projectRules: [
          {
            mountPrefix: 'w1',
            filename: '.clodexrules',
            content: 'new rule',
          },
        ],
      },
    );

    expect(diff).toContain('active-file-changed');
    expect(diff).toContain('project-rules-updated');
    expect(diff).toContain('new rule');
  });

  it('does not treat currentTime-only changes as meaningful env changes', () => {
    const adapter = createRuntimeContextDomainAdapter({
      host: makeHost(),
      mountManager: makeMountManager([]),
    });
    const base = {
      osName: 'darwin',
      osArch: 'arm64',
      activeFilePath: 'w1/app.ts',
      workspaceRoots: [{ prefix: 'w1', path: '/project' }],
      projectRules: [],
    };

    expect(
      adapter.equals?.(
        { ...base, currentTime: '2026-07-08T00:00:00.000Z' },
        { ...base, currentTime: '2026-07-08T00:01:00.000Z' },
      ),
    ).toBe(true);
  });
});
