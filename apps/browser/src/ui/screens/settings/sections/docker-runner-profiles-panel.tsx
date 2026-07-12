import { Button } from '@clodex/stage-ui/components/button';
import { Input } from '@clodex/stage-ui/components/input';
import { toast } from '@clodex/stage-ui/components/toaster';
import type {
  DockerRunnerProfile,
  DockerRunnerProfileInput,
  DockerRunnerProfilesSnapshot,
} from '@shared/docker-runner-profiles';
import { resolveFeatureGate } from '@shared/feature-gates';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { cn } from '@ui/utils';
import {
  BoxIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerCogIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SettingsPanel,
  SettingsSectionHeader,
} from '../_components/settings-page';

const EMPTY_DRAFT: DockerRunnerProfileInput = {
  name: '',
  image: '',
  cpus: 2,
  memoryMb: 4_096,
  pidsLimit: 512,
};

function toDraft(profile: DockerRunnerProfile): DockerRunnerProfileInput {
  return {
    id: profile.id,
    name: profile.name,
    image: profile.image,
    cpus: profile.cpus,
    memoryMb: profile.memoryMb,
    pidsLimit: profile.pidsLimit,
  };
}

function notify(result: { ok: boolean; message?: string }, title: string) {
  toast({
    id: `docker-runner-profile-${Date.now()}`,
    title: result.ok ? title : 'Docker runner failed',
    message:
      result.message ??
      (result.ok ? 'The operation completed.' : 'Please try again.'),
    type: result.ok ? 'info' : 'error',
    actions: [],
  });
}

export function DockerRunnerProfilesPanel({
  sshRunnerConnectionId,
}: {
  sshRunnerConnectionId: string | null;
}) {
  const preferences = useKartonState((state) => state.preferences);
  const releaseChannel = useKartonState(
    (state) => state.appInfo.releaseChannel,
  );
  const dockerGate = resolveFeatureGate(
    'docker-runner',
    preferences.featureGates.overrides,
    releaseChannel,
  );
  const abstractionGate = resolveFeatureGate(
    'runner-abstraction',
    preferences.featureGates.overrides,
    releaseChannel,
  );
  const runnerSelectionEnabled = dockerGate.enabled && abstractionGate.enabled;
  const listProfiles = useKartonProcedure((p) => p.dockerRunnerProfiles.list);
  const saveProfile = useKartonProcedure((p) => p.dockerRunnerProfiles.save);
  const deleteProfile = useKartonProcedure(
    (p) => p.dockerRunnerProfiles.delete,
  );
  const testProfile = useKartonProcedure((p) => p.dockerRunnerProfiles.test);
  const setSelectedProfile = useKartonProcedure(
    (p) => p.dockerRunnerProfiles.setSelected,
  );
  const [snapshot, setSnapshot] = useState<DockerRunnerProfilesSnapshot | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DockerRunnerProfileInput>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const selected = useMemo(
    () =>
      snapshot?.profiles.find((profile) => profile.id === selectedId) ?? null,
    [selectedId, snapshot],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await listProfiles();
      setSnapshot(next);
      const current =
        next.profiles.find((profile) => profile.id === selectedId) ??
        next.profiles[0] ??
        null;
      setSelectedId(current?.id ?? null);
      setDraft(current ? toDraft(current) : EMPTY_DRAFT);
    } catch (error) {
      console.error('Failed to load Docker runner profiles:', error);
      notify(
        {
          ok: false,
          message: 'Encrypted Docker profile storage is unavailable.',
        },
        'Docker profiles loaded',
      );
    } finally {
      setLoading(false);
    }
  }, [listProfiles, selectedId]);

  useEffect(() => {
    void refresh();
    // Refresh only when the backend procedure identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listProfiles]);

  const mergeProfile = useCallback((profile: DockerRunnerProfile) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            profiles: [
              profile,
              ...current.profiles.filter((item) => item.id !== profile.id),
            ],
          }
        : current,
    );
    setSelectedId(profile.id);
    setDraft(toDraft(profile));
    setDeleteArmed(false);
  }, []);

  const handleSave = useCallback(async () => {
    if (operation) return;
    setOperation('save');
    try {
      const result = await saveProfile(draft);
      if (result.ok) mergeProfile(result.profile);
      notify(result, 'Docker profile saved');
    } finally {
      setOperation(null);
    }
  }, [draft, mergeProfile, operation, saveProfile]);

  const handleTest = useCallback(async () => {
    if (!selected || operation) return;
    setOperation('test');
    try {
      const result = await testProfile(selected.id);
      if (result.profile) mergeProfile(result.profile);
      notify(result, 'Docker daemon verified');
    } finally {
      setOperation(null);
    }
  }, [mergeProfile, operation, selected, testProfile]);

  const handleSelection = useCallback(async () => {
    if (!selected || !snapshot || operation) return;
    setOperation('runner');
    try {
      const nextId =
        snapshot.selectedProfileId === selected.id ? null : selected.id;
      const result = await setSelectedProfile(nextId);
      if (result.ok) {
        setSnapshot((current) =>
          current
            ? {
                ...current,
                selectedProfileId: result.selectedProfileId,
                runtime: {
                  ...current.runtime,
                  source: current.runtime.environmentOverride
                    ? 'environment'
                    : result.selectedProfileId
                      ? 'profile'
                      : 'none',
                  activeProfileId: current.runtime.environmentOverride
                    ? null
                    : result.selectedProfileId,
                  message: current.runtime.environmentOverride
                    ? 'A startup environment override controls the Docker runner.'
                    : result.selectedProfileId
                      ? 'The selected profile controls the Docker runner.'
                      : 'No Docker runner profile is selected.',
                },
              }
            : current,
        );
      }
      notify(result, 'Docker runner updated');
    } finally {
      setOperation(null);
    }
  }, [operation, selected, setSelectedProfile, snapshot]);

  const handleDelete = useCallback(async () => {
    if (!selected || !snapshot || operation) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setOperation('delete');
    try {
      const result = await deleteProfile(selected.id);
      if (!result.ok) {
        notify(result, 'Docker profile deleted');
        return;
      }
      const profiles = snapshot.profiles.filter(
        (profile) => profile.id !== result.id,
      );
      const next = profiles[0] ?? null;
      setSnapshot({
        ...snapshot,
        profiles,
        selectedProfileId:
          snapshot.selectedProfileId === result.id
            ? null
            : snapshot.selectedProfileId,
        runtime:
          snapshot.selectedProfileId === result.id &&
          !snapshot.runtime.environmentOverride
            ? {
                ...snapshot.runtime,
                source: 'none',
                activeProfileId: null,
                message: 'No Docker runner profile is selected.',
              }
            : snapshot.runtime,
      });
      setSelectedId(next?.id ?? null);
      setDraft(next ? toDraft(next) : EMPTY_DRAFT);
      setDeleteArmed(false);
      notify(result, 'Docker profile deleted');
    } finally {
      setOperation(null);
    }
  }, [deleteArmed, deleteProfile, operation, selected, snapshot]);

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <SettingsSectionHeader
          title="Docker runner profiles"
          description="Run task shell commands in an isolated, digest-pinned container."
        />
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCwIcon
              className={cn('size-3.5', loading && 'animate-spin')}
            />
            Refresh
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setSelectedId(null);
              setDraft(EMPTY_DRAFT);
              setDeleteArmed(false);
            }}
          >
            <PlusIcon className="size-3.5" />
            New profile
          </Button>
        </div>
      </div>

      {sshRunnerConnectionId && (
        <div className="flex items-start gap-3 rounded-xl border border-warning-solid/25 bg-warning-solid/8 px-3.5 py-3">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning-solid" />
          <p className="text-token-text-secondary text-xs">
            An SSH runner is selected. Clear it before activating a Docker
            profile; runner routing fails closed.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <SettingsPanel className="p-3">
          {loading && !snapshot ? (
            <div className="flex h-24 items-center justify-center">
              <LoaderCircleIcon className="size-5 animate-spin text-token-text-tertiary" />
            </div>
          ) : snapshot?.profiles.length ? (
            <div className="space-y-2">
              {snapshot.profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  className={cn(
                    'w-full rounded-xl border p-3 text-left transition-colors',
                    selectedId === profile.id
                      ? 'border-clodex-green-400/35 bg-clodex-green-400/6'
                      : 'border-token-border-light hover:border-token-border-default',
                  )}
                  onClick={() => {
                    setSelectedId(profile.id);
                    setDraft(toDraft(profile));
                    setDeleteArmed(false);
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-sm text-token-text-primary">
                      {profile.name}
                    </span>
                    {snapshot.selectedProfileId === profile.id && (
                      <ServerCogIcon className="size-3.5 shrink-0 text-clodex-green-400" />
                    )}
                  </div>
                  <div className="mt-1 truncate font-mono text-[10px] text-token-text-tertiary">
                    {profile.image}
                  </div>
                  <div className="mt-2 text-[10px] text-token-text-tertiary">
                    {profile.cpus} CPU · {profile.memoryMb} MB ·{' '}
                    {profile.pidsLimit} PIDs
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="py-6 text-center">
              <BoxIcon className="mx-auto size-6 text-token-text-tertiary" />
              <p className="mt-2 font-medium text-sm text-token-text-primary">
                No Docker profiles
              </p>
            </div>
          )}
        </SettingsPanel>

        <SettingsPanel className="overflow-hidden">
          <div className="flex items-start justify-between gap-3 border-token-border-light border-b px-5 py-4">
            <div>
              <h3 className="font-semibold text-sm text-token-text-primary">
                {draft.id ? 'Profile details' : 'New Docker profile'}
              </h3>
              <p className="mt-1 text-token-text-secondary text-xs">
                Images must use immutable <code>@sha256:</code> references.
              </p>
            </div>
            {snapshot?.runtime.environmentOverride && (
              <span className="rounded-full border border-warning-solid/25 bg-warning-solid/8 px-2 py-1 font-medium text-[10px] text-warning-solid">
                Environment override
              </span>
            )}
          </div>

          <div className="space-y-4 p-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label
                className="space-y-1.5"
                htmlFor="docker-runner-profile-name"
              >
                <span className="font-medium text-token-text-secondary text-xs">
                  Display name
                </span>
                <Input
                  id="docker-runner-profile-name"
                  value={draft.name}
                  placeholder="Secure Node runner"
                  className="max-w-none"
                  onValueChange={(name) =>
                    setDraft((current) => ({ ...current, name }))
                  }
                />
              </label>
              <label
                className="space-y-1.5"
                htmlFor="docker-runner-profile-cpus"
              >
                <span className="font-medium text-token-text-secondary text-xs">
                  CPU limit
                </span>
                <Input
                  id="docker-runner-profile-cpus"
                  type="number"
                  min={0.25}
                  max={64}
                  step={0.25}
                  value={String(draft.cpus)}
                  className="max-w-none"
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      cpus: Number(value),
                    }))
                  }
                />
              </label>
            </div>
            <label
              className="space-y-1.5"
              htmlFor="docker-runner-profile-image"
            >
              <span className="font-medium text-token-text-secondary text-xs">
                Digest-pinned image
              </span>
              <Input
                id="docker-runner-profile-image"
                value={draft.image}
                placeholder="registry.example/runner@sha256:..."
                spellCheck={false}
                className="max-w-none font-mono"
                onValueChange={(image) =>
                  setDraft((current) => ({ ...current, image }))
                }
              />
            </label>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label
                className="space-y-1.5"
                htmlFor="docker-runner-profile-memory"
              >
                <span className="font-medium text-token-text-secondary text-xs">
                  Memory limit (MB)
                </span>
                <Input
                  id="docker-runner-profile-memory"
                  type="number"
                  min={128}
                  max={262_144}
                  value={String(draft.memoryMb)}
                  className="max-w-none"
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      memoryMb: Number(value),
                    }))
                  }
                />
              </label>
              <label
                className="space-y-1.5"
                htmlFor="docker-runner-profile-pids"
              >
                <span className="font-medium text-token-text-secondary text-xs">
                  PID limit
                </span>
                <Input
                  id="docker-runner-profile-pids"
                  type="number"
                  min={16}
                  max={65_536}
                  value={String(draft.pidsLimit)}
                  className="max-w-none"
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      pidsLimit: Number(value),
                    }))
                  }
                />
              </label>
            </div>

            {selected?.lastError && (
              <div className="flex items-start gap-3 rounded-xl border border-error-solid/20 bg-error-solid/7 px-3.5 py-3">
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-error-solid" />
                <p className="break-words text-token-text-secondary text-xs">
                  {selected.lastError}
                </p>
              </div>
            )}
            {snapshot && (
              <div className="flex items-center gap-2 text-[11px] text-token-text-tertiary">
                {snapshot.runtime.source === 'none' ? (
                  <BoxIcon className="size-3.5" />
                ) : (
                  <CheckCircle2Icon className="size-3.5 text-success-solid" />
                )}
                {snapshot.runtime.message}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-token-border-light border-t bg-token-bg-secondary/25 px-5 py-4">
            <Button
              variant="primary"
              size="sm"
              disabled={Boolean(operation)}
              onClick={() => void handleSave()}
            >
              {operation === 'save' && (
                <LoaderCircleIcon className="size-3.5 animate-spin" />
              )}
              {draft.id ? 'Save changes' : 'Save profile'}
            </Button>
            {selected && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={Boolean(operation)}
                  onClick={() => void handleTest()}
                >
                  <ShieldCheckIcon className="size-3.5" />
                  Test
                </Button>
                <Button
                  variant={
                    snapshot?.selectedProfileId === selected.id
                      ? 'primary'
                      : 'secondary'
                  }
                  size="sm"
                  disabled={
                    Boolean(operation) ||
                    !runnerSelectionEnabled ||
                    (Boolean(sshRunnerConnectionId) &&
                      snapshot?.selectedProfileId !== selected.id)
                  }
                  onClick={() => void handleSelection()}
                >
                  <ServerCogIcon className="size-3.5" />
                  {snapshot?.selectedProfileId === selected.id
                    ? 'Stop using as runner'
                    : 'Use as Docker runner'}
                </Button>
                <Button
                  variant={deleteArmed ? 'primary' : 'ghost'}
                  size="sm"
                  className={cn(
                    !deleteArmed && 'text-error-solid hover:text-error-solid',
                  )}
                  disabled={Boolean(operation)}
                  onClick={() => void handleDelete()}
                >
                  <Trash2Icon className="size-3.5" />
                  {deleteArmed ? 'Confirm delete' : 'Delete'}
                </Button>
              </>
            )}
            {!runnerSelectionEnabled && (
              <span className="text-[11px] text-token-text-tertiary">
                Enable “{dockerGate.definition.name}” and “
                {abstractionGate.definition.name}” in Preview features.
              </span>
            )}
          </div>
        </SettingsPanel>
      </div>
    </section>
  );
}
