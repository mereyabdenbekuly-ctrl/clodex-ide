import type { AgentStore } from '../../../store/agent-store';
import type { AgentMessage } from '../../../types/agent';
import { updateAgentInstanceState } from './internal';

/**
 * History-shape mutations. Each is exactly one `store.update()`.
 */

export function appendHistoryMessage(
  store: AgentStore,
  agentInstanceId: string,
  args: { message: AgentMessage },
): void {
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    state.history.push(args.message);
  });
}

/**
 * Removes only transport bookkeeping appended after an exact history prefix.
 *
 * Provider reconnect uses this instead of a broad tool/approval sweep when a
 * request disconnected before producing a model token or tool call. Queued
 * user messages are deliberately preserved. A caller must fail closed when
 * this function reports `conflict`; that result means the live history cannot
 * be proven equivalent to the pre-stream baseline.
 */
export type RemoveTransportOnlyAssistantTailResult =
  | { readonly status: 'no-tail' }
  | { readonly status: 'removed' }
  | {
      readonly status: 'conflict';
      readonly reason: 'baseline-mismatch' | 'non-transport-tail';
    };

export function removeTransportOnlyAssistantTail(
  store: AgentStore,
  agentInstanceId: string,
  args: { baselineMessageIds: readonly string[] },
): RemoveTransportOnlyAssistantTailResult {
  let result: RemoveTransportOnlyAssistantTailResult = {
    status: 'conflict',
    reason: 'baseline-mismatch',
  };
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    if (
      state.history.length < args.baselineMessageIds.length ||
      args.baselineMessageIds.some(
        (messageId, index) => state.history[index]?.id !== messageId,
      )
    ) {
      result = { status: 'conflict', reason: 'baseline-mismatch' };
      return;
    }
    const appended = state.history.slice(args.baselineMessageIds.length);
    if (appended.length === 0) {
      result = { status: 'no-tail' };
      return;
    }
    const transportOnly = appended.every(
      (message) =>
        message.role === 'assistant' &&
        message.parts.every((part) => {
          if (part.type === 'step-start') return true;
          if (part.type !== 'text' && part.type !== 'reasoning') return false;
          return !('text' in part) || part.text.length === 0;
        }),
    );
    if (!transportOnly) {
      result = { status: 'conflict', reason: 'non-transport-tail' };
      return;
    }
    state.history = state.history.slice(0, args.baselineMessageIds.length);
    result = { status: 'removed' };
  });
  return result;
}

/**
 * Truncate history at `messageIndex` and clear the queue. Defensive
 * no-op on missing ids — used both as a normal interrupt path and on
 * revert flows where the agent may already be gone.
 */
export function truncateHistoryAt(
  store: AgentStore,
  agentInstanceId: string,
  args: { messageIndex: number },
): void {
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    state.history = state.history.slice(0, args.messageIndex);
    state.queuedMessages = [];
  });
}

/**
 * Look up a user message by id, truncate history up to (but excluding)
 * it, and clear the queue. Throws if the user message is not in
 * history — matches the pre-refactor recipe.
 */
export function replaceUserMessage(
  store: AgentStore,
  agentInstanceId: string,
  args: { userMessageId: string },
): void {
  updateAgentInstanceState(
    store,
    agentInstanceId,
    (state) => {
      const replaceMessageIndex = state.history.findIndex(
        (m) => m.id === args.userMessageId,
      );
      if (replaceMessageIndex === -1) {
        throw new Error('User message not found in history');
      }
      state.history = state.history.slice(0, replaceMessageIndex);
      state.queuedMessages = [];
    },
    { source: 'replaceUserMessage' },
  );
}
