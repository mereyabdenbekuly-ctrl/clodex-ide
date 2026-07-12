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
import { Select } from '@clodex/stage-ui/components/select';
import { toast } from '@clodex/stage-ui/components/toaster';
import type {
  SessionContinuityReadiness,
  SessionShareRecord,
} from '@shared/session-continuity';
import { useKartonProcedure } from '@ui/hooks/use-karton';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import {
  CheckCircle2Icon,
  ClipboardIcon,
  CloudUploadIcon,
  LinkIcon,
  Loader2Icon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

function notify(
  title: string,
  message: string,
  type: 'info' | 'error' = 'info',
) {
  toast({
    id: `session-continuity-${Date.now()}`,
    title,
    message,
    type,
    duration: 4_000,
    actions: [],
  });
}

export function SessionContinuityDialog({
  sessionId,
  onClose,
}: {
  sessionId: string | null;
  onClose: () => void;
}) {
  const [, setOpenAgent] = useOpenAgent();
  const getReadiness = useKartonProcedure(
    (p) => p.sessionContinuity.getReadiness,
  );
  const teleport = useKartonProcedure((p) => p.sessionContinuity.teleport);
  const getShares = useKartonProcedure((p) => p.sessionContinuity.getShares);
  const createShare = useKartonProcedure(
    (p) => p.sessionContinuity.createShare,
  );
  const revokeShare = useKartonProcedure(
    (p) => p.sessionContinuity.revokeShare,
  );
  const setLastOpenAgentId = useKartonProcedure(
    (p) => p.browser.setLastOpenAgentId,
  );

  const [readiness, setReadiness] = useState<SessionContinuityReadiness | null>(
    null,
  );
  const [shares, setShares] = useState<SessionShareRecord[]>([]);
  const [prompt, setPrompt] = useState(
    'Continue this task in the cloud from the current context.',
  );
  const [expiresInHours, setExpiresInHours] = useState(24 * 7);
  const [busy, setBusy] = useState<
    'load' | 'teleport' | 'share' | string | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setBusy('load');
    setError(null);
    try {
      const [nextReadiness, snapshot] = await Promise.all([
        getReadiness(sessionId),
        getShares(),
      ]);
      setReadiness(nextReadiness);
      setShares(
        snapshot.shares.filter((share) => share.sessionId === sessionId),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Session continuity is unavailable.',
      );
    } finally {
      setBusy(null);
    }
  }, [getReadiness, getShares, sessionId]);

  useEffect(() => {
    if (sessionId) void refresh();
    else {
      setReadiness(null);
      setShares([]);
      setError(null);
    }
  }, [refresh, sessionId]);

  const handleTeleport = async () => {
    if (!sessionId) return;
    setBusy('teleport');
    try {
      const result = await teleport({ sessionId, prompt });
      setOpenAgent(result.agentId);
      await setLastOpenAgentId(result.agentId);
      notify('Cloud continuation started', 'The cloud task is now open.');
      onClose();
    } catch (cause) {
      notify(
        'Cloud continuation failed',
        cause instanceof Error ? cause.message : 'Please try again.',
        'error',
      );
    } finally {
      setBusy(null);
    }
  };

  const handleCreateShare = async () => {
    if (!sessionId) return;
    setBusy('share');
    try {
      const share = await createShare({ sessionId, expiresInHours });
      setShares((current) => [
        share,
        ...current.filter((item) => item.id !== share.id),
      ]);
      await navigator.clipboard.writeText(share.url);
      notify('Share link copied', 'The link is read-only and excludes tools.');
    } catch (cause) {
      notify(
        'Share could not be created',
        cause instanceof Error ? cause.message : 'Please try again.',
        'error',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={sessionId !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent className="max-h-[88vh] w-[min(680px,calc(100vw-2rem))] overflow-y-auto sm:min-w-0">
        <DialogClose />
        <DialogHeader>
          <DialogTitle>Continue or share task</DialogTitle>
          <DialogDescription>
            Move execution to the cloud or create an expiring read-only copy of
            the conversation.
          </DialogDescription>
        </DialogHeader>

        {busy === 'load' ? (
          <div className="flex min-h-40 items-center justify-center">
            <Loader2Icon className="size-5 animate-spin text-token-text-tertiary" />
          </div>
        ) : error ? (
          <div className="rounded-xl border border-error-solid/25 bg-error-solid/8 p-3 text-error-solid text-sm">
            {error}
          </div>
        ) : readiness ? (
          <div className="grid gap-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-token-border-light bg-token-bg-secondary/40 p-3">
                <p className="font-semibold text-token-text-primary">
                  {readiness.messageCount}
                </p>
                <p className="text-[11px] text-token-text-tertiary">messages</p>
              </div>
              <div className="rounded-xl border border-token-border-light bg-token-bg-secondary/40 p-3">
                <p className="font-semibold text-token-text-primary">
                  {readiness.workspacePaths.length}
                </p>
                <p className="text-[11px] text-token-text-tertiary">
                  workspaces
                </p>
              </div>
              <div className="col-span-2 flex items-center gap-2 rounded-xl border border-token-border-light bg-token-bg-secondary/40 p-3 text-token-text-secondary text-xs">
                <ShieldCheckIcon className="size-4 text-clodex-green-400" />
                Tools and attachments are excluded from shared copies.
              </div>
            </div>

            {readiness.reasons.length > 0 && (
              <div className="rounded-xl border border-warning-solid/20 bg-warning-solid/7 p-3 text-token-text-secondary text-xs">
                {readiness.reasons.join(' · ')}
              </div>
            )}

            <section className="grid gap-3">
              <div>
                <h3 className="font-medium text-token-text-primary">
                  Continue in cloud
                </h3>
                <p className="mt-1 text-token-text-secondary text-xs">
                  A new cloud turn continues from this session without modifying
                  local history.
                </p>
              </div>
              <textarea
                aria-label="Cloud continuation prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.currentTarget.value)}
                className="min-h-20 resize-y rounded-xl border border-token-border-light bg-token-main-surface-primary p-3 text-sm text-token-text-primary outline-none focus:ring-1 focus:ring-token-focus-border"
              />
              <Button
                className="justify-self-start"
                disabled={
                  !readiness.readyForTeleport || !prompt.trim() || busy !== null
                }
                onClick={() => void handleTeleport()}
              >
                {busy === 'teleport' ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <CloudUploadIcon className="size-4" />
                )}
                Continue in cloud
              </Button>
            </section>

            <section className="grid gap-3 border-token-border-light border-t pt-5">
              <div>
                <h3 className="font-medium text-token-text-primary">
                  Read-only sharing
                </h3>
                <p className="mt-1 text-token-text-secondary text-xs">
                  Links can be revoked at any time and expire automatically.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Select
                  value={expiresInHours}
                  items={[
                    { value: 24, label: 'Expires in 1 day' },
                    { value: 24 * 7, label: 'Expires in 7 days' },
                    { value: 24 * 30, label: 'Expires in 30 days' },
                  ]}
                  onValueChange={(value) => setExpiresInHours(Number(value))}
                  size="sm"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!readiness.readyForSharing || busy !== null}
                  onClick={() => void handleCreateShare()}
                >
                  {busy === 'share' ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <LinkIcon className="size-3.5" />
                  )}
                  Create and copy link
                </Button>
              </div>

              {shares.map((share) => (
                <div
                  key={share.id}
                  className="flex items-center gap-3 rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3"
                >
                  {share.revokedAt ? (
                    <Trash2Icon className="size-4 text-token-text-tertiary" />
                  ) : (
                    <CheckCircle2Icon className="size-4 text-success-solid" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-token-text-primary text-xs">
                      {share.url}
                    </p>
                    <p className="mt-0.5 text-[10px] text-token-text-tertiary">
                      {share.revokedAt
                        ? 'Revoked'
                        : `Expires ${new Date(share.expiresAt).toLocaleString()}`}
                    </p>
                  </div>
                  {!share.revokedAt && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Copy link"
                        onClick={() => {
                          void navigator.clipboard.writeText(share.url);
                          notify('Link copied', 'Ready to share.');
                        }}
                      >
                        <ClipboardIcon className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Revoke link"
                        disabled={busy === share.id}
                        onClick={() => {
                          setBusy(share.id);
                          void revokeShare(share.id)
                            .then((revoked) =>
                              setShares((current) =>
                                current.map((item) =>
                                  item.id === revoked.id ? revoked : item,
                                ),
                              ),
                            )
                            .finally(() => setBusy(null));
                        }}
                      >
                        {busy === share.id ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2Icon className="size-3.5" />
                        )}
                      </Button>
                    </>
                  )}
                </div>
              ))}
            </section>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
