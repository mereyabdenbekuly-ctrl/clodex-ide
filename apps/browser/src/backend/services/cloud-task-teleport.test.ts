import { describe, expect, it, vi } from 'vitest';
import type { AppState } from '@shared/karton-contracts/ui';
import type { CloudTaskTeleportState } from '@shared/cloud-task-teleport';
import type { KartonService } from './karton';
import {
  CloudTaskTeleportController,
  type CloudTaskTeleportSession,
} from './cloud-task-teleport';

describe('CloudTaskTeleportController', () => {
  it('publishes safe diagnostics and completes cloud-to-local handoff atomically', async () => {
    const { controller, handlers, state } = createController();
    const cloudOwned = createState();
    const suspended = {
      ...cloudOwned,
      phase: 'suspended' as const,
      handoffId: 'handoff-safe-id',
      lastSequence: 42,
      updatedAt: 2_000,
    };
    const session: CloudTaskTeleportSession = {
      state: cloudOwned,
      continueLocally: vi.fn(async () => suspended),
      resumeInCloud: vi.fn(async () => cloudOwned),
    };
    controller.register(session);

    await expect(
      handlers.get('cloudTasks.continueLocally')?.('ui', 'agent-1'),
    ).resolves.toEqual({ ok: true });
    expect(session.continueLocally).toHaveBeenCalledOnce();
    expect(state.cloudTasks.teleportByAgentId['agent-1']).toEqual(
      expect.objectContaining(suspended),
    );
    expect(JSON.stringify(state.cloudTasks)).not.toMatch(
      /credential|fencingToken|leaseId|snapshotHash|localPath/,
    );
    await controller.teardown();
  });

  it('rolls a failed resume back to suspended ownership', async () => {
    const { controller, handlers, state } = createController();
    const suspended = {
      ...createState(),
      phase: 'suspended' as const,
      handoffId: 'handoff-1',
    };
    controller.register({
      state: suspended,
      continueLocally: vi.fn(async () => suspended),
      resumeInCloud: vi.fn(async () => {
        throw new Error('new epoch was not confirmed');
      }),
    });

    await expect(
      handlers.get('cloudTasks.resumeInCloud')?.('ui', 'agent-1'),
    ).resolves.toEqual({
      ok: false,
      error: 'new epoch was not confirmed',
    });
    expect(state.cloudTasks.teleportByAgentId['agent-1']).toMatchObject({
      phase: 'suspended',
      epoch: 7,
      handoffId: 'handoff-1',
      error: 'new epoch was not confirmed',
    });
    await controller.teardown();
  });

  it('allows a failed recovered cloud-owned session to retry', async () => {
    const { controller, handlers } = createController();
    const failed = {
      ...createState(),
      phase: 'failed' as const,
      error: 'ownership was uncertain',
    };
    const recovered = {
      ...createState(),
      epoch: 8,
    };
    const resumeInCloud = vi.fn(async () => recovered);
    controller.register({
      state: failed,
      continueLocally: vi.fn(async () => failed),
      resumeInCloud,
    });

    await expect(
      handlers.get('cloudTasks.resumeInCloud')?.('ui', 'agent-1'),
    ).resolves.toEqual({ ok: true });
    expect(resumeInCloud).toHaveBeenCalledOnce();
    await controller.teardown();
  });

  it('resolves a diverged ledger explicitly and exports safe diagnostics', async () => {
    const saveMemorySyncDiagnostics = vi.fn(async () => ({
      canceled: false,
    }));
    const { controller, handlers, state } = createController({
      saveMemorySyncDiagnostics,
    });
    const diverged = {
      ...createState(),
      memorySyncState: 'diverged' as const,
    };
    const resolved = {
      ...diverged,
      memorySyncState: 'synchronized' as const,
    };
    const resolveMemoryDivergence = vi.fn(async () => resolved);
    controller.register({
      state: diverged,
      continueLocally: vi.fn(async () => diverged),
      resumeInCloud: vi.fn(async () => diverged),
      retryMemorySync: vi.fn(async () => diverged),
      resolveMemoryDivergence,
    });

    await expect(
      handlers.get('cloudTasks.resolveMemoryDivergence')?.(
        'ui',
        'agent-1',
        'keep-local',
      ),
    ).resolves.toEqual({ ok: true });
    expect(resolveMemoryDivergence).toHaveBeenCalledWith('keep-local');
    expect(state.cloudTasks.teleportByAgentId['agent-1']?.memorySyncState).toBe(
      'synchronized',
    );

    await expect(
      handlers.get('cloudTasks.exportMemorySyncDiagnostics')?.('ui', 'agent-1'),
    ).resolves.toEqual({
      ok: true,
      canceled: false,
      entryCount: 1,
    });
    expect(saveMemorySyncDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'clodex-memory-sync-diagnostics',
        entries: [expect.objectContaining({ status: 'diverged' })],
      }),
    );
    await controller.teardown();
  });
});

function createController(
  options: {
    saveMemorySyncDiagnostics?: () => Promise<{ canceled: boolean }>;
  } = {},
) {
  const state = {
    cloudTasks: { teleportByAgentId: {} },
  } as AppState;
  const handlers = new Map<
    string,
    (
      clientId: string,
      agentInstanceId: string,
      strategy?: 'keep-local' | 'accept-cloud',
    ) => Promise<unknown>
  >();
  const karton = {
    state,
    setState: (recipe: (draft: AppState) => void) => recipe(state),
    registerServerProcedureHandler: (
      name: string,
      handler: (
        clientId: string,
        agentInstanceId: string,
        strategy?: 'keep-local' | 'accept-cloud',
      ) => Promise<unknown>,
    ) => handlers.set(name, handler),
    removeServerProcedureHandler: (name: string) => handlers.delete(name),
  } as unknown as KartonService;
  const controller = new CloudTaskTeleportController({
    karton,
    logger: { warn: vi.fn() },
    isFeatureEnabled: () => true,
    now: () => 1_500,
    memorySyncJournal: {
      listForAgent: () => [
        {
          id: 'entry-1',
          taskId: 'task-1',
          agentInstanceId: 'agent-1',
          executionId: 'execution-1',
          operation: 'cloud-to-local',
          direction: 'cloud-to-local',
          status: 'diverged',
          epoch: 7,
          checkpointId: null,
          eventCount: 1,
          importedEvents: null,
          duplicateEvents: null,
          divergenceEventIdHash: 'a'.repeat(64),
          errorCode: 'event-divergence',
          resolution: null,
          recoveryClass: null,
          recoveryDecision: null,
          automatic: false,
          protocol: null,
          idempotentReplay: false,
          backoffMs: null,
          attempt: 1,
          startedAt: 1_000,
          finishedAt: 1_100,
        },
      ],
      exportForAgent: (agentInstanceId: string) => ({
        format: 'clodex-memory-sync-diagnostics',
        version: 1,
        exportedAt: 1_500,
        agentInstanceId,
        entries: [
          {
            id: 'entry-1',
            taskId: 'task-1',
            agentInstanceId: 'agent-1',
            executionId: 'execution-1',
            operation: 'cloud-to-local',
            direction: 'cloud-to-local',
            status: 'diverged',
            epoch: 7,
            checkpointId: null,
            eventCount: 1,
            importedEvents: null,
            duplicateEvents: null,
            divergenceEventIdHash: 'a'.repeat(64),
            errorCode: 'event-divergence',
            resolution: null,
            recoveryClass: null,
            recoveryDecision: null,
            automatic: false,
            protocol: null,
            idempotentReplay: false,
            backoffMs: null,
            attempt: 1,
            startedAt: 1_000,
            finishedAt: 1_100,
          },
        ],
      }),
    },
    saveMemorySyncDiagnostics: options.saveMemorySyncDiagnostics,
  });
  return { controller, handlers, state };
}

function createState(): CloudTaskTeleportState {
  return {
    agentInstanceId: 'agent-1',
    taskId: 'task-1',
    executionId: 'execution-1',
    phase: 'cloud-owned',
    epoch: 7,
    handoffId: null,
    lastSequence: 12,
    updatedAt: 1_000,
    error: null,
  };
}
