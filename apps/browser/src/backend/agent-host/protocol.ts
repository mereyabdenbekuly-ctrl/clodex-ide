import {
  isIsolatedAgentModelCallRequest,
  isIsolatedAgentModelCallResult,
  isIsolatedAgentModelStreamEvent,
  isIsolatedAgentToolCallRequest,
  isIsolatedAgentToolCallResult,
  isIsolatedAgentTurnEvent,
  isIsolatedAgentTurnRequest,
  isIsolatedAgentTurnResult,
  type IsolatedAgentModelCallRequest,
  type IsolatedAgentModelCallResult,
  type IsolatedAgentModelStreamEvent,
  type IsolatedAgentToolCallRequest,
  type IsolatedAgentToolCallResult,
  type IsolatedAgentTurnEvent,
  type IsolatedAgentTurnRequest,
  type IsolatedAgentTurnResult,
} from './isolated-agent-turn';

export const AGENT_HOST_PROTOCOL_VERSION = 5;
export const AGENT_HOST_HEARTBEAT_INTERVAL_MS = 5_000;

export interface AgentRuntimeSummary {
  id: string;
  type: string;
  parentAgentInstanceId: string | null;
  isWorking: boolean;
  historyLength: number;
  queuedMessageCount: number;
  lastMessageId: string | null;
}

export interface AgentRuntimeSnapshot {
  revision: number;
  agents: AgentRuntimeSummary[];
}

export interface OpenManusExecutionRequest {
  prompt: string;
  mountPrefix: string;
  timeoutMs: number;
  maxTokens: number;
}

export interface OpenManusExecutionResult {
  message: string;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  mountPrefix: string;
  runtimeId: string;
  stdout: string;
  stderr: string;
}

export type MainToAgentHostMessage =
  | {
      type: 'initialize';
      protocolVersion: number;
      launchId: string;
    }
  | {
      type: 'sync-runtime-state';
      launchId: string;
      snapshot: AgentRuntimeSnapshot;
    }
  | {
      type: 'ping';
      launchId: string;
      requestId: string;
      sentAt: number;
    }
  | {
      type: 'shutdown';
      launchId: string;
      requestId: string;
      reason: string;
    }
  | {
      type: 'execute-openmanus';
      launchId: string;
      requestId: string;
      request: OpenManusExecutionRequest;
    }
  | {
      type: 'cancel-execution';
      launchId: string;
      requestId: string;
    }
  | {
      type: 'execute-agent-turn';
      launchId: string;
      requestId: string;
      request: IsolatedAgentTurnRequest;
    }
  | {
      type: 'cancel-agent-turn';
      launchId: string;
      requestId: string;
    }
  | {
      type: 'agent-model-call-event';
      launchId: string;
      turnRequestId: string;
      callId: string;
      event: IsolatedAgentModelStreamEvent;
    }
  | {
      type: 'agent-model-call-complete';
      launchId: string;
      turnRequestId: string;
      callId: string;
      result: IsolatedAgentModelCallResult;
    }
  | {
      type: 'agent-model-call-error';
      launchId: string;
      turnRequestId: string;
      callId: string;
      error: {
        message: string;
        stack?: string;
      };
    }
  | {
      type: 'agent-tool-call-complete';
      launchId: string;
      turnRequestId: string;
      callId: string;
      result: IsolatedAgentToolCallResult;
    }
  | {
      type: 'agent-tool-call-error';
      launchId: string;
      turnRequestId: string;
      callId: string;
      error: {
        message: string;
        stack?: string;
      };
    };

export type AgentHostToMainMessage =
  | {
      type: 'ready';
      protocolVersion: number;
      launchId: string;
      pid: number;
      startedAt: number;
    }
  | {
      type: 'heartbeat';
      launchId: string;
      sequence: number;
      sentAt: number;
      trackedAgentCount: number;
      workingAgentCount: number;
      stateRevision: number;
    }
  | {
      type: 'runtime-state-synced';
      launchId: string;
      revision: number;
    }
  | {
      type: 'pong';
      launchId: string;
      requestId: string;
      sentAt: number;
      receivedAt: number;
    }
  | {
      type: 'shutdown-complete';
      launchId: string;
      requestId: string;
    }
  | {
      type: 'fatal';
      launchId: string | null;
      message: string;
    }
  | {
      type: 'execution-complete';
      launchId: string;
      requestId: string;
      result: OpenManusExecutionResult;
    }
  | {
      type: 'execution-error';
      launchId: string;
      requestId: string;
      error: {
        message: string;
        stack?: string;
      };
    }
  | {
      type: 'agent-turn-event';
      launchId: string;
      requestId: string;
      event: IsolatedAgentTurnEvent;
    }
  | {
      type: 'agent-turn-complete';
      launchId: string;
      requestId: string;
      result: IsolatedAgentTurnResult;
    }
  | {
      type: 'agent-turn-error';
      launchId: string;
      requestId: string;
      error: {
        message: string;
        stack?: string;
      };
    }
  | {
      type: 'agent-model-call-request';
      launchId: string;
      turnRequestId: string;
      callId: string;
      request: IsolatedAgentModelCallRequest;
    }
  | {
      type: 'agent-tool-call-request';
      launchId: string;
      turnRequestId: string;
      callId: string;
      request: IsolatedAgentToolCallRequest;
    };

export function isAgentHostToMainMessage(
  value: unknown,
): value is AgentHostToMainMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'ready':
      return (
        isNonNegativeInteger(value.protocolVersion) &&
        isNonEmptyString(value.launchId) &&
        isNonNegativeInteger(value.pid) &&
        isFiniteNumber(value.startedAt)
      );
    case 'heartbeat':
      return (
        isNonEmptyString(value.launchId) &&
        isNonNegativeInteger(value.sequence) &&
        isFiniteNumber(value.sentAt) &&
        isNonNegativeInteger(value.trackedAgentCount) &&
        isNonNegativeInteger(value.workingAgentCount) &&
        isNonNegativeInteger(value.stateRevision)
      );
    case 'runtime-state-synced':
      return (
        isNonEmptyString(value.launchId) && isNonNegativeInteger(value.revision)
      );
    case 'pong':
      return (
        isNonEmptyString(value.launchId) &&
        isNonEmptyString(value.requestId) &&
        isFiniteNumber(value.sentAt) &&
        isFiniteNumber(value.receivedAt)
      );
    case 'shutdown-complete':
      return (
        isNonEmptyString(value.launchId) && isNonEmptyString(value.requestId)
      );
    case 'fatal':
      return (
        (value.launchId === null || isNonEmptyString(value.launchId)) &&
        typeof value.message === 'string'
      );
    case 'execution-complete':
      return (
        isNonEmptyString(value.launchId) &&
        isNonEmptyString(value.requestId) &&
        isOpenManusExecutionResult(value.result)
      );
    case 'execution-error':
      return (
        isNonEmptyString(value.launchId) &&
        isNonEmptyString(value.requestId) &&
        isSerializedError(value.error)
      );
    case 'agent-turn-event':
      return (
        isNonEmptyString(value.launchId) &&
        isNonEmptyString(value.requestId) &&
        isIsolatedAgentTurnEvent(value.event)
      );
    case 'agent-turn-complete':
      return (
        isNonEmptyString(value.launchId) &&
        isNonEmptyString(value.requestId) &&
        isIsolatedAgentTurnResult(value.result)
      );
    case 'agent-turn-error':
      return (
        isNonEmptyString(value.launchId) &&
        isNonEmptyString(value.requestId) &&
        isSerializedError(value.error)
      );
    case 'agent-model-call-request':
      return (
        isNonEmptyString(value.launchId) &&
        isNonEmptyString(value.turnRequestId) &&
        isNonEmptyString(value.callId) &&
        isIsolatedAgentModelCallRequest(value.request)
      );
    case 'agent-tool-call-request':
      return (
        isNonEmptyString(value.launchId) &&
        isNonEmptyString(value.turnRequestId) &&
        isNonEmptyString(value.callId) &&
        isIsolatedAgentToolCallRequest(value.request)
      );
    default:
      return false;
  }
}

export function isMainToAgentHostMessage(
  value: unknown,
): value is MainToAgentHostMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'initialize':
      return (
        isNonNegativeInteger(value.protocolVersion) &&
        isNonEmptyString(value.launchId)
      );
    case 'sync-runtime-state':
      return (
        isNonEmptyString(value.launchId) &&
        isAgentRuntimeSnapshot(value.snapshot)
      );
    case 'ping':
      return (
        isNonEmptyString(value.launchId) &&
        isNonEmptyString(value.requestId) &&
        isFiniteNumber(value.sentAt)
      );
    case 'shutdown':
      return (
        isNonEmptyString(value.launchId) &&
        isNonEmptyString(value.requestId) &&
        typeof value.reason === 'string'
      );
    case 'execute-openmanus':
      return (
        isNonEmptyString(value.launchId) &&
        isNonEmptyString(value.requestId) &&
        isOpenManusExecutionRequest(value.request)
      );
    case 'cancel-execution':
      return (
        isNonEmptyString(value.launchId) && isNonEmptyString(value.requestId)
      );
    case 'execute-agent-turn':
      return (
        isNonEmptyString(value.launchId) &&
        isNonEmptyString(value.requestId) &&
        isIsolatedAgentTurnRequest(value.request)
      );
    case 'cancel-agent-turn':
      return (
        isNonEmptyString(value.launchId) && isNonEmptyString(value.requestId)
      );
    case 'agent-model-call-event':
      return (
        isNonEmptyString(value.launchId) &&
        isNonEmptyString(value.turnRequestId) &&
        isNonEmptyString(value.callId) &&
        isIsolatedAgentModelStreamEvent(value.event)
      );
    case 'agent-model-call-complete':
      return (
        isNonEmptyString(value.launchId) &&
        isNonEmptyString(value.turnRequestId) &&
        isNonEmptyString(value.callId) &&
        isIsolatedAgentModelCallResult(value.result)
      );
    case 'agent-model-call-error':
    case 'agent-tool-call-error':
      return (
        isNonEmptyString(value.launchId) &&
        isNonEmptyString(value.turnRequestId) &&
        isNonEmptyString(value.callId) &&
        isSerializedError(value.error)
      );
    case 'agent-tool-call-complete':
      return (
        isNonEmptyString(value.launchId) &&
        isNonEmptyString(value.turnRequestId) &&
        isNonEmptyString(value.callId) &&
        isIsolatedAgentToolCallResult(value.result)
      );
    default:
      return false;
  }
}

function isAgentRuntimeSnapshot(value: unknown): value is AgentRuntimeSnapshot {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.revision) &&
    Array.isArray(value.agents) &&
    value.agents.every(isAgentRuntimeSummary)
  );
}

function isAgentRuntimeSummary(value: unknown): value is AgentRuntimeSummary {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.type) &&
    (value.parentAgentInstanceId === null ||
      isNonEmptyString(value.parentAgentInstanceId)) &&
    typeof value.isWorking === 'boolean' &&
    isNonNegativeInteger(value.historyLength) &&
    isNonNegativeInteger(value.queuedMessageCount) &&
    (value.lastMessageId === null || isNonEmptyString(value.lastMessageId))
  );
}

function isOpenManusExecutionRequest(
  value: unknown,
): value is OpenManusExecutionRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['prompt', 'mountPrefix', 'timeoutMs', 'maxTokens']) &&
    isNonEmptyString(value.prompt) &&
    isNonEmptyString(value.mountPrefix) &&
    isPositiveInteger(value.timeoutMs) &&
    isPositiveInteger(value.maxTokens)
  );
}

function isOpenManusExecutionResult(
  value: unknown,
): value is OpenManusExecutionResult {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      [
        'message',
        'exitCode',
        'signal',
        'timedOut',
        'mountPrefix',
        'runtimeId',
        'stdout',
        'stderr',
      ],
      ['signal'],
    ) &&
    typeof value.message === 'string' &&
    (value.exitCode === null || Number.isInteger(value.exitCode)) &&
    (value.signal === undefined || typeof value.signal === 'string') &&
    typeof value.timedOut === 'boolean' &&
    isNonEmptyString(value.mountPrefix) &&
    isNonEmptyString(value.runtimeId) &&
    typeof value.stdout === 'string' &&
    typeof value.stderr === 'string'
  );
}

function isSerializedError(
  value: unknown,
): value is { message: string; stack?: string } {
  return (
    isRecord(value) &&
    typeof value.message === 'string' &&
    (value.stack === undefined || typeof value.stack === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): boolean {
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Object.keys(value);
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  return (
    keys.every((key) => allowedSet.has(key)) &&
    allowed.every((key) => optionalSet.has(key) || keys.includes(key))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}
