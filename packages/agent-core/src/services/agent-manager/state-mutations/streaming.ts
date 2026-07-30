import type { DynamicToolUIPart } from 'ai';
import type { AgentStore } from '../../../store/agent-store';
import type { AgentMessage, AgentToolUIPart } from '../../../types/agent';
import type {
  OwnedReasoningDetails,
  UserMessageMetadata,
} from '../../../types/metadata';
import { updateAgentInstanceState } from './internal';

/**
 * UI-message stream hot path. Each call is exactly one
 * `store.update()`.
 *
 * Tool/part states already considered "settled" by the merge — once a
 * part reports one of these, an incoming part of the same `type` and
 * `state` is treated as a no-change and skipped to avoid clobbering
 * downstream metadata (e.g. `endedAt` timestamps).
 */
const SETTLED_PART_STATES = new Set([
  'output-available',
  'output-error',
  'output-denied',
  'approval-responded',
  'done',
]);

/**
 * Merge an incoming UI message stream chunk into history. The
 * canonical hot path called per streaming tick from `BaseAgent`.
 *
 * Behavior:
 *   - Finds (or pushes) the message by `id`.
 *   - Replaces existing parts that have drifted, skipping
 *     already-settled identical parts.
 *   - Trims the existing parts array to the incoming length.
 *   - Maintains `partsMetadata` startedAt / endedAt for text/reasoning
 *     parts.
 *   - Invokes `onApprovalRequested` for any tool part that enters
 *     `approval-requested`.
 */
export function mergeUIMessageStream(
  store: AgentStore,
  agentInstanceId: string,
  args: {
    uiMessage: AgentMessage;
    onApprovalRequested?: (cb: {
      approvalId: string;
      toolPart: AgentToolUIPart | DynamicToolUIPart;
    }) => void;
  },
): void {
  const { uiMessage, onApprovalRequested } = args;
  const approvalRequests: Array<{
    approvalId: string;
    toolPart: AgentToolUIPart | DynamicToolUIPart;
  }> = [];
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    const existingMessage =
      state.history.find((message) => message.id === uiMessage.id) ??
      (() => {
        state.history.push(uiMessage);
        return state.history[state.history.length - 1]!;
      })();

    const incoming = uiMessage.parts;
    const existing = existingMessage.parts;
    for (let i = 0; i < incoming.length; i++) {
      if (i >= existing.length) {
        existing.push(incoming[i]!);
      } else {
        const ep = existing[i] as Record<string, unknown>;
        const ip = incoming[i] as Record<string, unknown>;
        const existingApproval = ep.approval as
          | { id?: unknown }
          | null
          | undefined;
        const incomingApproval = ip.approval as
          | { id?: unknown }
          | null
          | undefined;
        if (
          (ep.type === 'dynamic-tool' ||
            (typeof ep.type === 'string' && ep.type.startsWith('tool-'))) &&
          ep.type === ip.type &&
          ep.toolCallId === ip.toolCallId &&
          existingApproval?.id === incomingApproval?.id &&
          ep.state === 'approval-responded' &&
          ip.state === 'approval-requested'
        ) {
          continue;
        }
        if (
          ep.type === ip.type &&
          ep.state === ip.state &&
          SETTLED_PART_STATES.has(ep.state as string) &&
          (ep.preliminary === true) === (ip.preliminary === true)
        )
          continue;
        existing[i] = incoming[i]!;
      }
    }
    if (existing.length > incoming.length) existing.length = incoming.length;

    existingMessage.metadata ??= {
      createdAt: new Date(),
      partsMetadata: [],
    } as unknown as UserMessageMetadata;
    const emMeta = existingMessage.metadata as UserMessageMetadata;
    // Keep `partsMetadata` index-aligned with `parts`. Without this,
    // a shrunk-then-regrown stream reuses a stale `startedAt`/`endedAt`
    // at the recycled index via the `??=` writes below.
    if (emMeta.partsMetadata.length > incoming.length) {
      emMeta.partsMetadata.length = incoming.length;
    }

    uiMessage.parts.forEach(
      (part: (typeof uiMessage.parts)[number], index: number) => {
        if (part.type === 'text' || part.type === 'reasoning') {
          const streamPart = part as { state: string };
          emMeta.partsMetadata[index] ??= {
            startedAt: new Date(),
            endedAt: undefined,
          };
          if (streamPart.state === 'done') {
            emMeta.partsMetadata[index]!.endedAt ??= new Date();
          }
        }

        if (
          (part.type === 'dynamic-tool' || part.type.startsWith('tool-')) &&
          (part as AgentToolUIPart | DynamicToolUIPart).state ===
            'approval-requested'
        ) {
          const toolPart = part as AgentToolUIPart | DynamicToolUIPart;
          const approvalId = toolPart.approval?.id;
          if (approvalId && onApprovalRequested) {
            approvalRequests.push({ approvalId, toolPart });
          }
        }
      },
    );
  });
  // Side effects run only after AgentStore commits the merged message. This
  // guarantees lifecycle observers see the approval/tool state that caused
  // the callback rather than the previous snapshot.
  for (const request of approvalRequests) onApprovalRequested?.(request);
}

export function markRecoveredCloudSequence(
  store: AgentStore,
  agentInstanceId: string,
  args: {
    messageId: string;
    executionId: string;
    sequence: number;
    recoveredAt: string;
  },
): void {
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    const message = state.history.find(
      (candidate) => candidate.id === args.messageId,
    );
    if (!message || message.role !== 'assistant') return;
    message.metadata ??= {
      createdAt: new Date(),
      partsMetadata: [],
    } as unknown as UserMessageMetadata;
    (message.metadata as UserMessageMetadata).cloudReplay = {
      executionId: args.executionId,
      lastSequence: args.sequence,
      recoveredAt: args.recoveredAt,
    };
  });
}

/**
 * Attach a compressed history blob to the boundary message.
 *
 * Automatic compression currently runs as a pre-continuation admission
 * barrier. This mutation still validates the ordered compacted prefix so a
 * concurrent stop/undo/retry or any future caller cannot attach a stale
 * summary to a different conversation.
 */
export function storeCompressedHistory(
  store: AgentStore,
  agentInstanceId: string,
  args: {
    boundaryMessageId: string;
    compactedMessageIds: readonly string[];
    compressedHistory: string;
  },
): 'missing' | 'stale' | 'written' {
  let result: 'missing' | 'stale' | 'written' = 'missing';
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    const boundaryIndex = state.history.findIndex(
      (message) => message.id === args.boundaryMessageId,
    );
    if (boundaryIndex < 0) return;

    if (
      boundaryIndex !== args.compactedMessageIds.length ||
      args.compactedMessageIds.some(
        (messageId, index) => state.history[index]?.id !== messageId,
      )
    ) {
      result = 'stale';
      return;
    }

    const boundaryMessage = state.history[boundaryIndex];
    if (!boundaryMessage) return;
    boundaryMessage.metadata ??= {
      createdAt: new Date(),
      partsMetadata: [],
    } as unknown as UserMessageMetadata;
    const bm = boundaryMessage.metadata as UserMessageMetadata;
    bm.compressedHistory = args.compressedHistory;
    result = 'written';
  });
  return result;
}

/**
 * Roll back an in-memory compressed-history mutation after strict durable
 * persistence fails. The expected current value prevents an older rollback
 * from erasing a newer successful compression.
 */
export function restoreCompressedHistory(
  store: AgentStore,
  agentInstanceId: string,
  args: {
    boundaryMessageId: string;
    expectedCompressedHistory: string;
    previousCompressedHistory: string | undefined;
  },
): 'missing' | 'mismatch' | 'restored' {
  let result: 'missing' | 'mismatch' | 'restored' = 'missing';
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    const boundaryMessage = state.history.find(
      (message) => message.id === args.boundaryMessageId,
    );
    if (!boundaryMessage) return;

    const currentCompressedHistory =
      boundaryMessage.metadata?.compressedHistory;
    if (currentCompressedHistory !== args.expectedCompressedHistory) {
      result = 'mismatch';
      return;
    }

    if (args.previousCompressedHistory === undefined) {
      if (boundaryMessage.metadata) {
        delete boundaryMessage.metadata.compressedHistory;
      }
    } else {
      boundaryMessage.metadata ??= {
        createdAt: new Date(),
        partsMetadata: [],
      } as unknown as UserMessageMetadata;
      boundaryMessage.metadata.compressedHistory =
        args.previousCompressedHistory;
    }
    result = 'restored';
  });
  return result;
}

/**
 * Set the provider-owned signed reasoning_details on the assistant
 * message at `targetIdx`. Full-replace of the
 * `ownedReasoningDetails` array; the caller merges/appends per-source
 * before invoking.
 */
export function setAssistantOwnedReasoningDetails(
  store: AgentStore,
  agentInstanceId: string,
  args: { targetIdx: number; ownedReasoningDetails: OwnedReasoningDetails[] },
): void {
  updateAgentInstanceState(store, agentInstanceId, (state) => {
    const target = state.history[args.targetIdx];
    if (!target || target.role !== 'assistant') return;
    target.metadata ??= {
      createdAt: new Date(),
      partsMetadata: [],
    } as unknown as UserMessageMetadata;
    (target.metadata as UserMessageMetadata).ownedReasoningDetails =
      args.ownedReasoningDetails;
  });
}
