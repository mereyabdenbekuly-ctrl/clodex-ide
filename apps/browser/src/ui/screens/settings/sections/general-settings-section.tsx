import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@clodex/stage-ui/components/button';
import { Select } from '@clodex/stage-ui/components/select';
import { Slider } from '@clodex/stage-ui/components/slider';
import { Switch } from '@clodex/stage-ui/components/switch';
import { toast } from '@clodex/stage-ui/components/toaster';
import { useKartonState, useKartonProcedure } from '@ui/hooks/use-karton';
import { useGlobalDictation } from '@ui/hooks/use-global-dictation';
import { useTrack } from '@ui/hooks/use-track';
import {
  CopyIcon,
  MicIcon,
  PlayIcon,
  RadioIcon,
  RefreshCcwIcon,
  SquareIcon,
  TriangleAlertIcon,
  UploadIcon,
} from 'lucide-react';
import { enablePatches, produceWithPatches } from 'immer';
import {
  listAvailableFeatureGates,
  resolveFeatureGate,
  type FeatureGateId,
} from '@shared/feature-gates';
import type { DictationBackendDiagnostics } from '@shared/dictation';
import {
  createRedactedDictationDiagnosticReport,
  getDictationFallbackReasonLabel,
  getDictationMicrophoneTestFailureLabel,
  type DictationMicrophoneTestResult,
  type DictationRealtimeConnectionTestResult,
} from '@shared/dictation-diagnostics';
import {
  startDictationMicrophoneTest,
  type DictationMicrophoneTestOperation,
} from '@ui/hooks/dictation-microphone-test';
import {
  startRealtimeConnectionDiagnosticTest,
  type RealtimeConnectionDiagnosticOperation,
} from '@ui/hooks/dictation-realtime-connection-test';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSectionHeader,
} from '../_components/settings-page';

enablePatches();

// =============================================================================
// Power Save Blocker Setting Component
// =============================================================================

function PowerSaveBlockerSetting() {
  const globalConfig = useKartonState((s) => s.globalConfig);
  const isMacOs = useKartonState((s) => s.appInfo.platform === 'darwin');
  const setGlobalConfig = useKartonProcedure((p) => p.config.set);

  const isEnabled = globalConfig.blockAppSuspensionWhenAgentsActive ?? true;

  const handleChange = async (checked: boolean) => {
    await setGlobalConfig({
      blockAppSuspensionWhenAgentsActive: checked,
    });
  };

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <label htmlFor="agent-power-save-blocker">
          <h3 className="font-medium text-sm text-token-text-primary">
            Keep app awake while agents work
          </h3>
          <p className="mt-1 text-token-text-secondary text-xs leading-5">
            Prevent app suspension while agents run tool loops or other active
            work. Waiting for questions or tool approval still counts as idle.
          </p>
        </label>

        {isMacOs && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-warning-solid/20 bg-warning-solid/7 px-3 py-2.5 text-token-text-secondary text-xs leading-5">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning-solid" />
            <p>
              To prevent sleep in battery mode on macOS devices, including when
              the lid is closed, you must enable “Keep awake” mode in the
              bottom-right corner of the sidebar.
            </p>
          </div>
        )}
      </div>

      <Switch
        id="agent-power-save-blocker"
        checked={isEnabled}
        onCheckedChange={handleChange}
        size="xs"
        className="mt-1 shrink-0"
      />
    </div>
  );
}

// =============================================================================
// Notifications Setting Component
// =============================================================================

const DEFAULT_SOUND_PACK = 'bubble-pops';
const NOTIFICATION_LOUDNESS_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'subtle', label: 'Subtle' },
  { value: 'default', label: 'Loud' },
] as const;

type SoundLoudness = (typeof NOTIFICATION_LOUDNESS_OPTIONS)[number]['value'];

export function NotificationsSetting() {
  const globalConfig = useKartonState((s) => s.globalConfig);
  const notificationSoundPacks = useKartonState(
    (s) => s.notificationSoundPacks,
  );
  const isMacOs = useKartonState((s) => s.appInfo.platform === 'darwin');
  const setGlobalConfig = useKartonProcedure((p) => p.config.set);
  const previewSoundPack = useKartonProcedure((p) => p.config.previewSoundPack);
  const importSoundPack = useKartonProcedure((p) => p.config.importSoundPack);
  const track = useTrack();

  const soundLoudness: SoundLoudness =
    globalConfig.notificationSoundLoudness ?? 'subtle';
  const availablePacks =
    notificationSoundPacks.available.length > 0
      ? notificationSoundPacks.available
      : [DEFAULT_SOUND_PACK];
  const configuredPack = globalConfig.notificationSoundPack?.trim();
  const currentPack =
    configuredPack && availablePacks.includes(configuredPack)
      ? configuredPack
      : DEFAULT_SOUND_PACK;
  const packOptions = availablePacks.includes(currentPack)
    ? availablePacks
    : [currentPack, ...availablePacks];
  const loudnessIndex = Math.max(
    0,
    NOTIFICATION_LOUDNESS_OPTIONS.findIndex(
      (option) => option.value === soundLoudness,
    ),
  );

  const soundPackItems = packOptions.map((pack) => ({
    value: pack,
    label: notificationSoundPacks.displayNames[pack] ?? pack,
  }));

  const previewSound = (pack = currentPack, loudness = soundLoudness) => {
    if (loudness === 'off') return;
    void previewSoundPack(pack, loudness).catch(() => {
      // Preview is best-effort; config changes should still succeed.
    });
  };

  const handleLoudnessChange = async (value: number) => {
    const index = Math.max(
      0,
      Math.min(NOTIFICATION_LOUDNESS_OPTIONS.length - 1, Math.round(value)),
    );
    const notificationSoundLoudness =
      NOTIFICATION_LOUDNESS_OPTIONS[index]?.value ?? 'subtle';

    previewSound(currentPack, notificationSoundLoudness);

    await setGlobalConfig({
      notificationSoundLoudness,
    });
    track('changed-notification-sound-loudness', {
      loudness: notificationSoundLoudness,
    });
  };

  const handleSoundPackChange = async (value: unknown) => {
    if (typeof value !== 'string' || !packOptions.includes(value)) return;
    previewSound(value, soundLoudness);
    await setGlobalConfig({
      notificationSoundPack: value,
    });
    track('changed-notification-sound-theme', {
      theme: value === DEFAULT_SOUND_PACK ? value : 'custom',
    });
  };

  const handleImportSoundPack = async () => {
    try {
      const result = await importSoundPack();
      if ('error' in result) {
        if (result.error) {
          toast({
            id: `import-sound-pack-error-${Date.now()}`,
            title: 'Custom sound import failed',
            message: result.error,
            type: 'error',
            actions: [],
          });
        }
        return;
      }

      toast({
        id: `import-sound-pack-success-${Date.now()}`,
        title: 'Custom sound imported',
        message: `${result.name} is now selected for notifications.`,
        type: 'info',
        duration: 4000,
        actions: [],
      });
    } catch (err) {
      toast({
        id: `import-sound-pack-error-${Date.now()}`,
        title: 'Custom sound import failed',
        message:
          err instanceof Error ? err.message : 'Custom sound import failed.',
        type: 'error',
        actions: [],
      });
    }
  };

  const handleDockBounceChange = async (checked: boolean) => {
    await setGlobalConfig({
      dockBounceEnabled: checked,
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-medium text-sm text-token-text-primary">
          Notification sounds
        </h3>
        <p className="mt-1 text-token-text-secondary text-xs leading-5">
          Play a sound when the agent finishes work, asks a question, or
          encounters an error.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <h4 className="font-medium text-token-text-secondary text-xs">
            Loudness
          </h4>
          <div className="w-32 space-y-0.5 pl-2">
            <Slider
              value={loudnessIndex}
              min={0}
              max={2}
              step={1}
              ariaLabel="Notification sound loudness"
              thickness="default"
              onValueChange={handleLoudnessChange}
            />
            <div className="relative h-3 text-[11px] text-token-text-tertiary">
              {NOTIFICATION_LOUDNESS_OPTIONS.map((option, index) => (
                <span
                  key={option.value}
                  className="absolute -translate-x-1/2"
                  style={{
                    left: `${
                      (index / (NOTIFICATION_LOUDNESS_OPTIONS.length - 1)) * 100
                    }%`,
                  }}
                >
                  {option.label}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <h4 className="font-medium text-token-text-secondary text-xs">
            Sound pack
          </h4>
          <div className="flex items-center gap-1">
            <Select
              value={currentPack}
              onValueChange={handleSoundPackChange}
              items={soundPackItems}
              size="sm"
              triggerClassName="w-40 rounded-lg"
              side="bottom"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={soundLoudness === 'off'}
              onClick={() => previewSound()}
              aria-label="Preview sound"
            >
              <PlayIcon className="size-3.5" />
            </Button>
          </div>
          <button
            type="button"
            className="block text-token-text-tertiary text-xs underline transition-colors hover:text-token-text-primary"
            onClick={handleImportSoundPack}
          >
            <span className="inline-flex items-center gap-1">
              <UploadIcon className="size-3" />
              Use custom sound…
            </span>
          </button>
        </div>
      </div>

      {isMacOs && (
        <div
          className="flex cursor-pointer items-center justify-between gap-4 pt-2"
          onClick={() =>
            handleDockBounceChange(!globalConfig.dockBounceEnabled)
          }
        >
          <div className="min-w-0">
            <h3 className="font-medium text-sm text-token-text-primary">
              Dock icon bounce
            </h3>
            <p className="mt-1 text-token-text-secondary text-xs leading-5">
              Bounce the dock icon when the agent finishes, asks a question, or
              encounters an error while the window is not focused.
            </p>
          </div>
          <div onClick={(e) => e.stopPropagation()}>
            <Switch
              checked={globalConfig.dockBounceEnabled}
              onCheckedChange={handleDockBounceChange}
              size="xs"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ExperimentalFeaturesSetting() {
  const preferences = useKartonState((s) => s.preferences);
  const releaseChannel = useKartonState((s) => s.appInfo.releaseChannel);
  const updatePreferences = useKartonProcedure((p) => p.preferences.update);
  const availableGates = listAvailableFeatureGates(releaseChannel);

  if (availableGates.length === 0) {
    return null;
  }

  const handleToggle = async (id: FeatureGateId, checked: boolean) => {
    const [, patches] = produceWithPatches(preferences, (draft) => {
      const channelDefault = resolveFeatureGate(id, {}, releaseChannel).enabled;
      if (checked === channelDefault) {
        delete draft.featureGates.overrides[id];
      } else {
        draft.featureGates.overrides[id] = checked;
      }
    });
    await updatePreferences(patches);
  };

  return (
    <section className="space-y-3">
      <SettingsSectionHeader
        title="Preview features"
        description="Opt in to features that are usable but may still change."
      />
      <SettingsPanel className="divide-y divide-token-border-light overflow-hidden">
        {availableGates.map((definition) => {
          const resolved = resolveFeatureGate(
            definition.id,
            preferences.featureGates.overrides,
            releaseChannel,
          );

          return (
            <div
              key={definition.id}
              className="flex items-start justify-between gap-4 px-4 py-3.5 transition-colors hover:bg-token-list-hover-background"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-sm text-token-text-primary">
                    {definition.name}
                  </h3>
                  <span className="rounded-full border border-clodex-green-400/18 bg-clodex-green-400/8 px-2 py-0.5 font-medium text-[10px] text-clodex-green-400 uppercase tracking-[0.06em]">
                    {definition.stage}
                  </span>
                </div>
                <p className="mt-0.5 text-token-text-secondary text-xs leading-5">
                  {definition.description}
                </p>
              </div>

              <Switch
                checked={resolved.enabled}
                onCheckedChange={(checked) =>
                  handleToggle(definition.id, checked)
                }
                size="xs"
                aria-label={`Enable ${definition.name}`}
              />
            </div>
          );
        })}
      </SettingsPanel>
    </section>
  );
}

function DictationDiagnosticsSetting() {
  const dictation = useGlobalDictation();
  const platform = useKartonState((s) => s.appInfo.platform);
  const openAIConfig = useKartonState(
    (s) => s.preferences.providerConfigs.openai,
  );
  const globalDictationOverride = useKartonState(
    (s) => s.preferences.featureGates.overrides['global-dictation'],
  );
  const realtimeDictationOverride = useKartonState(
    (s) => s.preferences.featureGates.overrides['realtime-dictation'],
  );
  const activeClodexKeyId = useKartonState(
    (s) => s.userAccount.activeKeyId ?? '',
  );
  const clodexModelReadinessKey = useKartonState((s) =>
    (s.userAccount.models ?? [])
      .map((model) => `${model.id}:${model.enabled !== false}`)
      .sort()
      .join(','),
  );
  const getDiagnostics = useKartonProcedure(
    (procedures) => procedures.dictation.getDiagnostics,
  );
  const negotiateRealtime = useKartonProcedure(
    (procedures) => procedures.dictation.negotiateRealtime,
  );
  const cancelDictationRequest = useKartonProcedure(
    (procedures) => procedures.dictation.cancel,
  );
  const [backendDiagnostics, setBackendDiagnostics] =
    useState<DictationBackendDiagnostics>();
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [microphoneTestRunning, setMicrophoneTestRunning] = useState(false);
  const [microphoneLevel, setMicrophoneLevel] = useState(0);
  const [lastMicrophoneTest, setLastMicrophoneTest] =
    useState<DictationMicrophoneTestResult>();
  const [realtimeTestRunning, setRealtimeTestRunning] = useState(false);
  const [lastRealtimeConnectionTest, setLastRealtimeConnectionTest] =
    useState<DictationRealtimeConnectionTestResult>();
  const microphoneTestRef = useRef<DictationMicrophoneTestOperation | null>(
    null,
  );
  const realtimeTestRef = useRef<RealtimeConnectionDiagnosticOperation | null>(
    null,
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      setBackendDiagnostics(await getDiagnostics());
    } catch {
      setBackendDiagnostics(undefined);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [getDiagnostics]);

  const readinessKey = [
    openAIConfig.mode,
    openAIConfig.encryptedApiKey ?? '',
    openAIConfig.connectedCodingPlanId ?? '',
    activeClodexKeyId,
    clodexModelReadinessKey,
    globalDictationOverride === undefined
      ? 'default'
      : String(globalDictationOverride),
    realtimeDictationOverride === undefined
      ? 'default'
      : String(realtimeDictationOverride),
  ].join(':');

  useEffect(() => {
    realtimeTestRef.current?.cancel();
    void refresh();
  }, [readinessKey, refresh]);

  const cancelMicrophoneTest = useCallback(() => {
    microphoneTestRef.current?.cancel();
  }, []);

  const runMicrophoneTest = useCallback(() => {
    microphoneTestRef.current?.cancel();
    setLastMicrophoneTest(undefined);
    setMicrophoneLevel(0);
    setMicrophoneTestRunning(true);
    const operation = startDictationMicrophoneTest({
      onLevel: setMicrophoneLevel,
    });
    microphoneTestRef.current = operation;
    void operation.result.then((result) => {
      if (microphoneTestRef.current !== operation) return;
      microphoneTestRef.current = null;
      setMicrophoneTestRunning(false);
      setMicrophoneLevel(0);
      setLastMicrophoneTest(result);
    });
  }, []);

  const cancelRealtimeTest = useCallback(() => {
    realtimeTestRef.current?.cancel();
  }, []);

  const runRealtimeTest = useCallback(() => {
    realtimeTestRef.current?.cancel();
    setLastRealtimeConnectionTest(undefined);
    setRealtimeTestRunning(true);
    const operation = startRealtimeConnectionDiagnosticTest({
      runtimeSupport: dictation.runtimeSupport,
      getDiagnostics,
      negotiate: negotiateRealtime,
      cancelRemote: cancelDictationRequest,
    });
    realtimeTestRef.current = operation;
    void operation.result.then((result) => {
      if (realtimeTestRef.current !== operation) return;
      realtimeTestRef.current = null;
      setRealtimeTestRunning(false);
      setLastRealtimeConnectionTest(result);
      void refresh();
    });
  }, [
    cancelDictationRequest,
    dictation.runtimeSupport,
    getDiagnostics,
    negotiateRealtime,
    refresh,
  ]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') return;
      microphoneTestRef.current?.cancel();
      realtimeTestRef.current?.cancel();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      microphoneTestRef.current?.cancel();
      realtimeTestRef.current?.cancel();
    };
  }, []);

  const report = useMemo(
    () =>
      createRedactedDictationDiagnosticReport({
        platform,
        runtime: dictation.runtimeSupport,
        backend: backendDiagnostics,
        lastSession: dictation.lastSessionDiagnostics ?? undefined,
        lastMicrophoneTest,
        lastRealtimeConnectionTest,
      }),
    [
      backendDiagnostics,
      dictation.lastSessionDiagnostics,
      dictation.runtimeSupport,
      lastMicrophoneTest,
      lastRealtimeConnectionTest,
      platform,
    ],
  );

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
      toast({
        id: `dictation-diagnostics-copied-${Date.now()}`,
        title: 'Diagnostic report copied',
        message:
          'The report excludes audio, SDP, API keys and transcript text.',
        type: 'info',
        duration: 3500,
        actions: [],
      });
    } catch {
      toast({
        id: `dictation-diagnostics-copy-failed-${Date.now()}`,
        title: 'Could not copy report',
        message: 'Clipboard access is unavailable.',
        type: 'error',
        actions: [],
      });
    }
  };

  const lastSession = dictation.lastSessionDiagnostics;

  return (
    <>
      <hr className="border-derived-subtle border-t" />
      <section className="space-y-5">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
          <div>
            <h2 className="font-medium text-base text-foreground">
              Dictation diagnostics
            </h2>
            <p className="text-muted-foreground text-sm">
              Runtime readiness and content-free metrics for the latest
              in-memory session.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCcwIcon
                className={`size-3.5 ${loading ? 'animate-spin' : ''}`}
              />
              Refresh
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void copyReport()}
            >
              <CopyIcon className="size-3.5" />
              Copy report
            </Button>
          </div>
        </div>

        <div className="grid gap-2 rounded-xl border border-border bg-background/40 p-4 sm:grid-cols-2">
          <DiagnosticRow
            label="Microphone capture API"
            value={availabilityLabel(
              dictation.runtimeSupport.microphoneCapture,
            )}
            healthy={dictation.runtimeSupport.microphoneCapture}
          />
          <DiagnosticRow
            label="MediaRecorder"
            value={availabilityLabel(dictation.runtimeSupport.mediaRecorder)}
            healthy={dictation.runtimeSupport.mediaRecorder}
          />
          <DiagnosticRow
            label="Web Audio"
            value={availabilityLabel(dictation.runtimeSupport.webAudio)}
            healthy={dictation.runtimeSupport.webAudio}
          />
          <DiagnosticRow
            label="WebRTC"
            value={availabilityLabel(dictation.runtimeSupport.realtimeWebRtc)}
            healthy={dictation.runtimeSupport.realtimeWebRtc}
          />
          <DiagnosticRow
            label="Recorder MIME"
            value={
              dictation.runtimeSupport.recorderMimeType ?? 'Browser default'
            }
          />
          <DiagnosticRow
            label="Global dictation gate"
            value={backendReadinessLabel(
              backendDiagnostics?.globalDictationEnabled,
              loading,
              loadFailed,
            )}
            healthy={backendDiagnostics?.globalDictationEnabled}
          />
          <DiagnosticRow
            label="Realtime dictation gate"
            value={backendReadinessLabel(
              backendDiagnostics?.realtimeDictationEnabled,
              loading,
              loadFailed,
            )}
            healthy={backendDiagnostics?.realtimeDictationEnabled}
          />
          <DiagnosticRow
            label="Official OpenAI key"
            value={backendReadinessLabel(
              backendDiagnostics?.officialOpenAIConfigured,
              loading,
              loadFailed,
            )}
            healthy={backendDiagnostics?.officialOpenAIConfigured}
          />
          <DiagnosticRow
            label="Batch transcription"
            value={batchTranscriptionReadinessLabel(
              backendDiagnostics,
              loading,
              loadFailed,
            )}
            healthy={backendDiagnostics?.batchTranscriptionReady}
          />
          <DiagnosticRow label="Platform" value={platform} />
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="space-y-3 rounded-xl border border-border bg-background/40 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 font-medium text-foreground text-sm">
                  <MicIcon className="size-4" />
                  Local microphone test
                </h3>
                <p className="mt-1 text-muted-foreground text-xs leading-5">
                  Measures signal locally for four seconds. Audio is not
                  recorded, uploaded, or persisted.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant={microphoneTestRunning ? 'secondary' : 'primary'}
                disabled={
                  !dictation.runtimeSupport.microphoneCapture ||
                  !dictation.runtimeSupport.webAudio
                }
                onClick={
                  microphoneTestRunning
                    ? cancelMicrophoneTest
                    : runMicrophoneTest
                }
              >
                {microphoneTestRunning ? (
                  <SquareIcon className="size-3.5" />
                ) : (
                  <PlayIcon className="size-3.5" />
                )}
                {microphoneTestRunning ? 'Cancel' : 'Run test'}
              </Button>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-muted/50"
              aria-label="Microphone signal level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(microphoneLevel * 100)}
              role="meter"
            >
              <div
                className="h-full rounded-full bg-clodex-green-400 transition-[width] duration-75"
                style={{ width: `${Math.round(microphoneLevel * 100)}%` }}
              />
            </div>
            <DiagnosticRow
              label="Result"
              value={
                microphoneTestRunning
                  ? 'Listening locally…'
                  : microphoneTestResultLabel(lastMicrophoneTest)
              }
              healthy={microphoneTestHealthy(lastMicrophoneTest)}
            />
          </div>

          <div className="space-y-3 rounded-xl border border-border bg-background/40 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 font-medium text-foreground text-sm">
                  <RadioIcon className="size-4" />
                  Realtime connection test
                </h3>
                <p className="mt-1 text-muted-foreground text-xs leading-5">
                  Verifies SDP negotiation and data-channel readiness without
                  attaching a microphone track. The session closes immediately.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant={realtimeTestRunning ? 'secondary' : 'primary'}
                disabled={!dictation.runtimeSupport.realtimeWebRtc}
                onClick={
                  realtimeTestRunning ? cancelRealtimeTest : runRealtimeTest
                }
              >
                {realtimeTestRunning ? (
                  <SquareIcon className="size-3.5" />
                ) : (
                  <PlayIcon className="size-3.5" />
                )}
                {realtimeTestRunning ? 'Cancel' : 'Test connection'}
              </Button>
            </div>
            <DiagnosticRow
              label="Result"
              value={
                realtimeTestRunning
                  ? 'Negotiating…'
                  : realtimeConnectionTestResultLabel(
                      lastRealtimeConnectionTest,
                    )
              }
              healthy={realtimeConnectionTestHealthy(
                lastRealtimeConnectionTest,
              )}
            />
          </div>
        </div>

        <div className="space-y-3">
          <h3 className="font-medium text-foreground text-sm">
            Latest session
          </h3>
          {lastSession ? (
            <div className="grid gap-2 rounded-xl border border-border bg-background/40 p-4 sm:grid-cols-2">
              <DiagnosticRow label="Outcome" value={lastSession.outcome} />
              <DiagnosticRow
                label="Transport"
                value={`${lastSession.requestedTransport} → ${lastSession.finalTransport}`}
              />
              <DiagnosticRow
                label="Fallback"
                value={
                  lastSession.fallbackReason
                    ? getDictationFallbackReasonLabel(
                        lastSession.fallbackReason,
                      )
                    : 'None'
                }
                healthy={!lastSession.fallbackReason}
              />
              <DiagnosticRow
                label="Recording duration"
                value={formatMetric(lastSession.recordingDurationMs)}
              />
              <DiagnosticRow
                label="Negotiation latency"
                value={formatMetric(lastSession.negotiationLatencyMs)}
              />
              <DiagnosticRow
                label="First delta latency"
                value={formatMetric(lastSession.firstDeltaLatencyMs)}
              />
              <DiagnosticRow
                label="Finalization latency"
                value={formatMetric(lastSession.finalizationLatencyMs)}
              />
              <DiagnosticRow
                label="Recorder MIME"
                value={lastSession.recorderMimeType ?? 'Browser default'}
              />
            </div>
          ) : (
            <p className="rounded-xl border border-border bg-background/40 p-4 text-muted-foreground text-sm">
              No dictation session has run since this UI was mounted.
            </p>
          )}
        </div>

        <p className="text-muted-foreground text-xs">
          Diagnostics stay in renderer memory. The copied report cannot contain
          microphone audio, SDP, transcript text, request IDs or API keys.
        </p>
      </section>
    </>
  );
}

function DiagnosticRow({
  label,
  value,
  healthy,
}: {
  label: string;
  value: string;
  healthy?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg bg-muted/20 px-3 py-2">
      <span className="truncate text-muted-foreground text-xs">{label}</span>
      <span
        className={
          healthy === undefined
            ? 'truncate font-medium text-foreground text-xs'
            : healthy
              ? 'truncate font-medium text-success-foreground text-xs'
              : 'truncate font-medium text-warning-foreground text-xs'
        }
      >
        {value}
      </span>
    </div>
  );
}

function availabilityLabel(available: boolean): string {
  return available ? 'Available' : 'Unavailable';
}

function backendReadinessLabel(
  value: boolean | undefined,
  loading: boolean,
  failed: boolean,
): string {
  if (loading) return 'Checking…';
  if (failed || value === undefined) return 'Unknown';
  return value ? 'Ready' : 'Not ready';
}

function batchTranscriptionReadinessLabel(
  diagnostics: DictationBackendDiagnostics | undefined,
  loading: boolean,
  failed: boolean,
): string {
  if (loading) return 'Checking…';
  if (failed || !diagnostics) return 'Unknown';
  switch (diagnostics.batchTranscriptionRoute) {
    case 'official-openai':
      return 'Official OpenAI';
    case 'audio-capable-model':
      return 'Audio-capable model';
    case 'custom':
      return 'Custom transcriber';
    case null:
      return 'Not configured';
  }
}

function formatMetric(value: number | undefined): string {
  return value === undefined ? 'Not recorded' : `${value} ms`;
}

function microphoneTestResultLabel(
  result: DictationMicrophoneTestResult | undefined,
): string {
  if (!result) return 'Not run';
  switch (result.outcome) {
    case 'passed':
      return `Signal detected · peak ${result.peakLevel ?? 0}%`;
    case 'no-signal':
      return `No signal detected · peak ${result.peakLevel ?? 0}%`;
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return result.failureReason
        ? getDictationMicrophoneTestFailureLabel(result.failureReason)
        : 'Test failed';
  }
}

function microphoneTestHealthy(
  result: DictationMicrophoneTestResult | undefined,
): boolean | undefined {
  if (!result || result.outcome === 'cancelled') return undefined;
  return result.outcome === 'passed';
}

function realtimeConnectionTestResultLabel(
  result: DictationRealtimeConnectionTestResult | undefined,
): string {
  if (!result) return 'Not run';
  switch (result.outcome) {
    case 'connected':
      return `Connected · ${formatMetric(result.latencyMs)}`;
    case 'cancelled':
      return 'Cancelled';
    case 'not-ready':
    case 'failed':
      return result.failureReason
        ? getDictationFallbackReasonLabel(result.failureReason)
        : 'Connection test failed';
  }
}

function realtimeConnectionTestHealthy(
  result: DictationRealtimeConnectionTestResult | undefined,
): boolean | undefined {
  if (!result || result.outcome === 'cancelled') return undefined;
  return result.outcome === 'connected';
}

// =============================================================================
// Main Section Component
// =============================================================================

export function GeneralSettingsSection() {
  return (
    <SettingsPage
      eyebrow="Application"
      title="General"
      description="Control background behavior and opt in to features that are still being refined."
    >
      <div className="space-y-8">
        <section className="space-y-3">
          <SettingsSectionHeader
            title="Background activity"
            description="Choose how Clodex behaves while agents are working."
          />
          <SettingsPanel className="p-4">
            <PowerSaveBlockerSetting />
          </SettingsPanel>
        </section>
        <ExperimentalFeaturesSetting />
        <DictationDiagnosticsSetting />
      </div>
    </SettingsPage>
  );
}
