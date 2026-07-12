import { Button } from '@clodex/stage-ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@clodex/stage-ui/components/dialog';
import { OverlayScrollbar } from '@clodex/stage-ui/components/overlay-scrollbar';
import { parseHostedPullRequestPatch } from '@shared/hosted-pull-request-patch';
import type {
  HostedPullRequest,
  HostedPullRequestCheckState,
  HostedPullRequestCommentSide,
  HostedPullRequestFile,
  HostedPullRequestInlineCommentInput,
  HostedPullRequestMergeGateState,
  HostedPullRequestMergeInput,
  HostedPullRequestMergeMethod,
  HostedPullRequestMergeResult,
  HostedPullRequestReviewEvent,
  HostedPullRequestSubmitReviewInput,
  HostedPullRequestSubmitReviewResult,
} from '@shared/hosted-pull-request';
import { FileIcon } from '@ui/components/file-icon';
import { cn } from '@ui/utils';
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDotIcon,
  Clock3Icon,
  ExternalLinkIcon,
  FileCode2Icon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestArrowIcon,
  LockKeyholeIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SendIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
  XCircleIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

export type HostedPullRequestReviewProps = {
  pullRequest: HostedPullRequest;
  authenticated: boolean;
  onRefresh: () => void;
  onOpenExternal: (url: string) => void;
  onSubmitReview: (
    input: HostedPullRequestSubmitReviewInput,
  ) => Promise<HostedPullRequestSubmitReviewResult>;
  onMerge: (
    input: HostedPullRequestMergeInput,
  ) => Promise<HostedPullRequestMergeResult>;
  relativeNow?: Date | number | string;
};

type PendingInlineComment = HostedPullRequestInlineCommentInput & {
  id: string;
};

type InlineCommentEditor = {
  id: string;
  path: string;
  line: number;
  side: HostedPullRequestCommentSide;
  body: string;
};

type ReviewSubmissionState =
  | { status: 'idle' }
  | { status: 'submitting'; event: HostedPullRequestReviewEvent }
  | { status: 'success'; message: string; reviewUrl: string | null }
  | { status: 'error'; message: string; retryable: boolean };

type MergeSubmissionState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; message: string; mergeCommitSha: string | null }
  | { status: 'error'; message: string; retryable: boolean };

type ConfirmedReviewEvent = Exclude<HostedPullRequestReviewEvent, 'COMMENT'>;

function inlineCommentId(
  path: string,
  line: number,
  side: HostedPullRequestCommentSide,
): string {
  return `${path}\0${side}\0${line}`;
}

function reviewEventLabel(event: HostedPullRequestReviewEvent): string {
  switch (event) {
    case 'APPROVE':
      return 'Approval submitted to GitHub.';
    case 'REQUEST_CHANGES':
      return 'Changes requested on GitHub.';
    default:
      return 'Review comments submitted to GitHub.';
  }
}

function mergeMethodLabel(method: HostedPullRequestMergeMethod): string {
  switch (method) {
    case 'merge':
      return 'Create a merge commit';
    case 'rebase':
      return 'Rebase and merge';
    default:
      return 'Squash and merge';
  }
}

function mergeGateIcon(state: HostedPullRequestMergeGateState) {
  switch (state) {
    case 'pass':
      return <CheckCircle2Icon className="size-3.5 text-success-foreground" />;
    case 'blocked':
      return <XCircleIcon className="size-3.5 text-error-foreground" />;
    default:
      return <Clock3Icon className="size-3.5 text-warning-foreground" />;
  }
}

function formatRelativeDate(
  value: string,
  relativeNow: Date | number | string | undefined,
): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'recently';
  const now =
    relativeNow === undefined ? Date.now() : new Date(relativeNow).getTime();
  const elapsed = now - timestamp;
  const minutes = Math.max(1, Math.round(elapsed / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year:
      new Date(timestamp).getFullYear() === new Date(now).getFullYear()
        ? undefined
        : 'numeric',
  }).format(new Date(timestamp));
}

function getStateBadge(pullRequest: HostedPullRequest) {
  if (pullRequest.state === 'merged') {
    return {
      label: 'Merged',
      icon: GitMergeIcon,
      className: 'bg-purple-500/10 text-purple-500 ring-purple-500/20',
    };
  }
  if (pullRequest.state === 'closed') {
    return {
      label: 'Closed',
      icon: XCircleIcon,
      className:
        'bg-error-foreground/10 text-error-foreground ring-error-foreground/20',
    };
  }
  if (pullRequest.draft) {
    return {
      label: 'Draft',
      icon: CircleDotIcon,
      className:
        'bg-token-bg-tertiary text-token-text-secondary ring-token-border-default',
    };
  }
  return {
    label: 'Open',
    icon: GitPullRequestArrowIcon,
    className:
      'bg-success-foreground/10 text-success-foreground ring-success-foreground/20',
  };
}

function checkIcon(state: HostedPullRequestCheckState) {
  switch (state) {
    case 'success':
      return <CheckCircle2Icon className="size-3.5 text-success-foreground" />;
    case 'failure':
      return <XCircleIcon className="size-3.5 text-error-foreground" />;
    case 'pending':
      return <Clock3Icon className="size-3.5 text-warning-foreground" />;
    default:
      return <CircleDotIcon className="size-3.5 text-token-text-tertiary" />;
  }
}

function patchLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) {
    return 'bg-token-bg-secondary text-token-text-tertiary';
  }
  if (line.startsWith('@@')) {
    return 'bg-codex-blue-400/8 text-codex-blue-500';
  }
  if (line.startsWith('+')) {
    return 'bg-success-foreground/8 text-token-text-primary';
  }
  if (line.startsWith('-')) {
    return 'bg-error-foreground/8 text-token-text-primary';
  }
  return 'text-token-text-secondary';
}

function FilePatch({
  file,
  open,
  active,
  onToggle,
  onOpenExternal,
  pendingComments,
  editor,
  onStartComment,
  onChangeEditor,
  onSaveEditor,
  onCancelEditor,
  onEditComment,
  onRemoveComment,
  reviewLocked,
}: {
  file: HostedPullRequestFile;
  open: boolean;
  active: boolean;
  onToggle: () => void;
  onOpenExternal: (url: string) => void;
  pendingComments: PendingInlineComment[];
  editor: InlineCommentEditor | null;
  onStartComment: (
    path: string,
    line: number,
    side: HostedPullRequestCommentSide,
  ) => void;
  onChangeEditor: (body: string) => void;
  onSaveEditor: () => void;
  onCancelEditor: () => void;
  onEditComment: (comment: PendingInlineComment) => void;
  onRemoveComment: (id: string) => void;
  reviewLocked: boolean;
}) {
  const patchLines = useMemo(
    () => parseHostedPullRequestPatch(file.patch ?? ''),
    [file.patch],
  );
  const commentsById = useMemo(
    () => new Map(pendingComments.map((comment) => [comment.id, comment])),
    [pendingComments],
  );

  return (
    <section
      id={`pr-file-${encodeURIComponent(file.path)}`}
      className={cn(
        'overflow-hidden rounded-xl border bg-token-main-surface-primary shadow-codex-hairline',
        active
          ? 'border-codex-blue-400/35 ring-1 ring-codex-blue-400/12'
          : 'border-token-border-light',
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 border-token-border-light border-b px-3 py-2.5 text-left transition-colors hover:bg-token-list-hover-background"
        onClick={onToggle}
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-token-text-tertiary" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-token-text-tertiary" />
        )}
        <FileIcon filePath={file.path} className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium text-xs">
          {file.path}
        </span>
        <span className="rounded-md bg-token-bg-secondary px-1.5 py-0.5 text-[10px] text-token-text-tertiary uppercase">
          {file.status}
        </span>
        <span className="flex shrink-0 gap-1.5 font-mono text-[10px] tabular-nums">
          {file.additions > 0 && (
            <span className="text-success-foreground">+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span className="text-error-foreground">-{file.deletions}</span>
          )}
        </span>
      </button>

      {open &&
        (file.patch ? (
          <div className="overflow-x-auto bg-token-bg-secondary/25 py-1 font-mono text-[11px] leading-5">
            {patchLines.map((line) => {
              const target = line.commentTarget;
              const commentId = target
                ? inlineCommentId(file.path, target.line, target.side)
                : null;
              const pendingComment = commentId
                ? commentsById.get(commentId)
                : undefined;
              const editorOpen = commentId !== null && editor?.id === commentId;
              const targetLocked =
                reviewLocked || (editor !== null && !editorOpen);

              return (
                <div
                  // A patch can contain duplicate text; the parser index is the
                  // stable identity inside this immutable GitHub response.
                  key={`${line.index}:${line.text.slice(0, 20)}`}
                  className="min-w-[680px]"
                >
                  <div
                    className={cn(
                      'group/line grid grid-cols-[28px_42px_42px_minmax(0,1fr)] items-stretch',
                      patchLineClass(line.text),
                    )}
                  >
                    <div className="flex items-center justify-center">
                      {target && (
                        <button
                          type="button"
                          disabled={targetLocked}
                          className={cn(
                            'app-no-drag flex size-5 items-center justify-center rounded-md text-token-text-tertiary opacity-0 transition-colors hover:bg-codex-blue-400/12 hover:text-codex-blue-500 focus-visible:opacity-100 disabled:pointer-events-none group-hover/line:opacity-100',
                            (pendingComment || editorOpen) &&
                              'bg-codex-blue-400/10 text-codex-blue-500 opacity-100',
                          )}
                          aria-label={`${pendingComment ? 'Edit' : 'Add'} comment on ${file.path} line ${target.line}`}
                          onClick={() => {
                            if (pendingComment) onEditComment(pendingComment);
                            else
                              onStartComment(
                                file.path,
                                target.line,
                                target.side,
                              );
                          }}
                        >
                          {pendingComment ? (
                            <MessageSquarePlusIcon className="size-3" />
                          ) : (
                            <PlusIcon className="size-3" />
                          )}
                        </button>
                      )}
                    </div>
                    <span className="select-none border-token-border-light border-r px-2 text-right text-token-text-tertiary/70 tabular-nums">
                      {line.oldLine ?? ''}
                    </span>
                    <span className="select-none border-token-border-light border-r px-2 text-right text-token-text-tertiary/70 tabular-nums">
                      {line.newLine ?? ''}
                    </span>
                    <span className="whitespace-pre px-3">
                      {line.text || ' '}
                    </span>
                  </div>

                  {editorOpen && editor && (
                    <div className="border-codex-blue-400/25 border-y bg-token-main-surface-primary px-4 py-3 font-sans">
                      <textarea
                        autoFocus
                        disabled={reviewLocked}
                        value={editor.body}
                        onChange={(event) =>
                          onChangeEditor(event.currentTarget.value)
                        }
                        placeholder="Leave an inline comment…"
                        aria-label={`Comment on ${file.path} line ${editor.line}`}
                        maxLength={65_536}
                        className="min-h-20 w-full resize-y rounded-lg border border-token-border-light bg-token-input-background px-3 py-2 text-xs leading-5 outline-none placeholder:text-token-text-tertiary focus:border-codex-blue-400/55"
                      />
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <span className="text-[10px] text-token-text-tertiary">
                          {editor.side === 'LEFT' ? 'Original' : 'Updated'} line{' '}
                          {editor.line}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="ghost"
                            size="xs"
                            disabled={reviewLocked}
                            onClick={onCancelEditor}
                          >
                            Cancel
                          </Button>
                          <Button
                            variant="primary"
                            size="xs"
                            disabled={reviewLocked || !editor.body.trim()}
                            onClick={onSaveEditor}
                          >
                            Save comment
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {pendingComment && !editorOpen && (
                    <div className="border-codex-blue-400/18 border-y bg-codex-blue-400/5 px-4 py-2.5 font-sans">
                      <div className="flex items-start gap-2">
                        <MessageSquarePlusIcon className="mt-0.5 size-3.5 shrink-0 text-codex-blue-500" />
                        <p className="min-w-0 flex-1 whitespace-pre-wrap text-token-text-secondary text-xs leading-5">
                          {pendingComment.body}
                        </p>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Edit pending comment"
                          disabled={targetLocked}
                          onClick={() => onEditComment(pendingComment)}
                        >
                          <PencilIcon className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Remove pending comment"
                          disabled={targetLocked}
                          onClick={() => onRemoveComment(pendingComment.id)}
                        >
                          <Trash2Icon className="size-3" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex min-h-28 flex-col items-center justify-center gap-2 bg-token-bg-secondary/20 px-5 text-center">
            <FileCode2Icon className="size-5 text-token-text-tertiary" />
            <p className="text-token-text-secondary text-xs">
              GitHub did not provide a text patch for this file.
            </p>
            <button
              type="button"
              className="text-codex-blue-500 text-xs hover:underline"
              onClick={() => onOpenExternal(file.blobUrl)}
            >
              Open file on GitHub
            </button>
          </div>
        ))}
    </section>
  );
}

function getInitiallyOpenFiles(pullRequest: HostedPullRequest): Set<string> {
  const paths = pullRequest.files.map((file) => file.path);
  return new Set(paths.length <= 20 ? paths : paths.slice(0, 1));
}

export function HostedPullRequestReview({
  pullRequest,
  authenticated,
  onRefresh,
  onOpenExternal,
  onSubmitReview,
  onMerge,
  relativeNow,
}: HostedPullRequestReviewProps) {
  const [filePanelOpen, setFilePanelOpen] = useState(true);
  const [fileFilter, setFileFilter] = useState('');
  const [activeFile, setActiveFile] = useState<string | null>(
    pullRequest.files[0]?.path ?? null,
  );
  const [openFiles, setOpenFiles] = useState<Set<string>>(() =>
    getInitiallyOpenFiles(pullRequest),
  );
  const [summary, setSummary] = useState('');
  const [pendingComments, setPendingComments] = useState<
    PendingInlineComment[]
  >([]);
  const [inlineEditor, setInlineEditor] = useState<InlineCommentEditor | null>(
    null,
  );
  const [confirmationEvent, setConfirmationEvent] =
    useState<ConfirmedReviewEvent | null>(null);
  const [submission, setSubmission] = useState<ReviewSubmissionState>({
    status: 'idle',
  });
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergeMethod, setMergeMethod] =
    useState<HostedPullRequestMergeMethod | null>(
      pullRequest.mergePolicy.defaultMethod,
    );
  const [mergeConfirmation, setMergeConfirmation] = useState('');
  const [mergeSubmission, setMergeSubmission] = useState<MergeSubmissionState>({
    status: 'idle',
  });
  const reviewIdentity = `${pullRequest.repository.fullName}#${pullRequest.number}@${pullRequest.head.sha}`;

  useEffect(() => {
    setFileFilter('');
    setActiveFile(pullRequest.files[0]?.path ?? null);
    setOpenFiles(getInitiallyOpenFiles(pullRequest));
    setSummary('');
    setPendingComments([]);
    setInlineEditor(null);
    setConfirmationEvent(null);
    setSubmission({ status: 'idle' });
    setMergeDialogOpen(false);
    setMergeMethod(pullRequest.mergePolicy.defaultMethod);
    setMergeConfirmation('');
    setMergeSubmission({ status: 'idle' });
  }, [reviewIdentity]);

  useEffect(() => {
    if (
      mergeMethod === null ||
      !pullRequest.mergePolicy.availableMethods.includes(mergeMethod)
    ) {
      setMergeMethod(pullRequest.mergePolicy.defaultMethod);
    }
  }, [
    mergeMethod,
    pullRequest.mergePolicy.availableMethods,
    pullRequest.mergePolicy.defaultMethod,
  ]);

  const filteredFiles = useMemo(() => {
    const normalized = fileFilter.trim().toLowerCase();
    return normalized
      ? pullRequest.files.filter((file) =>
          file.path.toLowerCase().includes(normalized),
        )
      : pullRequest.files;
  }, [fileFilter, pullRequest.files]);

  const scrollToFile = useCallback((path: string) => {
    setActiveFile(path);
    setOpenFiles((current) => new Set(current).add(path));
    requestAnimationFrame(() => {
      document
        .getElementById(`pr-file-${encodeURIComponent(path)}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  const startInlineComment = useCallback(
    (path: string, line: number, side: HostedPullRequestCommentSide) => {
      const id = inlineCommentId(path, line, side);
      const existing = pendingComments.find((comment) => comment.id === id);
      setInlineEditor({
        id,
        path,
        line,
        side,
        body: existing?.body ?? '',
      });
      setSubmission({ status: 'idle' });
    },
    [pendingComments],
  );

  const saveInlineComment = useCallback(() => {
    if (!inlineEditor?.body.trim()) return;
    const nextComment: PendingInlineComment = {
      id: inlineEditor.id,
      path: inlineEditor.path,
      line: inlineEditor.line,
      side: inlineEditor.side,
      body: inlineEditor.body.trim(),
    };
    setPendingComments((current) => [
      ...current.filter((comment) => comment.id !== nextComment.id),
      nextComment,
    ]);
    setInlineEditor(null);
    setSubmission({ status: 'idle' });
  }, [inlineEditor]);

  const editInlineComment = useCallback((comment: PendingInlineComment) => {
    setInlineEditor({
      id: comment.id,
      path: comment.path,
      line: comment.line,
      side: comment.side,
      body: comment.body,
    });
    setSubmission({ status: 'idle' });
  }, []);

  const removeInlineComment = useCallback((id: string) => {
    setPendingComments((current) =>
      current.filter((comment) => comment.id !== id),
    );
    setInlineEditor((current) => (current?.id === id ? null : current));
    setSubmission({ status: 'idle' });
  }, []);

  const reviewUnavailableMessage =
    pullRequest.state !== 'open'
      ? 'This pull request is no longer open for review.'
      : pullRequest.draft
        ? 'Draft pull requests must be marked ready on GitHub before review submission.'
        : !authenticated
          ? 'Add a GitHub Personal Access Token in Settings → Plugins to submit reviews.'
          : null;
  const hasReviewContent =
    summary.trim().length > 0 || pendingComments.length > 0;
  const isSubmitting = submission.status === 'submitting';
  const isMerging = mergeSubmission.status === 'submitting';
  const isWriting = isSubmitting || isMerging;
  const hasLocalReviewDraft = hasReviewContent || inlineEditor !== null;
  const canSubmitBase =
    reviewUnavailableMessage === null && !isWriting && inlineEditor === null;
  const mergePolicyReady = pullRequest.mergePolicy.status === 'ready';
  const mergeMethodAvailable =
    mergeMethod !== null &&
    pullRequest.mergePolicy.availableMethods.includes(mergeMethod);
  const mergeConfirmationMatches =
    mergeConfirmation.trim() === pullRequest.mergePolicy.confirmationText;
  const canConfirmMerge =
    mergePolicyReady &&
    !hasLocalReviewDraft &&
    mergeMethodAvailable &&
    mergeConfirmationMatches &&
    !isWriting;

  const submitReview = useCallback(
    async (event: HostedPullRequestReviewEvent) => {
      if (
        isWriting ||
        reviewUnavailableMessage !== null ||
        inlineEditor !== null ||
        ((event === 'COMMENT' || event === 'REQUEST_CHANGES') &&
          !hasReviewContent)
      ) {
        return;
      }

      setSubmission({ status: 'submitting', event });
      try {
        const result = await onSubmitReview({
          repository: {
            owner: pullRequest.repository.owner,
            name: pullRequest.repository.name,
          },
          number: pullRequest.number,
          commitId: pullRequest.head.sha,
          event,
          body: summary.trim(),
          comments: pendingComments.map(({ id: _id, ...comment }) => comment),
        });
        if (!result.ok) {
          setSubmission({
            status: 'error',
            message: result.message,
            retryable: result.retryable,
          });
          return;
        }

        setSummary('');
        setPendingComments([]);
        setInlineEditor(null);
        setSubmission({
          status: 'success',
          message: reviewEventLabel(event),
          reviewUrl: result.reviewUrl,
        });
        onRefresh();
      } catch (error) {
        setSubmission({
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'The review could not be submitted. Try again.',
          retryable: true,
        });
      }
    },
    [
      hasReviewContent,
      inlineEditor,
      isWriting,
      onRefresh,
      onSubmitReview,
      pendingComments,
      pullRequest,
      reviewUnavailableMessage,
      summary,
    ],
  );

  const submitMerge = useCallback(async () => {
    if (!canConfirmMerge || !mergeMethod) return;

    setMergeSubmission({ status: 'submitting' });
    try {
      const result = await onMerge({
        repository: {
          owner: pullRequest.repository.owner,
          name: pullRequest.repository.name,
        },
        number: pullRequest.number,
        expectedHeadSha: pullRequest.head.sha,
        expectedBaseSha: pullRequest.base.sha,
        method: mergeMethod,
        confirmationText: mergeConfirmation.trim(),
      });
      if (!result.ok) {
        setMergeSubmission({
          status: 'error',
          message: result.message,
          retryable: result.retryable,
        });
        if (result.retryable) onRefresh();
        return;
      }

      setMergeSubmission({
        status: 'success',
        message: result.message,
        mergeCommitSha: result.mergeCommitSha,
      });
      setMergeDialogOpen(false);
      setMergeConfirmation('');
      onRefresh();
    } catch (error) {
      setMergeSubmission({
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'The pull request could not be merged. Refresh and try again.',
        retryable: true,
      });
    }
  }, [
    canConfirmMerge,
    mergeConfirmation,
    mergeMethod,
    onMerge,
    onRefresh,
    pullRequest,
  ]);

  const badge = getStateBadge(pullRequest);
  const BadgeIcon = badge.icon;

  return (
    <div
      className="codex-review-shell flex h-screen w-screen flex-col overflow-hidden text-token-text-primary"
      data-visual-surface="hosted-pull-request"
    >
      <header className="codex-review-toolbar z-20 flex min-h-12 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-full"
          aria-label={
            filePanelOpen ? 'Hide changed files' : 'Show changed files'
          }
          onClick={() => setFilePanelOpen((current) => !current)}
        >
          <GitPullRequestArrowIcon className="size-4" />
        </Button>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-semibold text-sm">
              {pullRequest.repository.fullName}
            </span>
            <span className="text-token-text-tertiary text-xs">
              #{pullRequest.number}
            </span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span
            className={cn(
              'hidden items-center gap-1 rounded-full px-2 py-1 text-[11px] ring-1 ring-inset sm:flex',
              badge.className,
            )}
          >
            <BadgeIcon className="size-3" />
            {badge.label}
          </span>
          <Button
            variant={
              pullRequest.mergePolicy.status === 'ready'
                ? 'primary'
                : 'secondary'
            }
            size="sm"
            className="rounded-full"
            disabled={isWriting}
            onClick={() => {
              setMergeSubmission((current) =>
                current.status === 'success' ? current : { status: 'idle' },
              );
              setMergeDialogOpen(true);
            }}
          >
            <LockKeyholeIcon className="size-3.5" />
            <span className="hidden sm:inline">Protected merge</span>
            <span className="sm:hidden">Merge</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-full"
            aria-label="Refresh pull request"
            disabled={isWriting}
            onClick={onRefresh}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full"
            onClick={() => onOpenExternal(pullRequest.url)}
          >
            <ExternalLinkIcon className="size-3.5" />
            <span className="hidden sm:inline">GitHub</span>
          </Button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {filePanelOpen && (
          <aside className="codex-review-sidebar absolute inset-y-0 left-0 z-30 flex w-[min(86vw,300px)] shrink-0 flex-col border-r shadow-codex-xl md:relative md:z-auto md:shadow-none">
            <div className="border-token-border-light border-b p-3">
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] ring-1 ring-inset sm:hidden',
                  badge.className,
                )}
              >
                <BadgeIcon className="size-3" />
                {badge.label}
              </span>
              <h1 className="mt-2 font-semibold text-sm leading-5">
                {pullRequest.title}
              </h1>
              <div className="mt-2 flex items-center gap-2 text-[11px] text-token-text-tertiary">
                {pullRequest.author.avatarUrl ? (
                  <img
                    src={pullRequest.author.avatarUrl}
                    alt=""
                    className="size-5 rounded-full"
                  />
                ) : (
                  <span className="flex size-5 items-center justify-center rounded-full bg-token-bg-tertiary">
                    {pullRequest.author.login.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="truncate">{pullRequest.author.login}</span>
                <span>
                  updated{' '}
                  {formatRelativeDate(pullRequest.updatedAt, relativeNow)}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-1.5 text-[11px]">
                <div className="rounded-lg bg-token-bg-secondary/60 px-2 py-1.5">
                  <span className="block text-token-text-tertiary">Base</span>
                  <span className="block truncate">
                    {pullRequest.base.branch}
                  </span>
                </div>
                <div className="rounded-lg bg-token-bg-secondary/60 px-2 py-1.5">
                  <span className="block text-token-text-tertiary">Head</span>
                  <span className="block truncate">
                    {pullRequest.head.branch}
                  </span>
                </div>
              </div>
            </div>

            <div className="border-token-border-light border-b p-3">
              <div className="flex items-center gap-2">
                {pullRequest.checks.failed > 0 ? (
                  <ShieldAlertIcon className="size-4 text-error-foreground" />
                ) : pullRequest.checks.pending > 0 ? (
                  <Clock3Icon className="size-4 text-warning-foreground" />
                ) : (
                  <CheckCircle2Icon className="size-4 text-success-foreground" />
                )}
                <span className="font-medium text-xs">
                  {pullRequest.checks.total === 0
                    ? 'No checks reported'
                    : `${pullRequest.checks.successful}/${pullRequest.checks.total} checks passed`}
                </span>
              </div>
              {pullRequest.checks.checks.length > 0 && (
                <div className="mt-2 flex max-h-32 flex-col gap-1 overflow-auto">
                  {pullRequest.checks.checks.map((check) => (
                    <button
                      key={check.id}
                      type="button"
                      disabled={!check.detailsUrl}
                      className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[11px] hover:bg-token-list-hover-background disabled:pointer-events-none"
                      onClick={() => {
                        if (check.detailsUrl) onOpenExternal(check.detailsUrl);
                      }}
                    >
                      {checkIcon(check.state)}
                      <span className="min-w-0 flex-1 truncate">
                        {check.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="p-2.5">
              <div className="flex h-8 items-center gap-2 rounded-lg border border-token-border-light bg-token-main-surface-primary/60 px-2.5">
                <SearchIcon className="size-3.5 text-token-text-tertiary" />
                <input
                  value={fileFilter}
                  onChange={(event) => setFileFilter(event.currentTarget.value)}
                  placeholder="Filter changed files…"
                  aria-label="Filter changed files"
                  className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-token-text-tertiary"
                />
              </div>
            </div>
            <OverlayScrollbar
              className="min-h-0 flex-1"
              contentClassName="px-2 pb-3"
            >
              <div className="flex flex-col gap-0.5">
                {filteredFiles.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    aria-current={activeFile === file.path ? 'true' : undefined}
                    className={cn(
                      'flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left',
                      activeFile === file.path
                        ? 'bg-token-list-hover-background text-token-text-primary'
                        : 'text-token-text-secondary hover:bg-token-list-hover-background',
                    )}
                    onClick={() => {
                      scrollToFile(file.path);
                      if (window.innerWidth < 768) setFilePanelOpen(false);
                    }}
                  >
                    <FileIcon
                      filePath={file.path}
                      className="size-4 shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {file.path}
                    </span>
                    <span className="flex gap-1 font-mono text-[10px]">
                      <span className="text-success-foreground">
                        +{file.additions}
                      </span>
                      <span className="text-error-foreground">
                        -{file.deletions}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </OverlayScrollbar>
          </aside>
        )}

        <OverlayScrollbar
          className="min-w-0 flex-1"
          contentClassName="px-3 pt-4 pb-64 sm:px-5"
        >
          <main className="mx-auto flex w-full max-w-5xl flex-col gap-3">
            <section className="rounded-xl border border-token-border-light bg-token-main-surface-primary p-4 shadow-codex-hairline">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <h1 className="font-semibold text-lg leading-6">
                    {pullRequest.title}
                  </h1>
                  <p className="mt-1 text-token-text-tertiary text-xs">
                    {pullRequest.author.login} wants to merge{' '}
                    <span className="font-mono text-token-text-secondary">
                      {pullRequest.commits}
                    </span>{' '}
                    commit{pullRequest.commits === 1 ? '' : 's'} into{' '}
                    <span className="font-mono text-token-text-secondary">
                      {pullRequest.base.branch}
                    </span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-[11px] text-token-text-tertiary">
                  <span className="flex items-center gap-1">
                    <GitCommitHorizontalIcon className="size-3.5" />
                    {pullRequest.commits}
                  </span>
                  <span>{pullRequest.changedFiles} files</span>
                  <span className="font-mono text-success-foreground">
                    +{pullRequest.additions}
                  </span>
                  <span className="font-mono text-error-foreground">
                    -{pullRequest.deletions}
                  </span>
                </div>
              </div>
              {pullRequest.body && (
                <p className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap border-token-border-light border-t pt-3 text-token-text-secondary text-xs leading-5">
                  {pullRequest.body}
                </p>
              )}
            </section>

            {filteredFiles.map((file) => (
              <FilePatch
                key={file.path}
                file={file}
                open={openFiles.has(file.path)}
                active={activeFile === file.path}
                onOpenExternal={onOpenExternal}
                pendingComments={pendingComments.filter(
                  (comment) => comment.path === file.path,
                )}
                editor={inlineEditor}
                onStartComment={startInlineComment}
                onChangeEditor={(body) =>
                  setInlineEditor((current) =>
                    current ? { ...current, body } : current,
                  )
                }
                onSaveEditor={saveInlineComment}
                onCancelEditor={() => setInlineEditor(null)}
                onEditComment={editInlineComment}
                onRemoveComment={removeInlineComment}
                reviewLocked={isWriting}
                onToggle={() => {
                  setActiveFile(file.path);
                  setOpenFiles((current) => {
                    const next = new Set(current);
                    if (next.has(file.path)) next.delete(file.path);
                    else next.add(file.path);
                    return next;
                  });
                }}
              />
            ))}

            {pullRequest.filesTruncated && (
              <div className="rounded-xl border border-warning-foreground/20 bg-warning-foreground/7 px-4 py-3 text-token-text-secondary text-xs">
                GitHub returned {pullRequest.files.length} of{' '}
                {pullRequest.changedFiles} changed files. Open the pull request
                on GitHub to review the remainder.
              </div>
            )}

            <section
              className={cn(
                'fixed right-3 bottom-3 rounded-2xl border border-token-border-light bg-token-main-surface-primary/95 p-3 shadow-codex-xl backdrop-blur-xl sm:p-4',
                filePanelOpen
                  ? 'left-3 z-20 md:left-[312px] md:z-40'
                  : 'left-3 z-40',
              )}
            >
              <div className="flex items-start gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-codex-blue-400/10 text-codex-blue-500">
                  <MessageSquarePlusIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="font-semibold text-sm">Submit review</h2>
                      <p className="mt-0.5 text-[11px] text-token-text-tertiary">
                        {pendingComments.length === 0
                          ? 'No pending inline comments'
                          : `${pendingComments.length} pending inline comment${pendingComments.length === 1 ? '' : 's'}`}
                      </p>
                    </div>
                    <span className="rounded-full bg-token-bg-secondary px-2 py-1 font-mono text-[10px] text-token-text-tertiary">
                      {pullRequest.head.sha.slice(0, 7)}
                    </span>
                  </div>

                  <textarea
                    value={summary}
                    onChange={(event) => {
                      setSummary(event.currentTarget.value);
                      if (submission.status !== 'submitting') {
                        setSubmission({ status: 'idle' });
                      }
                    }}
                    placeholder="Add a review summary…"
                    aria-label="Review summary"
                    maxLength={65_536}
                    disabled={isWriting}
                    className="mt-3 min-h-20 w-full resize-y rounded-xl border border-token-border-light bg-token-input-background px-3 py-2 text-xs leading-5 outline-none placeholder:text-token-text-tertiary focus:border-codex-blue-400/55"
                  />

                  {reviewUnavailableMessage && (
                    <div className="mt-2 flex items-start gap-2 rounded-lg border border-warning-foreground/20 bg-warning-foreground/7 px-3 py-2 text-token-text-secondary text-xs leading-5">
                      <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" />
                      {reviewUnavailableMessage}
                    </div>
                  )}
                  {inlineEditor && (
                    <div className="mt-2 flex items-start gap-2 rounded-lg border border-codex-blue-400/20 bg-codex-blue-400/6 px-3 py-2 text-token-text-secondary text-xs leading-5">
                      <PencilIcon className="mt-0.5 size-3.5 shrink-0 text-codex-blue-500" />
                      Save or cancel the open inline comment before submitting.
                    </div>
                  )}
                  {submission.status === 'error' && (
                    <div className="mt-2 flex items-start gap-2 rounded-lg border border-error-foreground/20 bg-error-foreground/7 px-3 py-2 text-token-text-secondary text-xs leading-5">
                      <XCircleIcon className="mt-0.5 size-3.5 shrink-0 text-error-foreground" />
                      <span className="min-w-0 flex-1">
                        {submission.message}
                      </span>
                      {submission.retryable && (
                        <span className="shrink-0 text-[10px] text-token-text-tertiary uppercase">
                          Retry available
                        </span>
                      )}
                    </div>
                  )}
                  {submission.status === 'success' && (
                    <div className="mt-2 flex items-center gap-2 rounded-lg border border-success-foreground/20 bg-success-foreground/7 px-3 py-2 text-token-text-secondary text-xs">
                      <CheckCircle2Icon className="size-3.5 shrink-0 text-success-foreground" />
                      <span className="min-w-0 flex-1">
                        {submission.message}
                      </span>
                      {submission.reviewUrl && (
                        <button
                          type="button"
                          className="app-no-drag shrink-0 text-codex-blue-500 hover:underline"
                          onClick={() =>
                            onOpenExternal(submission.reviewUrl ?? '')
                          }
                        >
                          Open review
                        </button>
                      )}
                    </div>
                  )}
                  {mergeSubmission.status === 'success' && (
                    <div className="mt-2 flex items-center gap-2 rounded-lg border border-purple-500/20 bg-purple-500/7 px-3 py-2 text-token-text-secondary text-xs">
                      <GitMergeIcon className="size-3.5 shrink-0 text-purple-500" />
                      <span className="min-w-0 flex-1">
                        {mergeSubmission.message}
                      </span>
                      {mergeSubmission.mergeCommitSha && (
                        <span className="shrink-0 rounded-md bg-token-bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-token-text-tertiary">
                          {mergeSubmission.mergeCommitSha.slice(0, 7)}
                        </span>
                      )}
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!canSubmitBase || !hasReviewContent}
                      onClick={() => void submitReview('COMMENT')}
                    >
                      {submission.status === 'submitting' &&
                      submission.event === 'COMMENT' ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <SendIcon className="size-3.5" />
                      )}
                      Comment
                    </Button>
                    <Button
                      variant="success"
                      size="sm"
                      disabled={!canSubmitBase}
                      onClick={() => setConfirmationEvent('APPROVE')}
                    >
                      <ShieldCheckIcon className="size-3.5" />
                      Approve
                    </Button>
                    <Button
                      variant="warning"
                      size="sm"
                      disabled={!canSubmitBase || !hasReviewContent}
                      onClick={() => setConfirmationEvent('REQUEST_CHANGES')}
                    >
                      <ShieldAlertIcon className="size-3.5" />
                      Request changes
                    </Button>
                  </div>
                </div>
              </div>
            </section>
          </main>
        </OverlayScrollbar>
      </div>

      <Dialog
        open={confirmationEvent !== null}
        onOpenChange={(open) => {
          if (!open && !isSubmitting) setConfirmationEvent(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          {!isSubmitting && <DialogClose />}
          <DialogHeader>
            <DialogTitle>
              {confirmationEvent === 'APPROVE'
                ? 'Approve this pull request?'
                : 'Request changes?'}
            </DialogTitle>
            <DialogDescription>
              {confirmationEvent === 'APPROVE'
                ? 'This submits an approval review on GitHub. It does not merge the pull request.'
                : 'This submits a changes-requested review on GitHub and includes the current summary and pending inline comments.'}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-xl border border-token-border-light bg-token-bg-secondary/45 px-3 py-2.5 text-token-text-secondary text-xs leading-5">
            <span className="font-medium text-token-text-primary">
              {pendingComments.length}
            </span>{' '}
            inline comment{pendingComments.length === 1 ? '' : 's'}
            {summary.trim() ? ' plus a review summary' : ''}
          </div>
          <DialogFooter>
            <Button
              variant={confirmationEvent === 'APPROVE' ? 'success' : 'warning'}
              size="sm"
              disabled={isSubmitting || confirmationEvent === null}
              onClick={() => {
                if (!confirmationEvent) return;
                void submitReview(confirmationEvent).finally(() =>
                  setConfirmationEvent(null),
                );
              }}
            >
              {isSubmitting ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : confirmationEvent === 'APPROVE' ? (
                <ShieldCheckIcon className="size-3.5" />
              ) : (
                <ShieldAlertIcon className="size-3.5" />
              )}
              {confirmationEvent === 'APPROVE'
                ? 'Submit approval'
                : 'Request changes'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={isSubmitting}
              onClick={() => setConfirmationEvent(null)}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={mergeDialogOpen}
        onOpenChange={(open) => {
          if (open) {
            setMergeDialogOpen(true);
            return;
          }
          if (isMerging) return;
          setMergeDialogOpen(false);
          setMergeConfirmation('');
          setMergeSubmission((current) =>
            current.status === 'success' ? current : { status: 'idle' },
          );
        }}
      >
        <DialogContent className="max-h-[calc(100vh-2rem)] gap-4 overflow-y-auto sm:max-w-xl">
          {!isMerging && <DialogClose />}
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LockKeyholeIcon className="size-4 text-codex-blue-500" />
              Protected merge
            </DialogTitle>
            <DialogDescription>
              Clodex will re-check GitHub permissions, branch rules, checks,
              mergeability, and both commit heads immediately before writing to
              the base branch.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 rounded-xl border border-token-border-light bg-token-bg-secondary/45 px-3 py-2.5 text-xs">
            <span className="min-w-0 flex-1 truncate font-medium text-token-text-primary">
              {pullRequest.head.branch}
            </span>
            <span className="text-token-text-tertiary">into</span>
            <span className="min-w-0 flex-1 truncate text-right font-medium text-token-text-primary">
              {pullRequest.base.branch}
            </span>
          </div>

          <div className="grid gap-1.5 sm:grid-cols-2">
            {pullRequest.mergePolicy.gates.map((gate) => (
              <div
                key={gate.id}
                className="flex min-w-0 items-start gap-2 rounded-lg border border-token-border-light bg-token-main-surface-primary px-2.5 py-2"
              >
                <span className="mt-0.5 shrink-0">
                  {mergeGateIcon(gate.state)}
                </span>
                <div className="min-w-0">
                  <div className="font-medium text-[11px] text-token-text-primary">
                    {gate.label}
                  </div>
                  <p className="mt-0.5 text-[10px] text-token-text-tertiary leading-4">
                    {gate.message}
                  </p>
                </div>
              </div>
            ))}
            <div className="flex min-w-0 items-start gap-2 rounded-lg border border-token-border-light bg-token-main-surface-primary px-2.5 py-2">
              <span className="mt-0.5 shrink-0">
                {mergeGateIcon(hasLocalReviewDraft ? 'blocked' : 'pass')}
              </span>
              <div className="min-w-0">
                <div className="font-medium text-[11px] text-token-text-primary">
                  Local review draft
                </div>
                <p className="mt-0.5 text-[10px] text-token-text-tertiary leading-4">
                  {hasLocalReviewDraft
                    ? 'Submit or clear the review summary and inline comments before merging.'
                    : 'No unsent review content will be left behind.'}
                </p>
              </div>
            </div>
          </div>

          {pullRequest.mergePolicy.activeRules.length > 0 && (
            <div>
              <div className="text-[10px] text-token-text-tertiary uppercase tracking-wide">
                Active base-branch rules
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {pullRequest.mergePolicy.activeRules.map((rule) => (
                  <span
                    key={rule.type}
                    className="rounded-full border border-token-border-light bg-token-bg-secondary px-2 py-1 text-[10px] text-token-text-secondary"
                  >
                    {rule.label}
                  </span>
                ))}
              </div>
            </div>
          )}

          <label className="block">
            <span className="font-medium text-token-text-primary text-xs">
              Merge method
            </span>
            <select
              value={mergeMethod ?? ''}
              aria-label="Merge method"
              disabled={
                isWriting ||
                pullRequest.mergePolicy.availableMethods.length === 0
              }
              onChange={(event) => {
                setMergeMethod(
                  event.currentTarget.value as HostedPullRequestMergeMethod,
                );
                setMergeSubmission({ status: 'idle' });
              }}
              className="mt-1.5 h-9 w-full rounded-lg border border-token-border-light bg-token-input-background px-3 text-token-text-primary text-xs outline-none focus:border-codex-blue-400/55 disabled:opacity-50"
            >
              {pullRequest.mergePolicy.availableMethods.length === 0 && (
                <option value="">No direct merge method available</option>
              )}
              {pullRequest.mergePolicy.availableMethods.map((method) => (
                <option key={method} value={method}>
                  {mergeMethodLabel(method)}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="font-medium text-token-text-primary text-xs">
              Type{' '}
              <span className="font-mono">
                {pullRequest.mergePolicy.confirmationText}
              </span>{' '}
              to confirm
            </span>
            <input
              value={mergeConfirmation}
              aria-label="Protected merge confirmation"
              autoComplete="off"
              spellCheck={false}
              disabled={
                isWriting ||
                !mergePolicyReady ||
                hasLocalReviewDraft ||
                !mergeMethodAvailable
              }
              onChange={(event) => {
                setMergeConfirmation(event.currentTarget.value);
                setMergeSubmission({ status: 'idle' });
              }}
              className="mt-1.5 h-9 w-full rounded-lg border border-token-border-light bg-token-input-background px-3 font-mono text-token-text-primary text-xs outline-none placeholder:text-token-text-tertiary focus:border-codex-blue-400/55 disabled:opacity-50"
              placeholder={pullRequest.mergePolicy.confirmationText}
            />
          </label>

          {mergeSubmission.status === 'error' && (
            <div className="flex items-start gap-2 rounded-lg border border-error-foreground/20 bg-error-foreground/7 px-3 py-2 text-token-text-secondary text-xs leading-5">
              <XCircleIcon className="mt-0.5 size-3.5 shrink-0 text-error-foreground" />
              <span className="min-w-0 flex-1">{mergeSubmission.message}</span>
              {mergeSubmission.retryable && (
                <span className="shrink-0 text-[10px] text-token-text-tertiary uppercase">
                  Refresh required
                </span>
              )}
            </div>
          )}

          <div className="rounded-lg border border-warning-foreground/20 bg-warning-foreground/7 px-3 py-2 text-[11px] text-token-text-secondary leading-5">
            This action writes to{' '}
            <span className="font-mono text-token-text-primary">
              {pullRequest.base.branch}
            </span>{' '}
            on GitHub. Clodex does not provide an automatic undo.
          </div>

          <DialogFooter>
            <Button
              variant="success"
              size="sm"
              disabled={!canConfirmMerge}
              onClick={() => void submitMerge()}
            >
              {isMerging ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <GitMergeIcon className="size-3.5" />
              )}
              Merge pull request
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={isMerging}
              onClick={() => {
                setMergeDialogOpen(false);
                setMergeConfirmation('');
                setMergeSubmission((current) =>
                  current.status === 'success' ? current : { status: 'idle' },
                );
              }}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
