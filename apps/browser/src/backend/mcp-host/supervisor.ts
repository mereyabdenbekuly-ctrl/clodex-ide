import {
  isMcpHostToMainMessage,
  MCP_HOST_PROTOCOL_VERSION,
  type McpConnectionState,
  type McpElicitationRequest,
  type McpElicitationResult,
  type McpHostToMainMessage,
  type McpOAuthHostRequest,
  type McpNetworkProxyConfig,
  type McpPromptDescriptor,
  type McpResourceDescriptor,
  type McpResourceTemplateDescriptor,
  type McpToolDescriptor,
  type ResolvedMcpTransport,
} from '@clodex/mcp-runtime';
import { utilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DisposableService } from '../services/disposable';
import type { Logger } from '../services/logger';

const MCP_HOST_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'mcp-host.cjs',
);

interface UtilityProcessHandle {
  pid: number | undefined;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: 'spawn', handler: () => void): this;
  on(event: 'message', handler: (message: unknown) => void): this;
  on(event: 'exit', handler: (code: number) => void): this;
  on(
    event: 'error',
    handler: (type: string, location: string, report: string) => void,
  ): this;
}

type ForkMcpHost = (
  modulePath: string,
  args: string[],
  options: Electron.ForkOptions,
) => UtilityProcessHandle;

type PendingRequest = {
  resolve: (message: McpHostToMainMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type DesiredServer = {
  transport: ResolvedMcpTransport;
  secretValues: string[];
  networkProxy?: McpNetworkProxyConfig;
};

export interface McpHostSupervisorOptions {
  fork?: ForkMcpHost;
  workerPath?: string;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  restartBaseDelayMs?: number;
  maxRestartsPerWindow?: number;
  restartWindowMs?: number;
  resolveNetworkProxy?: (
    serverId: string,
    transport: ResolvedMcpTransport,
  ) => McpNetworkProxyConfig | undefined;
  revokeNetworkProxy?: (serverId: string, proxy: McpNetworkProxyConfig) => void;
  onConnectionState?: (
    serverId: string,
    state: McpConnectionState,
    error?: Error,
  ) => void;
  onServerLog?: (
    serverId: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
  ) => void;
  onHostRestart?: (restartCount: number, error: Error) => void;
  onOAuthRequest?: (
    serverId: string,
    request: McpOAuthHostRequest,
  ) => Promise<unknown>;
  onElicitationRequest?: (
    serverId: string,
    agentInstanceId: string,
    request: McpElicitationRequest,
    signal: AbortSignal,
  ) => Promise<McpElicitationResult>;
  onListChanged?: (
    serverId: string,
    kind: 'tools' | 'resources' | 'prompts',
    items:
      | McpToolDescriptor[]
      | McpResourceDescriptor[]
      | McpPromptDescriptor[],
  ) => void;
}

type ProcessStatus = 'stopped' | 'starting' | 'ready' | 'restarting' | 'failed';

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 20_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_RESTART_BASE_DELAY_MS = 250;
const DEFAULT_MAX_RESTARTS_PER_WINDOW = 5;
const DEFAULT_RESTART_WINDOW_MS = 60_000;
const MCP_HOST_ENV_ALLOWLIST = [
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'PATHEXT',
  'SHELL',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'WINDIR',
] as const;

export class McpHostSupervisor extends DisposableService {
  private readonly fork: ForkMcpHost;
  private readonly workerPath: string;
  private readonly readyTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly restartBaseDelayMs: number;
  private readonly maxRestartsPerWindow: number;
  private readonly restartWindowMs: number;
  private readonly onConnectionState:
    | McpHostSupervisorOptions['onConnectionState']
    | undefined;
  private readonly onServerLog:
    | McpHostSupervisorOptions['onServerLog']
    | undefined;
  private readonly onHostRestart:
    | McpHostSupervisorOptions['onHostRestart']
    | undefined;
  private readonly onOAuthRequest:
    | McpHostSupervisorOptions['onOAuthRequest']
    | undefined;
  private readonly onElicitationRequest:
    | McpHostSupervisorOptions['onElicitationRequest']
    | undefined;
  private readonly onListChanged:
    | McpHostSupervisorOptions['onListChanged']
    | undefined;
  private readonly resolveNetworkProxy:
    | McpHostSupervisorOptions['resolveNetworkProxy']
    | undefined;
  private readonly revokeNetworkProxy:
    | McpHostSupervisorOptions['revokeNetworkProxy']
    | undefined;

  private child: UtilityProcessHandle | null = null;
  private launchId: string | null = null;
  private status: ProcessStatus = 'stopped';
  private shuttingDown = false;
  private lastHeartbeatReceivedAt = 0;
  private readyTimeout: ReturnType<typeof setTimeout> | null = null;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private restartTimeout: ReturnType<typeof setTimeout> | null = null;
  private restartTimestamps: number[] = [];
  private pendingRequests = new Map<string, PendingRequest>();
  private pendingElicitationRequests = new Map<string, AbortController>();
  private desiredServers = new Map<string, DesiredServer>();
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;

  private constructor(
    private readonly logger: Logger,
    options: McpHostSupervisorOptions = {},
  ) {
    super();
    this.fork =
      options.fork ?? (utilityProcess.fork.bind(utilityProcess) as ForkMcpHost);
    this.workerPath = options.workerPath ?? MCP_HOST_PATH;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.heartbeatTimeoutMs =
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.healthCheckIntervalMs =
      options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.restartBaseDelayMs =
      options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS;
    this.maxRestartsPerWindow =
      options.maxRestartsPerWindow ?? DEFAULT_MAX_RESTARTS_PER_WINDOW;
    this.restartWindowMs = options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
    this.onConnectionState = options.onConnectionState;
    this.onServerLog = options.onServerLog;
    this.onHostRestart = options.onHostRestart;
    this.onOAuthRequest = options.onOAuthRequest;
    this.onElicitationRequest = options.onElicitationRequest;
    this.onListChanged = options.onListChanged;
    this.resolveNetworkProxy = options.resolveNetworkProxy;
    this.revokeNetworkProxy = options.revokeNetworkProxy;
  }

  public static async create(
    logger: Logger,
    options: McpHostSupervisorOptions = {},
  ): Promise<McpHostSupervisor> {
    const supervisor = new McpHostSupervisor(logger, options);
    await supervisor.start();
    return supervisor;
  }

  public get processStatus(): ProcessStatus {
    return this.status;
  }

  public get pid(): number | undefined {
    return this.child?.pid;
  }

  public async connectServer(
    serverId: string,
    transport: ResolvedMcpTransport,
    secretValues: string[] = [],
  ): Promise<'connected' | 'authorization-required'> {
    this.assertNotDisposed();
    await this.ensureReady();
    const previousProxy = this.desiredServers.get(serverId)?.networkProxy;
    if (previousProxy) this.revokeNetworkProxy?.(serverId, previousProxy);
    const networkProxy = this.resolveNetworkProxy?.(serverId, transport);
    this.desiredServers.set(serverId, {
      transport: structuredClone(transport),
      secretValues: [...secretValues],
      networkProxy: networkProxy ? structuredClone(networkProxy) : undefined,
    });
    const response = await this.request(
      {
        type: 'connect-server',
        serverId,
        transport,
        secretValues,
        networkProxy,
      },
      this.requestTimeoutMs,
    );
    if (
      response.type !== 'connection-state' ||
      response.serverId !== serverId ||
      (response.state !== 'connected' &&
        response.state !== 'authorization-required')
    ) {
      throw response.type === 'connection-state' && response.error
        ? toError(response.error)
        : new Error(`MCP host failed to connect server "${serverId}"`);
    }
    return response.state;
  }

  public async disconnectServer(serverId: string): Promise<void> {
    this.assertNotDisposed();
    const desired = this.desiredServers.get(serverId);
    this.desiredServers.delete(serverId);
    if (desired?.networkProxy) {
      this.revokeNetworkProxy?.(serverId, desired.networkProxy);
    }
    if (this.status !== 'ready') return;
    const response = await this.request({
      type: 'disconnect-server',
      serverId,
    });
    if (
      response.type !== 'connection-state' ||
      response.serverId !== serverId ||
      response.state !== 'disconnected'
    ) {
      throw new Error(`MCP host failed to disconnect server "${serverId}"`);
    }
  }

  public async listTools(serverId: string): Promise<McpToolDescriptor[]> {
    this.assertNotDisposed();
    await this.ensureReady();
    const response = await this.request({
      type: 'list-tools',
      serverId,
    });
    if (response.type !== 'tools-result' || response.serverId !== serverId) {
      throw new Error(
        `MCP host returned an invalid tools result for "${serverId}"`,
      );
    }
    return response.tools;
  }

  public async listResources(
    serverId: string,
    cursor?: string,
  ): Promise<{
    resources: McpResourceDescriptor[];
    nextCursor?: string;
  }> {
    this.assertNotDisposed();
    await this.ensureReady();
    const response = await this.request({
      type: 'list-resources',
      serverId,
      cursor,
    });
    if (
      response.type !== 'resources-result' ||
      response.serverId !== serverId
    ) {
      throw new Error(
        `MCP host returned an invalid resources result for "${serverId}"`,
      );
    }
    return {
      resources: response.resources,
      nextCursor: response.nextCursor,
    };
  }

  public async listResourceTemplates(
    serverId: string,
    cursor?: string,
  ): Promise<{
    resourceTemplates: McpResourceTemplateDescriptor[];
    nextCursor?: string;
  }> {
    this.assertNotDisposed();
    await this.ensureReady();
    const response = await this.request({
      type: 'list-resource-templates',
      serverId,
      cursor,
    });
    if (
      response.type !== 'resource-templates-result' ||
      response.serverId !== serverId
    ) {
      throw new Error(
        `MCP host returned an invalid resource templates result for "${serverId}"`,
      );
    }
    return {
      resourceTemplates: response.resourceTemplates,
      nextCursor: response.nextCursor,
    };
  }

  public async readResource(
    serverId: string,
    uri: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    this.assertNotDisposed();
    await this.ensureReady();
    const timeoutMs = options.timeoutMs ?? 60_000;
    const response = await this.request(
      {
        type: 'read-resource',
        serverId,
        uri,
        timeoutMs,
      },
      timeoutMs + 2_000,
      options.signal,
    );
    if (
      response.type !== 'resource-read-result' ||
      response.serverId !== serverId ||
      response.uri !== uri
    ) {
      throw new Error(
        `MCP host returned an invalid resource result for "${serverId}"`,
      );
    }
    return response.result;
  }

  public async listPrompts(
    serverId: string,
    cursor?: string,
  ): Promise<{ prompts: McpPromptDescriptor[]; nextCursor?: string }> {
    this.assertNotDisposed();
    await this.ensureReady();
    const response = await this.request({
      type: 'list-prompts',
      serverId,
      cursor,
    });
    if (response.type !== 'prompts-result' || response.serverId !== serverId) {
      throw new Error(
        `MCP host returned an invalid prompts result for "${serverId}"`,
      );
    }
    return {
      prompts: response.prompts,
      nextCursor: response.nextCursor,
    };
  }

  public async getPrompt(
    serverId: string,
    promptName: string,
    args: Record<string, string>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    this.assertNotDisposed();
    await this.ensureReady();
    const timeoutMs = options.timeoutMs ?? 60_000;
    const response = await this.request(
      {
        type: 'get-prompt',
        serverId,
        promptName,
        arguments: args,
        timeoutMs,
      },
      timeoutMs + 2_000,
      options.signal,
    );
    if (
      response.type !== 'prompt-result' ||
      response.serverId !== serverId ||
      response.promptName !== promptName
    ) {
      throw new Error(
        `MCP host returned an invalid prompt result for "${serverId}/${promptName}"`,
      );
    }
    return response.result;
  }

  public async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      agentInstanceId?: string;
    } = {},
  ): Promise<unknown> {
    this.assertNotDisposed();
    await this.ensureReady();
    const timeoutMs = options.timeoutMs ?? 60_000;
    const response = await this.request(
      {
        type: 'call-tool',
        serverId,
        toolName,
        arguments: args,
        agentInstanceId: options.agentInstanceId,
        timeoutMs,
      },
      timeoutMs + 2_000,
      options.signal,
    );
    if (
      response.type !== 'tool-call-result' ||
      response.serverId !== serverId ||
      response.toolName !== toolName
    ) {
      throw new Error(
        `MCP host returned an invalid tool result for "${serverId}/${toolName}"`,
      );
    }
    return response.result;
  }

  public async finishOAuth(
    serverId: string,
    authorizationCode: string,
  ): Promise<void> {
    this.assertNotDisposed();
    await this.ensureReady();
    if (!this.desiredServers.has(serverId)) {
      throw new Error(`MCP server "${serverId}" is not awaiting OAuth`);
    }
    const response = await this.request({
      type: 'finish-oauth',
      serverId,
      authorizationCode,
    });
    if (
      response.type !== 'oauth-finish-result' ||
      response.serverId !== serverId
    ) {
      throw new Error(
        `MCP host returned an invalid OAuth result for "${serverId}"`,
      );
    }
  }

  private async start(): Promise<void> {
    if (
      this.shuttingDown ||
      this.status === 'ready' ||
      this.status === 'starting'
    ) {
      return await this.ensureReady();
    }
    this.status = 'starting';
    this.launchId = randomUUID();
    const launchId = this.launchId;

    await new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      const child = this.fork(this.workerPath, [], {
        serviceName: 'Clodex MCP Host',
        stdio: 'pipe',
        env: createMcpHostEnvironment(),
      });
      this.child = child;
      child.stdout?.on('data', (chunk) => {
        this.logger.debug('[McpHost] stdout', {
          message: capText(Buffer.from(chunk).toString('utf-8')),
        });
      });
      child.stderr?.on('data', (chunk) => {
        this.logger.warn('[McpHost] stderr', {
          message: capText(Buffer.from(chunk).toString('utf-8')),
        });
      });
      child.on('message', (message) => this.handleMessage(message));
      child.on('exit', (code) => this.handleExit(child, code));
      child.on('error', (type, location, report) => {
        this.logger.error('[McpHost] utility process error', {
          type,
          location,
          report: capText(report),
        });
      });
      child.on('spawn', () => {
        if (this.child !== child || this.launchId !== launchId) return;
        child.postMessage({
          type: 'initialize',
          protocolVersion: MCP_HOST_PROTOCOL_VERSION,
          launchId,
        });
      });
      this.readyTimeout = setTimeout(() => {
        if (this.launchId !== launchId || this.status === 'ready') return;
        const error = new Error('MCP host did not become ready in time');
        this.rejectInitialReady(error);
        this.failChild(error);
      }, this.readyTimeoutMs);
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.status === 'ready' && this.child && this.launchId) return;
    if (this.status === 'starting' || this.status === 'restarting') {
      return await new Promise<void>((resolve, reject) => {
        const poll = setInterval(() => {
          if (this.status === 'ready') {
            clearInterval(poll);
            resolve();
          } else if (this.status === 'failed' || this.shuttingDown) {
            clearInterval(poll);
            reject(new Error('MCP host is unavailable'));
          }
        }, 25);
        setTimeout(() => {
          clearInterval(poll);
          reject(new Error('Timed out waiting for MCP host readiness'));
        }, this.readyTimeoutMs + 1_000);
      });
    }
    await this.start();
  }

  private request(
    payload:
      | {
          type: 'connect-server';
          serverId: string;
          transport: ResolvedMcpTransport;
          secretValues: string[];
          networkProxy?: McpNetworkProxyConfig;
        }
      | { type: 'disconnect-server'; serverId: string }
      | { type: 'list-tools'; serverId: string }
      | { type: 'list-resources'; serverId: string; cursor?: string }
      | {
          type: 'list-resource-templates';
          serverId: string;
          cursor?: string;
        }
      | {
          type: 'read-resource';
          serverId: string;
          uri: string;
          timeoutMs: number;
        }
      | { type: 'list-prompts'; serverId: string; cursor?: string }
      | {
          type: 'get-prompt';
          serverId: string;
          promptName: string;
          arguments: Record<string, string>;
          timeoutMs: number;
        }
      | {
          type: 'call-tool';
          serverId: string;
          toolName: string;
          arguments: Record<string, unknown>;
          agentInstanceId?: string;
          timeoutMs: number;
        }
      | {
          type: 'finish-oauth';
          serverId: string;
          authorizationCode: string;
        },
    timeoutMs = this.requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<McpHostToMainMessage> {
    if (!this.child || !this.launchId || this.status !== 'ready') {
      return Promise.reject(new Error('MCP host is not ready'));
    }
    if (signal?.aborted) return Promise.reject(createAbortError());

    const requestId = randomUUID();
    const launchId = this.launchId;
    return new Promise<McpHostToMainMessage>((resolve, reject) => {
      const cleanup = () => {
        const pending = this.pendingRequests.get(requestId);
        if (pending) clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestId);
        signal?.removeEventListener('abort', handleAbort);
      };
      const handleAbort = () => {
        cleanup();
        this.safeSend({
          type: 'cancel-request',
          launchId,
          requestId,
        });
        reject(createAbortError());
      };
      const timeout = setTimeout(() => {
        cleanup();
        this.safeSend({
          type: 'cancel-request',
          launchId,
          requestId,
        });
        reject(new Error(`MCP host request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingRequests.set(requestId, {
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timeout,
      });
      signal?.addEventListener('abort', handleAbort, { once: true });
      if (
        !this.safeSend({
          ...payload,
          launchId,
          requestId,
        })
      ) {
        cleanup();
        reject(new Error('Failed to dispatch MCP host request'));
      }
    });
  }

  private handleMessage(raw: unknown): void {
    if (!isMcpHostToMainMessage(raw)) {
      this.failChild(new Error('MCP host emitted an invalid message'));
      return;
    }
    if (raw.launchId !== this.launchId) return;

    switch (raw.type) {
      case 'ready':
        if (raw.protocolVersion !== MCP_HOST_PROTOCOL_VERSION) {
          this.failChild(new Error('MCP host protocol version mismatch'));
          return;
        }
        this.status = 'ready';
        this.lastHeartbeatReceivedAt = Date.now();
        this.clearReadyTimeout();
        this.startHealthChecks();
        this.resolveReady?.();
        this.resolveReady = null;
        this.rejectReady = null;
        void this.restoreDesiredServers();
        break;
      case 'heartbeat':
        this.lastHeartbeatReceivedAt = Date.now();
        break;
      case 'connection-state': {
        const error = raw.error ? toError(raw.error) : undefined;
        this.onConnectionState?.(raw.serverId, raw.state, error);
        if (
          raw.requestId &&
          (raw.state === 'connected' ||
            raw.state === 'authorization-required' ||
            raw.state === 'failed' ||
            raw.state === 'disconnected')
        ) {
          const pending = this.pendingRequests.get(raw.requestId);
          if (raw.state === 'failed') {
            pending?.reject(error ?? new Error('MCP server connection failed'));
          } else {
            pending?.resolve(raw);
          }
        }
        break;
      }
      case 'tools-result':
      case 'resources-result':
      case 'resource-templates-result':
      case 'resource-read-result':
      case 'prompts-result':
      case 'prompt-result':
      case 'tool-call-result':
      case 'oauth-finish-result':
      case 'pong':
      case 'shutdown-complete':
        this.pendingRequests.get(raw.requestId)?.resolve(raw);
        break;
      case 'request-error':
        this.pendingRequests.get(raw.requestId)?.reject(toError(raw.error));
        break;
      case 'server-log':
        this.onServerLog?.(raw.serverId, raw.level, raw.message);
        break;
      case 'oauth-rpc-request':
        void this.handleOAuthRequest(raw);
        break;
      case 'elicitation-rpc-request':
        void this.handleElicitationRequest(raw);
        break;
      case 'elicitation-rpc-cancel':
        this.pendingElicitationRequests.get(raw.elicitationRequestId)?.abort();
        this.pendingElicitationRequests.delete(raw.elicitationRequestId);
        break;
      case 'list-changed': {
        const items =
          raw.kind === 'tools'
            ? raw.tools!
            : raw.kind === 'resources'
              ? raw.resources!
              : raw.prompts!;
        this.onListChanged?.(raw.serverId, raw.kind, items);
        break;
      }
      case 'fatal':
        this.failChild(toError(raw.error));
        break;
    }
  }

  private async handleOAuthRequest(
    message: Extract<McpHostToMainMessage, { type: 'oauth-rpc-request' }>,
  ): Promise<void> {
    if (!this.child || !this.launchId || message.launchId !== this.launchId) {
      return;
    }
    if (!this.onOAuthRequest) {
      this.safeSend({
        type: 'oauth-rpc-result',
        launchId: this.launchId,
        authRequestId: message.authRequestId,
        ok: false,
        error: 'MCP OAuth is not configured in the main process',
      });
      return;
    }
    try {
      const value = await this.onOAuthRequest(
        message.serverId,
        message.request,
      );
      this.safeSend({
        type: 'oauth-rpc-result',
        launchId: this.launchId,
        authRequestId: message.authRequestId,
        ok: true,
        value,
      });
    } catch (error) {
      this.safeSend({
        type: 'oauth-rpc-result',
        launchId: this.launchId,
        authRequestId: message.authRequestId,
        ok: false,
        error: capText(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  private async handleElicitationRequest(
    message: Extract<McpHostToMainMessage, { type: 'elicitation-rpc-request' }>,
  ): Promise<void> {
    if (!this.child || !this.launchId || message.launchId !== this.launchId) {
      return;
    }
    const controller = new AbortController();
    this.pendingElicitationRequests.set(
      message.elicitationRequestId,
      controller,
    );
    try {
      const result = this.onElicitationRequest
        ? await this.onElicitationRequest(
            message.serverId,
            message.agentInstanceId,
            message.request,
            controller.signal,
          )
        : ({ action: 'cancel' } as const);
      if (
        controller.signal.aborted ||
        !this.child ||
        message.launchId !== this.launchId
      ) {
        return;
      }
      this.safeSend({
        type: 'elicitation-rpc-result',
        launchId: this.launchId,
        elicitationRequestId: message.elicitationRequestId,
        ok: true,
        result,
      });
    } catch (error) {
      if (
        controller.signal.aborted ||
        !this.child ||
        message.launchId !== this.launchId
      ) {
        return;
      }
      this.safeSend({
        type: 'elicitation-rpc-result',
        launchId: this.launchId,
        elicitationRequestId: message.elicitationRequestId,
        ok: false,
        error: capText(error instanceof Error ? error.message : String(error)),
      });
    } finally {
      this.pendingElicitationRequests.delete(message.elicitationRequestId);
    }
  }

  private handleExit(child: UtilityProcessHandle, code: number): void {
    if (this.child !== child) return;
    this.child = null;
    this.launchId = null;
    this.stopHealthChecks();
    this.clearReadyTimeout();
    const error = new Error(`MCP host exited with code ${code}`);
    this.rejectInitialReady(error);
    this.rejectPending(error);
    if (this.shuttingDown) {
      this.status = 'stopped';
      return;
    }
    this.scheduleRestart(error);
  }

  private failChild(error: Error): void {
    this.logger.error('[McpHost] Host failure', { error });
    this.rejectInitialReady(error);
    this.rejectPending(error);
    const child = this.child;
    this.child = null;
    this.launchId = null;
    this.stopHealthChecks();
    this.clearReadyTimeout();
    child?.kill();
    if (!this.shuttingDown) this.scheduleRestart(error);
  }

  private scheduleRestart(error: Error): void {
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter(
      (timestamp) => now - timestamp < this.restartWindowMs,
    );
    if (this.restartTimestamps.length >= this.maxRestartsPerWindow) {
      this.status = 'failed';
      this.logger.error('[McpHost] Restart circuit breaker opened', { error });
      return;
    }
    this.restartTimestamps.push(now);
    this.onHostRestart?.(this.restartTimestamps.length, error);
    this.status = 'restarting';
    const delay =
      this.restartBaseDelayMs *
      2 ** Math.max(0, this.restartTimestamps.length - 1);
    this.restartTimeout = setTimeout(() => {
      this.restartTimeout = null;
      this.status = 'stopped';
      void this.start().catch((restartError) => {
        this.logger.error('[McpHost] Restart failed', { error: restartError });
      });
    }, delay);
  }

  private async restoreDesiredServers(): Promise<void> {
    for (const [serverId, desired] of this.desiredServers) {
      try {
        await this.connectServer(
          serverId,
          desired.transport,
          desired.secretValues,
        );
      } catch (error) {
        this.logger.warn(`[McpHost] Failed to restore server ${serverId}`, {
          error,
        });
      }
    }
  }

  private startHealthChecks(): void {
    if (this.healthInterval) return;
    this.healthInterval = setInterval(() => {
      if (
        this.status === 'ready' &&
        Date.now() - this.lastHeartbeatReceivedAt > this.heartbeatTimeoutMs
      ) {
        this.failChild(new Error('MCP host heartbeat timed out'));
      }
    }, this.healthCheckIntervalMs);
    this.healthInterval.unref?.();
  }

  private stopHealthChecks(): void {
    if (!this.healthInterval) return;
    clearInterval(this.healthInterval);
    this.healthInterval = null;
  }

  private clearReadyTimeout(): void {
    if (!this.readyTimeout) return;
    clearTimeout(this.readyTimeout);
    this.readyTimeout = null;
  }

  private rejectInitialReady(error: Error): void {
    this.rejectReady?.(error);
    this.resolveReady = null;
    this.rejectReady = null;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const controller of this.pendingElicitationRequests.values()) {
      controller.abort(error);
    }
    this.pendingElicitationRequests.clear();
  }

  private safeSend(message: unknown): boolean {
    try {
      if (!this.child) return false;
      this.child.postMessage(message);
      return true;
    } catch (error) {
      this.logger.error('[McpHost] Failed to send message', { error });
      return false;
    }
  }

  protected async onTeardown(): Promise<void> {
    this.shuttingDown = true;
    for (const [serverId, desired] of this.desiredServers) {
      if (desired.networkProxy) {
        this.revokeNetworkProxy?.(serverId, desired.networkProxy);
      }
    }
    this.desiredServers.clear();
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }
    this.stopHealthChecks();
    this.clearReadyTimeout();
    this.rejectPending(new Error('MCP host is shutting down'));
    const child = this.child;
    const launchId = this.launchId;
    this.child = null;
    this.launchId = null;
    if (child && launchId) {
      try {
        child.postMessage({
          type: 'shutdown',
          launchId,
          requestId: randomUUID(),
          reason: 'Clodex shutdown',
        });
      } catch {
        // Continue to the forced kill.
      }
      setTimeout(() => child.kill(), 1_000).unref?.();
    }
    this.status = 'stopped';
  }
}

function toError(serialized: {
  message: string;
  stack?: string;
  code?: string | number;
}): Error {
  const error = new Error(serialized.message);
  if (serialized.stack) error.stack = serialized.stack;
  if (serialized.code !== undefined) {
    (error as Error & { code?: string | number }).code = serialized.code;
  }
  return error;
}

function createMcpHostEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of MCP_HOST_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function capText(value: string, maxLength = 16_384): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…[truncated]`;
}

function createAbortError(): Error {
  const error = new Error('MCP request was aborted');
  error.name = 'AbortError';
  return error;
}
