import { Button } from '@clodex/stage-ui/components/button';
import { Checkbox } from '@clodex/stage-ui/components/checkbox';
import {
  Radio,
  RadioGroup,
  RadioLabel,
} from '@clodex/stage-ui/components/radio';
import type { TelemetryLevel } from '@shared/karton-contracts/ui/shared-types';
import { SignInOptionsPanel } from '@ui/components/auth/sign-in-options-panel';
import { useKartonState, useKartonProcedure } from '@ui/hooks/use-karton';
import { useTrack } from '@ui/hooks/use-track';
import { cn } from '@ui/utils';
import { produceWithPatches } from 'immer';
import { BoxIcon, KeyRoundIcon, UserRoundIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSectionHeader,
  SettingsSummaryCard,
} from '../_components/settings-page';

const CONSOLE_URL =
  import.meta.env.VITE_CLODEX_CONSOLE_URL ||
  import.meta.env.VITE_CLODEX_ORIGIN ||
  'https://clodex.xyz';

export function AccountSection() {
  const userAccount = useKartonState((s) => s.userAccount);
  const sendOtp = useKartonProcedure((p) => p.userAccount.sendOtp);
  const verifyOtp = useKartonProcedure((p) => p.userAccount.verifyOtp);
  // Auth handoff procedures wait for OS callbacks — see 02-auth.tsx for
  // rationale on the extended RPC timeout.
  const AUTH_RPC_TIMEOUT_MS = (5 * 60 + 10) * 1000; // 5 min 10 sec
  const signInSocial = useKartonProcedure((p) =>
    p.userAccount.signInSocial.withTimeout(AUTH_RPC_TIMEOUT_MS),
  );
  const signInEmail = useKartonProcedure((p) =>
    p.userAccount.signInEmail.withTimeout(AUTH_RPC_TIMEOUT_MS),
  );
  const signInTelegram = useKartonProcedure((p) =>
    p.userAccount.signInTelegram.withTimeout(AUTH_RPC_TIMEOUT_MS),
  );
  const logout = useKartonProcedure((p) => p.userAccount.logout);
  const openSettings = useKartonProcedure((p) => p.appScreen.openSettings);
  const openExternalUrl = useKartonProcedure((p) => p.openExternalUrl);
  // `useTrack` swallows RPC errors so a failed telemetry capture (e.g.
  // backend karton server unavailable) cannot crash the page.
  const track = useTrack();

  // Fire once per mounted route instance. The ref guard prevents React
  // StrictMode's development double-invocation; intentional route remounts
  // should still emit a fresh page-view event.
  const didTrackViewRef = useRef(false);
  useEffect(() => {
    if (didTrackViewRef.current) return;
    didTrackViewRef.current = true;
    track('account-page-viewed');
  }, [track]);

  const isAuthenticated =
    userAccount?.status === 'authenticated' ||
    userAccount?.status === 'server_unreachable';

  return (
    <SettingsPage
      eyebrow="Profile"
      title="Account"
      description={
        isAuthenticated
          ? 'Manage the optional Clodex Cloud provider and privacy preferences.'
          : 'Clodex Cloud is optional. You can also use your own provider keys or local models.'
      }
      toolbar={
        isAuthenticated ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SettingsSummaryCard
              label="profile keys"
              value={userAccount.keys?.length ?? 0}
              icon={<KeyRoundIcon className="size-4" />}
            />
            <SettingsSummaryCard
              label="available models"
              value={userAccount.models?.length ?? 0}
              icon={<BoxIcon className="size-4" />}
            />
          </div>
        ) : (
          <div className="max-w-xs">
            <SettingsSummaryCard
              label="account status"
              value="Signed out"
              icon={<UserRoundIcon className="size-4" />}
            />
          </div>
        )
      }
    >
      {isAuthenticated ? (
        <AuthenticatedView
          user={userAccount.user}
          machineId={userAccount.machineId}
          ideToken={userAccount.ideToken}
          keys={userAccount.keys ?? []}
          activeKeyId={userAccount.activeKeyId}
          isSwitchingKey={userAccount.isSwitchingKey}
          models={userAccount.models ?? []}
          onLogout={() => void logout()}
        />
      ) : (
        <SettingsPanel className="mx-auto max-w-2xl p-5 sm:p-7">
          <div className="mb-6">
            <SettingsSectionHeader
              title="Sign in to Clodex"
              description="Authentication opens in your browser and returns securely to the desktop app."
            />
          </div>
          <SignInOptionsPanel
            variant="section"
            title="Authenticate"
            description="Sign in only if you want to use the optional Clodex Cloud provider."
            sendOtp={(email, token) => sendOtp(email, token ?? '')}
            verifyOtp={verifyOtp}
            signInSocial={signInSocial}
            signInEmail={signInEmail}
            signInTelegram={signInTelegram}
            trackingPrefix="account-auth"
            track={track}
            openExternalUrl={openExternalUrl}
            onUseApiKeys={() =>
              void openSettings({ section: 'models-providers' })
            }
            onUseSubscription={() =>
              void openSettings({ section: 'models-providers' })
            }
          />
        </SettingsPanel>
      )}
    </SettingsPage>
  );
}

function AuthenticatedView({
  user,
  machineId,
  ideToken,
  keys,
  activeKeyId,
  isSwitchingKey,
  models,
  onLogout,
}: {
  user?: {
    id: string;
    email?: string;
    name?: string;
    username?: string;
    displayName?: string;
    group?: string;
  };
  machineId?: string;
  ideToken?: {
    keyId?: string;
    keyName?: string;
    group?: string;
  };
  keys: Array<{
    id: string;
    name: string;
    group?: string;
    status?: string;
    isDefault?: boolean;
    modelLimitsEnabled?: boolean;
    modelLimits?: string[];
    protocols?: string[];
    expiresAt?: string;
  }>;
  activeKeyId?: string;
  isSwitchingKey?: boolean;
  models: Array<{
    id: string;
    name?: string;
    provider?: string;
    protocols?: string[];
  }>;
  onLogout: () => void;
}) {
  const openExternalUrl = useKartonProcedure((p) => p.openExternalUrl);
  const refreshKeys = useKartonProcedure((p) => p.userAccount.refreshKeys);
  const selectKey = useKartonProcedure((p) => p.userAccount.selectKey);
  const profileLabel =
    user?.displayName ||
    user?.name ||
    user?.username ||
    user?.email ||
    'Clodex';

  return (
    <SettingsPanel className="divide-y divide-token-border-light overflow-hidden">
      <div className="flex flex-col gap-2 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-clodex-green-400/18 bg-clodex-green-400/8 text-clodex-green-400">
              <UserRoundIcon className="size-4.5" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate font-semibold text-base text-token-text-primary">
                {profileLabel}
              </h2>
              <p className="mt-0.5 text-token-text-secondary text-xs">
                Signed in to Clodex
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="p-5">
        <ApiKeyManager
          keys={keys}
          activeKeyId={activeKeyId ?? ideToken?.keyId}
          isSwitchingKey={isSwitchingKey}
          models={models}
          onRefresh={() => void refreshKeys()}
          onSelectKey={(keyId) => void selectKey(keyId)}
          onOpenConsole={() => void openExternalUrl(CONSOLE_URL)}
        />
      </div>

      <div className="flex flex-col gap-4 p-5">
        <SettingsSectionHeader
          title="Account details"
          description="Profile and device information associated with this desktop session."
        />
        <div className="flex flex-col gap-y-3">
          {user?.username && (
            <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4">
              <span className="font-medium text-token-text-tertiary text-xs">
                Username
              </span>
              <span className="break-all text-sm text-token-text-primary">
                {user.username}
              </span>
            </div>
          )}

          {user?.email && (
            <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4">
              <span className="font-medium text-token-text-tertiary text-xs">
                Email
              </span>
              <span className="break-all text-sm text-token-text-primary">
                {user.email}
              </span>
            </div>
          )}

          {user?.group && (
            <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4">
              <span className="font-medium text-token-text-tertiary text-xs">
                Group
              </span>
              <span className="break-all text-sm text-token-text-primary">
                {user.group}
              </span>
            </div>
          )}

          {(ideToken?.keyName || ideToken?.group) && (
            <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4">
              <span className="font-medium text-token-text-tertiary text-xs">
                IDE key
              </span>
              <span className="break-all text-sm text-token-text-primary">
                {[ideToken.keyName, ideToken.group].filter(Boolean).join(' / ')}
              </span>
            </div>
          )}

          {machineId && (
            <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4">
              <span className="font-medium text-token-text-tertiary text-xs">
                Machine ID
              </span>
              <span className="break-all font-mono text-token-text-primary text-xs">
                {machineId}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="p-5">
        <TelemetrySetting />
      </div>

      <div className="flex flex-col-reverse gap-2 bg-token-bg-secondary/35 p-4 sm:flex-row sm:justify-end">
        <Button
          variant="secondary"
          size="sm"
          className="rounded-xl"
          onClick={onLogout}
        >
          Sign out
        </Button>
        <Button
          variant="primary"
          size="sm"
          className="rounded-xl"
          onClick={() => void openExternalUrl(CONSOLE_URL)}
        >
          Open Console
        </Button>
      </div>
    </SettingsPanel>
  );
}

function ApiKeyManager({
  keys,
  activeKeyId,
  isSwitchingKey,
  models,
  onRefresh,
  onSelectKey,
  onOpenConsole,
}: {
  keys: Array<{
    id: string;
    name: string;
    group?: string;
    status?: string;
    isDefault?: boolean;
    modelLimitsEnabled?: boolean;
    modelLimits?: string[];
    protocols?: string[];
    expiresAt?: string;
  }>;
  activeKeyId?: string;
  isSwitchingKey?: boolean;
  models: Array<{
    id: string;
    name?: string;
    provider?: string;
    protocols?: string[];
  }>;
  onRefresh: () => void;
  onSelectKey: (keyId: string) => void;
  onOpenConsole: () => void;
}) {
  const activeKey = keys.find((key) => key.id === activeKeyId);
  const visibleModels = models.slice(0, 48);
  const hiddenModelCount = Math.max(models.length - visibleModels.length, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-sm text-token-text-primary">
            Profile keys
          </h3>
          <p className="mt-1 text-token-text-secondary text-xs leading-5">
            {keys.length > 0
              ? `${keys.length} keys linked to this Clodex profile. Active key controls chat models.`
              : 'Keys linked to this Clodex profile will appear here.'}
          </p>
        </div>
        <Button
          variant="ghost"
          size="xs"
          className="rounded-lg"
          onClick={onRefresh}
        >
          Refresh
        </Button>
      </div>

      {keys.length > 0 ? (
        <RadioGroup
          value={activeKeyId}
          onValueChange={(value) => {
            if (typeof value === 'string') onSelectKey(value);
          }}
          disabled={isSwitchingKey}
          className="gap-3"
        >
          {keys.map((key) => {
            const protocols =
              key.protocols && key.protocols.length > 0
                ? key.protocols
                : ['openai'];
            const isActive = key.id === activeKeyId;
            return (
              <RadioLabel
                key={key.id}
                className={cn(
                  'w-full items-start rounded-xl border border-token-border-light bg-token-bg-secondary/30 p-3 transition-colors hover:border-token-border-default hover:bg-token-bg-secondary/55',
                  isActive &&
                    'border-clodex-green-400/28 bg-clodex-green-400/6',
                )}
              >
                <Radio value={key.id} className="mt-0.5" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium text-sm text-token-text-primary">
                          {key.name}
                        </span>
                        {key.isDefault && <Pill>Default</Pill>}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {key.group && <Pill>{key.group}</Pill>}
                        {key.status && <Pill>{key.status}</Pill>}
                        {protocols.map((protocol) => (
                          <Pill key={protocol}>{formatProtocol(protocol)}</Pill>
                        ))}
                      </div>
                    </div>
                    {isActive && (
                      <span className="shrink-0 rounded-full bg-clodex-green-400/9 px-2 py-0.5 font-medium text-[10px] text-clodex-green-400 uppercase tracking-[0.06em]">
                        Active
                      </span>
                    )}
                  </div>
                  {key.modelLimitsEnabled && (
                    <p className="text-token-text-tertiary text-xs">
                      {key.modelLimits && key.modelLimits.length > 0
                        ? `${key.modelLimits.length} model limits configured`
                        : 'Model limits enabled'}
                    </p>
                  )}
                </div>
              </RadioLabel>
            );
          })}
        </RadioGroup>
      ) : (
        <div className="rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3.5">
          <div className="font-medium text-sm text-token-text-primary">
            No active keys
          </div>
          <p className="mt-1 text-token-text-secondary text-xs leading-5">
            Create a Clodex key in the console, add models to it, then refresh.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium text-sm text-token-text-primary">
            Available models
          </span>
          <span className="truncate text-token-text-tertiary text-xs">
            {activeKey?.name ?? 'Current key'}
          </span>
        </div>

        {models.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {visibleModels.map((model) => (
              <Pill key={model.id} title={model.id}>
                {model.name ?? model.id}
              </Pill>
            ))}
            {hiddenModelCount > 0 && <Pill>+{hiddenModelCount}</Pill>}
          </div>
        ) : (
          <p className="text-token-text-secondary text-xs leading-5">
            No models are enabled for the selected key.
          </p>
        )}
      </div>

      <div className="flex justify-end">
        <Button
          variant="secondary"
          size="sm"
          className="rounded-xl"
          onClick={onOpenConsole}
        >
          Manage keys
        </Button>
      </div>
    </div>
  );
}

function Pill({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex max-w-full items-center rounded-full border border-token-border-light bg-token-bg-secondary/65 px-2 py-0.5 text-[11px] text-token-text-secondary"
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

function formatProtocol(protocol: string): string {
  const normalized = protocol.toLowerCase();
  if (normalized.includes('anthropic')) return 'Anthropic';
  if (normalized.includes('openai')) return 'OpenAI';
  return protocol;
}

function TelemetrySetting() {
  const preferences = useKartonState((s) => s.preferences);
  const updatePreferences = useKartonProcedure((p) => p.preferences.update);

  const telemetryMode = preferences.privacy.telemetryLevel;

  const handleTelemetryChange = async (value: TelemetryLevel) => {
    const [, patches] = produceWithPatches(preferences, (draft) => {
      draft.privacy.telemetryLevel = value;
    });
    await updatePreferences(patches);
  };

  return (
    <div className="flex flex-col gap-4">
      <SettingsSectionHeader
        title="Telemetry"
        description="Control what usage data is collected to help improve Clodex."
      />

      <div className="flex items-center gap-2">
        <Checkbox
          size="xs"
          id="telemetry-anonymous-checkbox"
          checked={telemetryMode === 'anonymous' || telemetryMode === 'full'}
          onCheckedChange={(checked: boolean) => {
            void handleTelemetryChange(checked ? 'anonymous' : 'off');
          }}
        />
        <label
          htmlFor="telemetry-anonymous-checkbox"
          className="text-token-text-secondary text-xs"
        >
          Help improve Clodex by sharing anonymized events.
        </label>
      </div>
      <div
        className={cn(
          'flex items-center gap-2',
          telemetryMode === 'off' && 'pointer-events-none opacity-50',
        )}
      >
        <Checkbox
          size="xs"
          id="telemetry-full-checkbox"
          checked={telemetryMode === 'full'}
          disabled={telemetryMode === 'off'}
          onCheckedChange={(checked: boolean) => {
            void handleTelemetryChange(checked ? 'full' : 'anonymous');
          }}
        />
        <label
          htmlFor="telemetry-full-checkbox"
          className="text-token-text-secondary text-xs"
        >
          Share identifiable chat and usage data with Clodex.
        </label>
      </div>
    </div>
  );
}
