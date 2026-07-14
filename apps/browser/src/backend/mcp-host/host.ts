import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  ElicitRequestSchema,
  type ElicitRequestFormParams,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import {
  isMainToMcpHostMessage,
  collectMcpCatalogPages,
  mcpElicitationRequestSchema,
  MCP_HOST_HEARTBEAT_INTERVAL_MS,
  MCP_HOST_PROTOCOL_VERSION,
  type MainToMcpHostMessage,
  type McpElicitationRequest,
  type McpElicitationResult,
  type McpOAuthHostRequest,
  type McpHostSerializedError,
  type McpNetworkProxyConfig,
  type McpHostToMainMessage,
  type McpPromptDescriptor,
  type McpResourceDescriptor,
  type McpResourceTemplateDescriptor,
  type McpToolDescriptor,
  type ResolvedMcpTransport,
  type ResolvedMcpOAuthConfig,
  type ExecutableRuntimePolicy,
} from '@clodex/mcp-runtime';
import { assertBoundedMcpContextResult } from './context-limits';
import { createOAuthOriginBoundFetch, createOriginBoundFetch } from './network';
import { createNetworkProxyFetch } from './proxy-fetch';
import {
  prepareSandboxedRuntimeCommand,
  startRuntimeMemoryMonitor,
  type RuntimeMemoryMonitor,
} from './runtime-sandbox';
import {
  deleteExactMcpConnection,
  isExactMcpConnection,
  requireExactMcpConnection,
  StaleMcpConnectionError,
} from './connection-identity';

interface ParentPort {
  postMessage(message: McpHostToMainMessage): void;
  on(
    event: 'message',
    handler: (event: { data: unknown; ports: unknown[] }) => void,
  ): void;
}

interface Connection {
  connectionId: string;
  client: Client;
  transport: Transport;
  secretValues: string[];
  runtimePolicy: ExecutableRuntimePolicy | null;
  resourceMonitor: RuntimeMemoryMonitor | null;
}

type OAuthCapableTransport = StreamableHTTPClientTransport | SSEClientTransport;

interface PendingOAuthConnection {
  config: Exclude<ResolvedMcpTransport, { type: 'stdio' }>;
  secretValues: string[];
  networkProxy?: McpNetworkProxyConfig;
}

type PendingOAuthRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PendingElicitationRpc = {
  serverId: string;
  toolRequestIds: Set<string>;
  resolve: (value: McpElicitationResult) => void;
  reject: (error: Error) => void;
  abortHandler: () => void;
  signal: AbortSignal;
  timeout: ReturnType<typeof setTimeout>;
};

class OAuthAuthorizationRequiredSignal extends Error {
  public constructor() {
    super('MCP OAuth authorization is required');
    this.name = 'OAuthAuthorizationRequiredSignal';
  }
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort })
  .parentPort;

if (!parentPort) {
  throw new Error(
    'MCP host requires process.parentPort and must be launched with utilityProcess.fork()',
  );
}

const CONNECT_TIMEOUT_MS = 10_000;
const LIST_TOOLS_TIMEOUT_MS = 10_000;
const LIST_CONTEXT_TIMEOUT_MS = 10_000;
const MAX_STDERR_BUFFER = 16_384;
const startedAt = Date.now();
const connections = new Map<string, Connection>();
const pendingOAuthConnections = new Map<string, PendingOAuthConnection>();
const pendingOAuthRequests = new Map<string, PendingOAuthRpc>();
const pendingElicitationRequests = new Map<string, PendingElicitationRpc>();
const oauthSecretValues = new Map<string, Set<string>>();
const activeRequests = new Map<string, AbortController>();
const activeToolInvocations = new Map<string, Map<string, string>>();
let launchId: string | null = null;
let shuttingDown = false;
let heartbeatSequence = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function send(message: McpHostToMainMessage): void {
  parentPort.postMessage(message);
}

function sendFatal(error: unknown): void {
  try {
    send({
      type: 'fatal',
      launchId,
      error: serializeError(error, collectAllSecretValues()),
    });
  } catch {
    // The parent process may already be unavailable.
  }
}

function terminateAfterFatal(error: unknown): void {
  sendFatal(error);
  setImmediate(() => process.exit(1));
}

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (!launchId || shuttingDown) return;
    send({
      type: 'heartbeat',
      launchId,
      sequence: heartbeatSequence++,
      sentAt: Date.now(),
      connectedServerCount: connections.size,
      activeRequestCount: activeRequests.size,
    });
  }, MCP_HOST_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

function handleInitialize(
  message: Extract<MainToMcpHostMessage, { type: 'initialize' }>,
): void {
  if (message.protocolVersion !== MCP_HOST_PROTOCOL_VERSION) {
    terminateAfterFatal(
      new Error(
        `Unsupported MCP host protocol ${message.protocolVersion}; expected ${MCP_HOST_PROTOCOL_VERSION}`,
      ),
    );
    return;
  }
  if (launchId && launchId !== message.launchId) {
    terminateAfterFatal(
      new Error('MCP host received a second launch identity'),
    );
    return;
  }

  launchId = message.launchId;
  startHeartbeat();
  send({
    type: 'ready',
    protocolVersion: MCP_HOST_PROTOCOL_VERSION,
    launchId,
    pid: process.pid,
    startedAt,
  });
}

function handleMessage(message: MainToMcpHostMessage): void {
  if (message.type === 'oauth-rpc-result') {
    handleOAuthRpcResult(message);
    return;
  }
  if (message.type === 'elicitation-rpc-result') {
    handleElicitationRpcResult(message);
    return;
  }
  if (message.type === 'initialize') {
    handleInitialize(message);
    return;
  }
  if (!launchId || message.launchId !== launchId || shuttingDown) return;

  switch (message.type) {
    case 'connect-server':
      startRequest(message.requestId, (signal) =>
        connectServer(message, signal),
      );
      break;
    case 'disconnect-server':
      startRequest(message.requestId, () =>
        disconnectServer(
          message.serverId,
          message.connectionId,
          message.requestId,
        ),
      );
      break;
    case 'list-tools':
      startRequest(message.requestId, (signal) =>
        listTools(message.serverId, message.requestId, signal),
      );
      break;
    case 'list-resources':
      startRequest(message.requestId, (signal) =>
        listResources(message, signal),
      );
      break;
    case 'list-resource-templates':
      startRequest(message.requestId, (signal) =>
        listResourceTemplates(message, signal),
      );
      break;
    case 'read-resource':
      startRequest(message.requestId, (signal) =>
        readResource(message, signal),
      );
      break;
    case 'list-prompts':
      startRequest(message.requestId, (signal) => listPrompts(message, signal));
      break;
    case 'get-prompt':
      startRequest(message.requestId, (signal) => getPrompt(message, signal));
      break;
    case 'call-tool':
      startRequest(message.requestId, (signal) => callTool(message, signal));
      break;
    case 'finish-oauth':
      startRequest(message.requestId, () => finishOAuth(message));
      break;
    case 'cancel-request':
      cancelElicitationsForToolRequest(message.requestId);
      activeRequests.get(message.requestId)?.abort();
      break;
    case 'ping':
      send({
        type: 'pong',
        launchId,
        requestId: message.requestId,
        sentAt: message.sentAt,
        receivedAt: Date.now(),
      });
      break;
    case 'shutdown':
      void shutdown(message.requestId);
      break;
  }
}

function startRequest(
  requestId: string,
  execute: (signal: AbortSignal) => Promise<void>,
): void {
  if (!launchId) return;
  if (activeRequests.has(requestId)) {
    send({
      type: 'request-error',
      launchId,
      requestId,
      error: { message: `Duplicate MCP host request ${requestId}` },
    });
    return;
  }

  const controller = new AbortController();
  activeRequests.set(requestId, controller);
  void execute(controller.signal)
    .catch((error) => {
      if (!launchId || shuttingDown) return;
      send({
        type: 'request-error',
        launchId,
        requestId,
        error: serializeError(error, collectAllSecretValues()),
      });
    })
    .finally(() => {
      activeRequests.delete(requestId);
    });
}

async function connectServer(
  message: Extract<MainToMcpHostMessage, { type: 'connect-server' }>,
  signal: AbortSignal,
): Promise<void> {
  if (!launchId) return;
  send({
    type: 'connection-state',
    launchId,
    requestId: message.requestId,
    serverId: message.serverId,
    connectionId: message.connectionId,
    state: 'connecting',
  });

  await closeConnection(message.serverId);
  let authorizationRequired = false;
  let resolveAuthorizationRequired: (() => void) | undefined;
  const authorizationRequiredPromise = new Promise<void>((resolve) => {
    resolveAuthorizationRequired = resolve;
  });
  const markAuthorizationRequired = () => {
    authorizationRequired = true;
    if (message.transport.type !== 'stdio' && message.transport.oauth) {
      pendingOAuthConnections.set(message.serverId, {
        config: structuredClone(message.transport),
        secretValues: [...message.secretValues],
        networkProxy: message.networkProxy
          ? structuredClone(message.networkProxy)
          : undefined,
      });
    }
    resolveAuthorizationRequired?.();
  };
  const transport = createTransport(
    message.serverId,
    message.transport,
    message.secretValues,
    markAuthorizationRequired,
    message.networkProxy,
  );
  let resourceMonitor: RuntimeMemoryMonitor | null = null;
  let client!: Client;
  client = new Client(
    { name: 'clodex-mcp-host', version: '1.0.0' },
    {
      capabilities: {
        elicitation: {
          form: {},
        },
      },
      listChanged: {
        tools: {
          autoRefresh: false,
          onChanged: (error) => {
            void refreshListChangedCatalog(
              message.serverId,
              message.connectionId,
              'tools',
              client,
              message.secretValues,
              error,
            );
          },
        },
        resources: {
          autoRefresh: false,
          onChanged: (error) => {
            void refreshListChangedCatalog(
              message.serverId,
              message.connectionId,
              'resources',
              client,
              message.secretValues,
              error,
            );
          },
        },
        prompts: {
          autoRefresh: false,
          onChanged: (error) => {
            void refreshListChangedCatalog(
              message.serverId,
              message.connectionId,
              'prompts',
              client,
              message.secretValues,
              error,
            );
          },
        },
      },
    },
  );
  client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    if (
      !isExactMcpConnection(
        connections,
        message.serverId,
        client,
        message.connectionId,
      )
    ) {
      return { action: 'cancel' as const };
    }
    const params = request.params;
    if (params.mode === 'url') {
      return { action: 'cancel' as const };
    }
    const elicitationContext = resolveElicitationContext(message.serverId);
    if (!elicitationContext) {
      emitServerLog(
        message.serverId,
        'warn',
        'MCP elicitation was cancelled because no unambiguous agent call was active',
        collectServerSecretValues(message.serverId, message.secretValues),
      );
      return { action: 'cancel' as const };
    }
    const result = await requestMainElicitation(
      message.serverId,
      elicitationContext.agentInstanceId,
      elicitationContext.toolRequestIds,
      normalizeElicitationRequest(params),
      extra.signal,
    );
    if (
      !isExactMcpConnection(
        connections,
        message.serverId,
        client,
        message.connectionId,
      )
    ) {
      return { action: 'cancel' as const };
    }
    return result;
  });
  client.onclose = () => {
    resourceMonitor?.stop();
    resourceMonitor = null;
    if (!launchId || shuttingDown) return;
    const closed = deleteExactMcpConnection(
      connections,
      message.serverId,
      client,
      message.connectionId,
    );
    if (!closed) return;
    send({
      type: 'connection-state',
      launchId,
      serverId: message.serverId,
      connectionId: message.connectionId,
      state: 'disconnected',
    });
  };
  client.onerror = (error) => {
    if (!launchId || shuttingDown) return;
    if (
      !isExactMcpConnection(
        connections,
        message.serverId,
        client,
        message.connectionId,
      )
    ) {
      return;
    }
    send({
      type: 'server-log',
      launchId,
      serverId: message.serverId,
      level: 'error',
      message: redactText(
        error instanceof Error ? error.message : String(error),
        collectServerSecretValues(message.serverId, message.secretValues),
      ),
    });
  };

  try {
    const connectPromise = client.connect(transport, {
      signal,
      timeout: CONNECT_TIMEOUT_MS,
    });
    const outcome = await Promise.race([
      connectPromise.then(() => 'connected' as const),
      authorizationRequiredPromise.then(
        () => 'authorization-required' as const,
      ),
    ]);
    if (outcome === 'authorization-required') {
      void connectPromise.catch(() => undefined);
      await transport.close().catch(() => undefined);
      send({
        type: 'connection-state',
        launchId,
        requestId: message.requestId,
        serverId: message.serverId,
        connectionId: message.connectionId,
        state: 'authorization-required',
      });
      return;
    }
    if (signal.aborted) {
      await transport.close().catch(() => undefined);
      throw createAbortError();
    }
    const runtimePolicy =
      message.transport.type === 'stdio'
        ? (message.transport.runtimePolicy ?? null)
        : null;
    if (
      runtimePolicy &&
      transport instanceof StdioClientTransport &&
      transport.pid
    ) {
      resourceMonitor = startRuntimeMemoryMonitor({
        pid: transport.pid,
        maxMemoryMb: runtimePolicy.maxMemoryMb,
        onLimitExceeded: (residentBytes) => {
          emitServerLog(
            message.serverId,
            'error',
            `Executable runtime exceeded ${runtimePolicy.maxMemoryMb} MB memory limit (${Math.ceil(residentBytes / 1024 / 1024)} MB resident); terminating`,
            message.secretValues,
          );
          void transport.close().catch(() => undefined);
        },
      });
    }
    connections.set(message.serverId, {
      connectionId: message.connectionId,
      client,
      transport,
      secretValues: [...message.secretValues],
      runtimePolicy,
      resourceMonitor,
    });
    send({
      type: 'connection-state',
      launchId,
      requestId: message.requestId,
      serverId: message.serverId,
      connectionId: message.connectionId,
      state: 'connected',
    });
  } catch (error) {
    if (
      (authorizationRequired || isOAuthAuthorizationRequired(error)) &&
      message.transport.type !== 'stdio' &&
      message.transport.oauth
    ) {
      pendingOAuthConnections.set(message.serverId, {
        config: structuredClone(message.transport),
        secretValues: [...message.secretValues],
        networkProxy: message.networkProxy
          ? structuredClone(message.networkProxy)
          : undefined,
      });
      await transport.close().catch(() => undefined);
      send({
        type: 'connection-state',
        launchId,
        requestId: message.requestId,
        serverId: message.serverId,
        connectionId: message.connectionId,
        state: 'authorization-required',
      });
      return;
    }
    await transport.close().catch(() => undefined);
    send({
      type: 'connection-state',
      launchId,
      requestId: message.requestId,
      serverId: message.serverId,
      connectionId: message.connectionId,
      state: 'failed',
      error: serializeError(
        error,
        collectServerSecretValues(message.serverId, message.secretValues),
      ),
    });
  }
}

function createTransport(
  serverId: string,
  config: ResolvedMcpTransport,
  secretValues: string[],
  onAuthorizationRequired?: () => void,
  networkProxy?: McpNetworkProxyConfig,
): Transport {
  switch (config.type) {
    case 'stdio': {
      const sandboxed = config.runtimePolicy
        ? prepareSandboxedRuntimeCommand({
            command: config.command,
            args: config.args,
            policy: config.runtimePolicy,
          })
        : {
            command: config.command,
            args: config.args,
            cwd: config.cwd ?? process.cwd(),
          };
      const transport = new StdioClientTransport({
        command: sandboxed.command,
        args: sandboxed.args,
        cwd: sandboxed.cwd,
        env: config.env,
        stderr: 'pipe',
      });
      let stderrBuffer = '';
      transport.stderr?.on('data', (chunk: Buffer | string) => {
        stderrBuffer = capText(
          `${stderrBuffer}${Buffer.from(chunk).toString('utf-8')}`,
          MAX_STDERR_BUFFER,
        );
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? '';
        for (const line of lines) {
          emitServerLog(serverId, 'warn', line, secretValues);
        }
      });
      transport.stderr?.on('end', () => {
        if (stderrBuffer) {
          emitServerLog(serverId, 'warn', stderrBuffer, secretValues);
          stderrBuffer = '';
        }
      });
      return transport;
    }
    case 'streamable-http': {
      const fetchImpl = networkProxy
        ? createNetworkProxyFetch(networkProxy)
        : globalThis.fetch;
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: {
          headers: config.headers,
        },
        authProvider: config.oauth
          ? createOAuthProvider(serverId, config.oauth, onAuthorizationRequired)
          : undefined,
        fetch: config.oauth
          ? createOAuthOriginBoundFetch(
              new URL(config.url).origin,
              config.oauth.allowedAuthorizationOrigins,
              fetchImpl,
            )
          : createOriginBoundFetch(new URL(config.url).origin, fetchImpl),
      });
    }
    case 'sse': {
      const fetchImpl = networkProxy
        ? createNetworkProxyFetch(networkProxy)
        : globalThis.fetch;
      return new SSEClientTransport(new URL(config.url), {
        requestInit: {
          headers: config.headers,
        },
        authProvider: config.oauth
          ? createOAuthProvider(serverId, config.oauth, onAuthorizationRequired)
          : undefined,
        fetch: config.oauth
          ? createOAuthOriginBoundFetch(
              new URL(config.url).origin,
              config.oauth.allowedAuthorizationOrigins,
              fetchImpl,
            )
          : createOriginBoundFetch(new URL(config.url).origin, fetchImpl),
      });
    }
  }
}

async function disconnectServer(
  serverId: string,
  connectionId: string,
  requestId: string,
): Promise<void> {
  if (!launchId) return;
  await closeConnection(serverId, connectionId);
  send({
    type: 'connection-state',
    launchId,
    requestId,
    serverId,
    connectionId,
    state: 'disconnected',
  });
}

async function closeConnection(
  serverId: string,
  expectedConnectionId?: string,
): Promise<void> {
  const connection = connections.get(serverId);
  if (
    expectedConnectionId !== undefined &&
    connection?.connectionId !== expectedConnectionId
  ) {
    return;
  }
  connections.delete(serverId);
  pendingOAuthConnections.delete(serverId);
  oauthSecretValues.delete(serverId);
  connection?.resourceMonitor?.stop();
  await connection?.transport.close().catch(() => undefined);
}

function connectionTimeout(
  connection: Connection,
  requestedTimeoutMs: number,
): number {
  return Math.min(
    requestedTimeoutMs,
    connection.runtimePolicy?.requestTimeoutMs ?? requestedTimeoutMs,
  );
}

async function finishOAuth(
  message: Extract<MainToMcpHostMessage, { type: 'finish-oauth' }>,
): Promise<void> {
  if (!launchId) return;
  const pending = pendingOAuthConnections.get(message.serverId);
  if (!pending) {
    throw new Error(
      `MCP server "${message.serverId}" has no pending OAuth authorization`,
    );
  }
  pendingOAuthConnections.delete(message.serverId);
  const transport = createTransport(
    message.serverId,
    pending.config,
    pending.secretValues,
    undefined,
    pending.networkProxy,
  ) as OAuthCapableTransport;
  try {
    await transport.finishAuth(message.authorizationCode);
  } finally {
    await transport.close().catch(() => undefined);
  }
  send({
    type: 'oauth-finish-result',
    launchId,
    requestId: message.requestId,
    serverId: message.serverId,
  });
}

async function listTools(
  serverId: string,
  requestId: string,
  signal: AbortSignal,
): Promise<void> {
  if (!launchId) return;
  const connection = requireConnection(serverId);
  const tools = await collectMcpCatalogPages(async (cursor) => {
    const response = await connection.client.listTools(
      cursor ? { cursor } : undefined,
      {
        signal,
        timeout: connectionTimeout(connection, LIST_TOOLS_TIMEOUT_MS),
      },
    );
    return {
      items: response.tools.map(normalizeToolDescriptor),
      nextCursor: response.nextCursor,
    };
  });
  send({
    type: 'tools-result',
    launchId,
    requestId,
    serverId,
    tools,
  });
}

async function listResources(
  message: Extract<MainToMcpHostMessage, { type: 'list-resources' }>,
  signal: AbortSignal,
): Promise<void> {
  if (!launchId) return;
  const connection = requireConnection(message.serverId);
  const response = await connection.client.listResources(
    message.cursor ? { cursor: message.cursor } : undefined,
    { signal, timeout: connectionTimeout(connection, LIST_CONTEXT_TIMEOUT_MS) },
  );
  send({
    type: 'resources-result',
    launchId,
    requestId: message.requestId,
    serverId: message.serverId,
    resources: response.resources.map(normalizeResourceDescriptor),
    nextCursor: response.nextCursor,
  });
}

async function listResourceTemplates(
  message: Extract<MainToMcpHostMessage, { type: 'list-resource-templates' }>,
  signal: AbortSignal,
): Promise<void> {
  if (!launchId) return;
  const connection = requireConnection(message.serverId);
  const response = await connection.client.listResourceTemplates(
    message.cursor ? { cursor: message.cursor } : undefined,
    { signal, timeout: connectionTimeout(connection, LIST_CONTEXT_TIMEOUT_MS) },
  );
  send({
    type: 'resource-templates-result',
    launchId,
    requestId: message.requestId,
    serverId: message.serverId,
    resourceTemplates: response.resourceTemplates.map(
      normalizeResourceTemplateDescriptor,
    ),
    nextCursor: response.nextCursor,
  });
}

async function readResource(
  message: Extract<MainToMcpHostMessage, { type: 'read-resource' }>,
  signal: AbortSignal,
): Promise<void> {
  if (!launchId) return;
  const connection = requireConnection(message.serverId);
  const result = await connection.client.readResource(
    { uri: message.uri },
    { signal, timeout: connectionTimeout(connection, message.timeoutMs) },
  );
  assertBoundedMcpContextResult(result, 'MCP resource result');
  send({
    type: 'resource-read-result',
    launchId,
    requestId: message.requestId,
    serverId: message.serverId,
    uri: message.uri,
    result,
  });
}

async function listPrompts(
  message: Extract<MainToMcpHostMessage, { type: 'list-prompts' }>,
  signal: AbortSignal,
): Promise<void> {
  if (!launchId) return;
  const connection = requireConnection(message.serverId);
  const response = await connection.client.listPrompts(
    message.cursor ? { cursor: message.cursor } : undefined,
    { signal, timeout: connectionTimeout(connection, LIST_CONTEXT_TIMEOUT_MS) },
  );
  send({
    type: 'prompts-result',
    launchId,
    requestId: message.requestId,
    serverId: message.serverId,
    prompts: response.prompts.map(normalizePromptDescriptor),
    nextCursor: response.nextCursor,
  });
}

async function getPrompt(
  message: Extract<MainToMcpHostMessage, { type: 'get-prompt' }>,
  signal: AbortSignal,
): Promise<void> {
  if (!launchId) return;
  const connection = requireConnection(message.serverId);
  const result = await connection.client.getPrompt(
    {
      name: message.promptName,
      arguments: message.arguments,
    },
    { signal, timeout: connectionTimeout(connection, message.timeoutMs) },
  );
  assertBoundedMcpContextResult(result, 'MCP prompt result');
  send({
    type: 'prompt-result',
    launchId,
    requestId: message.requestId,
    serverId: message.serverId,
    promptName: message.promptName,
    result,
  });
}

async function callTool(
  message: Extract<MainToMcpHostMessage, { type: 'call-tool' }>,
  signal: AbortSignal,
): Promise<void> {
  if (!launchId) return;
  const connection = requireConnection(message.serverId);
  if (message.agentInstanceId) {
    const invocations =
      activeToolInvocations.get(message.serverId) ?? new Map<string, string>();
    invocations.set(message.requestId, message.agentInstanceId);
    activeToolInvocations.set(message.serverId, invocations);
  }
  try {
    const result = await connection.client.callTool(
      {
        name: message.toolName,
        arguments: message.arguments,
      },
      undefined,
      {
        signal,
        timeout: connectionTimeout(connection, message.timeoutMs),
      },
    );
    send({
      type: 'tool-call-result',
      launchId,
      requestId: message.requestId,
      serverId: message.serverId,
      toolName: message.toolName,
      result,
    });
  } finally {
    const invocations = activeToolInvocations.get(message.serverId);
    invocations?.delete(message.requestId);
    if (invocations?.size === 0) {
      activeToolInvocations.delete(message.serverId);
    }
  }
}

function requireConnection(serverId: string): Connection {
  const connection = connections.get(serverId);
  if (!connection) {
    throw new Error(`MCP server "${serverId}" is not connected`);
  }
  return connection;
}

function emitServerLog(
  serverId: string,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  secretValues: string[],
): void {
  if (!launchId || shuttingDown) return;
  const redacted = redactText(
    capText(message, MAX_STDERR_BUFFER),
    secretValues,
  );
  if (!redacted.trim()) return;
  send({
    type: 'server-log',
    launchId,
    serverId,
    level,
    message: redacted,
  });
}

function emitListChanged(
  serverId: string,
  connectionId: string,
  kind: 'tools' | 'resources' | 'prompts',
  payload: {
    tools?: McpToolDescriptor[];
    resources?: McpResourceDescriptor[];
    prompts?: McpPromptDescriptor[];
  },
): void {
  if (!launchId || shuttingDown) return;
  send({
    type: 'list-changed',
    launchId,
    serverId,
    connectionId,
    kind,
    ...payload,
  });
}

async function refreshListChangedCatalog(
  serverId: string,
  connectionId: string,
  kind: 'tools' | 'resources' | 'prompts',
  client: Client,
  baseSecretValues: string[],
  notificationError: Error | null,
): Promise<void> {
  if (!isExactMcpConnection(connections, serverId, client, connectionId))
    return;
  const secretValues = collectServerSecretValues(serverId, baseSecretValues);
  if (notificationError) {
    emitServerLog(
      serverId,
      'warn',
      `Failed to process ${kind} list-changed: ${notificationError.message}`,
      secretValues,
    );
    return;
  }
  try {
    const signal = AbortSignal.timeout(LIST_CONTEXT_TIMEOUT_MS);
    if (kind === 'tools') {
      const tools = await collectMcpCatalogPages(async (cursor) => {
        requireExactMcpConnection(connections, serverId, client, connectionId);
        const response = await client.listTools(
          cursor ? { cursor } : undefined,
          { signal, timeout: LIST_TOOLS_TIMEOUT_MS },
        );
        requireExactMcpConnection(connections, serverId, client, connectionId);
        return {
          items: response.tools.map(normalizeToolDescriptor),
          nextCursor: response.nextCursor,
        };
      });
      requireExactMcpConnection(connections, serverId, client, connectionId);
      emitListChanged(serverId, connectionId, kind, { tools });
      return;
    }
    if (kind === 'resources') {
      const resources = await collectMcpCatalogPages(async (cursor) => {
        requireExactMcpConnection(connections, serverId, client, connectionId);
        const response = await client.listResources(
          cursor ? { cursor } : undefined,
          { signal, timeout: LIST_CONTEXT_TIMEOUT_MS },
        );
        requireExactMcpConnection(connections, serverId, client, connectionId);
        return {
          items: response.resources.map(normalizeResourceDescriptor),
          nextCursor: response.nextCursor,
        };
      });
      requireExactMcpConnection(connections, serverId, client, connectionId);
      emitListChanged(serverId, connectionId, kind, { resources });
      return;
    }
    const prompts = await collectMcpCatalogPages(async (cursor) => {
      requireExactMcpConnection(connections, serverId, client, connectionId);
      const response = await client.listPrompts(
        cursor ? { cursor } : undefined,
        { signal, timeout: LIST_CONTEXT_TIMEOUT_MS },
      );
      requireExactMcpConnection(connections, serverId, client, connectionId);
      return {
        items: response.prompts.map(normalizePromptDescriptor),
        nextCursor: response.nextCursor,
      };
    });
    requireExactMcpConnection(connections, serverId, client, connectionId);
    emitListChanged(serverId, connectionId, kind, { prompts });
  } catch (error) {
    if (error instanceof StaleMcpConnectionError) return;
    emitServerLog(
      serverId,
      'warn',
      `Failed to refresh ${kind} after list-changed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      secretValues,
    );
  }
}

async function shutdown(requestId: string): Promise<void> {
  if (!launchId || shuttingDown) return;
  shuttingDown = true;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  for (const controller of activeRequests.values()) controller.abort();
  activeRequests.clear();
  for (const pending of pendingOAuthRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('MCP host is shutting down'));
  }
  pendingOAuthRequests.clear();
  for (const [elicitationRequestId, pending] of pendingElicitationRequests) {
    clearTimeout(pending.timeout);
    pending.signal.removeEventListener('abort', pending.abortHandler);
    pending.reject(new Error('MCP host is shutting down'));
    send({
      type: 'elicitation-rpc-cancel',
      launchId,
      elicitationRequestId,
      serverId: pending.serverId,
    });
  }
  pendingElicitationRequests.clear();
  activeToolInvocations.clear();
  await Promise.all(
    [
      ...new Set([...connections.keys(), ...pendingOAuthConnections.keys()]),
    ].map((serverId) => closeConnection(serverId)),
  );
  send({
    type: 'shutdown-complete',
    launchId,
    requestId,
  });
  setImmediate(() => process.exit(0));
}

function serializeError(
  error: unknown,
  secretValues: string[],
): McpHostSerializedError {
  const source =
    error instanceof Error
      ? error
      : new Error(String(error ?? 'Unknown error'));
  const codeValue = (source as Error & { code?: unknown }).code;
  return {
    message: redactText(capText(source.message, 16_384), secretValues),
    stack: source.stack
      ? redactText(capText(source.stack, 32_768), secretValues)
      : undefined,
    code:
      typeof codeValue === 'string' || typeof codeValue === 'number'
        ? codeValue
        : undefined,
  };
}

function collectAllSecretValues(): string[] {
  return [
    ...[...connections.values()].flatMap(
      (connection) => connection.secretValues,
    ),
    ...[...oauthSecretValues.values()].flatMap((values) => [...values]),
  ];
}

function redactText(value: string, secretValues: string[]): string {
  let result = value;
  for (const secret of secretValues) {
    if (!secret) continue;
    result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

function capText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…[truncated]`;
}

function createAbortError(): Error {
  const error = new Error('MCP host request was aborted');
  error.name = 'AbortError';
  return error;
}

function normalizeToolDescriptor(tool: McpToolDescriptor): McpToolDescriptor {
  return {
    ...tool,
    inputSchema: tool.inputSchema,
  };
}

function normalizeResourceDescriptor(
  resource: McpResourceDescriptor,
): McpResourceDescriptor {
  return { ...resource };
}

function normalizeResourceTemplateDescriptor(
  template: McpResourceTemplateDescriptor,
): McpResourceTemplateDescriptor {
  return { ...template };
}

function normalizePromptDescriptor(
  prompt: McpPromptDescriptor,
): McpPromptDescriptor {
  return {
    ...prompt,
    arguments: prompt.arguments?.map((argument) => ({ ...argument })),
  };
}

function createOAuthProvider(
  serverId: string,
  config: ResolvedMcpOAuthConfig,
  onAuthorizationRequired?: () => void,
): OAuthClientProvider {
  return {
    redirectUrl: config.redirectUrl,
    get clientMetadata(): OAuthClientMetadata {
      return structuredClone(config.clientMetadata) as OAuthClientMetadata;
    },
    state: async () =>
      String(await requestOAuth(serverId, { operation: 'prepare-state' })),
    clientInformation: async () =>
      rememberOAuthSecrets(
        serverId,
        (await requestOAuth(serverId, {
          operation: 'load-client-information',
        })) as OAuthClientInformationMixed | undefined,
      ),
    saveClientInformation: async (value) => {
      rememberOAuthSecrets(serverId, value);
      await requestOAuth(serverId, {
        operation: 'save-client-information',
        value,
      });
    },
    tokens: async () =>
      rememberOAuthSecrets(
        serverId,
        (await requestOAuth(serverId, {
          operation: 'load-tokens',
        })) as OAuthTokens | undefined,
      ),
    saveTokens: async (value) => {
      rememberOAuthSecrets(serverId, value);
      await requestOAuth(serverId, { operation: 'save-tokens', value });
    },
    redirectToAuthorization: async (authorizationUrl) => {
      await requestOAuth(serverId, {
        operation: 'open-authorization',
        authorizationUrl: authorizationUrl.toString(),
      });
      onAuthorizationRequired?.();
      // Force the pending initialize request to unwind immediately after main
      // durably stores state/PKCE and opens the browser.
      throw new OAuthAuthorizationRequiredSignal();
    },
    saveCodeVerifier: async (codeVerifier) => {
      await requestOAuth(serverId, {
        operation: 'save-code-verifier',
        codeVerifier,
      });
    },
    codeVerifier: async () =>
      String(
        await requestOAuth(serverId, {
          operation: 'load-code-verifier',
        }),
      ),
    saveDiscoveryState: async (value) => {
      await requestOAuth(serverId, {
        operation: 'save-discovery-state',
        value,
      });
    },
    discoveryState: async () =>
      (await requestOAuth(serverId, {
        operation: 'load-discovery-state',
      })) as OAuthDiscoveryState | undefined,
    invalidateCredentials: async (scope) => {
      await requestOAuth(serverId, {
        operation: 'invalidate-credentials',
        scope,
      });
    },
    validateResourceURL: async (serverUrl, resource) => {
      const expected = new URL(serverUrl);
      if (!resource) return expected;
      const selected = new URL(resource);
      if (selected.origin !== expected.origin) {
        throw new Error(
          'OAuth protected resource does not match the MCP server origin',
        );
      }
      return selected;
    },
  };
}

function requestOAuth(
  serverId: string,
  request: McpOAuthHostRequest,
): Promise<unknown> {
  if (!launchId || shuttingDown) {
    return Promise.reject(new Error('MCP host is unavailable'));
  }
  const authRequestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingOAuthRequests.delete(authRequestId);
      reject(new Error('MCP OAuth main-process request timed out'));
    }, 15_000);
    pendingOAuthRequests.set(authRequestId, { resolve, reject, timeout });
    send({
      type: 'oauth-rpc-request',
      launchId: launchId!,
      authRequestId,
      serverId,
      request,
    });
  });
}

function handleOAuthRpcResult(
  message: Extract<MainToMcpHostMessage, { type: 'oauth-rpc-result' }>,
): void {
  if (!launchId || message.launchId !== launchId) return;
  const pending = pendingOAuthRequests.get(message.authRequestId);
  if (!pending) return;
  pendingOAuthRequests.delete(message.authRequestId);
  clearTimeout(pending.timeout);
  if (message.ok) {
    pending.resolve(message.value);
  } else {
    pending.reject(new Error(message.error ?? 'MCP OAuth request failed'));
  }
}

function requestMainElicitation(
  serverId: string,
  agentInstanceId: string,
  toolRequestIds: Set<string>,
  request: McpElicitationRequest,
  signal: AbortSignal,
): Promise<McpElicitationResult> {
  if (!launchId || shuttingDown) {
    return Promise.resolve({ action: 'cancel' });
  }
  const elicitationRequestId = randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      const pending = pendingElicitationRequests.get(elicitationRequestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pending.signal.removeEventListener('abort', pending.abortHandler);
      pendingElicitationRequests.delete(elicitationRequestId);
    };
    const abortHandler = () => {
      cleanup();
      if (launchId && !shuttingDown) {
        send({
          type: 'elicitation-rpc-cancel',
          launchId,
          elicitationRequestId,
          serverId,
        });
      }
      resolve({ action: 'cancel' });
    };
    const timeout = setTimeout(() => {
      cleanup();
      if (launchId && !shuttingDown) {
        send({
          type: 'elicitation-rpc-cancel',
          launchId,
          elicitationRequestId,
          serverId,
        });
      }
      resolve({ action: 'cancel' });
    }, 10 * 60_000);
    pendingElicitationRequests.set(elicitationRequestId, {
      serverId,
      toolRequestIds,
      resolve: (value) => {
        cleanup();
        resolve(value);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
      abortHandler,
      signal,
      timeout,
    });
    signal.addEventListener('abort', abortHandler, { once: true });
    if (signal.aborted) {
      abortHandler();
      return;
    }
    send({
      type: 'elicitation-rpc-request',
      launchId: launchId!,
      elicitationRequestId,
      serverId,
      agentInstanceId,
      request,
    });
  });
}

function handleElicitationRpcResult(
  message: Extract<MainToMcpHostMessage, { type: 'elicitation-rpc-result' }>,
): void {
  if (!launchId || message.launchId !== launchId) return;
  const pending = pendingElicitationRequests.get(message.elicitationRequestId);
  if (!pending) return;
  if (message.ok && message.result) {
    pending.resolve(message.result);
  } else {
    pending.reject(
      new Error(message.error ?? 'MCP elicitation request failed'),
    );
  }
}

function cancelElicitationsForToolRequest(toolRequestId: string): void {
  for (const pending of pendingElicitationRequests.values()) {
    if (pending.toolRequestIds.has(toolRequestId)) {
      pending.abortHandler();
    }
  }
}

function resolveElicitationContext(serverId: string): {
  agentInstanceId: string;
  toolRequestIds: Set<string>;
} | null {
  const invocations = activeToolInvocations.get(serverId);
  if (!invocations || invocations.size === 0) return null;
  const agentIds = new Set(invocations.values());
  if (agentIds.size !== 1) return null;
  return {
    agentInstanceId: [...agentIds][0]!,
    toolRequestIds: new Set(invocations.keys()),
  };
}

function normalizeElicitationRequest(
  params: ElicitRequestFormParams,
): McpElicitationRequest {
  const required = new Set(params.requestedSchema.required ?? []);
  for (const requiredId of required) {
    if (!(requiredId in params.requestedSchema.properties)) {
      throw new Error(
        `MCP elicitation required field "${requiredId}" is not defined`,
      );
    }
  }
  return mcpElicitationRequestSchema.parse({
    message: params.message,
    fields: Object.entries(params.requestedSchema.properties).map(
      ([id, schema]) => {
        const base = {
          id,
          label: schema.title?.trim() || id,
          description: schema.description,
          required: required.has(id),
        };
        if (schema.type === 'boolean') {
          return {
            ...base,
            kind: 'boolean' as const,
            defaultValue: schema.default,
          };
        }
        if (schema.type === 'number' || schema.type === 'integer') {
          return {
            ...base,
            kind: 'number' as const,
            integer: schema.type === 'integer',
            minimum: schema.minimum,
            maximum: schema.maximum,
            defaultValue: schema.default,
          };
        }
        if (schema.type === 'array') {
          const options =
            'enum' in schema.items
              ? schema.items.enum.map((value) => ({ value, label: value }))
              : schema.items.anyOf.map((option) => ({
                  value: option.const,
                  label: option.title,
                }));
          return {
            ...base,
            kind: 'multi-select' as const,
            options,
            minItems: schema.minItems,
            maxItems: schema.maxItems,
            defaultValues: schema.default,
          };
        }
        if ('oneOf' in schema) {
          return {
            ...base,
            kind: 'select' as const,
            options: schema.oneOf.map((option) => ({
              value: option.const,
              label: option.title,
            })),
            defaultValue: schema.default,
          };
        }
        if ('enum' in schema) {
          return {
            ...base,
            kind: 'select' as const,
            options: schema.enum.map((value, index) => ({
              value,
              label:
                ('enumNames' in schema ? schema.enumNames?.[index] : null) ??
                value,
            })),
            defaultValue: schema.default,
          };
        }
        return {
          ...base,
          kind: 'text' as const,
          inputType: ('format' in schema ? schema.format : undefined) ?? 'text',
          minLength: 'minLength' in schema ? schema.minLength : undefined,
          maxLength: 'maxLength' in schema ? schema.maxLength : undefined,
          defaultValue: schema.default,
        };
      },
    ),
  });
}

function rememberOAuthSecrets<T>(serverId: string, value: T): T {
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const secrets = oauthSecretValues.get(serverId) ?? new Set<string>();
  for (const key of [
    'access_token',
    'refresh_token',
    'id_token',
    'client_secret',
  ]) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      secrets.add(candidate);
    }
  }
  if (secrets.size > 0) oauthSecretValues.set(serverId, secrets);
  return value;
}

function collectServerSecretValues(serverId: string, base: string[]): string[] {
  return [...base, ...(oauthSecretValues.get(serverId) ?? [])];
}

function isOAuthAuthorizationRequired(error: unknown): boolean {
  return (
    error instanceof OAuthAuthorizationRequiredSignal ||
    error instanceof UnauthorizedError ||
    (error instanceof Error &&
      (error.name === 'UnauthorizedError' ||
        error.name === 'OAuthAuthorizationRequiredSignal'))
  );
}

parentPort.on('message', (event) => {
  if (!isMainToMcpHostMessage(event.data)) {
    terminateAfterFatal(new Error('MCP host received an invalid message'));
    return;
  }
  handleMessage(event.data);
});

process.on('uncaughtException', (error) => {
  terminateAfterFatal(error);
});

process.on('unhandledRejection', (reason) => {
  terminateAfterFatal(reason);
});
