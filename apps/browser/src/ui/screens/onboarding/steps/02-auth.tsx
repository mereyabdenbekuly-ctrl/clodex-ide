import { Button } from '@clodex/stage-ui/components/button';
import { Checkbox } from '@clodex/stage-ui/components/checkbox';
import { cn } from '@ui/utils';
import { Input } from '@clodex/stage-ui/components/input';
import { OverlayScrollbar } from '@clodex/stage-ui/components/overlay-scrollbar';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useScrollFadeMask } from '@ui/hooks/use-scroll-fade-mask';
import { useTrack } from '@ui/hooks/use-track';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@clodex/stage-ui/components/tooltip';
import { useIsTruncated } from '@ui/hooks/use-is-truncated';
import {
  SignInOptionsPanel,
  type SignInMethod,
} from '@ui/components/auth/sign-in-options-panel';
import type { StepValidityCallback } from '../index';
import type {
  ModelProvider,
  TelemetryLevel,
} from '@shared/karton-contracts/ui/shared-types';
import {
  isProviderApiKeyConnected,
  supportsProviderAuthMethod,
} from '@shared/provider-auth';

type AuthMode = 'clodex' | 'api-keys' | 'local';
type CompletionAuthMode = 'clodex' | 'api-keys' | 'local';
type AuthPhase = 'form-input' | 'authentication-validated';
type ProviderKey =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'moonshotai'
  | 'alibaba'
  | 'deepseek'
  | 'z-ai';

const PROVIDERS: ProviderKey[] = [
  'anthropic',
  'openai',
  'google',
  'moonshotai',
  'alibaba',
  'deepseek',
  'z-ai',
];
const API_KEY_PROVIDERS = PROVIDERS.filter((provider) =>
  supportsProviderAuthMethod(provider, 'api-key'),
);

type ConnectResult = { success: true } | { success: false; error: string };

const API_KEY_URLS: Record<ProviderKey, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/app/apikey',
  moonshotai: 'https://platform.moonshot.ai/console/api-keys',
  alibaba: 'https://dashscope.console.aliyun.com/apiKey',
  deepseek: 'https://platform.deepseek.com/api_keys',
  'z-ai': 'https://z.ai/manage-apikey/apikey-list',
};

export type OnboardingAuthCompletion = {
  auth_method: CompletionAuthMode;
  provider?: ModelProvider;
};

export function StepAuth({
  isActive,
  onValidityChange,
  onAuthCompleted,
}: {
  isActive: boolean;
  onStepComplete?: () => void;
  onValidityChange?: StepValidityCallback;
  onAuthCompleted?: (completion: OnboardingAuthCompletion) => void;
}) {
  const sendOtp = useKartonProcedure((p) => p.userAccount.sendOtp);
  const verifyOtp = useKartonProcedure((p) => p.userAccount.verifyOtp);
  // Auth handoff procedures wait for OS callbacks (system browser → OAuth/OTP
  // → redirect). The default 30s RPC timeout kills these before the user
  // finishes. Extend to match the backend's 5-min app-level timeout plus a
  // buffer so the backend's own timeout (with a proper error message) fires
  // first, rather than the generic RPC "connection lost" rejection.
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
  const disconnectProvider = useKartonProcedure(
    (p) => p.preferences.disconnectProvider,
  );
  const connectProvider = useKartonProcedure(
    (p) => p.preferences.connectProvider,
  );
  const preferencesUpdate = useKartonProcedure((p) => p.preferences.update);
  const listProviderProfileModels = useKartonProcedure(
    (p) => p.preferences.listProviderProfileModels,
  );
  const openExternalUrl = useKartonProcedure((p) => p.openExternalUrl);
  const track = useTrack();
  const authStatus = useKartonState((s) => s.userAccount.status);
  const preferences = useKartonState((s) => s.preferences);
  const userDisplayName = useKartonState((s) =>
    s.userAccount.status === 'authenticated' ||
    s.userAccount.status === 'server_unreachable'
      ? s.userAccount.user?.displayName ||
        s.userAccount.user?.name ||
        s.userAccount.user?.username ||
        s.userAccount.user?.email
      : null,
  );

  const [mode, setMode] = useState<AuthMode>('api-keys');
  const [phase, setPhase] = useState<AuthPhase>(
    authStatus === 'authenticated' || authStatus === 'server_unreachable'
      ? 'authentication-validated'
      : 'form-input',
  );
  // Community onboarding is private by default. Identifiable telemetry is an
  // explicit opt-in available only after the user selects Clodex Cloud.
  const [telemetry, setTelemetry] = useState<TelemetryLevel>('off');
  const [showMoreProviders, setShowMoreProviders] = useState(false);

  // API-keys list scroll fadeout — mirrors the models-list pattern in
  // agent-settings.models-providers.tsx.
  const [apiKeysViewport, setApiKeysViewport] = useState<HTMLElement | null>(
    null,
  );
  const apiKeysScrollRef = useRef<HTMLElement | null>(null);
  apiKeysScrollRef.current = apiKeysViewport;
  const { maskStyle: apiKeysMaskStyle } = useScrollFadeMask(apiKeysScrollRef, {
    axis: 'vertical',
    fadeDistance: 24,
  });

  const hasConnectedApiKey = useMemo(() => {
    return API_KEY_PROVIDERS.some((provider) =>
      isProviderApiKeyConnected(preferences, provider),
    );
  }, [preferences.providerConfigs, preferences.providerProfiles]);

  const isValid =
    phase === 'authentication-validated' ||
    mode === 'local' ||
    (mode === 'api-keys' && hasConnectedApiKey);

  const switchMode = useCallback(
    (to: AuthMode) => {
      setMode((from) => {
        if (from !== to) {
          void track('onboarding-auth-mode-switched', { from, to });
        }
        return to;
      });
    },
    [track],
  );

  useEffect(() => {
    if (
      authStatus === 'unauthenticated' &&
      phase === 'authentication-validated'
    ) {
      setPhase('form-input');
      switchMode('api-keys');
    }
  }, [authStatus, phase, switchMode]);

  const trackAuthCompleted = useCallback(
    (completion: OnboardingAuthCompletion) => {
      void track('onboarding-auth-method-completed', completion);
      onAuthCompleted?.(completion);
    },
    [onAuthCompleted, track],
  );

  const handleConnectSingleKey = useCallback(
    async (provider: ProviderKey, apiKey: string): Promise<ConnectResult> => {
      try {
        const result = await connectProvider(provider, apiKey);
        if (result.success) {
          trackAuthCompleted({ auth_method: 'api-keys', provider });
        } else {
          void track('onboarding-auth-method-failed', {
            auth_method: 'api-keys',
            provider,
            error_kind: 'validation-error',
          });
        }
        return result;
      } catch (error) {
        void track('onboarding-auth-method-failed', {
          auth_method: 'api-keys',
          provider,
          error_kind: 'network-error',
        });
        throw error;
      }
    },
    [connectProvider, track, trackAuthCompleted],
  );

  const handleDisconnectApiKey = useCallback(
    async (provider: ProviderKey) => {
      await disconnectProvider(provider);
      void track('onboarding-auth-provider-disconnected', {
        auth_method: 'api-keys',
        provider,
      });
    },
    [disconnectProvider, track],
  );

  useEffect(() => {
    if (isActive) {
      onValidityChange?.(
        isValid,
        isValid
          ? undefined
          : 'Connect a provider key, a local model, or Clodex Cloud',
      );
    }
  }, [isActive, isValid, onValidityChange]);

  const handleGetApiKey = useCallback(
    (url: string) => {
      void openExternalUrl(url);
    },
    [openExternalUrl],
  );

  const handleClodexAuthenticated = useCallback(
    (_method: SignInMethod) => {
      trackAuthCompleted({ auth_method: 'clodex' });
      setPhase('authentication-validated');
    },
    [trackAuthCompleted],
  );

  const handleUseLocalOllama = useCallback(async () => {
    const profiles = preferences.providerProfiles.filter(
      (profile) => profile.id !== 'ollama-local',
    );
    profiles.push({
      id: 'ollama-local',
      providerType: 'ollama',
      displayName: 'Local Ollama',
      baseUrl: 'http://localhost:11434',
      protocol: 'ollama',
      customHeaders: {},
      enabled: true,
    });
    await preferencesUpdate([
      { op: 'replace', path: ['providerProfiles'], value: profiles },
      {
        op: 'replace',
        path: ['defaultProviderProfileId'],
        value: 'ollama-local',
      },
    ]);
    await listProviderProfileModels('ollama-local').catch(() => []);
    switchMode('local');
    trackAuthCompleted({ auth_method: 'local' });
  }, [
    preferences.providerProfiles,
    listProviderProfileModels,
    preferencesUpdate,
    switchMode,
    trackAuthCompleted,
  ]);

  if (phase === 'authentication-validated' && mode === 'clodex') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2.5">
        <div className="flex flex-col items-center gap-2">
          <h1 className="font-medium text-foreground text-xl">
            You&apos;re signed in as{' '}
            <span className="text-foreground">
              {userDisplayName ?? 'Clodex'}
            </span>
          </h1>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setPhase('form-input');
            }}
          >
            Use a different email
          </Button>
        </div>
        <div className="app-no-drag mt-2 flex items-center gap-2">
          <Checkbox
            size="xs"
            id="telemetry-full-checkbox"
            checked={telemetry === 'full'}
            onCheckedChange={(checked: boolean) => {
              setTelemetry(checked ? 'full' : 'off');
              void preferencesUpdate([
                {
                  op: 'replace',
                  path: ['privacy', 'telemetryLevel'],
                  value: checked ? 'full' : 'off',
                },
              ]);
            }}
          />
          <label
            htmlFor="telemetry-full-checkbox"
            className="text-muted-foreground text-xs"
          >
            Share identifiable chat and usage data with clodex.
          </label>
        </div>
        <p className="mt-1 max-w-sm text-center text-[11px] text-muted-foreground/80">
          Telemetry is disabled by default and can be configured in settings.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4">
      {mode !== 'clodex' && (
        <div className="flex flex-col items-center gap-2 pb-2">
          <h1 className="font-medium text-foreground text-xl">
            Choose how to connect
          </h1>
          <p className="text-muted-foreground text-sm">
            Use your own key, a local model, or optional Clodex Cloud.
          </p>
        </div>
      )}

      {mode === 'clodex' && phase === 'form-input' && (
        <SignInOptionsPanel
          title="Connect Clodex"
          description="Sign in to use Clodex Cloud as an optional model provider."
          sendOtp={(email, token) => sendOtp(email, token ?? '')}
          verifyOtp={verifyOtp}
          signInSocial={signInSocial}
          signInEmail={signInEmail}
          signInTelegram={signInTelegram}
          trackingPrefix="onboarding-auth"
          track={track}
          openExternalUrl={openExternalUrl}
          onUseApiKeys={() => switchMode('api-keys')}
          onUseSubscription={() => switchMode('api-keys')}
          onAuthenticated={handleClodexAuthenticated}
        />
      )}

      {mode === 'api-keys' && (
        <div className="app-no-drag flex w-full max-w-xs flex-col gap-3">
          <OverlayScrollbar
            className="mask-alpha max-h-96"
            style={apiKeysMaskStyle}
            onViewportRef={setApiKeysViewport}
            contentClassName="space-y-3"
          >
            <ApiKeyRow
              provider="anthropic"
              label="Anthropic"
              placeholder="sk-ant-api01..."
              autoFocus
              isConnected={isProviderApiKeyConnected(preferences, 'anthropic')}
              onConnect={handleConnectSingleKey}
              onDisconnect={handleDisconnectApiKey}
              apiKeyUrl={API_KEY_URLS.anthropic}
              onGetApiKey={handleGetApiKey}
              onFocusProvider={(provider) => {
                void track('onboarding-auth-api-key-input-focused', {
                  provider,
                });
              }}
            />
            <ApiKeyRow
              provider="openai"
              label="OpenAI"
              placeholder="sk-proj-LW..."
              isConnected={isProviderApiKeyConnected(preferences, 'openai')}
              onConnect={handleConnectSingleKey}
              onDisconnect={handleDisconnectApiKey}
              apiKeyUrl={API_KEY_URLS.openai}
              onGetApiKey={handleGetApiKey}
              onFocusProvider={(provider) => {
                void track('onboarding-auth-api-key-input-focused', {
                  provider,
                });
              }}
            />
            <ApiKeyRow
              provider="google"
              label="Google"
              placeholder="AIykSyLeD..."
              isConnected={isProviderApiKeyConnected(preferences, 'google')}
              onConnect={handleConnectSingleKey}
              onDisconnect={handleDisconnectApiKey}
              apiKeyUrl={API_KEY_URLS.google}
              onGetApiKey={handleGetApiKey}
              onFocusProvider={(provider) => {
                void track('onboarding-auth-api-key-input-focused', {
                  provider,
                });
              }}
            />
            {showMoreProviders && (
              <>
                <ApiKeyRow
                  provider="moonshotai"
                  label="Moonshot AI"
                  placeholder="sk-..."
                  isConnected={isProviderApiKeyConnected(
                    preferences,
                    'moonshotai',
                  )}
                  onConnect={handleConnectSingleKey}
                  onDisconnect={handleDisconnectApiKey}
                  apiKeyUrl={API_KEY_URLS.moonshotai}
                  onGetApiKey={handleGetApiKey}
                  onFocusProvider={(provider) => {
                    void track('onboarding-auth-api-key-input-focused', {
                      provider,
                    });
                  }}
                />
                <ApiKeyRow
                  provider="alibaba"
                  label="Alibaba Cloud"
                  placeholder="sk-..."
                  isConnected={isProviderApiKeyConnected(
                    preferences,
                    'alibaba',
                  )}
                  onConnect={handleConnectSingleKey}
                  onDisconnect={handleDisconnectApiKey}
                  apiKeyUrl={API_KEY_URLS.alibaba}
                  onGetApiKey={handleGetApiKey}
                  onFocusProvider={(provider) => {
                    void track('onboarding-auth-api-key-input-focused', {
                      provider,
                    });
                  }}
                />
                <ApiKeyRow
                  provider="deepseek"
                  label="DeepSeek"
                  placeholder="sk-..."
                  isConnected={isProviderApiKeyConnected(
                    preferences,
                    'deepseek',
                  )}
                  onConnect={handleConnectSingleKey}
                  onDisconnect={handleDisconnectApiKey}
                  apiKeyUrl={API_KEY_URLS.deepseek}
                  onGetApiKey={handleGetApiKey}
                  onFocusProvider={(provider) => {
                    void track('onboarding-auth-api-key-input-focused', {
                      provider,
                    });
                  }}
                />
                <ApiKeyRow
                  provider="z-ai"
                  label="Z.ai"
                  placeholder="sk-..."
                  isConnected={isProviderApiKeyConnected(preferences, 'z-ai')}
                  onConnect={handleConnectSingleKey}
                  onDisconnect={handleDisconnectApiKey}
                  apiKeyUrl={API_KEY_URLS['z-ai']}
                  onGetApiKey={handleGetApiKey}
                  onFocusProvider={(provider) => {
                    void track('onboarding-auth-api-key-input-focused', {
                      provider,
                    });
                  }}
                />
              </>
            )}
          </OverlayScrollbar>
          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void handleUseLocalOllama()}
            >
              Use local Ollama
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setShowMoreProviders((expanded) => {
                  const next = !expanded;
                  void track('onboarding-auth-providers-expanded', {
                    expanded: next,
                  });
                  return next;
                });
              }}
            >
              {showMoreProviders ? 'Show less' : 'Show 4 more providers'}
            </Button>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => switchMode('clodex')}
          >
            Quick start with Clodex Cloud
          </Button>
        </div>
      )}

      {mode === 'local' && (
        <div className="app-no-drag flex w-full max-w-xs flex-col gap-3 text-center">
          <p className="text-foreground text-sm">Local Ollama is configured.</p>
          <p className="text-muted-foreground text-xs">
            Models will be loaded from http://localhost:11434 and no API key is
            required.
          </p>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => switchMode('api-keys')}
          >
            Choose another provider
          </Button>
        </div>
      )}
    </div>
  );
}

function ApiKeyRow({
  provider,
  label,
  placeholder,
  autoFocus,
  isConnected,
  onConnect,
  onDisconnect,
  apiKeyUrl,
  onGetApiKey,
  onFocusProvider,
}: {
  provider: ProviderKey;
  label: string;
  placeholder: string;
  autoFocus?: boolean;
  isConnected: boolean;
  onConnect: (provider: ProviderKey, apiKey: string) => Promise<ConnectResult>;
  onDisconnect: (provider: ProviderKey) => Promise<void>;
  apiKeyUrl: string;
  onGetApiKey: (url: string) => void;
  onFocusProvider?: (provider: ProviderKey) => void;
}) {
  const [localInput, setLocalInput] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isCreateKeyVisible, setIsCreateKeyVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Synchronous in-flight guards. React state updates are async, so overlapping
  // handlers (blur + click, Enter + click) within the same event cycle would
  // otherwise each see `isConnecting === false` and double-fire the RPC.
  const connectInFlightRef = useRef(false);
  const disconnectInFlightRef = useRef(false);
  const focusTrackedRef = useRef(false);
  useEffect(
    () => () => {
      connectInFlightRef.current = false;
      disconnectInFlightRef.current = false;
    },
    [],
  );
  const inputId = `api-key-${provider}`;
  const errorId = `${inputId}-error`;

  useEffect(() => {
    if (!autoFocus || isConnected) return;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [autoFocus, isConnected]);

  const handleConnect = useCallback(async () => {
    if (connectInFlightRef.current) return;
    const key = localInput.trim();
    if (!key) return;
    connectInFlightRef.current = true;
    setIsConnecting(true);
    setLocalError(null);
    try {
      const res = await onConnect(provider, key);
      if (res.success) {
        setLocalInput('');
      } else {
        setLocalError(res.error);
      }
    } catch {
      setLocalError('Connection failed. Please try again.');
    } finally {
      connectInFlightRef.current = false;
      setIsConnecting(false);
    }
  }, [localInput, onConnect, provider]);

  const handleDisconnect = useCallback(async () => {
    if (disconnectInFlightRef.current) return;
    disconnectInFlightRef.current = true;
    setIsDisconnecting(true);
    try {
      await onDisconnect(provider);
      setLocalError(null);
    } catch (err) {
      setLocalError(
        err instanceof Error
          ? err.message
          : 'Disconnection failed. Please try again.',
      );
    } finally {
      disconnectInFlightRef.current = false;
      setIsDisconnecting(false);
    }
  }, [onDisconnect, provider]);

  return (
    <div
      className="flex flex-col gap-1"
      onMouseEnter={() => setIsCreateKeyVisible(true)}
      onMouseLeave={() => setIsCreateKeyVisible(false)}
      onFocus={() => setIsCreateKeyVisible(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setIsCreateKeyVisible(false);
        }
      }}
    >
      <div className="flex min-h-4 items-center justify-between gap-2">
        <label htmlFor={inputId} className="text-muted-foreground text-xs">
          {label}
        </label>
        {!isConnected && isCreateKeyVisible && (
          <Tooltip>
            <TooltipTrigger>
              <button
                type="button"
                data-skip-auto-connect="true"
                className="text-primary-foreground text-xs transition-colors hover:cursor-pointer hover:text-hover-derived"
                onClick={() => onGetApiKey(apiKeyUrl)}
              >
                Create key
              </button>
            </TooltipTrigger>
            <TooltipContent>{apiKeyUrl}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="flex gap-1.5">
        <Input
          ref={inputRef}
          id={inputId}
          placeholder={placeholder}
          size="sm"
          type="password"
          value={isConnected ? '••••••••••••••••' : localInput}
          aria-invalid={!!localError}
          aria-describedby={localError ? errorId : undefined}
          disabled={isConnecting || isConnected}
          readOnly={isConnected}
          style={{ maxWidth: 'none' }}
          className={cn(
            'min-w-0 flex-1',
            localError && 'border-error-foreground',
          )}
          onValueChange={
            isConnected
              ? undefined
              : (v) => {
                  setLocalInput(v);
                  setLocalError(null);
                }
          }
          onFocus={(e) => {
            if (isConnected || focusTrackedRef.current) return;
            // Ignore programmatic focus (e.g. autoFocus on mount) so the
            // provider-focus telemetry reflects genuine user intent only.
            if (!e.isTrusted) return;
            focusTrackedRef.current = true;
            onFocusProvider?.(provider);
          }}
          onKeyDown={(e) => {
            if (isConnected) return;
            if (e.key === 'Enter' && localInput.trim() && !isConnecting) {
              void handleConnect();
            }
          }}
          onBlur={(event) => {
            if (isConnected) return;
            if (
              event.relatedTarget instanceof HTMLElement &&
              event.relatedTarget.closest('[data-skip-auto-connect="true"]')
            ) {
              return;
            }
            if (localInput.trim() && !isConnecting) {
              void handleConnect();
            }
          }}
        />
        {isConnected ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleDisconnect()}
            disabled={isDisconnecting}
          >
            {isDisconnecting ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        ) : (
          localInput.trim() && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleConnect()}
              disabled={isConnecting}
            >
              {isConnecting ? 'Connecting…' : 'Connect'}
            </Button>
          )
        )}
      </div>
      {localError && <TruncatedErrorText id={errorId} text={localError} />}
    </div>
  );
}

function TruncatedErrorText({ id, text }: { id: string; text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const { isTruncated, tooltipOpen, setTooltipOpen } = useIsTruncated(ref);

  return (
    <Tooltip open={isTruncated && tooltipOpen} onOpenChange={setTooltipOpen}>
      <TooltipTrigger>
        <p
          ref={ref}
          id={id}
          role="alert"
          className={cn(
            'truncate text-2xs text-error-foreground',
            isTruncated && 'app-no-drag',
          )}
        >
          {text}
        </p>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        <div className="wrap-break-word line-clamp-12 max-h-48 max-w-xs overflow-y-auto text-2xs leading-relaxed">
          {text}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
