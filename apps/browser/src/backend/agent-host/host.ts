import {
  AGENT_HOST_HEARTBEAT_INTERVAL_MS,
  AGENT_HOST_PROTOCOL_VERSION,
  isMainToAgentHostMessage,
  type AgentHostToMainMessage,
  type AgentRuntimeSnapshot,
  type MainToAgentHostMessage,
} from './protocol';
import { executeOpenManusRequest } from './openmanus-runtime';
import { randomUUID } from 'node:crypto';
import type {
  AgentTurnHostHandlers,
  IsolatedAgentModelCallRequest,
  IsolatedAgentModelCallResult,
  IsolatedAgentModelStreamEvent,
  IsolatedAgentToolCallRequest,
  IsolatedAgentToolCallResult,
} from './isolated-agent-turn';
import { executeIsolatedAgentTurn } from './isolated-agent-turn-runtime';

interface ParentPort {
  postMessage(message: AgentHostToMainMessage): void;
  on(
    event: 'message',
    handler: (event: { data: unknown; ports: unknown[] }) => void,
  ): void;
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort })
  .parentPort;

if (!parentPort) {
  throw new Error(
    'Agent host requires process.parentPort and must be launched with utilityProcess.fork()',
  );
}

const startedAt = Date.now();
let launchId: string | null = null;
let heartbeatSequence = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let runtimeSnapshot: AgentRuntimeSnapshot = {
  revision: 0,
  agents: [],
};
let shuttingDown = false;
const activeExecutions = new Map<
  string,
  {
    controller: AbortController;
    completion: Promise<void>;
  }
>();
const activeAgentTurns = new Map<
  string,
  {
    controller: AbortController;
    completion: Promise<void>;
  }
>();
const pendingModelCalls = new Map<
  string,
  {
    turnRequestId: string;
    resolve: (result: IsolatedAgentModelCallResult) => void;
    reject: (error: Error) => void;
    onEvent: (event: IsolatedAgentModelStreamEvent) => void;
    removeAbortListener: () => void;
  }
>();
const pendingToolCalls = new Map<
  string,
  {
    turnRequestId: string;
    resolve: (result: IsolatedAgentToolCallResult) => void;
    reject: (error: Error) => void;
    removeAbortListener: () => void;
  }
>();

function send(message: AgentHostToMainMessage): void {
  parentPort.postMessage(message);
}

function sendFatal(message: string): void {
  try {
    send({ type: 'fatal', launchId, message });
  } catch {
    // The parent may already be gone. There is no secondary reporting
    // channel worth keeping the compromised worker alive for.
  }
}

function terminateAfterFatal(message: string): void {
  sendFatal(message);
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
      trackedAgentCount: runtimeSnapshot.agents.length,
      workingAgentCount: runtimeSnapshot.agents.filter(
        (agent) => agent.isWorking,
      ).length,
      stateRevision: runtimeSnapshot.revision,
    });
  }, AGENT_HOST_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

function handleInitialize(
  message: Extract<MainToAgentHostMessage, { type: 'initialize' }>,
): void {
  if (message.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION) {
    terminateAfterFatal(
      `Unsupported agent-host protocol ${message.protocolVersion}; expected ${AGENT_HOST_PROTOCOL_VERSION}`,
    );
    return;
  }
  if (launchId && launchId !== message.launchId) {
    terminateAfterFatal('Agent host received a second launch identity');
    return;
  }

  launchId = message.launchId;
  startHeartbeat();
  send({
    type: 'ready',
    protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
    launchId,
    pid: process.pid,
    startedAt,
  });
}

function handleMessage(message: MainToAgentHostMessage): void {
  if (message.type === 'initialize') {
    handleInitialize(message);
    return;
  }
  if (!launchId || message.launchId !== launchId || shuttingDown) return;

  switch (message.type) {
    case 'sync-runtime-state':
      runtimeSnapshot = message.snapshot;
      send({
        type: 'runtime-state-synced',
        launchId,
        revision: runtimeSnapshot.revision,
      });
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
      void handleShutdown(message);
      break;
    case 'execute-openmanus':
      startOpenManusExecution(message);
      break;
    case 'cancel-execution':
      activeExecutions.get(message.requestId)?.controller.abort();
      break;
    case 'execute-agent-turn':
      startAgentTurn(message);
      break;
    case 'cancel-agent-turn':
      activeAgentTurns.get(message.requestId)?.controller.abort();
      break;
    case 'agent-model-call-event':
      handleModelCallEvent(message);
      break;
    case 'agent-model-call-complete':
      settleModelCall(message.callId, message.turnRequestId, {
        result: message.result,
      });
      break;
    case 'agent-model-call-error':
      settleModelCall(message.callId, message.turnRequestId, {
        error: deserializeError(message.error),
      });
      break;
    case 'agent-tool-call-complete':
      settleToolCall(message.callId, message.turnRequestId, {
        result: message.result,
      });
      break;
    case 'agent-tool-call-error':
      settleToolCall(message.callId, message.turnRequestId, {
        error: deserializeError(message.error),
      });
      break;
  }
}

function startOpenManusExecution(
  message: Extract<MainToAgentHostMessage, { type: 'execute-openmanus' }>,
): void {
  if (!launchId) return;
  if (activeExecutions.has(message.requestId)) {
    send({
      type: 'execution-error',
      launchId,
      requestId: message.requestId,
      error: {
        message: `Duplicate execution request ${message.requestId}`,
      },
    });
    return;
  }

  const controller = new AbortController();
  const completion = executeOpenManusRequest(message.request, {
    signal: controller.signal,
  })
    .then((result) => {
      if (shuttingDown || !launchId) return;
      send({
        type: 'execution-complete',
        launchId,
        requestId: message.requestId,
        result,
      });
    })
    .catch((error) => {
      if (shuttingDown || !launchId) return;
      send({
        type: 'execution-error',
        launchId,
        requestId: message.requestId,
        error: serializeError(error, message.request.apiKey),
      });
    })
    .finally(() => {
      activeExecutions.delete(message.requestId);
    });

  activeExecutions.set(message.requestId, { controller, completion });
}

function startAgentTurn(
  message: Extract<MainToAgentHostMessage, { type: 'execute-agent-turn' }>,
): void {
  if (!launchId) return;
  if (activeAgentTurns.has(message.requestId)) {
    send({
      type: 'agent-turn-error',
      launchId,
      requestId: message.requestId,
      error: {
        message: `Duplicate agent turn request ${message.requestId}`,
      },
    });
    return;
  }

  const controller = new AbortController();
  const handlers: AgentTurnHostHandlers = {
    callModel: (request, options) =>
      callMainModel(message.requestId, request, options),
    callTool: (request, options) =>
      callMainTool(message.requestId, request, options),
  };
  const completion = executeIsolatedAgentTurn(message.request, {
    signal: controller.signal,
    handlers,
    onEvent: (event) => {
      if (shuttingDown || !launchId) return;
      send({
        type: 'agent-turn-event',
        launchId,
        requestId: message.requestId,
        event,
      });
    },
  })
    .then((result) => {
      if (shuttingDown || !launchId) return;
      send({
        type: 'agent-turn-complete',
        launchId,
        requestId: message.requestId,
        result,
      });
    })
    .catch((error) => {
      if (shuttingDown || !launchId) return;
      send({
        type: 'agent-turn-error',
        launchId,
        requestId: message.requestId,
        error: serializeError(error),
      });
    })
    .finally(() => {
      rejectPendingHostCallsForTurn(
        message.requestId,
        new Error('Isolated agent turn finished before host call completion'),
      );
      activeAgentTurns.delete(message.requestId);
    });

  activeAgentTurns.set(message.requestId, { controller, completion });
}

function callMainModel(
  turnRequestId: string,
  request: IsolatedAgentModelCallRequest,
  options: {
    signal: AbortSignal;
    onEvent: (event: IsolatedAgentModelStreamEvent) => void;
  },
): Promise<IsolatedAgentModelCallResult> {
  const currentLaunchId = launchId;
  if (!currentLaunchId) {
    return Promise.reject(new Error('Agent host is not initialized'));
  }
  if (options.signal.aborted) return Promise.reject(createAbortError());

  const callId = randomUUID();
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      const pending = pendingModelCalls.get(callId);
      if (!pending) return;
      pendingModelCalls.delete(callId);
      pending.removeAbortListener();
      reject(createAbortError());
    };
    const removeAbortListener = () => {
      options.signal.removeEventListener('abort', handleAbort);
    };
    pendingModelCalls.set(callId, {
      turnRequestId,
      resolve,
      reject,
      onEvent: options.onEvent,
      removeAbortListener,
    });
    options.signal.addEventListener('abort', handleAbort, { once: true });
    send({
      type: 'agent-model-call-request',
      launchId: currentLaunchId,
      turnRequestId,
      callId,
      request,
    });
  });
}

function callMainTool(
  turnRequestId: string,
  request: IsolatedAgentToolCallRequest,
  options: {
    signal: AbortSignal;
  },
): Promise<IsolatedAgentToolCallResult> {
  const currentLaunchId = launchId;
  if (!currentLaunchId) {
    return Promise.reject(new Error('Agent host is not initialized'));
  }
  if (options.signal.aborted) return Promise.reject(createAbortError());

  const callId = randomUUID();
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      const pending = pendingToolCalls.get(callId);
      if (!pending) return;
      pendingToolCalls.delete(callId);
      pending.removeAbortListener();
      reject(createAbortError());
    };
    const removeAbortListener = () => {
      options.signal.removeEventListener('abort', handleAbort);
    };
    pendingToolCalls.set(callId, {
      turnRequestId,
      resolve,
      reject,
      removeAbortListener,
    });
    options.signal.addEventListener('abort', handleAbort, { once: true });
    send({
      type: 'agent-tool-call-request',
      launchId: currentLaunchId,
      turnRequestId,
      callId,
      request,
    });
  });
}

function handleModelCallEvent(
  message: Extract<MainToAgentHostMessage, { type: 'agent-model-call-event' }>,
): void {
  const pending = pendingModelCalls.get(message.callId);
  if (!pending || pending.turnRequestId !== message.turnRequestId) return;
  pending.onEvent(message.event);
}

function settleModelCall(
  callId: string,
  turnRequestId: string,
  outcome:
    | { result: IsolatedAgentModelCallResult }
    | {
        error: Error;
      },
): void {
  const pending = pendingModelCalls.get(callId);
  if (!pending || pending.turnRequestId !== turnRequestId) return;
  pendingModelCalls.delete(callId);
  pending.removeAbortListener();
  if ('error' in outcome) pending.reject(outcome.error);
  else pending.resolve(outcome.result);
}

function settleToolCall(
  callId: string,
  turnRequestId: string,
  outcome:
    | { result: IsolatedAgentToolCallResult }
    | {
        error: Error;
      },
): void {
  const pending = pendingToolCalls.get(callId);
  if (!pending || pending.turnRequestId !== turnRequestId) return;
  pendingToolCalls.delete(callId);
  pending.removeAbortListener();
  if ('error' in outcome) pending.reject(outcome.error);
  else pending.resolve(outcome.result);
}

function rejectPendingHostCallsForTurn(
  turnRequestId: string,
  error: Error,
): void {
  for (const [callId, pending] of pendingModelCalls) {
    if (pending.turnRequestId !== turnRequestId) continue;
    pendingModelCalls.delete(callId);
    pending.removeAbortListener();
    pending.reject(error);
  }
  for (const [callId, pending] of pendingToolCalls) {
    if (pending.turnRequestId !== turnRequestId) continue;
    pendingToolCalls.delete(callId);
    pending.removeAbortListener();
    pending.reject(error);
  }
}

async function handleShutdown(
  message: Extract<MainToAgentHostMessage, { type: 'shutdown' }>,
): Promise<void> {
  if (!launchId || shuttingDown) return;
  shuttingDown = true;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  const active = [...activeExecutions.values()];
  for (const execution of active) execution.controller.abort();
  const activeTurns = [...activeAgentTurns.values()];
  for (const turn of activeTurns) turn.controller.abort();
  await Promise.race([
    Promise.allSettled([
      ...active.map((execution) => execution.completion),
      ...activeTurns.map((turn) => turn.completion),
    ]),
    new Promise<void>((resolve) => setTimeout(resolve, 400)),
  ]);

  send({
    type: 'shutdown-complete',
    launchId,
    requestId: message.requestId,
  });
  setImmediate(() => process.exit(0));
}

function serializeError(
  error: unknown,
  secret?: string,
): { message: string; stack?: string } {
  const value = error instanceof Error ? error : new Error(String(error));
  const redact = (text: string | undefined) =>
    secret && text ? text.split(secret).join('[REDACTED]') : text;
  return {
    message: redact(value.message) ?? 'Unknown execution error',
    stack: redact(value.stack),
  };
}

function deserializeError(error: { message: string; stack?: string }): Error {
  const value = new Error(error.message);
  if (error.stack) value.stack = error.stack;
  return value;
}

function abortAllExecutions(): void {
  for (const execution of activeExecutions.values()) {
    execution.controller.abort();
  }
  for (const turn of activeAgentTurns.values()) {
    turn.controller.abort();
  }
}

function createAbortError(): Error {
  return new DOMException('Agent host operation was aborted', 'AbortError');
}

parentPort.on('message', (event) => {
  if (!isMainToAgentHostMessage(event.data)) {
    terminateAfterFatal('Agent host received a malformed IPC message');
    return;
  }
  handleMessage(event.data);
});

process.on('uncaughtException', (error) => {
  abortAllExecutions();
  sendFatal(
    `Uncaught exception: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  abortAllExecutions();
  sendFatal(
    `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
  );
  process.exit(1);
});
