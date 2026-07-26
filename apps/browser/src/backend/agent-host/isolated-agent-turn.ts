export type AgentTurnJsonPrimitive = string | number | boolean | null;
export type AgentTurnJsonValue =
  | AgentTurnJsonPrimitive
  | AgentTurnJsonValue[]
  | { [key: string]: AgentTurnJsonValue };
export type AgentTurnJsonObject = {
  [key: string]: AgentTurnJsonValue;
};

export interface IsolatedAgentToolDefinition {
  name: string;
  description?: string;
  inputSchema: AgentTurnJsonObject;
  strict?: boolean;
}

export interface IsolatedAgentToolCall {
  toolCallId: string;
  toolName: string;
  input: AgentTurnJsonValue;
}

export type IsolatedAgentToolCallRejectionKind =
  | 'truncated-input'
  | 'invalid-input'
  | 'unknown-tool';

export interface IsolatedAgentRejectedToolCall {
  toolCallId: string;
  /** Host-verified advertised name, otherwise the literal `unknown`. */
  toolName: string;
  kind: IsolatedAgentToolCallRejectionKind;
  /** Bounded canonical diagnostic; never includes the rejected input. */
  message: string;
}

export function createIsolatedToolCallRejectionMessage(
  kind: IsolatedAgentToolCallRejectionKind,
): string {
  const guidance =
    kind === 'truncated-input'
      ? 'The call was not executed because its arguments were incomplete. Retry with smaller independent calls and split large edits into chunks.'
      : kind === 'unknown-tool'
        ? 'The call was not executed because the requested tool is unavailable. Use only tools advertised by the host.'
        : 'The call was not executed because its arguments were invalid. Regenerate one complete schema-valid input.';
  return `Recoverable tool call rejection (${kind}): ${guidance}`;
}

const DUPLICATE_TOOL_CALL_ID_REJECTION_MESSAGE =
  'Recoverable tool call rejection (invalid-input): The call was not executed because the provider reused a tool-call identifier within one model step. Regenerate the calls with unique identifiers.';

/**
 * Removes every executable call whose provider id is ambiguous within one
 * model step. The check includes already-rejected calls so a provider cannot
 * pair one invalid call with one executable call under the same id.
 *
 * Duplicate ids collapse approval state, UI parts, timings, and evidence when
 * they are allowed to cross the host boundary. Emit one bounded rejection per
 * duplicated id instead; never reflect provider inputs into the diagnostic.
 */
export function rejectDuplicateIsolatedToolCallIds(
  toolCalls: readonly IsolatedAgentToolCall[],
  rejectedToolCalls: readonly IsolatedAgentRejectedToolCall[] | undefined,
  allowedToolNames: ReadonlySet<string>,
): {
  toolCalls: IsolatedAgentToolCall[];
  rejectedToolCalls: IsolatedAgentRejectedToolCall[];
} {
  const rejected = rejectedToolCalls ?? [];
  const occurrences = new Map<string, number>();
  const orderedIds: string[] = [];
  for (const call of [...toolCalls, ...rejected]) {
    if (!occurrences.has(call.toolCallId)) orderedIds.push(call.toolCallId);
    occurrences.set(
      call.toolCallId,
      (occurrences.get(call.toolCallId) ?? 0) + 1,
    );
  }

  const duplicateIds = new Set(
    orderedIds.filter((toolCallId) => (occurrences.get(toolCallId) ?? 0) > 1),
  );
  if (duplicateIds.size === 0) {
    return {
      toolCalls: [...toolCalls],
      rejectedToolCalls: [...rejected],
    };
  }

  const allCalls = [...toolCalls, ...rejected];
  const duplicateRejections = orderedIds
    .filter((toolCallId) => duplicateIds.has(toolCallId))
    .map((toolCallId): IsolatedAgentRejectedToolCall => {
      const names = new Set(
        allCalls
          .filter((call) => call.toolCallId === toolCallId)
          .map((call) => call.toolName),
      );
      const onlyName = names.size === 1 ? names.values().next().value : null;
      return {
        toolCallId,
        toolName:
          typeof onlyName === 'string' && allowedToolNames.has(onlyName)
            ? onlyName
            : 'unknown',
        kind: 'invalid-input',
        message: DUPLICATE_TOOL_CALL_ID_REJECTION_MESSAGE,
      };
    });

  return {
    toolCalls: toolCalls.filter((call) => !duplicateIds.has(call.toolCallId)),
    rejectedToolCalls: [
      ...rejected.filter((call) => !duplicateIds.has(call.toolCallId)),
      ...duplicateRejections,
    ],
  };
}

export interface IsolatedAgentFileEditBatchMember {
  memberId: string;
  toolCallId: string;
}

export interface IsolatedAgentFileEditBatchMetadata {
  batchId: string;
  memberId: string;
  members: IsolatedAgentFileEditBatchMember[];
}

export type IsolatedAgentConversationMessage =
  | {
      role: 'user';
      content: string;
    }
  | {
      role: 'assistant';
      text: string;
      toolCalls: IsolatedAgentToolCall[];
    }
  | {
      role: 'tool';
      toolCallId: string;
      toolName: string;
      output: AgentTurnJsonValue;
    };

export interface IsolatedAgentTurnRequest {
  agentInstanceId: string;
  modelId: string;
  traceId: string;
  metadata: AgentTurnJsonObject;
  systemPrompt: string;
  messages: IsolatedAgentConversationMessage[];
  tools: IsolatedAgentToolDefinition[];
  maxSteps: number;
  settings?: {
    maxOutputTokens?: number;
    temperature?: number;
  };
}

export interface IsolatedAgentModelCallRequest {
  agentInstanceId: string;
  modelId: string;
  traceId: string;
  metadata: AgentTurnJsonObject;
  systemPrompt: string;
  messages: IsolatedAgentConversationMessage[];
  tools: IsolatedAgentToolDefinition[];
  settings?: IsolatedAgentTurnRequest['settings'];
}

export type IsolatedAgentModelStreamEvent =
  | {
      type: 'text-delta';
      text: string;
    }
  | {
      type: 'reasoning-delta';
      text: string;
    };

export interface IsolatedAgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  noCacheInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  textOutputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface IsolatedAgentModelCallResult {
  text: string;
  reasoning: string;
  toolCalls: IsolatedAgentToolCall[];
  rejectedToolCalls?: IsolatedAgentRejectedToolCall[];
  finishReason: string;
  rawFinishReason?: string;
  usage: IsolatedAgentUsage;
  providerMetadata?: AgentTurnJsonObject;
}

export interface IsolatedAgentToolCallRequest {
  agentInstanceId: string;
  call: IsolatedAgentToolCall;
  messages: IsolatedAgentConversationMessage[];
  /** Serializable only. The main process derives the host capability. */
  fileEditBatch?: IsolatedAgentFileEditBatchMetadata;
}

export type IsolatedAgentToolCallResult =
  | {
      status?: 'completed';
      output: AgentTurnJsonValue;
    }
  | {
      status: 'approval-required';
      approvalId: string;
    }
  | {
      status: 'error';
      message: string;
    };

export interface IsolatedAgentTurnStepResult {
  index: number;
  text: string;
  reasoning: string;
  finishReason: string;
  rawFinishReason?: string;
  usage: IsolatedAgentUsage;
  providerMetadata?: AgentTurnJsonObject;
  toolCalls: IsolatedAgentToolCall[];
  rejectedToolCalls?: IsolatedAgentRejectedToolCall[];
  toolResults: Array<{
    toolCallId: string;
    toolName: string;
    output: AgentTurnJsonValue;
  }>;
  toolErrors: Array<{
    toolCallId: string;
    toolName: string;
    message: string;
  }>;
  approvalRequests: Array<{
    approvalId: string;
    toolCallId: string;
    toolName: string;
  }>;
}

export type IsolatedAgentTurnEvent =
  | {
      type: 'step-started';
      step: number;
    }
  | {
      type: 'text-delta';
      step: number;
      text: string;
    }
  | {
      type: 'reasoning-delta';
      step: number;
      text: string;
    }
  | {
      type: 'tool-call';
      step: number;
      call: IsolatedAgentToolCall;
    }
  | {
      type: 'tool-result';
      step: number;
      toolCallId: string;
      toolName: string;
      output: AgentTurnJsonValue;
    }
  | {
      type: 'tool-error';
      step: number;
      toolCallId: string;
      toolName: string;
      message: string;
    }
  | {
      type: 'tool-approval-request';
      step: number;
      approvalId: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: 'step-finished';
      step: number;
      finishReason: string;
      usage: IsolatedAgentUsage;
    };

export interface IsolatedAgentTurnResult {
  status: 'completed' | 'max-steps';
  text: string;
  messages: IsolatedAgentConversationMessage[];
  steps: IsolatedAgentTurnStepResult[];
}

export interface AgentTurnHostHandlers {
  callModel(
    request: IsolatedAgentModelCallRequest,
    options: {
      signal: AbortSignal;
      onEvent: (event: IsolatedAgentModelStreamEvent) => void;
    },
  ): Promise<IsolatedAgentModelCallResult>;
  callTool(
    request: IsolatedAgentToolCallRequest,
    options: {
      signal: AbortSignal;
    },
  ): Promise<IsolatedAgentToolCallResult>;
}

export function isIsolatedAgentTurnRequest(
  value: unknown,
): value is IsolatedAgentTurnRequest {
  return (
    isRecord(value) &&
    isNonEmptyString(value.agentInstanceId) &&
    isNonEmptyString(value.modelId) &&
    isNonEmptyString(value.traceId) &&
    isAgentTurnJsonObject(value.metadata) &&
    typeof value.systemPrompt === 'string' &&
    Array.isArray(value.messages) &&
    value.messages.every(isIsolatedAgentConversationMessage) &&
    Array.isArray(value.tools) &&
    value.tools.every(isIsolatedAgentToolDefinition) &&
    isPositiveInteger(value.maxSteps) &&
    value.maxSteps <= 16 &&
    (value.settings === undefined || isIsolatedAgentSettings(value.settings))
  );
}

export function isIsolatedAgentModelCallRequest(
  value: unknown,
): value is IsolatedAgentModelCallRequest {
  return (
    isRecord(value) &&
    isNonEmptyString(value.agentInstanceId) &&
    isNonEmptyString(value.modelId) &&
    isNonEmptyString(value.traceId) &&
    isAgentTurnJsonObject(value.metadata) &&
    typeof value.systemPrompt === 'string' &&
    Array.isArray(value.messages) &&
    value.messages.every(isIsolatedAgentConversationMessage) &&
    Array.isArray(value.tools) &&
    value.tools.every(isIsolatedAgentToolDefinition) &&
    (value.settings === undefined || isIsolatedAgentSettings(value.settings))
  );
}

export function isIsolatedAgentModelStreamEvent(
  value: unknown,
): value is IsolatedAgentModelStreamEvent {
  return (
    isRecord(value) &&
    (value.type === 'text-delta' || value.type === 'reasoning-delta') &&
    typeof value.text === 'string'
  );
}

export function isIsolatedAgentModelCallResult(
  value: unknown,
): value is IsolatedAgentModelCallResult {
  return (
    isRecord(value) &&
    typeof value.text === 'string' &&
    typeof value.reasoning === 'string' &&
    Array.isArray(value.toolCalls) &&
    value.toolCalls.every(isIsolatedAgentToolCall) &&
    (value.rejectedToolCalls === undefined ||
      (Array.isArray(value.rejectedToolCalls) &&
        value.rejectedToolCalls.every(isIsolatedAgentRejectedToolCall))) &&
    typeof value.finishReason === 'string' &&
    (value.rawFinishReason === undefined ||
      typeof value.rawFinishReason === 'string') &&
    (value.providerMetadata === undefined ||
      isAgentTurnJsonObject(value.providerMetadata)) &&
    isIsolatedAgentUsage(value.usage)
  );
}

export function isIsolatedAgentToolCallRequest(
  value: unknown,
): value is IsolatedAgentToolCallRequest {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.agentInstanceId) ||
    !isIsolatedAgentToolCall(value.call) ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isIsolatedAgentConversationMessage)
  ) {
    return false;
  }
  if (value.fileEditBatch === undefined) return true;
  return (
    (value.call.toolName === 'write' || value.call.toolName === 'multiEdit') &&
    isIsolatedAgentFileEditBatchMetadata(value.fileEditBatch, value.call)
  );
}

export function isIsolatedAgentToolCallResult(
  value: unknown,
): value is IsolatedAgentToolCallResult {
  if (!isRecord(value)) return false;
  if (value.status === 'approval-required') {
    return isNonEmptyString(value.approvalId);
  }
  if (value.status === 'error') {
    return typeof value.message === 'string';
  }
  return (
    (value.status === undefined || value.status === 'completed') &&
    isAgentTurnJsonValue(value.output)
  );
}

export function isIsolatedAgentTurnEvent(
  value: unknown,
): value is IsolatedAgentTurnEvent {
  if (!isRecord(value) || !isPositiveInteger(value.step)) return false;
  switch (value.type) {
    case 'step-started':
      return true;
    case 'text-delta':
    case 'reasoning-delta':
      return typeof value.text === 'string';
    case 'tool-call':
      return isIsolatedAgentToolCall(value.call);
    case 'tool-result':
      return (
        isNonEmptyString(value.toolCallId) &&
        isNonEmptyString(value.toolName) &&
        isAgentTurnJsonValue(value.output)
      );
    case 'tool-error':
      return (
        isNonEmptyString(value.toolCallId) &&
        isNonEmptyString(value.toolName) &&
        typeof value.message === 'string'
      );
    case 'tool-approval-request':
      return (
        isNonEmptyString(value.approvalId) &&
        isNonEmptyString(value.toolCallId) &&
        isNonEmptyString(value.toolName)
      );
    case 'step-finished':
      return (
        typeof value.finishReason === 'string' &&
        isIsolatedAgentUsage(value.usage)
      );
    default:
      return false;
  }
}

export function isIsolatedAgentTurnResult(
  value: unknown,
): value is IsolatedAgentTurnResult {
  return (
    isRecord(value) &&
    (value.status === 'completed' || value.status === 'max-steps') &&
    typeof value.text === 'string' &&
    Array.isArray(value.messages) &&
    value.messages.every(isIsolatedAgentConversationMessage) &&
    Array.isArray(value.steps) &&
    value.steps.every(isIsolatedAgentTurnStepResult)
  );
}

export function isAgentTurnJsonValue(
  value: unknown,
): value is AgentTurnJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isAgentTurnJsonValue);
  return isAgentTurnJsonObject(value);
}

export function isAgentTurnJsonObject(
  value: unknown,
): value is AgentTurnJsonObject {
  return isRecord(value) && Object.values(value).every(isAgentTurnJsonValue);
}

function isIsolatedAgentToolDefinition(
  value: unknown,
): value is IsolatedAgentToolDefinition {
  return (
    isRecord(value) &&
    isNonEmptyString(value.name) &&
    (value.description === undefined ||
      typeof value.description === 'string') &&
    isAgentTurnJsonObject(value.inputSchema) &&
    (value.strict === undefined || typeof value.strict === 'boolean')
  );
}

function isIsolatedAgentToolCall(
  value: unknown,
): value is IsolatedAgentToolCall {
  return (
    isRecord(value) &&
    isNonEmptyString(value.toolCallId) &&
    isNonEmptyString(value.toolName) &&
    isAgentTurnJsonValue(value.input)
  );
}

function isIsolatedAgentRejectedToolCall(
  value: unknown,
): value is IsolatedAgentRejectedToolCall {
  return (
    isRecord(value) &&
    isNonEmptyString(value.toolCallId) &&
    isNonEmptyString(value.toolName) &&
    (value.kind === 'truncated-input' ||
      value.kind === 'invalid-input' ||
      value.kind === 'unknown-tool') &&
    typeof value.message === 'string'
  );
}

function isIsolatedAgentFileEditBatchMetadata(
  value: unknown,
  call: IsolatedAgentToolCall,
): value is IsolatedAgentFileEditBatchMetadata {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.batchId) ||
    !isNonEmptyString(value.memberId) ||
    !Array.isArray(value.members) ||
    value.members.length < 2 ||
    value.members.length > 64
  ) {
    return false;
  }

  const memberIds = new Set<string>();
  let currentMemberMatches = false;
  for (const member of value.members) {
    if (
      !isRecord(member) ||
      !isNonEmptyString(member.memberId) ||
      !isNonEmptyString(member.toolCallId) ||
      memberIds.has(member.memberId)
    ) {
      return false;
    }
    memberIds.add(member.memberId);
    if (member.memberId === value.memberId) {
      if (member.toolCallId !== call.toolCallId) return false;
      currentMemberMatches = true;
    }
  }
  return currentMemberMatches;
}

function isIsolatedAgentConversationMessage(
  value: unknown,
): value is IsolatedAgentConversationMessage {
  if (!isRecord(value)) return false;
  switch (value.role) {
    case 'user':
      return typeof value.content === 'string';
    case 'assistant':
      return (
        typeof value.text === 'string' &&
        Array.isArray(value.toolCalls) &&
        value.toolCalls.every(isIsolatedAgentToolCall)
      );
    case 'tool':
      return (
        isNonEmptyString(value.toolCallId) &&
        isNonEmptyString(value.toolName) &&
        isAgentTurnJsonValue(value.output)
      );
    default:
      return false;
  }
}

function isIsolatedAgentTurnStepResult(
  value: unknown,
): value is IsolatedAgentTurnStepResult {
  return (
    isRecord(value) &&
    isPositiveInteger(value.index) &&
    typeof value.text === 'string' &&
    typeof value.reasoning === 'string' &&
    typeof value.finishReason === 'string' &&
    (value.rawFinishReason === undefined ||
      typeof value.rawFinishReason === 'string') &&
    isIsolatedAgentUsage(value.usage) &&
    (value.providerMetadata === undefined ||
      isAgentTurnJsonObject(value.providerMetadata)) &&
    Array.isArray(value.toolCalls) &&
    value.toolCalls.every(isIsolatedAgentToolCall) &&
    (value.rejectedToolCalls === undefined ||
      (Array.isArray(value.rejectedToolCalls) &&
        value.rejectedToolCalls.every(isIsolatedAgentRejectedToolCall))) &&
    Array.isArray(value.toolResults) &&
    value.toolResults.every(
      (result) =>
        isRecord(result) &&
        isNonEmptyString(result.toolCallId) &&
        isNonEmptyString(result.toolName) &&
        isAgentTurnJsonValue(result.output),
    ) &&
    Array.isArray(value.toolErrors) &&
    value.toolErrors.every(
      (result) =>
        isRecord(result) &&
        isNonEmptyString(result.toolCallId) &&
        isNonEmptyString(result.toolName) &&
        typeof result.message === 'string',
    ) &&
    Array.isArray(value.approvalRequests) &&
    value.approvalRequests.every(
      (request) =>
        isRecord(request) &&
        isNonEmptyString(request.approvalId) &&
        isNonEmptyString(request.toolCallId) &&
        isNonEmptyString(request.toolName),
    )
  );
}

function isIsolatedAgentSettings(
  value: unknown,
): value is NonNullable<IsolatedAgentTurnRequest['settings']> {
  return (
    isRecord(value) &&
    (value.maxOutputTokens === undefined ||
      isPositiveInteger(value.maxOutputTokens)) &&
    (value.temperature === undefined || isFiniteNumber(value.temperature))
  );
}

function isIsolatedAgentUsage(value: unknown): value is IsolatedAgentUsage {
  return (
    isRecord(value) &&
    isOptionalNonNegativeNumber(value.inputTokens) &&
    isOptionalNonNegativeNumber(value.outputTokens) &&
    isOptionalNonNegativeNumber(value.totalTokens) &&
    isOptionalNonNegativeNumber(value.noCacheInputTokens) &&
    isOptionalNonNegativeNumber(value.cacheReadInputTokens) &&
    isOptionalNonNegativeNumber(value.cacheWriteInputTokens) &&
    isOptionalNonNegativeNumber(value.textOutputTokens) &&
    isOptionalNonNegativeNumber(value.reasoningOutputTokens)
  );
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return (
    value === undefined || (isFiniteNumber(value) && (value as number) >= 0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}
