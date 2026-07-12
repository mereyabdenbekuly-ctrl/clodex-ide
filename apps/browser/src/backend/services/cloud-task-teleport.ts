import type {
  CloudTaskTeleportActionResult,
  CloudTaskTeleportState,
} from '@shared/cloud-task-teleport';
import type {
  CloudTaskMemoryDivergenceResolution,
  CloudTaskMemorySyncDiagnosticsExport,
  CloudTaskMemorySyncExportResult,
} from '@shared/cloud-task-memory-sync';
import { dialog } from 'electron';
import { writeFile } from 'node:fs/promises';
import type { FileSystemCloudTaskMemorySyncJournal } from '../agent-host/cloud-task-memory-sync-journal';
import type { KartonService } from './karton';
import type { Logger } from './logger';
import { DisposableService } from './disposable';

const PROCEDURES = [
  'cloudTasks.continueLocally',
  'cloudTasks.resumeInCloud',
  'cloudTasks.retryMemorySync',
  'cloudTasks.resolveMemoryDivergence',
  'cloudTasks.exportMemorySyncDiagnostics',
] as const;

export interface CloudTaskTeleportSession {
  state: CloudTaskTeleportState;
  continueLocally(): Promise<CloudTaskTeleportState>;
  resumeInCloud(): Promise<CloudTaskTeleportState>;
  retryMemorySync?(): Promise<CloudTaskTeleportState>;
  resolveMemoryDivergence?(
    strategy: CloudTaskMemoryDivergenceResolution,
  ): Promise<CloudTaskTeleportState>;
}

export interface CloudTaskTeleportControllerOptions {
  karton: KartonService;
  logger: Pick<Logger, 'warn'>;
  isFeatureEnabled: () => boolean;
  now?: () => number;
  memorySyncJournal?: Pick<
    FileSystemCloudTaskMemorySyncJournal,
    'listForAgent' | 'exportForAgent'
  >;
  saveMemorySyncDiagnostics?: (
    value: CloudTaskMemorySyncDiagnosticsExport,
  ) => Promise<{ canceled: boolean }>;
}

/**
 * Owns the renderer-facing view of active Teleport executions.
 *
 * The execution runtime retains all sensitive lease material. This controller
 * only stores safe diagnostics and invokes opaque, fail-closed operations.
 */
export class CloudTaskTeleportController extends DisposableService {
  private readonly sessions = new Map<string, CloudTaskTeleportSession>();
  private readonly mutations = new Map<string, Promise<void>>();
  private readonly now: () => number;

  public constructor(
    private readonly options: CloudTaskTeleportControllerOptions,
  ) {
    super();
    this.now = options.now ?? Date.now;
    this.registerProcedures();
  }

  public publish(state: CloudTaskTeleportState): void {
    const memorySyncJournal =
      this.options.memorySyncJournal?.listForAgent(state.agentInstanceId, 10) ??
      state.memorySyncJournal ??
      [];
    this.options.karton.setState((draft) => {
      draft.cloudTasks.teleportByAgentId[state.agentInstanceId] =
        structuredClone({ ...state, memorySyncJournal });
    });
  }

  public register(session: CloudTaskTeleportSession): () => void {
    const agentInstanceId = session.state.agentInstanceId;
    this.sessions.set(agentInstanceId, session);
    this.publish(session.state);
    return () => {
      if (this.sessions.get(agentInstanceId) !== session) return;
      this.sessions.delete(agentInstanceId);
      this.options.karton.setState((draft) => {
        delete draft.cloudTasks.teleportByAgentId[agentInstanceId];
      });
    };
  }

  public update(
    agentInstanceId: string,
    update: Partial<Omit<CloudTaskTeleportState, 'agentInstanceId'>>,
  ): void {
    const current =
      this.options.karton.state.cloudTasks.teleportByAgentId[agentInstanceId];
    if (!current) return;
    const next = {
      ...current,
      ...update,
      agentInstanceId,
      updatedAt: update.updatedAt ?? this.now(),
    };
    const session = this.sessions.get(agentInstanceId);
    if (session) session.state = next;
    this.publish(next);
  }

  private registerProcedures(): void {
    this.options.karton.registerServerProcedureHandler(
      'cloudTasks.continueLocally',
      async (_clientId, agentInstanceId) =>
        await this.runAction(agentInstanceId, 'continueLocally'),
    );
    this.options.karton.registerServerProcedureHandler(
      'cloudTasks.resumeInCloud',
      async (_clientId, agentInstanceId) =>
        await this.runAction(agentInstanceId, 'resumeInCloud'),
    );
    this.options.karton.registerServerProcedureHandler(
      'cloudTasks.retryMemorySync',
      async (_clientId, agentInstanceId) =>
        await this.runMemoryAction(agentInstanceId, 'retry'),
    );
    this.options.karton.registerServerProcedureHandler(
      'cloudTasks.resolveMemoryDivergence',
      async (_clientId, agentInstanceId, strategy) =>
        await this.runMemoryAction(agentInstanceId, 'resolve', strategy),
    );
    this.options.karton.registerServerProcedureHandler(
      'cloudTasks.exportMemorySyncDiagnostics',
      async (_clientId, agentInstanceId) =>
        await this.exportMemorySyncDiagnostics(agentInstanceId),
    );
  }

  private async runMemoryAction(
    agentInstanceId: string,
    action: 'retry' | 'resolve',
    strategy?: CloudTaskMemoryDivergenceResolution,
  ): Promise<CloudTaskTeleportActionResult> {
    if (!this.options.isFeatureEnabled()) {
      return { ok: false, error: 'Cloud Tasks is disabled' };
    }
    const session = this.sessions.get(agentInstanceId);
    if (!session) return { ok: false, error: 'No active Teleport execution' };
    if (this.mutations.has(agentInstanceId)) {
      return { ok: false, error: 'A Teleport handoff is already in progress' };
    }
    if (action === 'resolve') {
      if (session.state.memorySyncState !== 'diverged') {
        return { ok: false, error: 'Memory ledger is not diverged' };
      }
      if (strategy !== 'keep-local' && strategy !== 'accept-cloud') {
        return { ok: false, error: 'Memory resolution strategy is invalid' };
      }
      if (!session.resolveMemoryDivergence) {
        return {
          ok: false,
          error: 'Memory divergence recovery is unavailable',
        };
      }
    } else if (!session.retryMemorySync) {
      return {
        ok: false,
        error: 'Memory synchronization retry is unavailable',
      };
    }

    let release: () => void = () => {};
    this.mutations.set(
      agentInstanceId,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    this.update(agentInstanceId, {
      memorySyncState: 'pending',
      error: null,
    });
    try {
      const next =
        action === 'retry'
          ? await session.retryMemorySync!()
          : await session.resolveMemoryDivergence!(strategy!);
      session.state = next;
      this.publish(next);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.update(agentInstanceId, {
        memorySyncState:
          session.state.memorySyncState === 'diverged' ? 'diverged' : 'failed',
        error: message,
      });
      return { ok: false, error: message };
    } finally {
      this.mutations.delete(agentInstanceId);
      release();
    }
  }

  private async exportMemorySyncDiagnostics(
    agentInstanceId: string,
  ): Promise<CloudTaskMemorySyncExportResult> {
    const journal = this.options.memorySyncJournal;
    if (!journal) {
      return { ok: false, error: 'Memory sync diagnostics are unavailable' };
    }
    const value = journal.exportForAgent(agentInstanceId);
    try {
      const result = await (
        this.options.saveMemorySyncDiagnostics ?? saveMemorySyncDiagnostics
      )(value);
      return {
        ok: true,
        canceled: result.canceled,
        entryCount: value.entries.length,
      };
    } catch {
      return { ok: false, error: 'Memory sync diagnostics export failed' };
    }
  }

  private async runAction(
    agentInstanceId: string,
    action: 'continueLocally' | 'resumeInCloud',
  ): Promise<CloudTaskTeleportActionResult> {
    if (!this.options.isFeatureEnabled()) {
      return { ok: false, error: 'Cloud Tasks is disabled' };
    }
    const session = this.sessions.get(agentInstanceId);
    if (!session) {
      return { ok: false, error: 'No active Teleport execution' };
    }
    const expectedPhases =
      action === 'continueLocally'
        ? (['cloud-owned'] as const)
        : (['suspended', 'failed'] as const);
    if (!(expectedPhases as readonly string[]).includes(session.state.phase)) {
      return {
        ok: false,
        error: `Teleport is ${session.state.phase}; expected ${expectedPhases.join(' or ')}`,
      };
    }
    if (this.mutations.has(agentInstanceId)) {
      return { ok: false, error: 'A Teleport handoff is already in progress' };
    }

    const transitionalPhase =
      action === 'continueLocally' ? 'suspending' : 'resuming';
    this.update(agentInstanceId, {
      phase: transitionalPhase,
      error: null,
    });
    let resolveMutation: () => void = () => {};
    const mutation = new Promise<void>((resolve) => {
      resolveMutation = resolve;
    });
    this.mutations.set(agentInstanceId, mutation);
    try {
      const next = await session[action]();
      this.publish(next);
      session.state = next;
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.warn(
        `[CloudTasks] Teleport ${action} failed for ${agentInstanceId}: ${message}`,
      );
      this.update(agentInstanceId, {
        phase: action === 'continueLocally' ? 'cloud-owned' : 'suspended',
        error: message,
      });
      return { ok: false, error: message };
    } finally {
      this.mutations.delete(agentInstanceId);
      resolveMutation();
    }
  }

  protected async onTeardown(): Promise<void> {
    for (const procedure of PROCEDURES) {
      this.options.karton.removeServerProcedureHandler(procedure);
    }
    await Promise.allSettled(this.mutations.values());
    this.sessions.clear();
  }
}

async function saveMemorySyncDiagnostics(
  value: CloudTaskMemorySyncDiagnosticsExport,
): Promise<{ canceled: boolean }> {
  const result = await dialog.showSaveDialog({
    title: 'Export Memory Sync diagnostics',
    defaultPath: `clodex-memory-sync-${value.agentInstanceId}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await writeFile(result.filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return { canceled: false };
}
