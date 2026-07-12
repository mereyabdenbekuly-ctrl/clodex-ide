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
} from '@shared/artifact-bridge';
import type { McpToolSettings } from '@shared/mcp-settings';
import { useKartonProcedure } from '@ui/hooks/use-karton';
import {
  BotIcon,
  CalendarClockIcon,
  Loader2Icon,
  PlugZapIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

const CAPABILITIES = [
  {
    value: 'agent:ask',
    label: 'Ask agent',
    description: 'Bounded 10k-character prompts with a short response.',
    icon: BotIcon,
  },
  {
    value: 'automation:run',
    label: 'Run automations',
    description: 'Start an existing automation by its identifier.',
    icon: CalendarClockIcon,
  },
  {
    value: 'mcp:call',
    label: 'Call approved MCP tools',
    description: 'Only individually selected read-only, non-destructive tools.',
    icon: PlugZapIcon,
  },
] satisfies Array<{
  value: ArtifactBridgeCapability;
  label: string;
  description: string;
  icon: typeof BotIcon;
}>;

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
  const setGrant = useKartonProcedure((p) => p.artifactBridge.setGrant);
  const revokeGrant = useKartonProcedure((p) => p.artifactBridge.revokeGrant);
  const listServers = useKartonProcedure((p) => p.mcp.list);
  const listTools = useKartonProcedure((p) => p.mcp.listTools);

  const [capabilities, setCapabilities] = useState<ArtifactBridgeCapability[]>(
    [],
  );
  const [selectedTools, setSelectedTools] = useState<
    Array<{ serverId: string; toolName: string }>
  >([]);
  const [toolsByServer, setToolsByServer] = useState<
    Array<{
      serverId: string;
      serverName: string;
      tools: McpToolSettings[];
    }>
  >([]);
  const [expiry, setExpiry] = useState<'never' | 'day' | 'week' | 'month'>(
    'week',
  );
  const [hasGrant, setHasGrant] = useState(false);
  const [busy, setBusy] = useState<'load' | 'save' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy('load');
    setError(null);
    try {
      const [grant, snapshot] = await Promise.all([
        getGrant(context),
        listServers(),
      ]);
      setHasGrant(grant !== null);
      setCapabilities(grant?.capabilities ?? []);
      setSelectedTools(grant?.mcpTools ?? []);
      if (grant?.expiresAt) {
        const hours =
          (new Date(grant.expiresAt).getTime() - Date.now()) / 3_600_000;
        setExpiry(hours <= 25 ? 'day' : hours <= 24 * 8 ? 'week' : 'month');
      } else {
        setExpiry('never');
      }

      const enabledServers = snapshot.servers.filter(
        (server) => server.enabled && server.runtime.status === 'connected',
      );
      const toolGroups = await Promise.all(
        enabledServers.map(async (server) => ({
          serverId: server.id,
          serverName: server.displayName,
          tools: (await listTools(server.id)).filter(
            (tool) =>
              tool.readOnly &&
              !tool.destructive &&
              tool.effectiveDecision === 'allow',
          ),
        })),
      );
      setToolsByServer(toolGroups.filter((group) => group.tools.length > 0));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Capabilities could not be loaded.',
      );
    } finally {
      setBusy(null);
    }
  }, [context, getGrant, listServers, listTools]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const save = async () => {
    setBusy('save');
    try {
      const expiryHours =
        expiry === 'day'
          ? 24
          : expiry === 'week'
            ? 24 * 7
            : expiry === 'month'
              ? 24 * 30
              : null;
      await setGrant({
        context,
        capabilities,
        mcpTools: capabilities.includes('mcp:call') ? selectedTools : [],
        expiresAt: expiryHours
          ? new Date(Date.now() + expiryHours * 3_600_000).toISOString()
          : null,
      });
      setHasGrant(true);
      notify(
        'App capabilities updated',
        'The capability manifest is now active.',
      );
      onOpenChange(false);
    } catch (cause) {
      notify(
        'Capabilities were not saved',
        cause instanceof Error ? cause.message : 'Please try again.',
        'error',
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] w-[min(700px,calc(100vw-2rem))] overflow-y-auto sm:min-w-0">
        <DialogClose />
        <DialogHeader>
          <DialogTitle>App capabilities</DialogTitle>
          <DialogDescription>
            Generated apps are untrusted by default. Grant only the narrow
            bridge operations this app needs.
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
        ) : (
          <div className="grid gap-5">
            <div className="flex items-center gap-2 rounded-xl border border-clodex-green-400/18 bg-clodex-green-400/7 p-3 text-token-text-secondary text-xs">
              <ShieldCheckIcon className="size-4 shrink-0 text-clodex-green-400" />
              Requests are rate-limited to 30 per minute and results are capped
              at 1 MB.
            </div>

            <div className="grid gap-2">
              {CAPABILITIES.map((capability) => {
                const enabled = capabilities.includes(capability.value);
                const Icon = capability.icon;
                return (
                  <div
                    key={capability.value}
                    className="flex items-center gap-3 rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3"
                  >
                    <Icon className="size-4 text-token-text-secondary" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm text-token-text-primary">
                        {capability.label}
                      </p>
                      <p className="text-token-text-tertiary text-xs">
                        {capability.description}
                      </p>
                    </div>
                    <Switch
                      checked={enabled}
                      aria-label={`Toggle ${capability.label}`}
                      onCheckedChange={(checked) =>
                        setCapabilities((current) =>
                          checked
                            ? [...current, capability.value]
                            : current.filter(
                                (item) => item !== capability.value,
                              ),
                        )
                      }
                    />
                  </div>
                );
              })}
            </div>

            {capabilities.includes('mcp:call') && (
              <div className="grid gap-3">
                <div>
                  <h3 className="font-medium text-sm text-token-text-primary">
                    Allowed MCP tools
                  </h3>
                  <p className="mt-1 text-token-text-tertiary text-xs">
                    Unsafe, destructive, and ask-policy tools are excluded.
                  </p>
                </div>
                {toolsByServer.length === 0 ? (
                  <p className="rounded-xl border border-token-border-light p-3 text-token-text-secondary text-xs">
                    No connected MCP server currently exposes eligible tools.
                  </p>
                ) : (
                  toolsByServer.map((group) => (
                    <div
                      key={group.serverId}
                      className="overflow-hidden rounded-xl border border-token-border-light"
                    >
                      <div className="bg-token-bg-secondary/60 px-3 py-2 font-medium text-xs">
                        {group.serverName}
                      </div>
                      {group.tools.map((tool) => {
                        const selected = selectedTools.some(
                          (item) =>
                            item.serverId === group.serverId &&
                            item.toolName === tool.name,
                        );
                        return (
                          <div
                            key={tool.name}
                            className="flex items-center justify-between gap-3 border-token-border-light border-t px-3 py-2.5"
                          >
                            <div className="min-w-0">
                              <p className="font-mono text-token-text-primary text-xs">
                                {tool.name}
                              </p>
                              <p className="truncate text-[11px] text-token-text-tertiary">
                                {tool.description || 'Read-only MCP tool'}
                              </p>
                            </div>
                            <Switch
                              checked={selected}
                              aria-label={`Allow ${tool.name}`}
                              onCheckedChange={(checked) =>
                                setSelectedTools((current) =>
                                  checked
                                    ? [
                                        ...current,
                                        {
                                          serverId: group.serverId,
                                          toolName: tool.name,
                                        },
                                      ]
                                    : current.filter(
                                        (item) =>
                                          !(
                                            item.serverId === group.serverId &&
                                            item.toolName === tool.name
                                          ),
                                      ),
                                )
                              }
                            />
                          </div>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium text-sm text-token-text-primary">
                  Grant expiry
                </p>
                <p className="text-token-text-tertiary text-xs">
                  Expired grants fail closed.
                </p>
              </div>
              <Select
                value={expiry}
                items={[
                  { value: 'day', label: '1 day' },
                  { value: 'week', label: '7 days' },
                  { value: 'month', label: '30 days' },
                  { value: 'never', label: 'No expiry' },
                ]}
                onValueChange={(value) => setExpiry(value as typeof expiry)}
                size="sm"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            disabled={busy !== null || Boolean(error)}
            onClick={() => void save()}
          >
            {busy === 'save' && <Loader2Icon className="size-4 animate-spin" />}
            Save grant
          </Button>
          {hasGrant && (
            <Button
              variant="secondary"
              className="mr-auto text-error-solid"
              disabled={busy !== null}
              onClick={() => {
                setBusy('revoke');
                void revokeGrant(context)
                  .then(() => {
                    setHasGrant(false);
                    setCapabilities([]);
                    setSelectedTools([]);
                    notify('Grant revoked', 'The app bridge is disabled.');
                  })
                  .finally(() => setBusy(null));
              }}
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
