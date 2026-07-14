import type { DynamicToolUIPart } from 'ai';
import { clearPendingApproval } from '../../../agents/shared/pending-approvals-cleanup';
import type { AgentStore } from '../../../store/agent-store';
import type { AgentState, AgentToolUIPart } from '../../../types/agent';
import type { UserMessageMetadata } from '../../../types/metadata';
import { updateAgentInstanceState } from './internal';

type ToolPart = AgentToolUIPart | DynamicToolUIPart;

/** A tool part whose approval is still awaiting an explicit response. */
export type ApprovalRequestedToolPart = ToolPart & {
  state: 'approval-requested';
  input: unknown;
  approval: {
    id: string;
    approved?: never;
    reason?: never;
  };
};

/**
 * Exact history binding captured before a host starts an asynchronous
 * approval prepare phase. The detached input prevents a host callback from
 * mutating AgentStore through an aliased object reference.
 */
export interface ApprovalRequestBinding {
  readonly approvalId: string;
  readonly messageId: string;
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

/** Detached snapshot of one pending approval request. */
export interface ApprovalRequestSnapshot extends ApprovalRequestBinding {
  readonly originalPart: ApprovalRequestedToolPart;
}

/**
 * Previous value of the ephemeral pending-approval index. `present` is kept
 * separately so rollback can faithfully distinguish a missing property from
 * an (invalid but representable at runtime) own property whose value is
 * `undefined`.
 */
export type PendingApprovalBefore =
  | { readonly present: false }
  | {
      readonly present: true;
      readonly value: { explanation: string } | undefined;
    };

/** Exact receipt required to reverse one approval response mutation. */
export interface ApprovalResolutionReceipt extends ApprovalRequestBinding {
  readonly approved: boolean;
  readonly reason?: string;
  readonly originalPart: ApprovalRequestedToolPart;
  readonly pendingApprovalBefore: PendingApprovalBefore;
}

/**
 * Carries the precomputed rollback receipt when AgentStore committed the
 * mutation but a synchronous subscriber threw before `resolveApproval` could
 * return normally.
 */
export class ApprovalResolutionMutationError extends Error {
  public readonly receipt: ApprovalResolutionReceipt;

  public constructor(receipt: ApprovalResolutionReceipt, cause: unknown) {
    super('Approval response mutation did not settle cleanly', { cause });
    this.name = 'ApprovalResolutionMutationError';
    this.receipt = receipt;
  }
}

export interface ResolveApprovalArgs {
  readonly approvalId: string;
  readonly approved: boolean;
  readonly reason?: string;
  /**
   * Optional for backward compatibility with existing callers. Durable
   * approval paths pass the snapshot captured before broker preparation so a
   * stale/rebound request fails closed after the await boundary.
   */
  readonly expected?: ApprovalRequestBinding;
}

function isToolPart(part: { type: string }): boolean {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-');
}

function isApprovalRequestedToolPart(part: {
  type: string;
}): part is ApprovalRequestedToolPart {
  if (!isToolPart(part)) return false;
  return (part as ToolPart).state === 'approval-requested';
}

function getToolName(part: ApprovalRequestedToolPart): string {
  const toolName =
    part.type === 'dynamic-tool'
      ? part.toolName
      : part.type.slice('tool-'.length);
  if (typeof toolName !== 'string' || toolName.length === 0) {
    throw new Error(
      `approval-state: malformed approval '${part.approval.id}' has no tool name`,
    );
  }
  return toolName;
}

function cloneDetached<T>(value: T, source: string): T {
  try {
    return structuredClone(value);
  } catch {
    throw new Error(
      `approval-state.${source}: approval snapshot is not structured-cloneable`,
    );
  }
}

/**
 * Structural comparison for detached JSON-like tool inputs. It never reads a
 * property through normal `obj[key]` access, calls `toJSON`, or invokes an
 * accessor. Non-plain object instances fail closed unless they are the exact
 * same reference.
 */
function structurallyEqualWithoutAccessors(
  left: unknown,
  right: unknown,
  leftToRight = new WeakMap<object, object>(),
  rightToLeft = new WeakMap<object, object>(),
): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== 'object' ||
    left === null ||
    typeof right !== 'object' ||
    right === null
  ) {
    return false;
  }

  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;

  const leftPrototype = Object.getPrototypeOf(left);
  const rightPrototype = Object.getPrototypeOf(right);
  if (leftPrototype !== rightPrototype) return false;
  if (
    !leftIsArray &&
    leftPrototype !== Object.prototype &&
    leftPrototype !== null
  ) {
    return false;
  }

  const mappedRight = leftToRight.get(left);
  if (mappedRight) return mappedRight === right;
  const mappedLeft = rightToLeft.get(right);
  if (mappedLeft) return mappedLeft === left;
  leftToRight.set(left, right);
  rightToLeft.set(right, left);

  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  for (const key of leftKeys) {
    const leftDescriptor = Object.getOwnPropertyDescriptor(left, key);
    const rightDescriptor = Object.getOwnPropertyDescriptor(right, key);
    if (!leftDescriptor || !rightDescriptor) return false;
    if (!('value' in leftDescriptor) || !('value' in rightDescriptor)) {
      return false;
    }
    if (
      !structurallyEqualWithoutAccessors(
        leftDescriptor.value,
        rightDescriptor.value,
        leftToRight,
        rightToLeft,
      )
    ) {
      return false;
    }
  }

  return true;
}

function requireAgentState(
  store: AgentStore,
  agentInstanceId: string,
  source: string,
): AgentState {
  const entry = store.get().agents.instances[agentInstanceId];
  if (!entry) {
    throw new Error(
      `approval-state.${source}: unknown agent instance id '${agentInstanceId}'`,
    );
  }
  return entry.state;
}

function createApprovalRequestSnapshot(args: {
  part: ApprovalRequestedToolPart;
  messageId: string;
  messageIndex: number;
  partIndex: number;
  source: string;
}): ApprovalRequestSnapshot {
  const { part } = args;
  const approvalId = part.approval?.id;
  if (typeof approvalId !== 'string' || approvalId.length === 0) {
    throw new Error(
      `approval-state.${args.source}: malformed approval request has no approval id`,
    );
  }
  if (typeof part.toolCallId !== 'string' || part.toolCallId.length === 0) {
    throw new Error(
      `approval-state.${args.source}: malformed approval '${approvalId}' has no tool-call id`,
    );
  }

  const originalPart = cloneDetached(part, args.source);
  return {
    approvalId,
    messageId: args.messageId,
    messageIndex: args.messageIndex,
    partIndex: args.partIndex,
    toolCallId: part.toolCallId,
    toolName: getToolName(part),
    input: cloneDetached(part.input, args.source),
    originalPart,
  };
}

function assertExpectedBinding(
  actual: ApprovalRequestBinding,
  expected: ApprovalRequestBinding,
): void {
  const scalarBindings: Array<keyof Omit<ApprovalRequestBinding, 'input'>> = [
    'approvalId',
    'messageId',
    'messageIndex',
    'partIndex',
    'toolCallId',
    'toolName',
  ];
  for (const field of scalarBindings) {
    if (actual[field] !== expected[field]) {
      throw new Error(
        `approval-state.resolveApproval: stale approval binding for '${actual.approvalId}' (${field})`,
      );
    }
  }
  if (!structurallyEqualWithoutAccessors(actual.input, expected.input)) {
    throw new Error(
      `approval-state.resolveApproval: stale approval binding for '${actual.approvalId}' (input)`,
    );
  }
}

function snapshotPendingApprovalBefore(
  state: AgentState,
  toolCallId: string,
): PendingApprovalBefore {
  if (!Object.hasOwn(state.pendingApprovals, toolCallId)) {
    return { present: false };
  }
  return {
    present: true,
    value: cloneDetached(state.pendingApprovals[toolCallId], 'resolveApproval'),
  };
}

function pendingApprovalMatchesBefore(
  state: AgentState,
  receipt: ApprovalResolutionReceipt,
): boolean {
  const present = Object.hasOwn(state.pendingApprovals, receipt.toolCallId);
  if (present !== receipt.pendingApprovalBefore.present) return false;
  if (!present || !receipt.pendingApprovalBefore.present) return true;
  return structurallyEqualWithoutAccessors(
    state.pendingApprovals[receipt.toolCallId],
    receipt.pendingApprovalBefore.value,
  );
}

function approvalRequestRemainsUnchanged(
  store: AgentStore,
  agentInstanceId: string,
  receipt: ApprovalResolutionReceipt,
): boolean {
  const state = store.get().agents.instances[agentInstanceId]?.state;
  const message = state?.history[receipt.messageIndex];
  const part = message?.parts[receipt.partIndex];
  return Boolean(
    state &&
      message?.role === 'assistant' &&
      message.id === receipt.messageId &&
      part &&
      isApprovalRequestedToolPart(part) &&
      structurallyEqualWithoutAccessors(part, receipt.originalPart) &&
      pendingApprovalMatchesBefore(state, receipt),
  );
}

/**
 * Finds exactly one pending request for `approvalId` and returns a detached,
 * index-bound snapshot. Unknown and ambiguous ids are errors rather than
 * silent no-ops.
 */
export function snapshotApprovalRequest(
  store: AgentStore,
  agentInstanceId: string,
  args: { approvalId: string },
): ApprovalRequestSnapshot {
  if (args.approvalId.length === 0) {
    throw new Error(
      'approval-state.snapshotApprovalRequest: approval id must not be empty',
    );
  }

  const state = requireAgentState(
    store,
    agentInstanceId,
    'snapshotApprovalRequest',
  );
  const matches: Array<{
    part: ApprovalRequestedToolPart;
    messageId: string;
    messageIndex: number;
    partIndex: number;
  }> = [];

  for (
    let messageIndex = 0;
    messageIndex < state.history.length;
    messageIndex++
  ) {
    const message = state.history[messageIndex]!;
    if (message.role !== 'assistant') continue;
    for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
      const part = message.parts[partIndex]!;
      if (!isApprovalRequestedToolPart(part)) continue;
      if (part.approval.id !== args.approvalId) continue;
      matches.push({
        part,
        messageId: message.id,
        messageIndex,
        partIndex,
      });
    }
  }

  if (matches.length === 0) {
    throw new Error(
      `approval-state.snapshotApprovalRequest: no approval-requested tool part found for approval id '${args.approvalId}'`,
    );
  }
  if (matches.length !== 1) {
    throw new Error(
      `approval-state.snapshotApprovalRequest: ambiguous approval id '${args.approvalId}' matched ${matches.length} approval-requested tool parts`,
    );
  }
  return createApprovalRequestSnapshot({
    ...matches[0]!,
    source: 'snapshotApprovalRequest',
  });
}

/** Captures every currently pending request for lifecycle invalidation. */
export function snapshotPendingApprovalRequests(
  store: AgentStore,
  agentInstanceId: string,
): ApprovalRequestSnapshot[] {
  const state = requireAgentState(
    store,
    agentInstanceId,
    'snapshotPendingApprovalRequests',
  );
  const snapshots: ApprovalRequestSnapshot[] = [];

  for (
    let messageIndex = 0;
    messageIndex < state.history.length;
    messageIndex++
  ) {
    const message = state.history[messageIndex]!;
    if (message.role !== 'assistant') continue;
    for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
      const part = message.parts[partIndex]!;
      if (!isApprovalRequestedToolPart(part)) continue;
      snapshots.push(
        createApprovalRequestSnapshot({
          part,
          messageId: message.id,
          messageIndex,
          partIndex,
          source: 'snapshotPendingApprovalRequests',
        }),
      );
    }
  }

  return snapshots;
}

/** Returns unique pending tool-call ids in their history order. */
export function snapshotPendingApprovalToolCallIds(
  store: AgentStore,
  agentInstanceId: string,
): string[] {
  const state = requireAgentState(
    store,
    agentInstanceId,
    'snapshotPendingApprovalToolCallIds',
  );
  const toolCallIds = new Set<string>();
  for (const message of state.history) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (!isApprovalRequestedToolPart(part)) continue;
      if (typeof part.toolCallId !== 'string' || part.toolCallId.length === 0) {
        throw new Error(
          `approval-state.snapshotPendingApprovalToolCallIds: malformed approval '${part.approval.id}' has no tool-call id`,
        );
      }
      toolCallIds.add(part.toolCallId);
    }
  }
  return [...toolCallIds];
}

/**
 * Tool-approval state-machine transitions. Each call wraps exactly one
 * `store.update()`. These are the "Bucket C" complex transforms that
 * walk message history and rewrite tool parts in place.
 *
 * Tool-part states considered effect-terminal by the approval/error sweeps.
 * `approval-responded` is deliberately excluded: a decision is not an effect,
 * so stop/new-message must still close it before execution can resume.
 */
const TERMINAL_TOOL_STATES = new Set([
  'output-available',
  'output-error',
  'output-denied',
]);

export interface ApprovalSweepReceipt {
  readonly changed: boolean;
  readonly dirtyMessageIndices: readonly number[];
}

/**
 * Walk every assistant message in history and force-terminate every
 * non-terminal tool part. Used by the stop / interrupt paths so a
 * cancelled turn leaves no dangling pending-approval entries.
 */
export function denyAllNonTerminalToolPartsInHistory(
  store: AgentStore,
  agentInstanceId: string,
  args: { approvalDenyReason: string; forceErrorText: string },
): ApprovalSweepReceipt {
  const dirtyMessageIndices = new Set<number>();
  let pendingApprovalsChanged = false;
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    for (
      let messageIndex = 0;
      messageIndex < state.history.length;
      messageIndex++
    ) {
      const historyMsg = state.history[messageIndex]!;
      if (historyMsg.role !== 'assistant') continue;
      for (let i = 0; i < historyMsg.parts.length; i++) {
        const p = historyMsg.parts[i]!;
        if (!(p.type.startsWith('tool-') || p.type === 'dynamic-tool')) {
          continue;
        }
        const toolPart = p as AgentToolUIPart | DynamicToolUIPart;
        if (TERMINAL_TOOL_STATES.has(toolPart.state)) continue;

        clearPendingApproval(state.pendingApprovals, toolPart.toolCallId);

        if (toolPart.state === 'approval-requested') {
          const updatedToolPart: AgentToolUIPart | DynamicToolUIPart = {
            ...toolPart,
            state: 'output-denied' as const,
            approval: {
              ...toolPart.approval!,
              approved: false,
              reason: args.approvalDenyReason,
            },
          } as AgentToolUIPart | DynamicToolUIPart;
          historyMsg.parts[i] =
            updatedToolPart as unknown as (typeof historyMsg.parts)[number];
        } else {
          const updatedToolPart: AgentToolUIPart | DynamicToolUIPart = {
            ...toolPart,
            state: 'output-error',
            input: toolPart.input ?? {},
            approval: undefined,
            errorText: args.forceErrorText,
          } as AgentToolUIPart | DynamicToolUIPart;
          historyMsg.parts[i] =
            updatedToolPart as unknown as (typeof historyMsg.parts)[number];
        }
        dirtyMessageIndices.add(messageIndex);
      }
    }
    const orphanedToolCallIds = Object.keys(state.pendingApprovals);
    if (orphanedToolCallIds.length > 0) {
      pendingApprovalsChanged = true;
      for (const toolCallId of orphanedToolCallIds) {
        delete state.pendingApprovals[toolCallId];
      }
    }
  });
  return {
    changed: dirtyMessageIndices.size > 0 || pendingApprovalsChanged,
    dirtyMessageIndices: [...dirtyMessageIndices],
  };
}

/**
 * Walk only the last assistant message's tool parts. Used by the
 * runloop's per-step error tail so a single failed step terminates
 * just the in-flight tool calls; cleans up trailing `reasoning` parts
 * and pops the whole message when nothing remains.
 */
export function terminateNonTerminalToolPartsInLastAssistant(
  store: AgentStore,
  agentInstanceId: string,
  args: { approvalDenyReason: string; outputErrorText: string },
): ApprovalSweepReceipt {
  let changed = false;
  let dirtyMessageIndex: number | undefined;
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    const lastMessageIndex = state.history.length - 1;
    const lastMsg = state.history[lastMessageIndex];
    if (lastMsg?.role !== 'assistant') {
      const orphanedToolCallIds = Object.keys(state.pendingApprovals);
      for (const toolCallId of orphanedToolCallIds) {
        delete state.pendingApprovals[toolCallId];
        changed = true;
      }
      return;
    }

    lastMsg.parts.forEach((p, index) => {
      if (p.type === 'dynamic-tool' || p.type.startsWith('tool-')) {
        const toolPart = p as AgentToolUIPart | DynamicToolUIPart;
        if (toolPart.state === 'approval-requested') {
          clearPendingApproval(state.pendingApprovals, toolPart.toolCallId);
          const updatedToolPart: AgentToolUIPart | DynamicToolUIPart = {
            ...toolPart,
            state: 'output-denied',
            approval: {
              ...toolPart.approval!,
              approved: false,
              reason: args.approvalDenyReason,
            },
          } as AgentToolUIPart | DynamicToolUIPart;
          lastMsg.parts[index] =
            updatedToolPart as unknown as (typeof lastMsg.parts)[number];
          changed = true;
        } else if (!TERMINAL_TOOL_STATES.has(toolPart.state)) {
          const updatedToolPart: AgentToolUIPart | DynamicToolUIPart = {
            ...toolPart,
            state: 'output-error',
            input: toolPart.input ?? {},
            approval: undefined,
            errorText: args.outputErrorText,
          } as AgentToolUIPart | DynamicToolUIPart;
          lastMsg.parts[index] =
            updatedToolPart as unknown as (typeof lastMsg.parts)[number];
          changed = true;
        }
      }
    });

    while (
      lastMsg.parts.length > 0 &&
      lastMsg.parts[lastMsg.parts.length - 1]!.type === 'reasoning'
    ) {
      lastMsg.parts.pop();
      (
        lastMsg.metadata as UserMessageMetadata | undefined
      )?.partsMetadata?.pop();
      changed = true;
    }

    if (lastMsg.parts.length === 0) {
      state.history.pop();
      changed = true;
    } else if (changed) {
      dirtyMessageIndex = lastMessageIndex;
    }

    const orphanedToolCallIds = Object.keys(state.pendingApprovals);
    for (const toolCallId of orphanedToolCallIds) {
      delete state.pendingApprovals[toolCallId];
      changed = true;
    }
  });
  return {
    changed,
    dirtyMessageIndices:
      dirtyMessageIndex === undefined ? [] : [dirtyMessageIndex],
  };
}

/**
 * Resolves exactly one pending approval and returns the receipt needed for a
 * precise rollback. `expected` binds an earlier prepare-phase snapshot to the
 * exact message, part, tool call, tool name, and structurally-equal input.
 */
export function resolveApproval(
  store: AgentStore,
  agentInstanceId: string,
  args: ResolveApprovalArgs,
): ApprovalResolutionReceipt {
  const current = snapshotApprovalRequest(store, agentInstanceId, {
    approvalId: args.approvalId,
  });
  if (args.expected) {
    assertExpectedBinding(current, args.expected);
  }

  const stateBefore = requireAgentState(
    store,
    agentInstanceId,
    'resolveApproval',
  );
  const pendingApprovalBefore = snapshotPendingApprovalBefore(
    stateBefore,
    current.toolCallId,
  );
  const receipt: ApprovalResolutionReceipt = {
    approvalId: current.approvalId,
    messageId: current.messageId,
    messageIndex: current.messageIndex,
    partIndex: current.partIndex,
    toolCallId: current.toolCallId,
    toolName: current.toolName,
    input: cloneDetached(current.input, 'resolveApproval'),
    approved: args.approved,
    reason: args.reason,
    originalPart: cloneDetached(current.originalPart, 'resolveApproval'),
    pendingApprovalBefore,
  };

  try {
    updateAgentInstanceState(
      store,
      agentInstanceId,
      (state) => {
        const message = state.history[current.messageIndex];
        const part = message?.parts[current.partIndex];
        if (
          !message ||
          message.role !== 'assistant' ||
          message.id !== current.messageId ||
          !part ||
          !isApprovalRequestedToolPart(part) ||
          part.approval.id !== current.approvalId ||
          part.toolCallId !== current.toolCallId ||
          getToolName(part) !== current.toolName ||
          !structurallyEqualWithoutAccessors(part, current.originalPart)
        ) {
          throw new Error(
            `approval-state.resolveApproval: approval '${current.approvalId}' changed before mutation`,
          );
        }

        delete state.pendingApprovals[current.toolCallId];
        const updatedToolPart: ToolPart = {
          ...part,
          state: 'approval-responded',
          approval: {
            ...part.approval,
            approved: args.approved,
            reason: args.reason,
          },
        } as ToolPart;
        message.parts[current.partIndex] =
          updatedToolPart as (typeof message.parts)[number];
      },
      { throwOnMissing: true, source: 'resolveApproval' },
    );
  } catch (error) {
    if (approvalRequestRemainsUnchanged(store, agentInstanceId, receipt)) {
      throw error;
    }
    throw new ApprovalResolutionMutationError(receipt, error);
  }

  return receipt;
}

function receiptOriginalPartIsConsistent(
  receipt: ApprovalResolutionReceipt,
): boolean {
  const part = receipt.originalPart;
  return (
    isApprovalRequestedToolPart(part) &&
    part.approval.id === receipt.approvalId &&
    part.toolCallId === receipt.toolCallId &&
    getToolName(part) === receipt.toolName &&
    structurallyEqualWithoutAccessors(part.input, receipt.input)
  );
}

/**
 * Reverses only the exact `approval-responded` part produced by the supplied
 * receipt. Any changed index, binding, response, or pending-approval entry
 * makes rollback return `false` without overwriting newer state.
 */
export function rollbackApprovalResolution(
  store: AgentStore,
  agentInstanceId: string,
  args: { receipt: ApprovalResolutionReceipt },
): boolean {
  const { receipt } = args;
  let restoredPart: ApprovalRequestedToolPart;
  let restoredPendingApproval: { explanation: string } | undefined;
  try {
    if (!receiptOriginalPartIsConsistent(receipt)) return false;
    restoredPart = cloneDetached(
      receipt.originalPart,
      'rollbackApprovalResolution',
    );
    restoredPendingApproval = receipt.pendingApprovalBefore.present
      ? cloneDetached(
          receipt.pendingApprovalBefore.value,
          'rollbackApprovalResolution',
        )
      : undefined;
  } catch {
    return false;
  }

  const expectedRespondedPart: ToolPart = {
    ...receipt.originalPart,
    state: 'approval-responded',
    approval: {
      ...receipt.originalPart.approval,
      approved: receipt.approved,
      reason: receipt.reason,
    },
  } as ToolPart;

  let rolledBack = false;
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    const message = state.history[receipt.messageIndex];
    const part = message?.parts[receipt.partIndex];
    if (
      !message ||
      message.role !== 'assistant' ||
      message.id !== receipt.messageId ||
      !part ||
      !isToolPart(part) ||
      (part as ToolPart).state !== 'approval-responded' ||
      (part as ToolPart).approval?.id !== receipt.approvalId ||
      (part as ToolPart).toolCallId !== receipt.toolCallId ||
      Object.hasOwn(state.pendingApprovals, receipt.toolCallId) ||
      !structurallyEqualWithoutAccessors(part, expectedRespondedPart)
    ) {
      return;
    }

    message.parts[receipt.partIndex] =
      restoredPart as (typeof message.parts)[number];
    if (receipt.pendingApprovalBefore.present) {
      (
        state.pendingApprovals as Record<
          string,
          { explanation: string } | undefined
        >
      )[receipt.toolCallId] = restoredPendingApproval;
    } else {
      delete state.pendingApprovals[receipt.toolCallId];
    }
    rolledBack = true;
  });

  return rolledBack;
}
