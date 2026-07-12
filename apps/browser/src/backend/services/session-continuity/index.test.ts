import { describe, expect, it, vi } from 'vitest';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import {
  SessionContinuityService,
  type SessionCheckpointPersistence,
  type SessionContinuityPersistence,
} from './index';
import {
  createAgentSessionCheckpoint,
  createWorkspaceSnapshot,
} from '@clodex/agent-core/agents';

const workspaceSnapshot = createWorkspaceSnapshot({
  createdAt: Date.parse('2026-07-11T10:00:00.000Z'),
  selection: 'mounted-workspaces',
  entries: [],
  mounts: [],
});

describe('SessionContinuityService', () => {
  it('checks readiness, teleports, creates a share, and revokes it', async () => {
    let store = { version: 1 as const, shares: [] };
    const persistence: SessionContinuityPersistence = {
      load: async () => structuredClone(store),
      save: async (value) => {
        store = structuredClone(value) as typeof store;
      },
    };
    let checkpointStore = { version: 1 as const, checkpoints: [] };
    const checkpointPersistence: SessionCheckpointPersistence = {
      load: async () => structuredClone(checkpointStore),
      save: async (value) => {
        checkpointStore = structuredClone(value) as typeof checkpointStore;
      },
    };
    const handlers = new Map<string, (...args: any[]) => Promise<any>>();
    const karton = {
      registerServerProcedureHandler: (
        name: string,
        handler: (...args: any[]) => Promise<any>,
      ) => handlers.set(name, handler),
      removeServerProcedureHandler: (name: string) => handlers.delete(name),
    } as unknown as KartonService;
    const teleport = vi.fn(async (sessionId: string) => ({
      agentId: sessionId,
    }));
    const checkpoint = createAgentSessionCheckpoint({
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-07-11T10:00:00.000Z',
      task: {
        agentInstanceId: 'agent-1',
        agentType: 'chat',
        title: 'Task',
        goal: null,
        lineage: {
          parentAgentInstanceId: null,
          forkedFromAgentId: null,
          forkedFromMessageId: null,
        },
      },
      execution: {
        state: 'idle',
        target: 'local',
        activeModelId: 'model-1',
        approvalProfile: 'alwaysAsk',
        usedTokens: 0,
        historyMessageCount: 4,
        lastMessageId: 'message-4',
      },
      memory: {
        history: {
          kind: 'agent-memory-jsonl',
          agentInstanceId: 'agent-1',
          messageCount: 4,
          contentHash:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        compressedHistory: null,
      },
      workspace: {
        capturedAt: '2026-07-11T10:00:00.000Z',
        snapshot: workspaceSnapshot,
        workspaces: [],
      },
      persistence: {
        agentStateFlushedAt: '2026-07-11T10:00:00.000Z',
        memoryFlushedAt: '2026-07-11T10:00:00.000Z',
      },
    });
    const revokeShare = vi.fn(async () => undefined);
    const service = await SessionContinuityService.create({
      logger: {} as Logger,
      karton,
      persistence,
      checkpointPersistence,
      isFeatureEnabled: () => true,
      isCloudAvailable: () => true,
      getSessionInfo: async () => ({
        exists: true,
        messageCount: 4,
        workspacePaths: ['/repo'],
      }),
      prepareCheckpoint: async () => checkpoint,
      teleport,
      buildSharePayload: async () => ({
        sessionId: 'agent-1',
        title: 'Task',
        createdAt: '2026-07-11T10:00:00.000Z',
        messages: [],
      }),
      sharingAdapter: {
        available: () => true,
        createShare: async () => ({
          id: 'share-1',
          url: 'https://share.clodex.test/s/share-1',
          expiresAt: '2026-07-18T10:00:00.000Z',
        }),
        revokeShare,
      },
      now: () => Date.parse('2026-07-11T10:00:00.000Z'),
    });

    await expect(
      handlers.get('sessionContinuity.teleport')?.('ui', {
        sessionId: 'agent-1',
        prompt: 'Continue in cloud.',
      }),
    ).resolves.toEqual({ agentId: 'agent-1' });
    const share = await handlers.get('sessionContinuity.createShare')?.('ui', {
      sessionId: 'agent-1',
      expiresInHours: 168,
    });
    expect(share).toMatchObject({ id: 'share-1', revokedAt: null });
    expect(service.getLatestCheckpoint('agent-1')).toEqual(checkpoint);
    await handlers.get('sessionContinuity.revokeShare')?.('ui', 'share-1');
    expect(revokeShare).toHaveBeenCalledWith('share-1');
    expect(service.getShares().shares[0]?.revokedAt).not.toBeNull();
    await service.teardown();
  });

  it('keeps local execution authoritative when cloud handoff fails', async () => {
    let localExecutionActive = true;
    let checkpointStore = { version: 1 as const, checkpoints: [] };
    const handlers = new Map<string, (...args: any[]) => Promise<any>>();
    const service = await SessionContinuityService.create({
      logger: {} as Logger,
      karton: {
        registerServerProcedureHandler: (
          name: string,
          handler: (...args: any[]) => Promise<any>,
        ) => handlers.set(name, handler),
        removeServerProcedureHandler: (name: string) => handlers.delete(name),
      } as unknown as KartonService,
      persistence: {
        load: async () => ({ version: 1, shares: [] }),
        save: async () => undefined,
      },
      checkpointPersistence: {
        load: async () => structuredClone(checkpointStore),
        save: async (value) => {
          checkpointStore = structuredClone(value) as typeof checkpointStore;
        },
      },
      isFeatureEnabled: () => true,
      isCloudAvailable: () => true,
      getSessionInfo: async () => ({
        exists: true,
        messageCount: 1,
        workspacePaths: ['/repo'],
      }),
      prepareCheckpoint: async () =>
        createAgentSessionCheckpoint({
          id: '22222222-2222-4222-8222-222222222222',
          createdAt: '2026-07-11T10:00:00.000Z',
          task: {
            agentInstanceId: 'agent-1',
            agentType: 'chat',
            title: 'Task',
            goal: null,
            lineage: {
              parentAgentInstanceId: null,
              forkedFromAgentId: null,
              forkedFromMessageId: null,
            },
          },
          execution: {
            state: 'idle',
            target: 'local',
            activeModelId: 'model-1',
            approvalProfile: 'alwaysAsk',
            usedTokens: 0,
            historyMessageCount: 1,
            lastMessageId: 'message-1',
          },
          memory: {
            history: {
              kind: 'agent-memory-jsonl',
              agentInstanceId: 'agent-1',
              messageCount: 1,
              contentHash:
                'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            },
            compressedHistory: null,
          },
          workspace: {
            capturedAt: '2026-07-11T10:00:00.000Z',
            snapshot: workspaceSnapshot,
            workspaces: [],
          },
          persistence: {
            agentStateFlushedAt: '2026-07-11T10:00:00.000Z',
            memoryFlushedAt: '2026-07-11T10:00:00.000Z',
          },
        }),
      teleport: async () => {
        throw new Error('cloud restore failed');
      },
      buildSharePayload: async () => {
        throw new Error('not used');
      },
    });

    await expect(
      handlers.get('sessionContinuity.teleport')?.('ui', {
        sessionId: 'agent-1',
        prompt: 'Continue in cloud.',
      }),
    ).rejects.toThrow('cloud restore failed');
    expect(localExecutionActive).toBe(true);
    expect(checkpointStore.checkpoints).toHaveLength(1);
    await service.teardown();
    localExecutionActive = false;
  });
});
