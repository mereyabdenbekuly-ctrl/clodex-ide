import { cn } from '@ui/utils';
import type {
  ReasoningUIPart,
  DynamicToolUIPart,
  FileUIPart,
  TextUIPart,
  UIMessagePart,
  UIDataTypes,
} from 'ai';
import type {
  AgentMessage,
  AgentToolUIPart,
} from '@shared/karton-contracts/ui/agent';
import type { UIAgentTools } from '@shared/karton-contracts/ui/agent/tools/types';
import { useMemo, memo, useState, useCallback } from 'react';
import { ThinkingPart } from './message-part-ui/thinking';
import { FilePart } from './message-part-ui/file';
import { TextPart } from './message-part-ui/text';
import { CopyToolPart } from './message-part-ui/tools/copy';
import { MkdirToolPart } from './message-part-ui/tools/mkdir';
import { DeleteFileToolPart } from './message-part-ui/tools/delete';
import { UpdateWorkspaceMdToolPart } from './message-part-ui/tools/update-workspace-md';
import { MultiEditToolPart } from './message-part-ui/tools/multi-edit';
import { WriteToolPart } from './message-part-ui/tools/write';
import {
  ExploringToolParts,
  isReadOnlyToolPart,
  type ReadOnlyToolPart,
} from './message-part-ui/tools/exploring';
import { UnknownToolPart } from './message-part-ui/tools/unknown';
import { ExecuteSandboxJsToolPart } from './message-part-ui/tools/execute-sandbox-js';
import { ReadConsoleLogsToolPart } from './message-part-ui/tools/read-console-logs';
import { AskUserQuestionsToolPart } from './message-part-ui/tools/ask-user-questions';
import { ExecuteShellCommandToolPart } from './message-part-ui/tools/execute-shell-command';
import { ClodexMcpToolPart } from './message-part-ui/tools/clodex-mcp';
import { OpenManusToolPart } from './message-part-ui/tools/openmanus';
import { MemoryToolPart } from './message-part-ui/tools/memory';
import { isToolOrReasoningPart } from './message-utils';
import { MessageBetweenSteps } from './message-between-steps';
import { IconDotsOutline18 } from 'nucleo-ui-outline-18';
import {
  Menu,
  MenuTrigger,
  MenuContent,
  MenuItem,
} from '@clodex/stage-ui/components/menu';
import { CheckIcon, CopyIcon, HistoryIcon } from 'lucide-react';
import { RevertConfirmPopover } from './revert-confirm-popover';
import { SwarmDiffArtifact } from './swarm-diff-artifact';
import type { Mount } from '@shared/karton-contracts/ui/agent/metadata';
import {
  CloudTaskArtifactPart,
  type CloudTaskArtifactUIPart,
} from './cloud-task-artifact';

type AssistantMessage = AgentMessage & { role: 'assistant' };

/**
 * Fast deep equality optimised for streaming tool parts.
 * Short-circuits on string-length differences (O(1) for growing content)
 * instead of JSON.stringify which is O(n) and allocates a full copy.
 */
function cheapDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'string')
    return a.length === (b as string).length && a === b;
  if (typeof a === 'number' || typeof a === 'boolean') return false;
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === (b as Date).getTime();
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!cheapDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    if (aKeys.length !== Object.keys(bObj).length) return false;
    for (const key of aKeys) {
      if (!cheapDeepEqual(aObj[key], bObj[key])) return false;
    }
    return true;
  }
  return false;
}

/** Part with its original index in msg.parts for correct metadata lookup */
type PartWithOriginalIndex =
  | {
      part: UIMessagePart<UIDataTypes, UIAgentTools>;
      originalIndex: number;
    }
  | {
      parts: { part: ReadOnlyToolPart; originalIndex: number }[];
    };

/** Memoized renderer for a single (non-grouped) part inside a message. */
const SinglePartRenderer = memo(
  function SinglePartRenderer({
    item,
    stableKey,
    isLastPart,
    isWorking,
    isLastMessage,
    msg,
  }: {
    item: {
      part: UIMessagePart<UIDataTypes, UIAgentTools>;
      originalIndex: number;
    };
    stableKey: string;
    isLastPart: boolean;
    isWorking: boolean;
    isLastMessage: boolean;
    msg: AssistantMessage;
  }) {
    const { part, originalIndex } = item;

    if (part.type === 'data-cloud-artifact') {
      return (
        <CloudTaskArtifactPart
          key={stableKey}
          part={part as unknown as CloudTaskArtifactUIPart}
        />
      );
    }
    if (part.type === 'data-cloud-log' || part.type === 'data-cloud-usage') {
      return null;
    }

    switch (part.type) {
      case 'text':
        if ((part as TextUIPart).text.trim() === '') return null;
        return (
          <TextPart
            key={stableKey}
            part={part as TextUIPart}
            messageRole="assistant"
          />
        );
      case 'reasoning':
        if (part.text.trim() === '') return null;
        return (
          <ThinkingPart
            key={stableKey}
            thinkingDuration={
              (msg.metadata?.partsMetadata?.[
                originalIndex
              ]?.endedAt?.getTime() ?? 0) -
              (msg.metadata?.partsMetadata?.[
                originalIndex
              ]?.startedAt?.getTime() ?? 0)
            }
            part={part as ReasoningUIPart}
            isLastPart={isLastPart}
            isShimmering={
              isWorking &&
              part.state === 'streaming' &&
              isLastPart &&
              isLastMessage
            }
          />
        );
      case 'file':
        return <FilePart key={stableKey} part={part as FileUIPart} />;
      case 'tool-copy':
        return <CopyToolPart key={stableKey} part={part} />;
      case 'tool-mkdir':
        return <MkdirToolPart key={stableKey} part={part} />;
      case 'tool-delete':
        return <DeleteFileToolPart key={stableKey} part={part} />;
      case 'tool-updateWorkspaceMd':
        return <UpdateWorkspaceMdToolPart key={stableKey} part={part} />;
      case 'tool-multiEdit':
        return <MultiEditToolPart key={stableKey} part={part} />;
      case 'tool-executeSandboxJs':
        return (
          <ExecuteSandboxJsToolPart
            key={stableKey}
            part={part}
            isLastPart={isLastPart}
            messageAttachments={msg.metadata?.attachments}
          />
        );
      case 'tool-readConsoleLogs':
        return (
          <ReadConsoleLogsToolPart
            key={stableKey}
            part={part}
            isLastPart={isLastPart}
          />
        );
      case 'tool-write':
        return <WriteToolPart key={stableKey} part={part} />;
      case 'tool-askUserQuestions':
        return <AskUserQuestionsToolPart key={stableKey} part={part} />;
      case 'tool-runOpenManus':
        return <OpenManusToolPart key={stableKey} part={part} />;
      case 'tool-addMemory':
      case 'tool-listMemories':
      case 'tool-readMemory':
      case 'tool-searchMemories':
      case 'tool-deleteMemory':
        return (
          <MemoryToolPart
            key={stableKey}
            part={part}
            shimmer={isWorking && isLastPart && isLastMessage}
          />
        );
      case 'tool-createShellSession':
      case 'tool-executeShellCommand':
        return (
          <ExecuteShellCommandToolPart
            key={stableKey}
            part={part}
            isLastPart={isLastPart}
          />
        );
      default:
        if (part.type.startsWith('tool-mcp_clodex_')) {
          return (
            <ClodexMcpToolPart
              key={stableKey}
              part={part as DynamicToolUIPart}
              shimmer={isWorking && isLastPart && isLastMessage}
            />
          );
        }
        return (
          <UnknownToolPart
            shimmer={isWorking && isLastPart && isLastMessage}
            key={stableKey}
            part={part as AgentToolUIPart | DynamicToolUIPart}
          />
        );
    }
  },
  (prev, next) => {
    // Bail out if the part object reference is the same (Immer structural
    // sharing keeps settled parts stable) and positional flags match.
    if (prev.item.part !== next.item.part) return false;
    if (prev.isLastPart !== next.isLastPart) return false;
    if (prev.isLastMessage !== next.isLastMessage) return false;
    // Only compare isWorking when it matters (last part of last message)
    if (prev.isLastPart && prev.isLastMessage) {
      if (prev.isWorking !== next.isWorking) return false;
    }
    // partsMetadata for reasoning duration
    if (prev.item.part.type === 'reasoning') {
      const pMeta = prev.msg.metadata?.partsMetadata?.[prev.item.originalIndex];
      const nMeta = next.msg.metadata?.partsMetadata?.[next.item.originalIndex];
      if (pMeta?.endedAt !== nMeta?.endedAt) return false;
      if (pMeta?.startedAt !== nMeta?.startedAt) return false;
    }
    // Attachments can be appended after the part settles (e.g. screenshots)
    if (prev.item.part.type === 'tool-executeSandboxJs') {
      if (prev.msg.metadata?.attachments !== next.msg.metadata?.attachments)
        return false;
    }
    return true;
  },
);

export const MessageAssistant = memo(
  function MessageAssistant({
    message: msg,
    isLastMessage,
    isWorking,
    showBetweenStepsIndicator,
    hasSubsequentFileModifications,
    agentInstanceId,
    resolvedMounts,
  }: {
    message: AssistantMessage;
    isLastMessage: boolean;
    isWorking: boolean;
    showBetweenStepsIndicator?: boolean;
    hasSubsequentFileModifications?: boolean;
    agentInstanceId: string | null;
    resolvedMounts: Mount[];
  }) {
    const isEmptyMessage = useMemo(() => {
      if (
        msg.parts
          .map((part) => part.type)
          .some(
            (type) =>
              type === 'dynamic-tool' ||
              type.startsWith('tool-') ||
              type === 'file' ||
              type === 'data-cloud-artifact',
          )
      )
        return false;

      return msg.parts.every(
        (part) =>
          (part.type !== 'text' && part.type !== 'reasoning') ||
          ((part.type === 'text' || part.type === 'reasoning') &&
            part.text.trim() === ''),
      );
    }, [msg.parts]);

    const assistantText = useMemo(
      () =>
        msg.parts
          .filter(
            (part): part is TextUIPart =>
              part.type === 'text' && part.text.trim().length > 0,
          )
          .map((part) => part.text)
          .join('\n\n'),
      [msg.parts],
    );

    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [copied, setCopied] = useState(false);

    const handleCopyResponse = useCallback(() => {
      if (!assistantText) return;
      void navigator.clipboard
        .writeText(assistantText)
        .then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        })
        .catch(() => {
          setCopied(false);
        });
    }, [assistantText]);

    const dispatchRestore = useCallback(
      (undoToolCalls: boolean) => {
        setIsConfirmOpen(false);
        window.dispatchEvent(
          new CustomEvent('chat-restore-checkpoint', {
            detail: {
              assistantMessageId: msg.id,
              undoToolCalls,
            },
          }),
        );
      },
      [msg.id],
    );

    const handleRestoreCheckpoint = useCallback(() => {
      if (hasSubsequentFileModifications) {
        setIsConfirmOpen(true);
      } else {
        dispatchRestore(false);
      }
    }, [hasSubsequentFileModifications, dispatchRestore]);

    if (isEmptyMessage && !isLastMessage) return null;

    return (
      <div className={cn('flex w-full flex-col gap-1')}>
        <div className="w-full">
          <div
            className={cn(
              'mt-2 flex w-full shrink-0 flex-row items-center justify-start gap-2',
              isEmptyMessage ? 'hidden' : '',
            )}
          >
            <div
              className={cn(
                'codex-message-assistant group group/chat-message-assistant wrap-break-word relative min-h-8 w-full min-w-1/3 origin-bottom-left select-text space-y-3 py-2 font-normal last:mb-0.5',
              )}
            >
              {(() => {
                // Merge read-only tools into groups, preserving original indices for metadata lookup
                const partsWithIndices = msg.parts.reduce(
                  (acc, part, originalIndex) => {
                    // Skip step-start parts, they don't contain information we need to render
                    if (part.type === 'step-start') return acc;

                    // Check if this is a read-only tool or reasoning part
                    if (
                      isToolOrReasoningPart(part) &&
                      isReadOnlyToolPart(part)
                    ) {
                      const previousItem = acc[acc.length - 1];
                      // Merge into previous group if one exists
                      if (previousItem && 'parts' in previousItem)
                        previousItem.parts.push({ part, originalIndex });
                      // Create a new group
                      else acc.push({ parts: [{ part, originalIndex }] });
                      // Non-grouped part
                    } else acc.push({ part, originalIndex });

                    return acc;
                  },
                  [] as PartWithOriginalIndex[],
                );

                const typeCounters: Record<string, number> = {};
                let exploringGroupIndex = 0;

                return partsWithIndices.map((item, index) => {
                  const isLastPart = index === partsWithIndices.length - 1;

                  // Handle grouped read-only parts (exploring tools + reasoning)
                  if ('parts' in item) {
                    const stableKey = `${msg.id}:exploring:${exploringGroupIndex}`;
                    exploringGroupIndex++;
                    return (
                      <ExploringToolParts
                        key={stableKey}
                        items={item.parts}
                        partsMetadata={msg.metadata?.partsMetadata ?? []}
                        isAutoExpanded={isLastPart}
                        isShimmering={isWorking && isLastPart && isLastMessage}
                        messageAttachments={msg.metadata?.attachments}
                      />
                    );
                  }

                  // Handle single parts — delegate to memoized renderer
                  const { part } = item;
                  const currentTypeIndex = typeCounters[part.type] ?? 0;
                  typeCounters[part.type] = currentTypeIndex + 1;
                  const stableKey = `${msg.id}:${part.type}:${currentTypeIndex}`;

                  return (
                    <SinglePartRenderer
                      key={stableKey}
                      item={
                        item as {
                          part: UIMessagePart<UIDataTypes, UIAgentTools>;
                          originalIndex: number;
                        }
                      }
                      stableKey={stableKey}
                      isLastPart={isLastPart}
                      isWorking={isWorking}
                      isLastMessage={isLastMessage}
                      msg={msg}
                    />
                  );
                });
              })()}
              {showBetweenStepsIndicator && <MessageBetweenSteps />}
              {(assistantText || !isLastMessage) && (
                <div className="flex min-h-6 items-center gap-0.5 opacity-55 transition-opacity focus-within:opacity-100 group-hover/chat-message-assistant:opacity-100">
                  {assistantText && (
                    <button
                      type="button"
                      aria-label={copied ? 'Response copied' : 'Copy response'}
                      title={copied ? 'Copied' : 'Copy response'}
                      className="flex size-6 cursor-pointer items-center justify-center rounded-md text-token-text-tertiary transition-colors hover:bg-token-list-hover-background hover:text-token-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
                      onClick={handleCopyResponse}
                    >
                      {copied ? (
                        <CheckIcon className="size-3.5" />
                      ) : (
                        <CopyIcon className="size-3.5" />
                      )}
                    </button>
                  )}
                  {!isLastMessage && (
                    <>
                      <Menu>
                        <MenuTrigger>
                          <button
                            type="button"
                            aria-label="Message actions"
                            className="flex size-6 cursor-pointer items-center justify-center rounded-md text-token-text-tertiary transition-colors hover:bg-token-list-hover-background hover:text-token-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
                          >
                            <IconDotsOutline18 className="size-3.5" />
                          </button>
                        </MenuTrigger>
                        <MenuContent
                          side="bottom"
                          align="end"
                          sideOffset={2}
                          size="xs"
                        >
                          <MenuItem size="xs" onClick={handleRestoreCheckpoint}>
                            <HistoryIcon className="size-3" />
                            Restore checkpoint
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                      <RevertConfirmPopover
                        open={isConfirmOpen}
                        onOpenChange={setIsConfirmOpen}
                        onConfirm={dispatchRestore}
                      />
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
          {msg.metadata?.swarmDiffArtifact && (
            <SwarmDiffArtifact
              agentInstanceId={agentInstanceId}
              resolvedMounts={resolvedMounts}
            />
          )}
        </div>
      </div>
    );
  },
  // Custom comparison to prevent re-renders when message object references change
  (prevProps, nextProps) => {
    if (prevProps.message.id !== nextProps.message.id) return false;
    if (prevProps.isLastMessage !== nextProps.isLastMessage) return false;
    // Only re-render for isWorking changes if this is the last message
    // (shimmer effects only apply to last message)
    if (prevProps.isLastMessage && prevProps.isWorking !== nextProps.isWorking)
      return false;
    if (
      prevProps.showBetweenStepsIndicator !==
      nextProps.showBetweenStepsIndicator
    )
      return false;
    if (
      prevProps.hasSubsequentFileModifications !==
      nextProps.hasSubsequentFileModifications
    )
      return false;
    if (prevProps.agentInstanceId !== nextProps.agentInstanceId) return false;
    if (prevProps.resolvedMounts !== nextProps.resolvedMounts) return false;
    if (
      prevProps.message.metadata?.swarmDiffArtifact !==
      nextProps.message.metadata?.swarmDiffArtifact
    )
      return false;

    if (prevProps.message.parts.length !== nextProps.message.parts.length)
      return false;

    // Check for autoCompactInformation changes
    const prevAutoCompact = prevProps.message.metadata?.compressedHistory;
    const nextAutoCompact = nextProps.message.metadata?.compressedHistory;
    if (prevAutoCompact !== nextAutoCompact) return false;

    // Deep compare parts by type and key content
    for (let i = 0; i < prevProps.message.parts.length; i++) {
      const prevPart = prevProps.message.parts[i];
      const nextPart = nextProps.message.parts[i];
      if (!prevPart || !nextPart) return false;
      if (prevPart.type !== nextPart.type) return false;

      // For text parts, compare text and state
      if (prevPart.type === 'text' && nextPart.type === 'text') {
        if (prevPart.text !== nextPart.text) return false;
        if (prevPart.state !== nextPart.state) return false;
      }
      // For reasoning parts, compare text and state
      if (prevPart.type === 'reasoning' && nextPart.type === 'reasoning') {
        if (prevPart.text !== nextPart.text) return false;
        if (prevPart.state !== nextPart.state) return false;
      }
      // For tool parts, compare state, input, and output to allow streaming updates.
      // Uses cheapDeepEqual instead of JSON.stringify to avoid O(n) serialisation
      // on every comparison — critical during high-frequency streaming bursts.
      if (
        prevPart.type.startsWith('tool-') ||
        prevPart.type === 'dynamic-tool'
      ) {
        const prevState = (prevPart as any).state;
        const nextState = (nextPart as any).state;
        if (prevState !== nextState) return false;
        if (!cheapDeepEqual((prevPart as any).input, (nextPart as any).input))
          return false;
        if (!cheapDeepEqual((prevPart as any).output, (nextPart as any).output))
          return false;
      }
    }

    return true;
  },
);
