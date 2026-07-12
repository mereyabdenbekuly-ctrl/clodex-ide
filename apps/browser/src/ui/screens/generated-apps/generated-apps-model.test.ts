import { describe, expect, it } from 'vitest';
import type { GeneratedApp } from '@shared/generated-apps';
import {
  filterGeneratedApps,
  getGeneratedAppsSummary,
  getGeneratedAppWorkspaceOptions,
} from './generated-apps-model';

function app(key: string, overrides: Partial<GeneratedApp> = {}): GeneratedApp {
  return {
    key,
    appId: key,
    owner: {
      kind: 'agent',
      agentId: `agent-${key}`,
      taskTitle: `Build ${key}`,
      workspacePath: `/workspace/${key}`,
    },
    title: key,
    description: null,
    status: 'ready',
    entryPath: 'index.html',
    previewUrl: `clodex://internal/preview/${key}`,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    lastOpenedAt: null,
    regenerationRequestedAt: null,
    fileCount: 2,
    totalBytes: 100,
    error: null,
    ...overrides,
  };
}

describe('generated apps catalog model', () => {
  const apps = [
    app('Analytics', {
      description: 'Revenue dashboard',
      owner: {
        kind: 'agent',
        agentId: 'agent-a',
        taskTitle: 'Build reporting',
        workspacePath: '/workspace/product',
      },
      updatedAt: '2026-07-10T11:00:00.000Z',
      lastOpenedAt: '2026-07-10T10:00:00.000Z',
    }),
    app('Broken app', {
      status: 'broken',
      error: 'index.html is missing.',
      owner: {
        kind: 'agent',
        agentId: 'agent-b',
        taskTitle: 'Prototype onboarding',
        workspacePath: '/workspace/design',
      },
      updatedAt: '2026-07-09T11:00:00.000Z',
    }),
    app('Regenerating', {
      status: 'regenerating',
      regenerationRequestedAt: '2026-07-10T11:30:00.000Z',
      owner: {
        kind: 'agent',
        agentId: 'agent-c',
        taskTitle: 'Repair reporting',
        workspacePath: '/workspace/product',
      },
      lastOpenedAt: '2026-07-10T11:30:00.000Z',
    }),
  ];

  it('summarizes operational states', () => {
    expect(getGeneratedAppsSummary(apps)).toEqual({
      total: 3,
      ready: 1,
      needsAttention: 1,
      regenerating: 1,
    });
  });

  it('filters across metadata and ownership', () => {
    expect(
      filterGeneratedApps(apps, {
        query: 'revenue',
        status: 'all',
        workspacePath: null,
        sort: 'updated-desc',
      }).map((item) => item.key),
    ).toEqual(['Analytics']);

    expect(
      filterGeneratedApps(apps, {
        query: '',
        status: 'attention',
        workspacePath: '/workspace/design',
        sort: 'updated-desc',
      }).map((item) => item.key),
    ).toEqual(['Broken app']);
  });

  it('sorts by last opened and returns unique workspaces', () => {
    expect(
      filterGeneratedApps(apps, {
        query: '',
        status: 'all',
        workspacePath: null,
        sort: 'opened-desc',
      }).map((item) => item.key),
    ).toEqual(['Regenerating', 'Analytics', 'Broken app']);
    expect(getGeneratedAppWorkspaceOptions(apps)).toEqual([
      '/workspace/design',
      '/workspace/product',
    ]);
  });
});
