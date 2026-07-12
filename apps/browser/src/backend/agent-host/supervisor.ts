import type { AgentStore, AgentSystemState } from '@clodex/agent-core';
import { utilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentHostProcessTelemetryEvents,
  AgentHostProcessTelemetrySink,
} from '@shared/agent-runtime-telemetry';
import { DisposableService } from '../services/disposable';
import type { Logger } from '../services/logger';
import {
  AGENT_HOST_PROTOCOL_VERSION,
  isAgentHostToMainMessage,
  type AgentHostToMainMessage,
  type AgentRuntimeSnapshot,
  type AgentRuntimeSummary,
  type MainToAgentHostMessage,
  type OpenManusExecutionRequest,
  type OpenManusExecutionResult,
} from './protocol';
import type {
  AgentTurnHostHandlers,
  IsolatedAgentModelCallRequest,
  IsolatedAgentToolCallRequest,
  IsolatedAgentTurnEvent,
  IsolatedAgentTurnRequest,
  IsolatedAgentTurnResult,
} from './isolated-agent-turn';

const AGENT_HOST_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'agent-host.cjs',
);

interface UtilityProcessHandle {
  pid: number | undefined;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  postMessage(message: MainToAgentHostMessage): void;
  kill(): boolean;
  on(event: 'spawn', handler: () => void): this;
  on(event: 'message', handler: (message: unknown) => void): this;
  on(event: 'exit', handler: (code: number) => void): this;
  on(
    event: 'error',
    handler: (type: string, location: string, report: string) => void,
  ): this;
}

type ForkAgentHost = (
  modulePath: string,
  args: string[],
  options: Electron.ForkOptions,
) => UtilityProcessHandle;

export interface AgentHostProcessOptions {
  fork?: ForkAgentHost;
  workerPath?: string;
  telemetry?: AgentHostProcessTelemetrySink;
  readyTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  mainLoopStallThresholdMs?: number;
  restartWindowMs?: number;
  maxRestartsPerWindow?: number;
  restartBaseDelayMs?: number;
}

export interface MainLoopStallDetails {
  stalledForMs: number;
  heartbeatSequence: number;
}

type MainLoopStallListener = (details: MainLoopStallDetails) => void;
interface PendingExecution {
  resolve: (result: OpenManusExecutionResult) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
}
interface PendingAgentTurn {
  request: IsolatedAgentTurnRequest;
  handlers: AgentTurnHostHandlers;
  resolve: (result: IsolatedAgentTurnResult) => void;
  reject: (error: Error) => void;
  onEvent?: (event: IsolatedAgentTurnEvent) => void;
  removeAbortListener: () => void;
}
interface PendingHostCall {
  turnRequestId: string;
  controller: AbortController;
}
type ProcessStatus = 'stopped' | 'starting' | 'ready' | 'restarting' | 'failed';

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 20_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_MAIN_LOOP_STALL_THRESHOLD_MS = 45_000;
const DEFAULT_RESTART_WINDOW_MS = 60_000;
const DEFAULT_MAX_RESTARTS_PER_WINDOW = 5;
const DEFAULT_RESTART_BASE_DELAY_MS = 250;

/**
 * Supervises the dedicated Electron utility process that will own agent
 * execution as the split-process migration progresses.
 *
 * The control plane keeps a content-free runtime ledger in the child. Explicit
 * execution requests use a separate typed lane and may carry task content plus
 * short-lived credentials required by that isolated workload.
 */
export class AgentHostProcessService extends DisposableService {
  private readonly logger: Logger;
  private readonly telemetry: AgentHostProcessTelemetrySink | undefined;
  private readonly fork: ForkAgentHost;
  private readonly workerPath: string;
  private readonly readyTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly mainLoopStallThresholdMs: number;
  private readonly restartWindowMs: number;
  private readonly maxRestartsPerWindow: number;
  private readonly restartBaseDelayMs: number;

  private child: UtilityProcessHandle | null = null;
  private launchId: string | null = null;
  private status: ProcessStatus = 'stopped';
  private hasEverBeenReady = false;
  private shuttingDown = false;
  private readyTimeout: ReturnType<typeof setTimeout> | null = null;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private restartTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastHeartbeatReceivedAt = 0;
  private lastStallNotificationAt = 0;
  private restartTimestamps: number[] = [];
  private recoveryStartedAt: number | null = null;
  private currentRecoveryAttempt = 0;
  private stateRevision = 0;
  private stateFingerprint = '';
  private runtimeStateSyncCount = 0;
  private lastSyncedRuntimeRevision: number | null = null;
  private latestSnapshot: AgentRuntimeSnapshot = {
    revision: 0,
    agents: [],
  };
  private removeStoreListener: (() => void) | null = null;
  private readonly stallListeners = new Set<MainLoopStallListener>();
  private readonly pendingExecutions = new Map<string, PendingExecution>();
  private readonly pendingAgentTurns = new Map<string, PendingAgentTurn>();
  private readonly pendingHostCalls = new Map<string, PendingHostCall>();
  private agentTurnHandlers: AgentTurnHostHandlers | null = null;
  private resolveInitialReady: (() => void) | null = null;
  private rejectInitialReady: ((error: Error) => void) | null = null;
  private resolveShutdown: (() => void) | null = null;

  private constructor(logger: Logger, options: AgentHostProcessOptions = {}) {
    super();
    this.logger = logger;
    this.telemetry = options.telemetry;
    this.fork =
      options.fork ??
      (utilityProcess.fork.bind(utilityProcess) as ForkAgentHost);
    this.workerPath = options.workerPath ?? AGENT_HOST_PATH;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.heartbeatTimeoutMs =
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.healthCheckIntervalMs =
      options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.mainLoopStallThresholdMs =
      options.mainLoopStallThresholdMs ?? DEFAULT_MAIN_LOOP_STALL_THRESHOLD_MS;
    this.restartWindowMs = options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
    this.maxRestartsPerWindow =
      options.maxRestartsPerWindow ?? DEFAULT_MAX_RESTARTS_PER_WINDOW;
    this.restartBaseDelayMs =
      options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS;
  }

  public static async create(
    logger: Logger,
    options: AgentHostProcessOptions = {},
  ): Promise<AgentHostProcessService> {
    const service = new AgentHostProcessService(logger, options);
    await service.start();
    return service;
  }

  public get processStatus(): ProcessStatus {
    return this.status;
  }

  public get pid(): number | undefined {
    return this.child?.pid;
  }

  public get canExecuteAgentWorkloads(): boolean {
    return this.status === 'ready' && this.child !== null;
  }

  public get canExecuteAgentTurns(): boolean {
    return this.canExecuteAgentWorkloads && this.agentTurnHandlers !== null;
  }

  public get syncedRuntimeRevision(): number | null {
    return this.lastSyncedRuntimeRevision;
  }

  public get runtimeSyncCount(): number {
    return this.runtimeStateSyncCount;
  }

  public setAgentTurnHandlers(handlers: AgentTurnHostHandlers | null): void {
    this.assertNotDisposed();
    this.agentTurnHandlers = handlers;
  }

  public onMainLoopStall(listener: MainLoopStallListener): () => void {
    this.stallListeners.add(listener);
    return () => {
      this.stallListeners.delete(listener);
    };
  }

  public bindAgentStore(store: AgentStore): void {
    this.assertNotDisposed();
    this.removeStoreListener?.();

    const publish = (state: AgentSystemState) => {
      const agents = createRuntimeSummaries(state);
      const fingerprint = JSON.stringify(agents);
      if (fingerprint === this.stateFingerprint) return;

      this.stateFingerprint = fingerprint;
      this.latestSnapshot = {
        revision: ++this.stateRevision,
        agents,
      };
      this.sendRuntimeSnapshot();
    };

    publish(store.get());
    this.removeStoreListener = store.subscribe((state) => publish(state));
  }

  public async executeOpenManus(
    request: OpenManusExecutionRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<OpenManusExecutionResult> {
    this.assertNotDisposed();
    if (!this.canExecuteAgentWorkloads || !this.launchId) {
      throw new Error('Agent utility process is not ready for execution');
    }
    if (options.signal?.aborted) throw createAbortError();

    const requestId = randomUUID();
    const launchId = this.launchId;
    return await new Promise<OpenManusExecutionResult>((resolve, reject) => {
      const handleAbort = () => {
        const pending = this.pendingExecutions.get(requestId);
        if (!pending) return;
        this.pendingExecutions.delete(requestId);
        pending.removeAbortListener();
        this.safeSend({
          type: 'cancel-execution',
          launchId,
          requestId,
        });
        reject(createAbortError());
      };
      const removeAbortListener = () => {
        options.signal?.removeEventListener('abort', handleAbort);
      };
      this.pendingExecutions.set(requestId, {
        resolve,
        reject,
        removeAbortListener,
      });
      options.signal?.addEventListener('abort', handleAbort, {
        once: true,
      });

      if (
        !this.safeSend({
          type: 'execute-openmanus',
          launchId,
          requestId,
          request,
        })
      ) {
        this.pendingExecutions.delete(requestId);
        removeAbortListener();
        reject(
          new Error('Failed to dispatch execution to agent utility process'),
        );
      }
    });
  }

  public async executeAgentTurn(
    request: IsolatedAgentTurnRequest,
    options: {
      signal?: AbortSignal;
      onEvent?: (event: IsolatedAgentTurnEvent) => void;
      handlers?: AgentTurnHostHandlers;
    } = {},
  ): Promise<IsolatedAgentTurnResult> {
    this.assertNotDisposed();
    const handlers = options.handlers ?? this.agentTurnHandlers;
    if (!this.canExecuteAgentWorkloads || !this.launchId || !handlers) {
      throw new Error(
        'Agent utility process is not ready for isolated agent turns',
      );
    }
    if (options.signal?.aborted) throw createAbortError();

    const requestId = randomUUID();
    const launchId = this.launchId;
    return await new Promise<IsolatedAgentTurnResult>((resolve, reject) => {
      const handleAbort = () => {
        const pending = this.pendingAgentTurns.get(requestId);
        if (!pending) return;
        this.pendingAgentTurns.delete(requestId);
        pending.removeAbortListener();
        this.abortHostCallsForTurn(requestId);
        this.safeSend({
          type: 'cancel-agent-turn',
          launchId,
          requestId,
        });
        reject(createAbortError());
      };
      const removeAbortListener = () => {
        options.signal?.removeEventListener('abort', handleAbort);
      };
      this.pendingAgentTurns.set(requestId, {
        request,
        handlers,
        resolve,
        reject,
        onEvent: options.onEvent,
        removeAbortListener,
      });
      options.signal?.addEventListener('abort', handleAbort, { once: true });

      if (
        !this.safeSend({
          type: 'execute-agent-turn',
          launchId,
          requestId,
          request,
        })
      ) {
        this.pendingAgentTurns.delete(requestId);
        removeAbortListener();
        reject(
          new Error(
            'Failed to dispatch isolated turn to agent utility process',
          ),
        );
      }
    });
  }

  private async start(): Promise<void> {
    this.assertNotDisposed();
    if (this.status === 'ready') return;
    if (this.status === 'starting') {
      throw new Error('Agent host process is already starting');
    }

    this.status = 'starting';
    const ready = new Promise<void>((resolve, reject) => {
      this.resolveInitialReady = resolve;
      this.rejectInitialReady = reject;
    });
    this.spawnProcess();
    await ready;
  }

  private spawnProcess(): void {
    const launchId = randomUUID();
    let child: UtilityProcessHandle;
    try {
      child = this.fork(this.workerPath, [], {
        execArgv: ['--max-old-space-size=256'],
        serviceName: 'clodex-agent-host',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {},
        allowLoadingUnsignedLibraries: false,
      });
    } catch (error) {
      this.handleSpawnFailure(
        new Error('Failed to fork agent host process', { cause: error }),
      );
      return;
    }

    this.child = child;
    this.launchId = launchId;
    this.lastHeartbeatReceivedAt = Date.now();

    child.on('spawn', () => {
      if (this.child !== child || this.launchId !== launchId) return;
      this.attachProcessLogs(child);
      this.safeSend({
        type: 'initialize',
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        launchId,
      });
    });
    child.on('message', (message) => {
      if (this.child !== child) return;
      this.handleMessage(message);
    });
    child.on('error', (type, location, report) => {
      this.logger.error(
        `[AgentHostProcess] Fatal utility-process error: ${type} at ${location}`,
        report,
      );
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.handleExit(code);
    });

    this.clearReadyTimeout();
    this.readyTimeout = setTimeout(() => {
      if (this.child !== child || this.status === 'ready') return;
      child.kill();
      this.failInitialStart(
        new Error(
          `Agent host did not become ready within ${this.readyTimeoutMs}ms`,
        ),
      );
    }, this.readyTimeoutMs);
    this.readyTimeout.unref?.();
  }

  private attachProcessLogs(child: UtilityProcessHandle): void {
    child.stdout?.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) this.logger.debug(`[AgentHostProcess:stdout] ${message}`);
    });
    child.stderr?.on('data', (chunk) => {
      const message = String(chunk).trim();
      if (message) this.logger.warn(`[AgentHostProcess:stderr] ${message}`);
    });
  }

  private handleMessage(value: unknown): void {
    if (!isAgentHostToMainMessage(value)) {
      this.logger.warn('[AgentHostProcess] Ignoring malformed worker message');
      return;
    }
    const message = value as AgentHostToMainMessage;
    if (
      message.type !== 'fatal' &&
      (!this.launchId || message.launchId !== this.launchId)
    ) {
      return;
    }

    switch (message.type) {
      case 'ready': {
        if (message.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION) {
          this.child?.kill();
          this.failInitialStart(
            new Error(
              `Agent host protocol mismatch: ${message.protocolVersion}`,
            ),
          );
          return;
        }
        this.clearReadyTimeout();
        const recoveredFromCrash =
          this.hasEverBeenReady && this.recoveryStartedAt !== null;
        this.status = 'ready';
        this.hasEverBeenReady = true;
        this.lastHeartbeatReceivedAt = Date.now();
        this.startHealthMonitor();
        this.sendRuntimeSnapshot();
        this.logger.info(
          `[AgentHostProcess] Ready (pid=${message.pid}, launch=${message.launchId})`,
        );
        if (recoveredFromCrash) {
          this.captureLifecycle({
            phase: 'restart-succeeded',
            restart_attempt: this.currentRecoveryAttempt,
            recovery_duration_ms: Math.max(
              0,
              Date.now() - this.recoveryStartedAt!,
            ),
          });
          this.recoveryStartedAt = null;
          this.currentRecoveryAttempt = 0;
        }
        this.resolveInitialReady?.();
        this.resolveInitialReady = null;
        this.rejectInitialReady = null;
        break;
      }
      case 'heartbeat':
        this.handleHeartbeat(message);
        break;
      case 'runtime-state-synced':
        this.runtimeStateSyncCount += 1;
        this.lastSyncedRuntimeRevision = message.revision;
        this.logger.debug(
          `[AgentHostProcess] Runtime state synced at revision ${message.revision}`,
        );
        break;
      case 'pong':
        this.lastHeartbeatReceivedAt = Date.now();
        break;
      case 'shutdown-complete':
        this.logger.debug(
          `[AgentHostProcess] Worker acknowledged shutdown request ${message.requestId}`,
        );
        break;
      case 'fatal':
        this.logger.error(
          `[AgentHostProcess] Worker fatal: ${message.message}`,
        );
        break;
      case 'execution-complete':
        this.resolveExecution(message.requestId, message.result);
        break;
      case 'execution-error': {
        const error = new Error(message.error.message);
        if (message.error.stack) error.stack = message.error.stack;
        this.rejectExecution(message.requestId, error);
        break;
      }
      case 'agent-turn-event':
        this.emitAgentTurnEvent(message.requestId, message.event);
        break;
      case 'agent-turn-complete':
        this.resolveAgentTurn(message.requestId, message.result);
        break;
      case 'agent-turn-error':
        this.rejectAgentTurn(
          message.requestId,
          deserializeError(message.error),
        );
        break;
      case 'agent-model-call-request':
        this.handleAgentModelCallRequest(
          message.turnRequestId,
          message.callId,
          message.request,
        );
        break;
      case 'agent-tool-call-request':
        this.handleAgentToolCallRequest(
          message.turnRequestId,
          message.callId,
          message.request,
        );
        break;
    }
  }

  private handleHeartbeat(
    message: Extract<AgentHostToMainMessage, { type: 'heartbeat' }>,
  ): void {
    const now = Date.now();
    this.lastHeartbeatReceivedAt = now;
    const stalledForMs = Math.max(0, now - message.sentAt);
    if (stalledForMs < this.mainLoopStallThresholdMs) return;
    if (now - this.lastStallNotificationAt < this.mainLoopStallThresholdMs) {
      return;
    }

    this.lastStallNotificationAt = now;
    this.logger.info(
      `[AgentHostProcess] Main event-loop stall observed by utility process. stalledForMs=${stalledForMs}`,
    );
    for (const listener of this.stallListeners) {
      try {
        listener({
          stalledForMs,
          heartbeatSequence: message.sequence,
        });
      } catch (error) {
        this.logger.warn(
          '[AgentHostProcess] Main-loop stall listener failed',
          error,
        );
      }
    }
  }

  private startHealthMonitor(): void {
    if (this.healthInterval) return;
    this.healthInterval = setInterval(() => {
      if (this.status !== 'ready' || !this.child) return;
      const silentForMs = Date.now() - this.lastHeartbeatReceivedAt;
      if (silentForMs <= this.heartbeatTimeoutMs) return;

      this.logger.warn(
        `[AgentHostProcess] Worker heartbeat timed out after ${silentForMs}ms; restarting`,
      );
      this.child.kill();
    }, this.healthCheckIntervalMs);
    this.healthInterval.unref?.();
  }

  private handleExit(code: number): void {
    const pendingExecutionCount = this.pendingExecutions.size;
    const pendingTurnCount = this.pendingAgentTurns.size;
    this.clearReadyTimeout();
    this.resolveShutdown?.();
    this.resolveShutdown = null;
    this.rejectPendingExecutions(
      new Error(
        `Agent utility process exited during execution (code ${code}); request was not replayed`,
      ),
    );
    this.rejectPendingAgentTurns(
      new Error(
        `Agent utility process exited during isolated turn (code ${code}); turn was not replayed`,
      ),
    );
    this.abortAllHostCalls();
    this.child = null;
    this.launchId = null;

    if (this.shuttingDown) {
      this.status = 'stopped';
      return;
    }

    if (!this.hasEverBeenReady) {
      this.failInitialStart(
        new Error(`Agent host exited before ready (code ${code})`),
      );
      return;
    }

    this.logger.warn(
      `[AgentHostProcess] Utility process exited unexpectedly (code ${code})`,
    );
    this.recoveryStartedAt ??= Date.now();
    this.captureLifecycle({
      phase: 'worker-crashed',
      restart_attempt: this.restartTimestamps.length,
      exit_code: code,
      pending_execution_count: pendingExecutionCount,
      pending_turn_count: pendingTurnCount,
    });
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    const now = Date.now();
    this.recoveryStartedAt ??= now;
    this.restartTimestamps = this.restartTimestamps.filter(
      (timestamp) => now - timestamp <= this.restartWindowMs,
    );
    if (this.restartTimestamps.length >= this.maxRestartsPerWindow) {
      this.status = 'failed';
      this.logger.error(
        `[AgentHostProcess] Restart budget exhausted (${this.maxRestartsPerWindow}/${this.restartWindowMs}ms)`,
      );
      this.captureLifecycle({
        phase: 'restart-budget-exhausted',
        restart_attempt: this.restartTimestamps.length,
        recovery_duration_ms: Math.max(
          0,
          now - (this.recoveryStartedAt ?? now),
        ),
      });
      return;
    }

    this.restartTimestamps.push(now);
    this.currentRecoveryAttempt = this.restartTimestamps.length;
    this.status = 'restarting';
    const delay = Math.min(
      5_000,
      this.restartBaseDelayMs *
        2 ** Math.max(0, this.restartTimestamps.length - 1),
    );
    this.captureLifecycle({
      phase: 'restart-scheduled',
      restart_attempt: this.currentRecoveryAttempt,
      delay_ms: delay,
    });
    this.restartTimeout = setTimeout(() => {
      this.restartTimeout = null;
      if (this.shuttingDown) return;
      this.status = 'starting';
      this.spawnProcess();
    }, delay);
    this.restartTimeout.unref?.();
  }

  private sendRuntimeSnapshot(): void {
    if (this.status !== 'ready' || !this.launchId) return;
    this.safeSend({
      type: 'sync-runtime-state',
      launchId: this.launchId,
      snapshot: this.latestSnapshot,
    });
  }

  private safeSend(message: MainToAgentHostMessage): boolean {
    if (!this.child) return false;
    try {
      this.child.postMessage(message);
      return true;
    } catch (error) {
      this.logger.warn('[AgentHostProcess] Failed to send IPC message', error);
      return false;
    }
  }

  private resolveExecution(
    requestId: string,
    result: OpenManusExecutionResult,
  ): void {
    const pending = this.pendingExecutions.get(requestId);
    if (!pending) return;
    this.pendingExecutions.delete(requestId);
    pending.removeAbortListener();
    pending.resolve(result);
  }

  private rejectExecution(requestId: string, error: Error): void {
    const pending = this.pendingExecutions.get(requestId);
    if (!pending) return;
    this.pendingExecutions.delete(requestId);
    pending.removeAbortListener();
    pending.reject(error);
  }

  private rejectPendingExecutions(error: Error): void {
    for (const [requestId, pending] of this.pendingExecutions) {
      this.pendingExecutions.delete(requestId);
      pending.removeAbortListener();
      pending.reject(error);
    }
  }

  private emitAgentTurnEvent(
    requestId: string,
    event: IsolatedAgentTurnEvent,
  ): void {
    const pending = this.pendingAgentTurns.get(requestId);
    if (!pending?.onEvent) return;
    try {
      pending.onEvent(event);
    } catch (error) {
      this.logger.warn(
        '[AgentHostProcess] Isolated turn event listener failed',
        error,
      );
    }
  }

  private resolveAgentTurn(
    requestId: string,
    result: IsolatedAgentTurnResult,
  ): void {
    const pending = this.pendingAgentTurns.get(requestId);
    if (!pending) return;
    this.pendingAgentTurns.delete(requestId);
    pending.removeAbortListener();
    this.abortHostCallsForTurn(requestId);
    pending.resolve(result);
  }

  private rejectAgentTurn(requestId: string, error: Error): void {
    const pending = this.pendingAgentTurns.get(requestId);
    if (!pending) return;
    this.pendingAgentTurns.delete(requestId);
    pending.removeAbortListener();
    this.abortHostCallsForTurn(requestId);
    pending.reject(error);
  }

  private rejectPendingAgentTurns(error: Error): void {
    for (const [requestId, pending] of this.pendingAgentTurns) {
      this.pendingAgentTurns.delete(requestId);
      pending.removeAbortListener();
      pending.reject(error);
    }
  }

  private handleAgentModelCallRequest(
    turnRequestId: string,
    callId: string,
    request: IsolatedAgentModelCallRequest,
  ): void {
    const turn = this.pendingAgentTurns.get(turnRequestId);
    if (!turn || !this.launchId) {
      this.sendAgentModelCallError(
        turnRequestId,
        callId,
        new Error('Isolated agent turn is no longer active'),
      );
      return;
    }
    if (!isAllowedModelCall(turn.request, request)) {
      this.sendAgentModelCallError(
        turnRequestId,
        callId,
        new Error('Worker requested model access outside the turn contract'),
      );
      return;
    }
    if (this.pendingHostCalls.has(callId)) {
      this.sendAgentModelCallError(
        turnRequestId,
        callId,
        new Error(`Duplicate host model call ${callId}`),
      );
      return;
    }

    const controller = new AbortController();
    this.pendingHostCalls.set(callId, {
      turnRequestId,
      controller,
    });
    void turn.handlers
      .callModel(request, {
        signal: controller.signal,
        onEvent: (event) => {
          if (!this.isHostCallActive(callId, turnRequestId)) return;
          this.safeSend({
            type: 'agent-model-call-event',
            launchId: this.launchId!,
            turnRequestId,
            callId,
            event,
          });
        },
      })
      .then((result) => {
        if (!this.isHostCallActive(callId, turnRequestId)) return;
        this.safeSend({
          type: 'agent-model-call-complete',
          launchId: this.launchId!,
          turnRequestId,
          callId,
          result,
        });
      })
      .catch((error) => {
        if (!this.isHostCallActive(callId, turnRequestId)) return;
        this.sendAgentModelCallError(
          turnRequestId,
          callId,
          normalizeError(error),
        );
      })
      .finally(() => {
        this.pendingHostCalls.delete(callId);
      });
  }

  private handleAgentToolCallRequest(
    turnRequestId: string,
    callId: string,
    request: IsolatedAgentToolCallRequest,
  ): void {
    const turn = this.pendingAgentTurns.get(turnRequestId);
    if (!turn || !this.launchId) {
      this.sendAgentToolCallError(
        turnRequestId,
        callId,
        new Error('Isolated agent turn is no longer active'),
      );
      return;
    }
    if (!isAllowedToolCall(turn.request, request)) {
      this.sendAgentToolCallError(
        turnRequestId,
        callId,
        new Error('Worker requested a tool outside the turn contract'),
      );
      return;
    }
    if (this.pendingHostCalls.has(callId)) {
      this.sendAgentToolCallError(
        turnRequestId,
        callId,
        new Error(`Duplicate host tool call ${callId}`),
      );
      return;
    }

    const controller = new AbortController();
    this.pendingHostCalls.set(callId, {
      turnRequestId,
      controller,
    });
    void turn.handlers
      .callTool(request, {
        signal: controller.signal,
      })
      .then((result) => {
        if (!this.isHostCallActive(callId, turnRequestId)) return;
        this.safeSend({
          type: 'agent-tool-call-complete',
          launchId: this.launchId!,
          turnRequestId,
          callId,
          result,
        });
      })
      .catch((error) => {
        if (!this.isHostCallActive(callId, turnRequestId)) return;
        this.sendAgentToolCallError(
          turnRequestId,
          callId,
          normalizeError(error),
        );
      })
      .finally(() => {
        this.pendingHostCalls.delete(callId);
      });
  }

  private sendAgentModelCallError(
    turnRequestId: string,
    callId: string,
    error: Error,
  ): void {
    if (!this.launchId) return;
    this.safeSend({
      type: 'agent-model-call-error',
      launchId: this.launchId,
      turnRequestId,
      callId,
      error: serializeError(error),
    });
  }

  private sendAgentToolCallError(
    turnRequestId: string,
    callId: string,
    error: Error,
  ): void {
    if (!this.launchId) return;
    this.safeSend({
      type: 'agent-tool-call-error',
      launchId: this.launchId,
      turnRequestId,
      callId,
      error: serializeError(error),
    });
  }

  private isHostCallActive(callId: string, turnRequestId: string): boolean {
    const pending = this.pendingHostCalls.get(callId);
    return (
      pending?.turnRequestId === turnRequestId &&
      this.pendingAgentTurns.has(turnRequestId) &&
      this.launchId !== null
    );
  }

  private abortHostCallsForTurn(turnRequestId: string): void {
    for (const [callId, pending] of this.pendingHostCalls) {
      if (pending.turnRequestId !== turnRequestId) continue;
      this.pendingHostCalls.delete(callId);
      pending.controller.abort();
    }
  }

  private abortAllHostCalls(): void {
    for (const [callId, pending] of this.pendingHostCalls) {
      this.pendingHostCalls.delete(callId);
      pending.controller.abort();
    }
  }

  private failInitialStart(error: Error): void {
    this.clearReadyTimeout();
    this.status = 'failed';
    this.rejectInitialReady?.(error);
    this.resolveInitialReady = null;
    this.rejectInitialReady = null;
  }

  private handleSpawnFailure(error: Error): void {
    if (!this.hasEverBeenReady) {
      this.failInitialStart(error);
      return;
    }

    this.child = null;
    this.launchId = null;
    this.logger.warn(
      '[AgentHostProcess] Failed to restart utility process',
      error,
    );
    this.captureLifecycle({
      phase: 'restart-spawn-failed',
      restart_attempt: this.currentRecoveryAttempt,
      recovery_duration_ms:
        this.recoveryStartedAt === null
          ? undefined
          : Math.max(0, Date.now() - this.recoveryStartedAt),
    });
    this.scheduleRestart();
  }

  private captureLifecycle(
    properties: AgentHostProcessTelemetryEvents['agent-host-process-lifecycle'],
  ): void {
    try {
      this.telemetry?.capture('agent-host-process-lifecycle', properties);
    } catch (error) {
      this.logger.debug(
        `[AgentHostProcess] Failed to capture lifecycle telemetry: ${normalizeError(error).message}`,
      );
    }
  }

  private clearReadyTimeout(): void {
    if (!this.readyTimeout) return;
    clearTimeout(this.readyTimeout);
    this.readyTimeout = null;
  }

  protected async onTeardown(): Promise<void> {
    this.shuttingDown = true;
    this.removeStoreListener?.();
    this.removeStoreListener = null;
    this.stallListeners.clear();
    this.clearReadyTimeout();
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }
    if (this.launchId) {
      for (const requestId of this.pendingExecutions.keys()) {
        this.safeSend({
          type: 'cancel-execution',
          launchId: this.launchId,
          requestId,
        });
      }
      for (const requestId of this.pendingAgentTurns.keys()) {
        this.safeSend({
          type: 'cancel-agent-turn',
          launchId: this.launchId,
          requestId,
        });
      }
    }
    this.rejectPendingExecutions(
      new Error('Agent utility process is shutting down'),
    );
    this.rejectPendingAgentTurns(
      new Error('Agent utility process is shutting down'),
    );
    this.abortAllHostCalls();

    const child = this.child;
    const launchId = this.launchId;
    if (!child || !launchId) {
      this.status = 'stopped';
      return;
    }

    const requestId = randomUUID();
    const shutdownComplete = new Promise<void>((resolve) => {
      this.resolveShutdown = resolve;
    });
    this.safeSend({
      type: 'shutdown',
      launchId,
      requestId,
      reason: 'app-shutdown',
    });

    await Promise.race([
      shutdownComplete,
      new Promise<void>((resolve) => setTimeout(resolve, 750)),
    ]);
    if (this.child === child) child.kill();
    this.child = null;
    this.launchId = null;
    this.status = 'stopped';
  }
}

function createAbortError(): Error {
  return new DOMException('Agent execution was aborted', 'AbortError');
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function serializeError(error: Error): { message: string; stack?: string } {
  return {
    message: error.message,
    stack: error.stack,
  };
}

function deserializeError(error: { message: string; stack?: string }): Error {
  const value = new Error(error.message);
  if (error.stack) value.stack = error.stack;
  return value;
}

function isAllowedModelCall(
  turn: IsolatedAgentTurnRequest,
  request: IsolatedAgentModelCallRequest,
): boolean {
  return (
    request.agentInstanceId === turn.agentInstanceId &&
    request.modelId === turn.modelId &&
    request.traceId === turn.traceId &&
    request.systemPrompt === turn.systemPrompt &&
    JSON.stringify(request.metadata) === JSON.stringify(turn.metadata) &&
    JSON.stringify(request.tools) === JSON.stringify(turn.tools) &&
    JSON.stringify(request.settings) === JSON.stringify(turn.settings)
  );
}

function isAllowedToolCall(
  turn: IsolatedAgentTurnRequest,
  request: IsolatedAgentToolCallRequest,
): boolean {
  return (
    request.agentInstanceId === turn.agentInstanceId &&
    turn.tools.some((tool) => tool.name === request.call.toolName)
  );
}

function createRuntimeSummaries(
  state: AgentSystemState,
): AgentRuntimeSummary[] {
  return Object.entries(state.agents.instances)
    .map(([id, instance]) => ({
      id,
      type: String(instance.type),
      parentAgentInstanceId: instance.parentAgentInstanceId,
      isWorking: instance.state.isWorking,
      historyLength: instance.state.history.length,
      queuedMessageCount: instance.state.queuedMessages.length,
      lastMessageId: instance.state.history.at(-1)?.id ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}
