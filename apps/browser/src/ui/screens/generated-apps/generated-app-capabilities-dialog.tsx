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
import { Switch } from '@clodex/stage-ui/components/switch';
import { toast } from '@clodex/stage-ui/components/toaster';
import type {
  ArtifactBridgeCapability,
  ArtifactBridgeContext,
  ArtifactBridgeGrant,
} from '@shared/artifact-bridge';
import type {
  ArtifactBridgeGrantReviewSelection,
  ArtifactBridgeGrantReviewSnapshot,
} from '@shared/artifact-bridge-grant-review';
import { useKartonProcedure } from '@ui/hooks/use-karton';
import {
  BotIcon,
  CalendarClockIcon,
  CircleAlertIcon,
  FingerprintIcon,
  Loader2Icon,
  PenLineIcon,
  PlugZapIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  createGeneratedAppGrantReviewSubmission,
  createInitialGeneratedAppGrantReviewSelection,
  getGeneratedAppGrantReviewAutomationOptions,
  getGeneratedAppGrantReviewCapabilityOptions,
  getGeneratedAppGrantReviewExpiryState,
  getGeneratedAppGrantReviewMcpToolOptions,
  hasUnsupportedGeneratedAppWriteSelection,
  parseGeneratedAppGrantReviewSnapshot,
  setGeneratedAppGrantReviewAutomation,
  setGeneratedAppGrantReviewCapability,
  setGeneratedAppGrantReviewExpiry,
  setGeneratedAppGrantReviewMcpTool,
} from './generated-app-capabilities-dialog-model';

const CAPABILITY_PRESENTATION = {
  'agent:ask': {
    label: 'Ask agent',
    icon: BotIcon,
  },
  'automation:run': {
    label: 'Run declared automations',
    icon: CalendarClockIcon,
  },
  'mcp:call': {
    label: 'Call declared MCP read tools',
    icon: PlugZapIcon,
  },
  'mcp:write': {
    label: 'Call declared MCP write tools',
    icon: PenLineIcon,
  },
} satisfies Record<
  ArtifactBridgeCapability,
  { label: string; icon: typeof BotIcon }
>;

function notify(
  title: string,
  message: string,
  type: 'info' | 'error' = 'info',
) {
  toast({
    id: `artifact-grant-${Date.now()}`,
    title,
    message,
    type,
    duration: 4_000,
    actions: [],
  });
}

function ReviewFact({
  label,
  value,
  code = false,
}: {
  label: string;
  value: string;
  code?: boolean;
}) {
  return (
    <div className="grid gap-1">
      <dt className="text-[10px] text-token-text-tertiary uppercase tracking-[0.08em]">
        {label}
      </dt>
      <dd
        className={
          code
            ? 'break-all font-mono text-[11px] text-token-text-primary'
            : 'text-token-text-primary text-xs'
        }
      >
        {value}
      </dd>
    </div>
  );
}

export function GeneratedAppCapabilitiesDialog({
  context,
  open,
  onOpenChange,
}: {
  context: ArtifactBridgeContext;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const getGrant = useKartonProcedure((p) => p.artifactBridge.getGrant);
  const getPolicy = useKartonProcedure((p) => p.artifactBridge.getPolicy);
  const openGrantReview = useKartonProcedure(
    (p) => p.artifactBridge.openGrantReview,
  );
  const submitGrantReview = useKartonProcedure(
    (p) => p.artifactBridge.submitGrantReview,
  );
  const revokeGrant = useKartonProcedure((p) => p.artifactBridge.revokeGrant);

  const [snapshot, setSnapshot] =
    useState<ArtifactBridgeGrantReviewSnapshot | null>(null);
  const [selection, setSelection] =
    useState<ArtifactBridgeGrantReviewSelection | null>(null);
  const [hasGrant, setHasGrant] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{
    context: ArtifactBridgeContext;
    scope: ArtifactBridgeGrant['scope'];
  } | null>(null);
  const [busy, setBusy] = useState<'load' | 'save' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setBusy('load');
    setError(null);
    setSnapshot(null);
    setSelection(null);
    setHasGrant(false);
    setRevokeTarget(null);

    void (async () => {
      try {
        const [grant, policy] = await Promise.all([
          getGrant(context),
          getPolicy(context),
        ]);
        if (!active) return;
        setHasGrant(grant !== null);
        setRevokeTarget(
          grant ? { context: grant.context, scope: grant.scope } : null,
        );
        const initialSelection = createInitialGeneratedAppGrantReviewSelection(
          grant,
          policy,
          Date.now(),
        );
        const nextSnapshot = parseGeneratedAppGrantReviewSnapshot(
          await openGrantReview(context, initialSelection),
        );
        if (!active) return;
        setSnapshot(nextSnapshot);
        setSelection(nextSnapshot.selection);
      } catch (cause) {
        if (!active) return;
        setError(
          cause instanceof Error
            ? cause.message
            : 'Canonical capability review could not be opened.',
        );
      } finally {
        if (active) setBusy(null);
      }
    })();

    return () => {
      active = false;
    };
  }, [context, getGrant, getPolicy, open, openGrantReview]);

  const capabilityOptions = useMemo(
    () =>
      snapshot && selection
        ? getGeneratedAppGrantReviewCapabilityOptions(snapshot, selection)
        : [],
    [selection, snapshot],
  );
  const mcpToolOptions = useMemo(
    () =>
      snapshot && selection
        ? getGeneratedAppGrantReviewMcpToolOptions(snapshot, selection)
        : [],
    [selection, snapshot],
  );
  const automationOptions = useMemo(
    () =>
      snapshot && selection
        ? getGeneratedAppGrantReviewAutomationOptions(snapshot, selection)
        : [],
    [selection, snapshot],
  );
  const expiryState = useMemo(
    () =>
      snapshot && selection
        ? getGeneratedAppGrantReviewExpiryState(snapshot, selection)
        : null,
    [selection, snapshot],
  );
  const unsupportedWriteSelection = selection
    ? hasUnsupportedGeneratedAppWriteSelection(selection)
    : false;

  const save = async () => {
    if (!snapshot || !selection) return;
    setBusy('save');
    try {
      await submitGrantReview(
        createGeneratedAppGrantReviewSubmission(snapshot, selection),
      );
      setHasGrant(true);
      notify(
        'App capabilities updated',
        'The exact reviewed manifest and policy selection is now active.',
      );
      onOpenChange(false);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : 'Please open a new review.';
      setError(`${message} Open a new review before trying again.`);
      setSnapshot(null);
      setSelection(null);
      notify('Capabilities were not saved', message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setBusy('revoke');
    try {
      await revokeGrant(revokeTarget.context, revokeTarget.scope);
      setHasGrant(false);
      setRevokeTarget(null);
      notify('Grant revoked', 'The exact app grant was revoked.');
      onOpenChange(false);
    } catch (cause) {
      notify(
        'Grant was not revoked',
        cause instanceof Error ? cause.message : 'Please try again.',
        'error',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[min(760px,calc(100vw-2rem))] overflow-y-auto sm:min-w-0">
        <DialogClose />
        <DialogHeader>
          <DialogTitle>Review app capabilities</DialogTitle>
          <DialogDescription>
            Review the backend-resolved manifest, identity, and organization
            policy. The generated app cannot create or expand this grant.
          </DialogDescription>
        </DialogHeader>

        {busy === 'load' ? (
          <div className="flex min-h-44 items-center justify-center">
            <Loader2Icon className="size-5 animate-spin text-token-text-tertiary" />
          </div>
        ) : error ? (
          <div className="rounded-xl border border-error-solid/25 bg-error-solid/8 p-3 text-error-solid text-sm">
            {error}
          </div>
        ) : snapshot && selection ? (
          <div className="grid gap-5">
            <section className="grid gap-3 rounded-xl border border-token-border-light bg-token-bg-secondary/25 p-4">
              <div className="flex items-start gap-3">
                <FingerprintIcon className="mt-0.5 size-4 shrink-0 text-clodex-green-400" />
                <div className="min-w-0">
                  <h3 className="font-semibold text-sm text-token-text-primary">
                    {snapshot.manifest.name}
                  </h3>
                  {snapshot.manifest.description && (
                    <p className="mt-1 text-token-text-secondary text-xs">
                      {snapshot.manifest.description}
                    </p>
                  )}
                </div>
              </div>
              <dl className="grid gap-3 sm:grid-cols-2">
                <ReviewFact label="App ID" value={snapshot.manifest.id} code />
                <ReviewFact
                  label="Manifest version"
                  value={snapshot.manifest.version}
                />
                <ReviewFact
                  label="Resolved app version"
                  value={snapshot.identity.appVersion}
                />
                <ReviewFact
                  label="Manifest schema version"
                  value={String(snapshot.identity.manifestSchemaVersion)}
                  code
                />
                <ReviewFact
                  label="Context"
                  value={formatReviewContext(snapshot)}
                  code
                />
                <ReviewFact
                  label="Provenance"
                  value={snapshot.provenance.kind}
                  code
                />
                <ReviewFact
                  label="Grant scope"
                  value={formatReviewScope(selection)}
                  code
                />
                <div className="sm:col-span-2">
                  <ReviewFact
                    label="Manifest SHA-256"
                    value={snapshot.identity.manifestHash}
                    code
                  />
                </div>
                <div className="sm:col-span-2">
                  <ReviewFact
                    label="Executable SHA-256"
                    value={snapshot.identity.executableHash}
                    code
                  />
                </div>
                <div className="sm:col-span-2">
                  <ReviewFact
                    label="Asset SHA-256"
                    value={snapshot.identity.assetHash}
                    code
                  />
                </div>
              </dl>
            </section>

            <div className="flex items-center gap-2 rounded-xl border border-clodex-green-400/18 bg-clodex-green-400/7 p-3 text-token-text-secondary text-xs">
              <ShieldCheckIcon className="size-4 shrink-0 text-clodex-green-400" />
              Every selector below comes from review {snapshot.reviewId}. The
              backend will re-resolve identity, manifest, and policy when this
              one-shot review is submitted.
            </div>

            <section className="grid gap-2">
              <div>
                <h3 className="font-semibold text-sm text-token-text-primary">
                  Manifest requests
                </h3>
                <p className="mt-1 text-token-text-tertiary text-xs">
                  Reasons are exact manifest declarations, not an AI summary.
                </p>
              </div>
              {capabilityOptions.length === 0 ? (
                <p className="rounded-xl border border-token-border-light p-3 text-token-text-secondary text-xs">
                  This manifest declares no capabilities.
                </p>
              ) : (
                capabilityOptions.map((option) => {
                  const presentation = CAPABILITY_PRESENTATION[option.type];
                  const Icon = presentation.icon;
                  return (
                    <div
                      key={option.type}
                      className="flex items-start gap-3 rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3"
                    >
                      <Icon className="mt-0.5 size-4 shrink-0 text-token-text-secondary" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-sm text-token-text-primary">
                            {presentation.label}
                          </p>
                          <code className="rounded bg-token-bg-secondary px-1.5 py-0.5 text-[10px] text-token-text-tertiary">
                            {option.type}
                          </code>
                        </div>
                        <p className="mt-1 text-token-text-secondary text-xs">
                          {option.reason}
                        </p>
                        {option.restriction && (
                          <p className="mt-1 text-[11px] text-warning-solid">
                            {option.restriction}
                          </p>
                        )}
                      </div>
                      <Switch
                        checked={option.selected}
                        disabled={busy !== null || !option.editable}
                        aria-label={`Grant ${option.type}`}
                        onCheckedChange={(checked) =>
                          setSelection((current) =>
                            current
                              ? setGeneratedAppGrantReviewCapability(
                                  snapshot,
                                  current,
                                  option.type,
                                  checked,
                                )
                              : current,
                          )
                        }
                      />
                    </div>
                  );
                })
              )}
            </section>

            {selection.capabilities.includes('mcp:call') && (
              <section className="grid gap-2">
                <div>
                  <h3 className="font-semibold text-sm text-token-text-primary">
                    Declared MCP read tools
                  </h3>
                  <p className="mt-1 text-token-text-tertiary text-xs">
                    Only exact server/tool pairs declared by the manifest and
                    allowed by the snapshot policy are selectable.
                  </p>
                </div>
                {mcpToolOptions.map((tool) => (
                  <div
                    key={`${tool.serverId}/${tool.toolName}`}
                    className="flex items-center gap-3 rounded-xl border border-token-border-light px-3 py-2.5"
                  >
                    <code className="min-w-0 flex-1 break-all text-xs">
                      {tool.serverId}/{tool.toolName}
                    </code>
                    {!tool.allowedByPolicy && (
                      <span className="text-[11px] text-warning-solid">
                        Policy denied
                      </span>
                    )}
                    <Switch
                      checked={tool.selected}
                      disabled={busy !== null || !tool.allowedByPolicy}
                      aria-label={`Grant ${tool.serverId}/${tool.toolName}`}
                      onCheckedChange={(checked) =>
                        setSelection((current) =>
                          current
                            ? setGeneratedAppGrantReviewMcpTool(
                                snapshot,
                                current,
                                tool,
                                checked,
                              )
                            : current,
                        )
                      }
                    />
                  </div>
                ))}
              </section>
            )}

            {selection.capabilities.includes('automation:run') && (
              <section className="grid gap-2">
                <div>
                  <h3 className="font-semibold text-sm text-token-text-primary">
                    Declared automations
                  </h3>
                  <p className="mt-1 text-token-text-tertiary text-xs">
                    Automation labels are not inferred; exact manifest IDs are
                    shown.
                  </p>
                </div>
                {automationOptions.map((automation) => (
                  <div
                    key={automation.automationId}
                    className="flex items-center gap-3 rounded-xl border border-token-border-light px-3 py-2.5"
                  >
                    <code className="min-w-0 flex-1 break-all text-xs">
                      {automation.automationId}
                    </code>
                    <Switch
                      checked={automation.selected}
                      disabled={busy !== null}
                      aria-label={`Grant automation ${automation.automationId}`}
                      onCheckedChange={(checked) =>
                        setSelection((current) =>
                          current
                            ? setGeneratedAppGrantReviewAutomation(
                                snapshot,
                                current,
                                automation.automationId,
                                checked,
                              )
                            : current,
                        )
                      }
                    />
                  </div>
                ))}
              </section>
            )}

            {expiryState && (
              <section className="flex items-center justify-between gap-3 rounded-xl border border-token-border-light p-3">
                <div>
                  <p className="font-medium text-sm text-token-text-primary">
                    Grant expiry
                  </p>
                  <p className="text-token-text-tertiary text-xs">
                    Choices are bounded by the snapshotted organization policy.
                  </p>
                </div>
                <Select
                  value={expiryState.value}
                  items={expiryState.options.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  onValueChange={(value) =>
                    setSelection((current) =>
                      current
                        ? setGeneratedAppGrantReviewExpiry(
                            snapshot,
                            current,
                            value,
                          )
                        : current,
                    )
                  }
                  size="sm"
                />
              </section>
            )}

            {unsupportedWriteSelection && (
              <div className="flex items-start gap-2 rounded-xl border border-warning-solid/25 bg-warning-solid/8 p-3 text-warning-solid text-xs">
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
                This grant contains MCP write authority. This dialog will not
                modify or resubmit write selections; revoke it or use the
                separate reviewed write flow.
              </div>
            )}

            <section className="grid gap-3 rounded-xl border border-token-border-light p-4">
              <div className="flex items-center gap-2">
                <ScrollTextIcon className="size-4 text-token-text-secondary" />
                <h3 className="font-semibold text-sm text-token-text-primary">
                  Policy and review provenance
                </h3>
              </div>
              <dl className="grid gap-3 sm:grid-cols-2">
                <ReviewFact
                  label="Policy status"
                  value={snapshot.policy.enabled ? 'enabled' : 'disabled'}
                  code
                />
                <ReviewFact
                  label="Never-expiring grants"
                  value={
                    snapshot.policy.allowNeverExpiringGrants
                      ? 'allowed'
                      : 'denied'
                  }
                  code
                />
                <ReviewFact
                  label="Maximum grant duration"
                  value={`${snapshot.policy.maxGrantDurationHours} hours`}
                />
                <ReviewFact
                  label="Review expires"
                  value={snapshot.expiresAt}
                  code
                />
                <div className="sm:col-span-2">
                  <ReviewFact
                    label="Allowed capabilities"
                    value={
                      snapshot.policy.allowedCapabilities.join(', ') || 'none'
                    }
                    code
                  />
                </div>
                <div className="sm:col-span-2">
                  <ReviewFact
                    label="Allowed MCP read patterns"
                    value={
                      snapshot.policy.allowedMcpReadTools.join(', ') || 'none'
                    }
                    code
                  />
                </div>
                <div className="sm:col-span-2">
                  <ReviewFact
                    label="Policy SHA-256"
                    value={snapshot.policyHash}
                    code
                  />
                </div>
              </dl>
            </section>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            disabled={
              busy !== null ||
              Boolean(error) ||
              !snapshot ||
              !selection ||
              unsupportedWriteSelection
            }
            onClick={() => void save()}
          >
            {busy === 'save' && <Loader2Icon className="size-4 animate-spin" />}
            Approve exact selection
          </Button>
          {hasGrant && revokeTarget && (
            <Button
              variant="secondary"
              className="mr-auto text-error-solid"
              disabled={busy !== null}
              onClick={() => void revoke()}
            >
              {busy === 'revoke' ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <Trash2Icon className="size-4" />
              )}
              Revoke
            </Button>
          )}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatReviewContext(
  snapshot: ArtifactBridgeGrantReviewSnapshot,
): string {
  const context = snapshot.context;
  if (context.kind === 'package') {
    return `package:${context.packageId} / app:${context.appId}`;
  }
  const plugin = context.pluginId ? ` / plugin:${context.pluginId}` : '';
  return `agent:${context.agentId} / app:${context.appId}${plugin}`;
}

function formatReviewScope(
  selection: ArtifactBridgeGrantReviewSelection,
): string {
  return selection.scope.kind === 'persistent'
    ? 'persistent'
    : `session:${selection.scope.sessionId}`;
}
