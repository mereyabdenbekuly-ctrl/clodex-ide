import { IconArrowUpOutline24, IconTrash2Outline24 } from '@clodex/icons';
import { Button } from '@clodex/stage-ui/components/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@clodex/stage-ui/components/tooltip';
import type { AgentMessage } from '@shared/karton-contracts/ui/agent';
import {
  AttachmentLinkRouter,
  getAttachmentKey,
  parseMessageSegments,
} from '@ui/components/streamdown/attachment-links';
import { AttachmentMetadataProvider } from '@ui/hooks/use-attachment-metadata';
import { cn } from '@ui/utils';
import {
  CheckIcon,
  ChevronDownIcon,
  Loader2Icon,
  PencilIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { StatusCardSection } from './shared';
import { getMessageText } from './shared';
import {
  canSaveQueuedMessageDraft,
  replaceQueuedMessageText,
} from './message-queue-edit-state';

type MessageQueueLabels = {
  explanation: string;
  queuedForNextIteration: string;
  interruptAndSend: string;
  interruptAndSendDescription: string;
  remove: string;
  edit: string;
  save: string;
  cancel: string;
  noLongerQueued: string;
  updateFailed: string;
};

export interface QueuedMessagesSectionProps {
  queuedMessages: Array<AgentMessage & { role: 'user' }>;
  onRemoveMessage: (messageId: string) => Promise<void>;
  onUpdateMessage: (
    messageId: string,
    message: AgentMessage & { role: 'user' },
  ) => Promise<'updated' | 'not-found'>;
  onFlush: () => Promise<void>;
  labels: MessageQueueLabels;
}

function MessageQueueSectionContent({
  queuedMessages,
  onRemoveMessage,
  onUpdateMessage,
  labels,
}: QueuedMessagesSectionProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [savingMessageId, setSavingMessageId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (
      editingMessageId &&
      !queuedMessages.some((message) => message.id === editingMessageId)
    ) {
      setEditingMessageId(null);
      setDraft('');
      setNotice(labels.noLongerQueued);
    }
  }, [editingMessageId, labels.noLongerQueued, queuedMessages]);

  const cancelEdit = () => {
    if (savingMessageId) return;
    setEditingMessageId(null);
    setDraft('');
    setNotice(null);
  };

  const saveEdit = async (message: AgentMessage & { role: 'user' }) => {
    if (!canSaveQueuedMessageDraft(draft) || savingMessageId) return;
    setSavingMessageId(message.id);
    setNotice(null);
    try {
      const result = await onUpdateMessage(
        message.id,
        replaceQueuedMessageText(message, draft),
      );
      setEditingMessageId(null);
      setDraft('');
      if (result === 'not-found') setNotice(labels.noLongerQueued);
    } catch {
      setNotice(labels.updateFailed);
    } finally {
      setSavingMessageId(null);
    }
  };

  return (
    <div className="pt-1" onMouseLeave={() => setHoveredIndex(null)}>
      <p className="px-2 pb-1 text-[11px] text-muted-foreground">
        {labels.explanation}
      </p>
      {notice && (
        <p className="px-2 pb-1 text-[11px] text-warning-foreground">
          {notice}
        </p>
      )}
      {queuedMessages.map((queuedMsg, index) => {
        const isEditing = editingMessageId === queuedMsg.id;
        const isSaving = savingMessageId === queuedMsg.id;
        const isFirst = index === 0;
        const showButtons = isFirst
          ? hoveredIndex === null || hoveredIndex === 0
          : hoveredIndex === index;

        if (isEditing) {
          return (
            <div
              key={queuedMsg.id}
              className="mx-1 mb-1 rounded border border-border bg-surface-1 p-1.5"
              onMouseEnter={() => setHoveredIndex(index)}
            >
              <textarea
                autoFocus
                value={draft}
                disabled={isSaving}
                aria-label={labels.edit}
                className="min-h-16 w-full resize-y rounded bg-transparent px-1.5 py-1 text-foreground text-xs outline-none ring-1 ring-border focus:ring-clodex-green-400 disabled:opacity-60"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelEdit();
                  } else if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void saveEdit(queuedMsg);
                  }
                }}
              />
              <div className="mt-1 flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={isSaving}
                  onClick={(event) => {
                    event.stopPropagation();
                    cancelEdit();
                  }}
                >
                  <XIcon className="size-3" />
                  {labels.cancel}
                </Button>
                <Button
                  variant="primary"
                  size="xs"
                  disabled={!canSaveQueuedMessageDraft(draft) || isSaving}
                  onClick={(event) => {
                    event.stopPropagation();
                    void saveEdit(queuedMsg);
                  }}
                >
                  {isSaving ? (
                    <Loader2Icon className="size-3 animate-spin" />
                  ) : (
                    <CheckIcon className="size-3" />
                  )}
                  {labels.save}
                </Button>
              </div>
            </div>
          );
        }

        return (
          <div
            key={queuedMsg.id}
            className="relative flex w-full flex-row items-center rounded px-1 py-0.5 text-foreground hover:bg-surface-1 hover:text-hover-derived"
            onMouseEnter={() => setHoveredIndex(index)}
          >
            <div className="flex size-5 shrink-0 items-center justify-center">
              <div className="size-1 rounded-full bg-foreground" />
            </div>
            <span
              className={cn(
                'inline-flex w-full items-center gap-0.5 overflow-x-hidden text-ellipsis whitespace-nowrap text-xs transition-[mask-image] duration-200',
                showButtons
                  ? 'mask-[linear-gradient(to_left,transparent_0px,transparent_76px,black_104px)]'
                  : 'mask-[linear-gradient(to_left,transparent_0px,black_24px)]',
              )}
            >
              {parseMessageSegments(getMessageText(queuedMsg)).map((segment) =>
                segment.kind === 'text' ? (
                  segment.content
                ) : (
                  <AttachmentLinkRouter
                    key={getAttachmentKey(segment.linkData)}
                    linkData={segment.linkData}
                  />
                ),
              )}
            </span>
            <div
              className={cn(
                'absolute top-1/2 right-1 -translate-y-1/2 flex-row items-center',
                showButtons ? 'flex' : 'hidden',
              )}
            >
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={labels.edit}
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditingMessageId(queuedMsg.id);
                      setDraft(getMessageText(queuedMsg));
                      setNotice(null);
                    }}
                  >
                    <PencilIcon className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{labels.edit}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={labels.remove}
                    onClick={(event) => {
                      event.stopPropagation();
                      void onRemoveMessage(queuedMsg.id);
                    }}
                  >
                    <IconTrash2Outline24 className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{labels.remove}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function MessageQueueSection(
  props: QueuedMessagesSectionProps,
): StatusCardSection | null {
  if (props.queuedMessages.length === 0) return null;

  return {
    key: 'message-queue',
    trigger: (isOpen: boolean) => (
      <div className="flex h-6 w-full flex-row items-center justify-between gap-2 pl-1.5 text-muted-foreground text-xs hover:text-foreground has-[button:hover]:text-muted-foreground">
        <div className="flex flex-row items-center justify-start gap-2">
          <ChevronDownIcon
            className={cn(
              'size-3 shrink-0 transition-transform duration-50',
              isOpen && 'rotate-180',
            )}
          />
          {props.labels.queuedForNextIteration}
        </div>
        <Tooltip>
          <TooltipTrigger>
            <Button
              variant="ghost"
              size="xs"
              onClick={(event) => {
                event.stopPropagation();
                void props.onFlush();
              }}
            >
              {props.labels.interruptAndSend}
              <IconArrowUpOutline24 className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {props.labels.interruptAndSendDescription}
          </TooltipContent>
        </Tooltip>
      </div>
    ),
    scrollable: true,
    contentClassName: 'px-0',
    content: (
      <AttachmentMetadataProvider messages={props.queuedMessages}>
        <MessageQueueSectionContent {...props} />
      </AttachmentMetadataProvider>
    ),
  };
}
