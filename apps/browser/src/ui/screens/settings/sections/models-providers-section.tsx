import { OverlayScrollbar } from '@clodex/stage-ui/components/overlay-scrollbar';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@clodex/stage-ui/components/tooltip';
import { useKartonState, useKartonProcedure } from '@ui/hooks/use-karton';
import { useTrack } from '@ui/hooks/use-track';
import type {
  CustomEndpoint,
  CustomModel,
  ModelCapabilities,
  ModelProvider,
  ProviderEndpointMode,
  ProviderProfile,
  ProviderProfileSaveInput,
  UserPreferences,
} from '@shared/karton-contracts/ui/shared-types';
import type { AIProviderProtocol, AIProviderType } from '@shared/ai-provider';
import {
  PROVIDER_DISPLAY_INFO,
  PROVIDER_OFFICIAL_URLS,
} from '@shared/karton-contracts/ui/shared-types';
import type {
  BuiltInModel,
  SelectableBuiltInModel,
} from '@shared/available-models';
import {
  availableModelAliases,
  getAvailableModel,
  getSelectableBuiltInModels,
} from '@shared/available-models';
import {
  getEnabledModelThinkingOption,
  getModelThinkingDisplayState,
  getModelThinkingOptions,
  type ModelThinkingDisplayState,
} from '@ui/utils/model-thinking';
import { ModelThinkingPanel } from '@ui/components/model-thinking-panel';
import {
  useEffect,
  useState,
  useMemo,
  useCallback,
  useRef,
  useLayoutEffect,
} from 'react';

import { cn } from '@ui/utils';
import { useIsTruncated } from '@ui/hooks/use-is-truncated';
import { useScrollFadeMask } from '@ui/hooks/use-scroll-fade-mask';
import {
  RadioGroup,
  Radio,
  RadioLabel,
} from '@clodex/stage-ui/components/radio';
import { Input } from '@clodex/stage-ui/components/input';
import { Button } from '@clodex/stage-ui/components/button';
import { Select } from '@clodex/stage-ui/components/select';
import { Switch } from '@clodex/stage-ui/components/switch';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogHeader,
  DialogFooter,
} from '@clodex/stage-ui/components/dialog';
import { produceWithPatches, enablePatches } from 'immer';
import {
  IconChevronRightOutline18,
  IconChevronDownOutline18,
  IconPlusOutline18,
  IconPenOutline18,
  IconTrashOutline18,
} from 'nucleo-ui-outline-18';
import { BoxesIcon, KeyRoundIcon, ServerCogIcon } from 'lucide-react';
import {
  SettingsPage,
  SettingsSectionHeader,
  SettingsSummaryCard,
} from '../_components/settings-page';

enablePatches();

const EMPTY_CUSTOM_MODELS: UserPreferences['customModels'] = [];
const EMPTY_CUSTOM_ENDPOINTS: UserPreferences['customEndpoints'] = [];
const EMPTY_MODEL_THINKING_OVERRIDES: UserPreferences['agent']['modelThinkingOverrides'] =
  {};
const RECOMMENDED_MODEL_IDS = availableModelAliases.map(
  (alias) => alias.modelId,
);
const CONSOLE_URL =
  import.meta.env.VITE_CLODEX_CONSOLE_URL ||
  import.meta.env.VITE_CLODEX_ORIGIN ||
  'https://clodex.xyz';

// =============================================================================
// Model Provider Configuration
// =============================================================================

const PROVIDERS: ModelProvider[] = [
  'anthropic',
  'openai',
  'google',
  'moonshotai',
  'alibaba',
  'deepseek',
  'z-ai',
  'minimax',
  'xiaomi-mimo',
  'mistral',
];

function getThinkingDefaultOptionsForModel(
  model: BuiltInModel,
  preferences: UserPreferences,
): Parameters<typeof getModelThinkingDisplayState>[2] {
  const provider = model.officialProvider;
  if (!provider) return { providerMode: 'clodex' };

  const config = preferences.providerConfigs[provider];
  if (config.mode !== 'custom') return { providerMode: config.mode };

  const endpoint = preferences.customEndpoints.find(
    (item) => item.id === config.customProviderId,
  );
  if (!endpoint) return { providerMode: 'clodex' };

  return {
    providerMode: 'custom',
    customEndpointApiSpec: endpoint.apiSpec,
  };
}

function ProviderConfigCard({ provider }: { provider: ModelProvider }) {
  const setSettingsRoute = useKartonProcedure(
    (p) => p.appScreen.setSettingsRoute,
  );
  const preferences = useKartonState((s) => s.preferences);
  const updatePreferences = useKartonProcedure((p) => p.preferences.update);
  const setProviderApiKey = useKartonProcedure(
    (p) => p.preferences.setProviderApiKey,
  );
  const clearProviderApiKey = useKartonProcedure(
    (p) => p.preferences.clearProviderApiKey,
  );
  const validateProviderApiKey = useKartonProcedure(
    (p) => p.preferences.validateProviderApiKey,
  );

  const config = preferences.providerConfigs?.[provider] ?? {
    mode: 'clodex' as const,
  };
  const displayInfo = PROVIDER_DISPLAY_INFO[provider];
  const officialUrl = PROVIDER_OFFICIAL_URLS[provider];
  const customEndpoints =
    preferences?.customEndpoints ?? EMPTY_CUSTOM_ENDPOINTS;

  const [apiKeyInput, setApiKeyInput] = useState('');
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [validated, setValidated] = useState<
    null | { success: true } | { success: false; error: string }
  >(null);
  const hasKey = !!config.encryptedApiKey;

  useEffect(() => {
    if (validated?.success) {
      const timer = setTimeout(() => setValidated(null), 2_000);
      return () => clearTimeout(timer);
    }
  }, [validated]);

  const handleModeChange = useCallback(
    async (newMode: unknown) => {
      const [, patches] = produceWithPatches(preferences, (draft) => {
        draft.providerConfigs[provider].mode = newMode as ProviderEndpointMode;
      });
      await updatePreferences(patches);
    },
    [preferences, provider, updatePreferences],
  );

  const handleCustomProviderChange = useCallback(
    async (endpointId: string) => {
      const [, patches] = produceWithPatches(preferences, (draft) => {
        draft.providerConfigs[provider].customProviderId = endpointId;
      });
      await updatePreferences(patches);
    },
    [preferences, provider, updatePreferences],
  );

  const handleSaveAndValidate = useCallback(
    async (key: string) => {
      if (!key.trim()) return;
      const trimmedKey = key.trim();

      if (config.mode === 'official') {
        setIsValidating(true);
        setValidated(null);
        try {
          const result = await validateProviderApiKey(provider, trimmedKey);
          if (result && !result.success) {
            setValidated({ success: false, error: result.error });
            return;
          }
        } catch {
          setValidated({
            success: false,
            error: 'Validation request failed. Please try again.',
          });
          return;
        } finally {
          setIsValidating(false);
        }
      }

      setIsSavingKey(true);
      try {
        await setProviderApiKey(provider, trimmedKey);
        setApiKeyInput('');
        setValidated({ success: true });
      } finally {
        setIsSavingKey(false);
      }
    },
    [provider, config, setProviderApiKey, validateProviderApiKey],
  );

  const handleClearApiKey = useCallback(async () => {
    await clearProviderApiKey(provider);
    setValidated(null);
  }, [provider, clearProviderApiKey]);

  const customProviderItems = customEndpoints.map((ep) => ({
    value: ep.id,
    label: ep.name,
  }));

  return (
    <div className="space-y-3 rounded-lg border border-derived p-3">
      <div className="-mt-1">
        <h3 className="font-medium text-foreground text-sm">
          {displayInfo.name}
        </h3>
        <p className="text-muted-foreground text-xs">
          {displayInfo.description}
        </p>
      </div>

      <RadioGroup value={config.mode} onValueChange={handleModeChange}>
        <RadioLabel>
          <Radio value="clodex" />
          <span>Use my Clodex account</span>
        </RadioLabel>

        <RadioLabel>
          <Radio value="official" />
          <span>Use own API key with {displayInfo.name} API</span>
        </RadioLabel>

        <RadioLabel>
          <Radio value="custom" />
          <span>Use custom provider</span>
        </RadioLabel>
      </RadioGroup>

      {/* Official mode: API key fields */}
      {config.mode === 'official' && (
        <div className="grid grid-cols-1 gap-3 border-derived border-t pt-3 sm:grid-cols-2">
          <div className="space-y-1">
            <p className="font-medium text-muted-foreground text-xs">
              Endpoint URL
            </p>
            <Input
              value={officialUrl}
              disabled
              size="sm"
              style={{ maxWidth: 'none' }}
            />
          </div>

          <div className="space-y-1">
            <p className="font-medium text-muted-foreground text-xs">
              API Key
              {isValidating && (
                <span className="ml-1.5 font-normal text-subtle-foreground">
                  validating...
                </span>
              )}
              {!isValidating && validated?.success && (
                <span className="ml-1.5 font-normal text-success-foreground">
                  Updated
                </span>
              )}
            </p>
            <div className="flex gap-1.5">
              <Input
                type="password"
                value={apiKeyInput}
                placeholder={
                  hasKey || validated
                    ? '••••••••••••••••••••••••••••••••'
                    : 'Enter API key...'
                }
                onValueChange={(v) => {
                  setApiKeyInput(v);
                  setValidated(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && apiKeyInput.trim()) {
                    void handleSaveAndValidate(apiKeyInput);
                  }
                }}
                onBlur={() => {
                  if (apiKeyInput.trim()) {
                    void handleSaveAndValidate(apiKeyInput);
                  }
                }}
                disabled={isValidating || isSavingKey}
                size="sm"
                style={{ maxWidth: 'none' }}
                className="min-w-0 flex-1"
              />
              {apiKeyInput ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleSaveAndValidate(apiKeyInput)}
                  disabled={isValidating || isSavingKey}
                >
                  Save
                </Button>
              ) : hasKey ? (
                <Button variant="ghost" size="sm" onClick={handleClearApiKey}>
                  Clear
                </Button>
              ) : null}
            </div>
            {validated && !validated.success && (
              <TruncatedErrorText text={validated.error} />
            )}
          </div>
        </div>
      )}

      {/* Custom provider mode: select from configured providers */}
      {config.mode === 'custom' && (
        <div className="border-derived border-t pt-3">
          {customEndpoints.length === 0 ? (
            <div className="space-y-2">
              <p className="text-muted-foreground text-xs">
                No custom providers configured yet.
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setSettingsRoute({ section: 'custom-providers' })
                }
              >
                Configure Providers
                <IconChevronRightOutline18 className="size-3" />
              </Button>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="font-medium text-muted-foreground text-xs">
                Provider
              </p>
              <Select
                value={config.customProviderId ?? ''}
                onValueChange={handleCustomProviderChange}
                items={customProviderItems}
                placeholder="Select a provider..."
                size="md"
                triggerClassName="w-full"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Model Providers Section
// =============================================================================

function ClodexProfileKeysSection() {
  const userAccount = useKartonState((s) => s.userAccount);
  const refreshKeys = useKartonProcedure((p) => p.userAccount.refreshKeys);
  const selectKey = useKartonProcedure((p) => p.userAccount.selectKey);
  const openExternalUrl = useKartonProcedure((p) => p.openExternalUrl);
  const keys = userAccount.keys ?? [];
  const models = userAccount.models ?? [];
  const activeKeyId = userAccount.activeKeyId ?? userAccount.ideToken?.keyId;
  const activeKey = keys.find((key) => key.id === activeKeyId);
  const visibleModels = models.slice(0, 36);
  const hiddenModelCount = Math.max(models.length - visibleModels.length, 0);
  const profileLabel =
    userAccount.user?.displayName ||
    userAccount.user?.name ||
    userAccount.user?.username ||
    userAccount.user?.email ||
    'Clodex';
  return (
    <div className="space-y-4 rounded-lg border border-derived p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-foreground text-sm">
            Clodex profile keys
          </h3>
          <p className="text-muted-foreground text-xs">
            {keys.length > 0
              ? `${keys.length} keys linked to this profile. Select one to control chat models.`
              : 'No profile keys loaded yet. Refresh or create a key in Clodex.'}
          </p>
          <p className="mt-1 truncate text-muted-foreground text-xs">
            Profile: {profileLabel}
            {activeKey?.name ? ` · Active key: ${activeKey.name}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-start gap-2">
          <div className="flex gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refreshKeys()}
            >
              Refresh
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void openExternalUrl(CONSOLE_URL)}
            >
              Manage
            </Button>
          </div>
        </div>
      </div>

      {keys.length > 0 ? (
        <RadioGroup
          value={activeKeyId}
          onValueChange={(value) => {
            if (typeof value === 'string') void selectKey(value);
          }}
          disabled={userAccount.isSwitchingKey}
          className="gap-2"
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
                  'w-full items-start rounded-md border border-derived p-3 transition-colors',
                  isActive && 'border-primary bg-primary/5',
                )}
              >
                <Radio value={key.id} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <InlinePill>Key</InlinePill>
                        <span className="truncate font-medium text-foreground text-sm">
                          {key.name}
                        </span>
                        {key.isDefault && <InlinePill>Default</InlinePill>}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {key.group && <InlinePill>{key.group}</InlinePill>}
                        {key.status && <InlinePill>{key.status}</InlinePill>}
                        {protocols.map((protocol) => (
                          <InlinePill key={protocol}>
                            {formatProtocol(protocol)}
                          </InlinePill>
                        ))}
                      </div>
                    </div>
                    {isActive && (
                      <span className="shrink-0 text-muted-foreground text-xs">
                        Active
                      </span>
                    )}
                  </div>
                  {key.modelLimitsEnabled && (
                    <p className="mt-2 text-muted-foreground text-xs">
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
        <div className="rounded-md border border-derived p-3">
          <p className="text-muted-foreground text-sm">
            Keys from your Clodex profile will appear here after sign-in.
          </p>
        </div>
      )}

      <div className="space-y-2 border-derived border-t pt-3">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium text-foreground text-sm">
            Models in active key
          </span>
          <span className="truncate text-muted-foreground text-xs">
            {activeKey?.name ?? 'Current key'}
          </span>
        </div>
        {models.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {visibleModels.map((model) => (
              <InlinePill key={model.id} title={model.id}>
                {model.name ?? model.id}
              </InlinePill>
            ))}
            {hiddenModelCount > 0 && (
              <InlinePill>+{hiddenModelCount}</InlinePill>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            No models are enabled for the selected key.
          </p>
        )}
      </div>
    </div>
  );
}

function InlinePill({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex max-w-full items-center rounded-sm border border-derived bg-surface-2 px-1.5 py-0.5 text-muted-foreground text-xs"
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

function getBareModelId(modelId: string): string {
  return modelId.split('/').pop() ?? modelId;
}

function ModelProvidersSection() {
  const [showAll, setShowAll] = useState(false);
  const primary = PROVIDERS.slice(0, 3);
  const secondary = PROVIDERS.slice(3);
  return (
    <div className="space-y-3">
      {primary.map((provider) => (
        <ProviderConfigCard key={provider} provider={provider} />
      ))}
      {showAll &&
        secondary.map((provider) => (
          <ProviderConfigCard key={provider} provider={provider} />
        ))}
      {secondary.length > 0 && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'Show less' : `Show ${secondary.length} more providers`}
          </Button>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Model Components
// =============================================================================

const BUILT_IN_MODEL_IDS = new Set(
  getSelectableBuiltInModels().map((m) => m.modelId),
) as Set<string>;

function CustomModelDialog({
  model,
  open,
  onOpenChange,
  onSave,
  existingModelIds,
  customEndpoints,
}: {
  model?: CustomModel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (
    data: Omit<CustomModel, 'providerOptions' | 'headers'> & {
      providerOptions: Record<string, unknown>;
      headers: Record<string, string>;
    },
  ) => void;
  existingModelIds: Set<string>;
  customEndpoints: CustomEndpoint[];
}) {
  // Pages run under a different preload than the sidebar UI, so we cannot
  // import `@ui/hooks/use-track` here (it reaches for `window.electron`).
  // `useTrack` from the pages hooks routes through the pages-API
  // `captureTelemetry` bridge and swallows RPC errors so a failed capture
  // can never crash the page.
  const track = useTrack();
  const isAddMode = !model;
  // Set to true when onSave() fires; distinguishes a save-initiated close
  // from a cancel/dismiss close inside the shared `handleDialogOpenChange`.
  const savedRef = useRef(false);

  const [modelId, setModelId] = useState(model?.modelId ?? '');
  const [displayName, setDisplayName] = useState(model?.displayName ?? '');
  const [description, setDescription] = useState(model?.description ?? '');
  const [contextWindowSize, setContextWindowSize] = useState(
    model?.contextWindowSize ?? 128000,
  );
  const [endpointId, setEndpointId] = useState(model?.endpointId ?? 'openai');
  const [thinkingEnabled, setThinkingEnabled] = useState(
    model?.thinkingEnabled ?? false,
  );
  const defaultCaps: ModelCapabilities = {
    inputModalities: {
      text: true,
      audio: false,
      image: false,
      video: false,
      file: false,
    },
    outputModalities: {
      text: true,
      audio: false,
      image: false,
      video: false,
      file: false,
    },
    toolCalling: true,
  };
  const [capabilities, setCapabilities] = useState<ModelCapabilities>(
    model?.capabilities ?? defaultCaps,
  );
  const [providerOptionsJson, setProviderOptionsJson] = useState(
    model?.providerOptions && Object.keys(model.providerOptions).length > 0
      ? JSON.stringify(model.providerOptions, null, 2)
      : '',
  );
  const [headersJson, setHeadersJson] = useState(
    model?.headers && Object.keys(model.headers).length > 0
      ? JSON.stringify(model.headers, null, 2)
      : '',
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);

  const [scrollViewport, setScrollViewport] = useState<HTMLElement | null>(
    null,
  );
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  scrollViewportRef.current = scrollViewport;
  const { maskStyle } = useScrollFadeMask(scrollViewportRef, {
    axis: 'vertical',
    fadeDistance: 24,
  });

  // Depend ONLY on `open` so the effect runs exactly on the open/close
  // transitions. Reading `model`/`isAddMode`/`track` without listing them
  // as deps is intentional — we want their values at the moment the
  // dialog opened, not whenever parent re-renders push new references.
  // Without this scoping, normal parent re-renders would silently reset
  // the user's in-progress form input and re-emit `*-add-started`.
  useEffect(() => {
    if (!open) return;
    setModelId(model?.modelId ?? '');
    setDisplayName(model?.displayName ?? '');
    setDescription(model?.description ?? '');
    setContextWindowSize(model?.contextWindowSize ?? 128000);
    setEndpointId(model?.endpointId ?? 'openai');
    setThinkingEnabled(model?.thinkingEnabled ?? false);
    setCapabilities(model?.capabilities ?? defaultCaps);
    setProviderOptionsJson(
      model?.providerOptions && Object.keys(model.providerOptions).length > 0
        ? JSON.stringify(model.providerOptions, null, 2)
        : '',
    );
    setHeadersJson(
      model?.headers && Object.keys(model.headers).length > 0
        ? JSON.stringify(model.headers, null, 2)
        : '',
    );
    setShowAdvanced(false);
    setJsonError(null);
    savedRef.current = false;
    if (isAddMode) {
      track('custom-model-add-started');
    }
  }, [open]);

  const isDuplicate =
    modelId.trim().length > 0 &&
    (BUILT_IN_MODEL_IDS.has(modelId.trim()) ||
      (existingModelIds.has(modelId.trim()) &&
        modelId.trim() !== model?.modelId));

  const canSave =
    modelId.trim().length > 0 &&
    displayName.trim().length > 0 &&
    !isDuplicate &&
    !jsonError;

  // "Touched" = the user changed anything from the initial field values.
  // Derived from current state so we don't need per-input bookkeeping.
  const anyFieldTouched =
    modelId !== (model?.modelId ?? '') ||
    displayName !== (model?.displayName ?? '') ||
    description !== (model?.description ?? '') ||
    contextWindowSize !== (model?.contextWindowSize ?? 128000) ||
    endpointId !== (model?.endpointId ?? 'openai') ||
    thinkingEnabled !== (model?.thinkingEnabled ?? false) ||
    providerOptionsJson !==
      (model?.providerOptions && Object.keys(model.providerOptions).length > 0
        ? JSON.stringify(model.providerOptions, null, 2)
        : '') ||
    headersJson !==
      (model?.headers && Object.keys(model.headers).length > 0
        ? JSON.stringify(model.headers, null, 2)
        : '') ||
    JSON.stringify(capabilities) !==
      JSON.stringify(model?.capabilities ?? defaultCaps);

  // A pristine, unmodified form is NOT an error — empty required fields
  // at initial state mean "not filled in yet", not "validation failed".
  // `had_validation_errors` should only be true when the user entered
  // input that triggered a concrete validation rule (duplicate ID, invalid
  // JSON in provider options / headers).
  const hadValidationErrors = isDuplicate || jsonError !== null;

  const handleDialogOpenChange = (next: boolean) => {
    if (!next && open && isAddMode && !savedRef.current) {
      track('custom-model-add-aborted', {
        had_validation_errors: hadValidationErrors,
        any_field_touched: anyFieldTouched,
      });
    }
    onOpenChange(next);
  };

  const endpointOptions = useMemo(() => {
    const builtIn = [
      { value: 'anthropic', label: 'Anthropic', group: 'Built-in' },
      { value: 'openai', label: 'OpenAI', group: 'Built-in' },
      { value: 'google', label: 'Google', group: 'Built-in' },
      { value: 'moonshotai', label: 'Moonshot AI', group: 'Built-in' },
      { value: 'alibaba', label: 'Alibaba Cloud', group: 'Built-in' },
      { value: 'deepseek', label: 'DeepSeek', group: 'Built-in' },
      { value: 'z-ai', label: 'Z.ai', group: 'Built-in' },
      { value: 'minimax', label: 'MiniMax', group: 'Built-in' },
      { value: 'xiaomi-mimo', label: 'Xiaomi MiMo', group: 'Built-in' },
      { value: 'mistral', label: 'Mistral', group: 'Built-in' },
    ];
    const custom = customEndpoints.map((ep) => ({
      value: ep.id,
      label: ep.name,
      group: 'Custom',
    }));
    return [...builtIn, ...custom];
  }, [customEndpoints]);

  const handleSave = () => {
    let providerOptions: Record<string, unknown> = {};
    let headers: Record<string, string> = {};

    if (providerOptionsJson.trim()) {
      try {
        providerOptions = JSON.parse(providerOptionsJson);
      } catch {
        setJsonError('Invalid JSON in Provider Options');
        return;
      }
    }
    if (headersJson.trim()) {
      try {
        headers = JSON.parse(headersJson);
      } catch {
        setJsonError('Invalid JSON in Headers');
        return;
      }
    }

    onSave({
      modelId: modelId.trim(),
      displayName: displayName.trim(),
      description: description.trim(),
      contextWindowSize,
      endpointId,
      thinkingEnabled,
      capabilities,
      providerOptions,
      headers,
    });
    if (isAddMode) {
      track('custom-model-add-finished');
    }
    savedRef.current = true;
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="max-h-[85vh] sm:max-w-md">
        <DialogClose />
        <DialogHeader>
          <DialogTitle>{model ? 'Edit Model' : 'Add Custom Model'}</DialogTitle>
          <DialogDescription>
            Define a model and assign it to a provider or custom endpoint.
          </DialogDescription>
        </DialogHeader>

        <OverlayScrollbar
          className="mask-alpha min-h-0 flex-1"
          style={maskStyle}
          onViewportRef={setScrollViewport}
        >
          <div className="space-y-4">
            <div className="space-y-1.5">
              <p className="font-medium text-foreground text-xs">Model ID</p>
              <Input
                placeholder="gpt-4o-mini"
                value={modelId}
                onValueChange={(val) => {
                  setModelId(val);
                  setJsonError(null);
                }}
                size="sm"
              />
              {isDuplicate && (
                <p className="text-error-foreground text-xs">
                  This model ID already exists.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <p className="font-medium text-foreground text-xs">
                Display Name
              </p>
              <Input
                placeholder="GPT-4o Mini"
                value={displayName}
                onValueChange={setDisplayName}
                size="sm"
              />
            </div>

            <div className="space-y-1.5">
              <p className="font-medium text-foreground text-xs">
                Description{' '}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </p>
              <Input
                placeholder="A fast, affordable model..."
                value={description}
                onValueChange={setDescription}
                size="sm"
              />
            </div>

            <div className="space-y-1.5">
              <p className="font-medium text-foreground text-xs">
                Context Window
              </p>
              <Input
                type="number"
                value={String(contextWindowSize)}
                onValueChange={(val) =>
                  setContextWindowSize(Number.parseInt(val, 10) || 128000)
                }
                size="sm"
              />
            </div>

            <div className="space-y-1.5">
              <p className="font-medium text-foreground text-xs">Endpoint</p>
              <Select
                value={endpointId}
                onValueChange={(val) => setEndpointId(val as string)}
                items={endpointOptions}
                size="md"
                triggerClassName="w-full"
              />
            </div>

            {/* Capabilities */}
            <div className="space-y-3 border-derived border-t pt-3">
              <p className="font-medium text-foreground text-xs">
                Capabilities
              </p>

              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {/* biome-ignore lint/a11y/noLabelWithoutControl: base-ui Switch renders a button, label click delegates correctly */}
                <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground text-xs">
                  <Switch
                    checked={thinkingEnabled}
                    onCheckedChange={setThinkingEnabled}
                    size="xs"
                  />
                  Thinking
                </label>

                {/* biome-ignore lint/a11y/noLabelWithoutControl: base-ui Switch renders a button, label click delegates correctly */}
                <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground text-xs">
                  <Switch
                    checked={capabilities.toolCalling}
                    onCheckedChange={(v) =>
                      setCapabilities((c) => ({ ...c, toolCalling: v }))
                    }
                    size="xs"
                  />
                  Tool Calling
                </label>
              </div>

              <div className="space-y-1.5">
                <p className="text-muted-foreground text-xs">
                  Input Modalities
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {(['text', 'image', 'audio', 'video', 'file'] as const).map(
                    (mod) => (
                      // biome-ignore lint/a11y/noLabelWithoutControl: base-ui Switch renders a button, label click delegates correctly
                      <label
                        key={mod}
                        className="flex cursor-pointer items-center gap-1.5 text-muted-foreground text-xs"
                      >
                        <Switch
                          checked={capabilities.inputModalities[mod]}
                          onCheckedChange={(v) =>
                            setCapabilities((c) => ({
                              ...c,
                              inputModalities: {
                                ...c.inputModalities,
                                [mod]: v,
                              },
                            }))
                          }
                          size="xs"
                        />
                        {mod}
                      </label>
                    ),
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-muted-foreground text-xs">
                  Output Modalities
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {(['text', 'image', 'audio', 'video', 'file'] as const).map(
                    (mod) => (
                      // biome-ignore lint/a11y/noLabelWithoutControl: base-ui Switch renders a button, label click delegates correctly
                      <label
                        key={mod}
                        className="flex cursor-pointer items-center gap-1.5 text-muted-foreground text-xs"
                      >
                        <Switch
                          checked={capabilities.outputModalities[mod]}
                          onCheckedChange={(v) =>
                            setCapabilities((c) => ({
                              ...c,
                              outputModalities: {
                                ...c.outputModalities,
                                [mod]: v,
                              },
                            }))
                          }
                          size="xs"
                        />
                        {mod}
                      </label>
                    ),
                  )}
                </div>
              </div>
            </div>

            <div className="border-derived border-t pt-3">
              <button
                type="button"
                className="flex w-full items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                <IconChevronDownOutline18
                  className={`size-3.5 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
                />
                Advanced
              </button>
              {showAdvanced && (
                <div className="mt-3 space-y-3">
                  <div className="space-y-1.5">
                    <p className="font-medium text-foreground text-xs">
                      Provider Options (JSON)
                    </p>
                    <textarea
                      className="w-full rounded-lg border border-derived p-2 font-mono text-foreground text-xs focus:outline-none focus:ring-1 focus:ring-muted-foreground/35"
                      rows={3}
                      placeholder='{"reasoningEffort": "high"}'
                      value={providerOptionsJson}
                      onChange={(e) => {
                        setProviderOptionsJson(e.target.value);
                        setJsonError(null);
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <p className="font-medium text-foreground text-xs">
                      Headers (JSON)
                    </p>
                    <textarea
                      className="w-full rounded-lg border border-derived p-2 font-mono text-foreground text-xs focus:outline-none focus:ring-1 focus:ring-muted-foreground/35"
                      rows={3}
                      placeholder='{"x-custom-header": "value"}'
                      value={headersJson}
                      onChange={(e) => {
                        setHeadersJson(e.target.value);
                        setJsonError(null);
                      }}
                    />
                  </div>
                  {jsonError && (
                    <p className="text-error-foreground text-xs">{jsonError}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </OverlayScrollbar>

        <DialogFooter>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSave}
            onClick={handleSave}
          >
            {model ? 'Save Changes' : 'Add Model'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleDialogOpenChange(false)}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BuiltInModelCard({
  model,
  isEnabled,
  thinkingDisplay,
  onToggle,
  onEditThinking,
}: {
  model: SelectableBuiltInModel;
  isEnabled: boolean;
  thinkingDisplay: ModelThinkingDisplayState | null;
  onToggle: () => void;
  onEditThinking: (event: React.MouseEvent<HTMLElement>) => void;
}) {
  return (
    <div
      data-model-card
      className={cn(
        'group/model-card cursor-pointer rounded-lg border border-derived bg-surface-1 p-3',
        !isEnabled && 'opacity-60',
      )}
      onClick={onToggle}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="-mt-1 min-w-0 flex-1">
          <h3 className="font-medium text-foreground text-sm">
            {model.modelDisplayName}
            {thinkingDisplay && (
              <span className="ml-1.5 font-normal text-subtle-foreground">
                {thinkingDisplay.label}
              </span>
            )}
          </h3>
          <p className="text-muted-foreground text-xs">
            {model.modelId} &middot;{' '}
            {model.officialProvider
              ? PROVIDER_DISPLAY_INFO[model.officialProvider].name
              : 'Unknown'}{' '}
            &middot; {model.modelContext}
          </p>
        </div>
        <div
          className="flex shrink-0 items-center gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          {thinkingDisplay && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-thinking-edit-trigger
              className="h-5 px-1.5 opacity-0 transition-opacity group-focus-within/model-card:opacity-100 group-hover/model-card:opacity-100"
              onClick={onEditThinking}
            >
              Edit
            </Button>
          )}
          <Switch
            checked={isEnabled}
            onCheckedChange={() => onToggle()}
            size="xs"
            aria-label={`${isEnabled ? 'Disable' : 'Enable'} ${model.modelDisplayName}`}
          />
        </div>
      </div>
    </div>
  );
}

function CustomModelCard({
  model,
  endpointName,
  isEnabled,
  onToggle,
  onEdit,
  onDelete,
}: {
  model: CustomModel;
  endpointName: string;
  isEnabled: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        'cursor-pointer rounded-lg border border-derived bg-surface-1 p-3',
        !isEnabled && 'opacity-60',
      )}
      onClick={onToggle}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="-mt-1 min-w-0 flex-1">
          <h3 className="font-medium text-foreground text-sm">
            {model.displayName}
          </h3>
          <p className="truncate text-muted-foreground text-xs">
            {model.modelId} &middot; {endpointName} &middot;{' '}
            {Math.round(model.contextWindowSize / 1000)}k context
          </p>
          {model.description && (
            <p className="mt-0.5 truncate text-muted-foreground/70 text-xs">
              {model.description}
            </p>
          )}
        </div>
        <div
          className="flex shrink-0 items-center gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onEdit}
            className="size-4"
          >
            <IconPenOutline18 className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onDelete}
            className="mr-0.5 size-4"
          >
            <IconTrashOutline18 className="size-3.5" />
          </Button>
          <Switch
            checked={isEnabled}
            onCheckedChange={() => onToggle()}
            size="xs"
            aria-label={`${isEnabled ? 'Disable' : 'Enable'} ${model.displayName}`}
          />
        </div>
      </div>
    </div>
  );
}

type ClodexKeyModel = {
  id: string;
  name?: string;
  provider?: string;
  protocols?: string[];
};

function ClodexKeyModelCard({ model }: { model: ClodexKeyModel }) {
  const bareModelId = getBareModelId(model.id);
  const catalogModel = getAvailableModel(bareModelId);
  const displayName = model.name ?? catalogModel?.modelDisplayName ?? model.id;
  const providerLabel =
    model.provider ??
    (catalogModel?.officialProvider
      ? PROVIDER_DISPLAY_INFO[catalogModel.officialProvider].name
      : undefined);
  const protocols =
    model.protocols && model.protocols.length > 0 ? model.protocols : [];
  const detailParts = [
    model.id,
    providerLabel,
    catalogModel?.modelContext,
  ].filter(Boolean);

  return (
    <div className="rounded-lg border border-derived bg-surface-1 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="-mt-1 min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <InlinePill>From key</InlinePill>
            <h3 className="truncate font-medium text-foreground text-sm">
              {displayName}
            </h3>
          </div>
          <p className="mt-1 truncate text-muted-foreground text-xs">
            {detailParts.join(' · ')}
          </p>
          {protocols.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {protocols.map((protocol) => (
                <InlinePill key={protocol}>
                  {formatProtocol(protocol)}
                </InlinePill>
              ))}
            </div>
          )}
        </div>
        <span className="shrink-0 text-muted-foreground text-xs">Enabled</span>
      </div>
    </div>
  );
}

function CustomModelsSection() {
  const preferences = useKartonState((s) => s.preferences);
  const userAccount = useKartonState((s) => s.userAccount);
  const updatePreferences = useKartonProcedure((p) => p.preferences.update);

  const customModels = preferences?.customModels ?? EMPTY_CUSTOM_MODELS;
  const clodexModels = userAccount.models ?? [];
  const useClodexModelList =
    userAccount.status === 'authenticated' ||
    (userAccount.keys?.length ?? 0) > 0 ||
    clodexModels.length > 0;
  const customEndpoints =
    preferences?.customEndpoints ?? EMPTY_CUSTOM_ENDPOINTS;
  const disabledModelIds = useMemo(
    () => new Set(preferences.agent.disabledModelIds),
    [preferences.agent.disabledModelIds],
  );
  const thinkingOverrides =
    preferences.agent.modelThinkingOverrides ?? EMPTY_MODEL_THINKING_OVERRIDES;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<CustomModel | undefined>(
    undefined,
  );

  const existingModelIds = useMemo(
    () => new Set(customModels.map((m) => m.modelId)),
    [customModels],
  );

  const resolveEndpointName = useCallback(
    (endpointId: string) => {
      if (endpointId === 'anthropic') return 'Anthropic';
      if (endpointId === 'openai') return 'OpenAI';
      if (endpointId === 'google') return 'Google';
      if (endpointId === 'moonshotai') return 'Moonshot AI';
      if (endpointId === 'alibaba') return 'Alibaba Cloud';
      if (endpointId === 'deepseek') return 'DeepSeek';
      if (endpointId === 'z-ai') return 'Z.ai';
      if (endpointId === 'minimax') return 'MiniMax';
      if (endpointId === 'xiaomi-mimo') return 'Xiaomi MiMo';
      if (endpointId === 'mistral') return 'Mistral';
      return (
        customEndpoints.find((ep) => ep.id === endpointId)?.name ?? 'Unknown'
      );
    },
    [customEndpoints],
  );

  const [searchQuery, setSearchQuery] = useState('');

  const filteredBuiltIn = useMemo(() => {
    if (useClodexModelList) return [];
    const selectableModels = getSelectableBuiltInModels({
      disabledModelIds: RECOMMENDED_MODEL_IDS,
    });
    if (!searchQuery.trim()) return selectableModels;
    const q = searchQuery.toLowerCase();
    return selectableModels.filter(
      (m) =>
        m.modelId.toLowerCase().includes(q) ||
        m.modelDisplayName.toLowerCase().includes(q) ||
        (m.officialProvider &&
          PROVIDER_DISPLAY_INFO[m.officialProvider].name
            .toLowerCase()
            .includes(q)),
    );
  }, [searchQuery, useClodexModelList]);

  const filteredClodexModels = useMemo(() => {
    if (!searchQuery.trim()) return clodexModels;
    const q = searchQuery.toLowerCase();
    return clodexModels.filter((model) => {
      const protocols = model.protocols?.join(' ') ?? '';
      return (
        model.id.toLowerCase().includes(q) ||
        getBareModelId(model.id).toLowerCase().includes(q) ||
        (model.name ?? '').toLowerCase().includes(q) ||
        (model.provider ?? '').toLowerCase().includes(q) ||
        protocols.toLowerCase().includes(q)
      );
    });
  }, [searchQuery, clodexModels]);

  const filteredCustom = useMemo(() => {
    if (useClodexModelList) return [];
    if (!searchQuery.trim()) return customModels;
    const q = searchQuery.toLowerCase();
    return customModels.filter(
      (m) =>
        m.modelId.toLowerCase().includes(q) ||
        m.displayName.toLowerCase().includes(q) ||
        resolveEndpointName(m.endpointId).toLowerCase().includes(q),
    );
  }, [searchQuery, customModels, resolveEndpointName, useClodexModelList]);

  const [listScrollViewport, setListScrollViewport] =
    useState<HTMLElement | null>(null);
  const listScrollRef = useRef<HTMLElement | null>(null);
  listScrollRef.current = listScrollViewport;
  const { maskStyle: listMaskStyle } = useScrollFadeMask(listScrollRef, {
    axis: 'vertical',
    fadeDistance: 24,
  });

  const listContainerRef = useRef<HTMLDivElement>(null);
  const thinkingPanelRef = useRef<HTMLDivElement>(null);
  const thinkingPanelAnchorRef = useRef<HTMLElement | null>(null);
  const [thinkingPanelModelId, setThinkingPanelModelId] = useState<
    string | null
  >(null);
  const [thinkingPanelCenterY, setThinkingPanelCenterY] = useState(0);
  const [thinkingPanelOffset, setThinkingPanelOffset] = useState(0);
  const [thinkingPanelLeft, setThinkingPanelLeft] = useState(0);
  const [thinkingPanelSide, setThinkingPanelSide] = useState<'left' | 'right'>(
    'right',
  );

  const thinkingPanelModel = useMemo(
    () =>
      thinkingPanelModelId
        ? getAvailableModel(thinkingPanelModelId)
        : undefined,
    [thinkingPanelModelId],
  );

  const updateThinkingPanelOffset = useCallback(() => {
    if (
      !thinkingPanelModelId ||
      !thinkingPanelRef.current ||
      !listContainerRef.current
    ) {
      return;
    }

    const panel = thinkingPanelRef.current;
    const panelHeight = panel.offsetHeight;
    const panelWidth = panel.offsetWidth;
    const container = listContainerRef.current;
    const containerHeight = container.offsetHeight;
    const anchorRect = thinkingPanelAnchorRef.current?.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const panelGap = 4;

    if (anchorRect) {
      const rightSpace = window.innerWidth - anchorRect.right;
      const leftSpace = anchorRect.left;
      const side =
        rightSpace >= panelWidth + panelGap || rightSpace >= leftSpace
          ? 'right'
          : 'left';
      const rawLeft =
        side === 'right'
          ? anchorRect.right - containerRect.left + panelGap
          : anchorRect.left - containerRect.left - panelWidth - panelGap;
      const minLeft = panelGap - containerRect.left;
      const maxLeft =
        window.innerWidth - containerRect.left - panelWidth - panelGap;

      setThinkingPanelSide(side);
      setThinkingPanelLeft(Math.min(Math.max(rawLeft, minLeft), maxLeft));
    }
    const centerY = anchorRect
      ? anchorRect.top + anchorRect.height / 2 - containerRect.top
      : thinkingPanelCenterY;
    let offset = centerY - panelHeight / 2;
    offset = Math.max(0, offset);
    offset = Math.min(offset, Math.max(0, containerHeight - panelHeight));
    setThinkingPanelOffset(offset);
  }, [thinkingPanelCenterY, thinkingPanelModelId]);

  useLayoutEffect(() => {
    updateThinkingPanelOffset();
  }, [updateThinkingPanelOffset]);

  useEffect(() => {
    if (
      !thinkingPanelModelId ||
      !thinkingPanelRef.current ||
      !listContainerRef.current
    ) {
      return;
    }

    const observer = new ResizeObserver(() => updateThinkingPanelOffset());
    observer.observe(thinkingPanelRef.current);
    observer.observe(listContainerRef.current);
    listScrollViewport?.addEventListener('scroll', updateThinkingPanelOffset);
    window.addEventListener('resize', updateThinkingPanelOffset);
    updateThinkingPanelOffset();

    return () => {
      observer.disconnect();
      listScrollViewport?.removeEventListener(
        'scroll',
        updateThinkingPanelOffset,
      );
      window.removeEventListener('resize', updateThinkingPanelOffset);
    };
  }, [listScrollViewport, thinkingPanelModelId, updateThinkingPanelOffset]);

  useEffect(() => {
    if (!thinkingPanelModelId) return;
    if (
      filteredBuiltIn.some((model) => model.modelId === thinkingPanelModelId)
    ) {
      return;
    }
    setThinkingPanelModelId(null);
  }, [filteredBuiltIn, thinkingPanelModelId]);

  useEffect(() => {
    if (!thinkingPanelModelId) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (thinkingPanelRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest('[data-thinking-edit-trigger]')
      ) {
        return;
      }
      setThinkingPanelModelId(null);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [thinkingPanelModelId]);

  const handleAdd = useCallback(() => {
    setEditingModel(undefined);
    setDialogOpen(true);
  }, []);

  const handleEdit = useCallback((m: CustomModel) => {
    setEditingModel(m);
    setDialogOpen(true);
  }, []);

  const handleEditThinking = useCallback(
    (modelId: string, event: React.MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      event.preventDefault();

      const container = listContainerRef.current;
      const target = event.currentTarget;
      const anchor = target.closest<HTMLElement>('[data-model-card]') ?? target;
      thinkingPanelAnchorRef.current = target;

      if (container) {
        const containerRect = container.getBoundingClientRect();
        const itemRect = anchor.getBoundingClientRect();
        setThinkingPanelCenterY(
          itemRect.top + itemRect.height / 2 - containerRect.top,
        );
      }

      setThinkingPanelModelId((current) => {
        if (current === modelId) {
          thinkingPanelAnchorRef.current = null;
          return null;
        }
        return modelId;
      });
    },
    [],
  );

  const handleSetThinkingEnabled = useCallback(
    async (modelId: string, enabled: boolean) => {
      const model = getAvailableModel(modelId);
      if (!model) return;
      const targetModelId = model.modelId;

      const route = getThinkingDefaultOptionsForModel(model, preferences);
      const option = enabled
        ? getEnabledModelThinkingOption(
            model,
            thinkingOverrides[targetModelId]?.value,
            route,
          )
        : (getModelThinkingOptions(model, route).find(
            (item) => item.value === thinkingOverrides[targetModelId]?.value,
          ) ?? getModelThinkingOptions(model, route)[0]);
      if (!option) return;

      const [, patches] = produceWithPatches(preferences, (draft) => {
        draft.agent.modelThinkingOverrides[targetModelId] = {
          ...draft.agent.modelThinkingOverrides[targetModelId],
          enabled,
          provider: option.provider,
          value: option.value,
        };
      });
      await updatePreferences(patches);
    },
    [preferences, thinkingOverrides, updatePreferences],
  );

  const handleSetThinkingValue = useCallback(
    async (modelId: string, value: string) => {
      const model = getAvailableModel(modelId);
      if (!model) return;
      const targetModelId = model.modelId;

      const route = getThinkingDefaultOptionsForModel(model, preferences);
      const option = getModelThinkingOptions(model, route).find(
        (item) => item.value === value,
      );
      if (!option) return;

      const [, patches] = produceWithPatches(preferences, (draft) => {
        draft.agent.modelThinkingOverrides[targetModelId] = {
          enabled: true,
          provider: option.provider,
          value: option.value,
        };
      });
      await updatePreferences(patches);
    },
    [preferences, updatePreferences],
  );

  const handleResetThinkingOverride = useCallback(
    async (modelId: string) => {
      const targetModelId = getAvailableModel(modelId)?.modelId ?? modelId;
      const [, patches] = produceWithPatches(preferences, (draft) => {
        delete draft.agent.modelThinkingOverrides[targetModelId];
      });
      await updatePreferences(patches);
    },
    [preferences, updatePreferences],
  );

  const handleSave = useCallback(
    async (
      data: Omit<CustomModel, 'providerOptions' | 'headers'> & {
        providerOptions: Record<string, unknown>;
        headers: Record<string, string>;
      },
    ) => {
      if (editingModel) {
        const idx = customModels.findIndex(
          (m) => m.modelId === editingModel.modelId,
        );
        if (idx === -1) return;
        const [, patches] = produceWithPatches(preferences, (draft) => {
          draft.customModels[idx] = data;
        });
        await updatePreferences(patches);
      } else {
        const [, patches] = produceWithPatches(preferences, (draft) => {
          draft.customModels.push(data);
        });
        await updatePreferences(patches);
      }
    },
    [editingModel, customModels, preferences, updatePreferences],
  );

  const handleDelete = useCallback(
    async (modelId: string) => {
      const [, patches] = produceWithPatches(preferences, (draft) => {
        const idx = draft.customModels.findIndex((m) => m.modelId === modelId);
        if (idx !== -1) {
          draft.customModels.splice(idx, 1);
        }
      });
      await updatePreferences(patches);
    },
    [preferences, updatePreferences],
  );

  const handleToggleModel = useCallback(
    async (modelId: string) => {
      const [, patches] = produceWithPatches(preferences, (draft) => {
        const idx = draft.agent.disabledModelIds.indexOf(modelId);
        if (idx === -1) {
          draft.agent.disabledModelIds.push(modelId);
        } else {
          draft.agent.disabledModelIds.splice(idx, 1);
        }
      });
      await updatePreferences(patches);
    },
    [preferences, updatePreferences],
  );

  const noResults = useClodexModelList
    ? searchQuery.trim().length > 0 && filteredClodexModels.length === 0
    : searchQuery.trim().length > 0 &&
      filteredBuiltIn.length === 0 &&
      filteredCustom.length === 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Input
          placeholder={
            useClodexModelList
              ? 'Filter active key models...'
              : 'Filter models...'
          }
          value={searchQuery}
          onValueChange={setSearchQuery}
          size="sm"
          className="flex-1"
          style={{ maxWidth: 'none' }}
        />
        {!useClodexModelList && (
          <Button variant="secondary" size="sm" onClick={handleAdd}>
            <IconPlusOutline18 className="size-3.5" />
            Add Model
          </Button>
        )}
      </div>

      <div ref={listContainerRef} className="relative">
        <OverlayScrollbar
          className="mask-alpha h-96"
          style={listMaskStyle}
          onViewportRef={setListScrollViewport}
          contentClassName="space-y-3"
        >
          {useClodexModelList ? (
            <>
              {filteredClodexModels.map((model) => (
                <ClodexKeyModelCard key={model.id} model={model} />
              ))}

              {clodexModels.length === 0 && (
                <div className="rounded-lg border border-derived-subtle p-4">
                  <p className="text-center text-muted-foreground text-sm">
                    No models are enabled for the selected Clodex key.
                  </p>
                </div>
              )}
            </>
          ) : (
            filteredBuiltIn.map((model) => (
              <BuiltInModelCard
                key={model.modelId}
                model={model}
                isEnabled={!disabledModelIds.has(model.modelId)}
                thinkingDisplay={getModelThinkingDisplayState(
                  model.targetModel,
                  thinkingOverrides[model.modelId],
                  getThinkingDefaultOptionsForModel(
                    model.targetModel,
                    preferences,
                  ),
                )}
                onToggle={() => handleToggleModel(model.modelId)}
                onEditThinking={(event) =>
                  handleEditThinking(model.modelId, event)
                }
              />
            ))
          )}

          {filteredCustom.map((model) => (
            <CustomModelCard
              key={model.modelId}
              model={model}
              endpointName={resolveEndpointName(model.endpointId)}
              isEnabled={!disabledModelIds.has(model.modelId)}
              onToggle={() => handleToggleModel(model.modelId)}
              onEdit={() => handleEdit(model)}
              onDelete={() => handleDelete(model.modelId)}
            />
          ))}

          {noResults && (
            <div className="rounded-lg border border-derived-subtle p-4">
              <p className="text-center text-muted-foreground text-sm">
                No models match your filter.
              </p>
            </div>
          )}
        </OverlayScrollbar>

        {thinkingPanelModel && (
          <div
            ref={thinkingPanelRef}
            className={cn(
              'absolute z-10 flex w-64 flex-col rounded-lg border border-derived bg-background text-foreground text-xs shadow-lg transition-[top] duration-100 ease-out',
              thinkingPanelSide === 'right'
                ? 'fade-in-0 slide-in-from-left-1 animate-in duration-150'
                : 'fade-in-0 slide-in-from-right-1 animate-in duration-150',
            )}
            style={{ top: thinkingPanelOffset, left: thinkingPanelLeft }}
          >
            <ModelThinkingPanel
              model={thinkingPanelModel}
              override={thinkingOverrides[thinkingPanelModel.modelId]}
              defaultOptions={getThinkingDefaultOptionsForModel(
                thinkingPanelModel,
                preferences,
              )}
              onEnabledChange={(enabled) =>
                handleSetThinkingEnabled(thinkingPanelModel.modelId, enabled)
              }
              onValueChange={(value) =>
                handleSetThinkingValue(thinkingPanelModel.modelId, value)
              }
              onReset={() =>
                handleResetThinkingOverride(thinkingPanelModel.modelId)
              }
            />
          </div>
        )}
      </div>

      <CustomModelDialog
        model={editingModel}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSave={handleSave}
        existingModelIds={existingModelIds}
        customEndpoints={customEndpoints}
      />
    </div>
  );
}

// =============================================================================
// Main Page Component
// =============================================================================

const PROFILE_TYPE_OPTIONS: Array<{
  type: AIProviderType;
  label: string;
  protocol: AIProviderProtocol;
  baseUrl?: string;
  keyRequired: boolean;
}> = [
  {
    type: 'openai',
    label: 'OpenAI',
    protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    keyRequired: true,
  },
  {
    type: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com/v1',
    keyRequired: true,
  },
  {
    type: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyRequired: true,
  },
  {
    type: 'ollama',
    label: 'Ollama',
    protocol: 'ollama',
    baseUrl: 'http://localhost:11434',
    keyRequired: false,
  },
  {
    type: 'openai-compatible',
    label: 'OpenAI-compatible',
    protocol: 'openai-chat',
    keyRequired: false,
  },
  {
    type: 'clodex',
    label: 'Clodex Cloud',
    protocol: 'openai-responses',
    baseUrl: 'https://clodex.xyz/v1',
    keyRequired: true,
  },
];

function ProviderProfilesSection() {
  const preferences = useKartonState((s) => s.preferences);
  const saveProfile = useKartonProcedure(
    (p) => p.preferences.saveProviderProfile,
  );
  const deleteProfile = useKartonProcedure(
    (p) => p.preferences.deleteProviderProfile,
  );
  const setDefault = useKartonProcedure(
    (p) => p.preferences.setDefaultProviderProfile,
  );
  const testProfile = useKartonProcedure(
    (p) => p.preferences.testProviderProfile,
  );
  const listModels = useKartonProcedure(
    (p) => p.preferences.listProviderProfileModels,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderProfile | undefined>();
  const [statuses, setStatuses] = useState<
    Record<string, { message: string; ok: boolean }>
  >({});

  const openCreate = useCallback(() => {
    setEditing(undefined);
    setDialogOpen(true);
  }, []);

  const handleTest = useCallback(
    async (profileId: string) => {
      setStatuses((current) => ({
        ...current,
        [profileId]: { ok: true, message: 'Testing…' },
      }));
      try {
        const result = await testProfile(profileId);
        setStatuses((current) => ({
          ...current,
          [profileId]: {
            ok: result.success,
            message: result.success
              ? `Connected${result.status ? ` · HTTP ${result.status}` : ''}`
              : result.message ||
                `Connection failed${result.status ? ` · HTTP ${result.status}` : ''}`,
          },
        }));
      } catch (error) {
        setStatuses((current) => ({
          ...current,
          [profileId]: {
            ok: false,
            message:
              error instanceof Error ? error.message : 'Connection failed',
          },
        }));
      }
    },
    [testProfile],
  );

  const handleModels = useCallback(
    async (profileId: string) => {
      try {
        const models = await listModels(profileId);
        setStatuses((current) => ({
          ...current,
          [profileId]: {
            ok: true,
            message: `${models.length} model${models.length === 1 ? '' : 's'} available`,
          },
        }));
      } catch (error) {
        setStatuses((current) => ({
          ...current,
          [profileId]: {
            ok: false,
            message: error instanceof Error ? error.message : 'Refresh failed',
          },
        }));
      }
    },
    [listModels],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-medium text-sm">AI providers</h3>
          <p className="text-muted-foreground text-xs">
            Choose one active provider. Secrets are stored outside preferences.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={openCreate}>
          <IconPlusOutline18 className="size-3" />
          Add provider
        </Button>
      </div>

      {preferences.providerProfiles.length === 0 ? (
        <div className="rounded-lg border border-derived border-dashed p-4 text-center text-muted-foreground text-xs">
          No provider selected. Add BYOK, a local model, custom endpoint, or
          Clodex Cloud.
        </div>
      ) : (
        <RadioGroup
          value={preferences.defaultProviderProfileId}
          onValueChange={(value) => {
            if (typeof value === 'string') void setDefault(value);
          }}
          className="gap-2"
        >
          {preferences.providerProfiles.map((profile) => {
            const status = statuses[profile.id];
            return (
              <div
                key={profile.id}
                className="rounded-lg border border-derived bg-surface-1 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <RadioLabel className="flex min-w-0 flex-1 items-start gap-2">
                    <Radio value={profile.id} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm">
                        {profile.displayName}
                      </span>
                      <span className="block truncate text-muted-foreground text-xs">
                        {profile.providerType} ·{' '}
                        {profile.baseUrl ?? 'default endpoint'}
                        {profile.apiKeyReference ? ' · key configured' : ''}
                      </span>
                    </span>
                  </RadioLabel>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => void handleTest(profile.id)}
                    >
                      Test
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => void handleModels(profile.id)}
                    >
                      Models
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        setEditing(profile);
                        setDialogOpen(true);
                      }}
                    >
                      <IconPenOutline18 className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => void deleteProfile(profile.id)}
                    >
                      <IconTrashOutline18 className="size-3" />
                    </Button>
                  </div>
                </div>
                {status && (
                  <p
                    className={cn(
                      'mt-2 text-xs',
                      status.ok
                        ? 'text-success-foreground'
                        : 'text-error-foreground',
                    )}
                  >
                    {status.message}
                  </p>
                )}
              </div>
            );
          })}
        </RadioGroup>
      )}

      <ProviderProfileDialog
        open={dialogOpen}
        profile={editing}
        onOpenChange={setDialogOpen}
        onSave={async (input) => {
          await saveProfile(input);
          setDialogOpen(false);
        }}
      />
    </div>
  );
}

function ProviderProfileDialog({
  open,
  profile,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  profile?: ProviderProfile;
  onOpenChange: (open: boolean) => void;
  onSave: (input: ProviderProfileSaveInput) => Promise<void>;
}) {
  const initialType = profile?.providerType ?? 'openai';
  const [providerType, setProviderType] = useState<AIProviderType>(initialType);
  const defaults =
    PROFILE_TYPE_OPTIONS.find((option) => option.type === providerType) ??
    PROFILE_TYPE_OPTIONS[0]!;
  const [displayName, setDisplayName] = useState(
    profile?.displayName ?? defaults.label,
  );
  const [baseUrl, setBaseUrl] = useState(
    profile?.baseUrl ?? defaults.baseUrl ?? '',
  );
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [customHeadersJson, setCustomHeadersJson] = useState(
    JSON.stringify(profile?.customHeaders ?? {}, null, 2),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    const type = profile?.providerType ?? 'openai';
    const option =
      PROFILE_TYPE_OPTIONS.find((candidate) => candidate.type === type) ??
      PROFILE_TYPE_OPTIONS[0]!;
    setProviderType(type);
    setDisplayName(profile?.displayName ?? option.label);
    setBaseUrl(profile?.baseUrl ?? option.baseUrl ?? '');
    setApiKey('');
    setClearApiKey(false);
    setCustomHeadersJson(JSON.stringify(profile?.customHeaders ?? {}, null, 2));
    setError(undefined);
  }, [open, profile]);

  const selected =
    PROFILE_TYPE_OPTIONS.find((option) => option.type === providerType) ??
    PROFILE_TYPE_OPTIONS[0]!;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogClose />
        <DialogHeader>
          <DialogTitle>
            {profile ? 'Edit provider' : 'Add provider'}
          </DialogTitle>
          <DialogDescription>
            Provider credentials are encrypted and are never exported with
            preferences.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <label className="block text-xs">
            Type
            <select
              className="mt-1 h-8 w-full rounded-md border border-derived bg-surface-1 px-2"
              value={providerType}
              onChange={(event) => {
                const type = event.target.value as AIProviderType;
                const option =
                  PROFILE_TYPE_OPTIONS.find(
                    (candidate) => candidate.type === type,
                  ) ?? PROFILE_TYPE_OPTIONS[0]!;
                setProviderType(type);
                setDisplayName(option.label);
                setBaseUrl(option.baseUrl ?? '');
              }}
            >
              {PROFILE_TYPE_OPTIONS.map((option) => (
                <option key={option.type} value={option.type}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="provider-profile-name" className="block text-xs">
            Name
            <Input
              id="provider-profile-name"
              className="mt-1"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label htmlFor="provider-profile-base-url" className="block text-xs">
            Base URL
            <Input
              id="provider-profile-base-url"
              className="mt-1"
              value={baseUrl}
              placeholder={selected.baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          {selected.type !== 'ollama' && (
            <div className="space-y-2">
              <label
                htmlFor="provider-profile-api-key"
                className="block text-xs"
              >
                API key{' '}
                {profile?.apiKeyReference
                  ? '(configured; leave empty to preserve)'
                  : ''}
                <Input
                  id="provider-profile-api-key"
                  className="mt-1"
                  type="password"
                  value={apiKey}
                  disabled={clearApiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
              {profile?.apiKeyReference && (
                <label className="flex items-center gap-2 text-muted-foreground text-xs">
                  <input
                    type="checkbox"
                    checked={clearApiKey}
                    onChange={(event) => {
                      setClearApiKey(event.target.checked);
                      if (event.target.checked) setApiKey('');
                    }}
                  />
                  Remove the stored API key
                </label>
              )}
            </div>
          )}
          <label className="block text-xs">
            Custom headers (JSON)
            <textarea
              className="mt-1 min-h-24 w-full resize-y rounded-md border border-derived bg-surface-1 px-2 py-1.5 font-mono text-xs"
              value={customHeadersJson}
              spellCheck={false}
              placeholder={'{\n  "X-Organization": "example"\n}'}
              onChange={(event) => setCustomHeadersJson(event.target.value)}
            />
            <span className="mt-1 block text-muted-foreground">
              Header names and values only. Do not put secrets here; use the API
              key field for credentials.
            </span>
          </label>
          {error && <p className="text-error-foreground text-xs">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              saving ||
              !displayName.trim() ||
              (!profile && selected.keyRequired && !apiKey.trim())
            }
            onClick={() => {
              setError(undefined);
              let customHeaders: Record<string, string>;
              try {
                const parsed = JSON.parse(customHeadersJson || '{}') as unknown;
                if (
                  !parsed ||
                  Array.isArray(parsed) ||
                  typeof parsed !== 'object' ||
                  Object.values(parsed).some(
                    (value) => typeof value !== 'string',
                  )
                ) {
                  throw new Error('Headers must be a JSON object of strings');
                }
                customHeaders = parsed as Record<string, string>;
              } catch (parseError) {
                setError(
                  parseError instanceof Error
                    ? parseError.message
                    : 'Custom headers are not valid JSON',
                );
                return;
              }
              setSaving(true);
              const id =
                profile?.id ??
                `${providerType}-${crypto.randomUUID().slice(0, 8)}`;
              void onSave({
                id,
                providerType,
                displayName: displayName.trim(),
                baseUrl: baseUrl.trim() || undefined,
                apiKey: apiKey.trim() || undefined,
                clearApiKey,
                protocol: selected.protocol,
                customHeaders,
                enabled: profile?.enabled ?? true,
              })
                .catch((saveError) =>
                  setError(
                    saveError instanceof Error
                      ? saveError.message
                      : 'Could not save provider',
                  ),
                )
                .finally(() => setSaving(false));
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ModelsProvidersSection() {
  const setSettingsRoute = useKartonProcedure(
    (p) => p.appScreen.setSettingsRoute,
  );
  const _userAccount = useKartonState((s) => s.userAccount);
  const preferences = useKartonState((s) => s.preferences);
  const activeProfile = preferences.providerProfiles.find(
    (profile) => profile.id === preferences.defaultProviderProfileId,
  );

  return (
    <SettingsPage
      eyebrow="AI runtime"
      title="Models & providers"
      description="Connect BYOK, local models, custom endpoints, or optional Clodex Cloud."
      toolbar={
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SettingsSummaryCard
            accent
            label="active provider"
            value={activeProfile?.displayName ?? 'Not selected'}
            icon={<KeyRoundIcon className="size-4" />}
          />
          <SettingsSummaryCard
            label="provider profiles"
            value={preferences.providerProfiles.length}
            icon={<BoxesIcon className="size-4" />}
          />
          <SettingsSummaryCard
            label="custom endpoints"
            value={preferences.customEndpoints?.length ?? 0}
            icon={<ServerCogIcon className="size-4" />}
          />
        </div>
      }
    >
      <div className="space-y-8">
        <section className="space-y-4">
          <SettingsSectionHeader
            title="Provider connections"
            description="The active provider controls where prompts, code, and workspace context are sent."
          />

          <ProviderProfilesSection />

          {activeProfile?.providerType === 'clodex' && (
            <ClodexProfileKeysSection />
          )}

          <details>
            <summary className="cursor-pointer text-muted-foreground text-xs">
              Legacy provider routing
            </summary>
            <div className="mt-3">
              <ModelProvidersSection />
            </div>
          </details>
        </section>

        <section className="space-y-4">
          <SettingsSectionHeader
            title="Models"
            description="Every model is displayed with the provider that will receive the request."
            trailing={
              <Button
                variant="secondary"
                size="sm"
                className="rounded-xl"
                onClick={() =>
                  setSettingsRoute({ section: 'custom-providers' })
                }
              >
                Custom Providers
                <IconChevronRightOutline18 className="size-3" />
              </Button>
            }
          />

          <CustomModelsSection />
        </section>
      </div>
    </SettingsPage>
  );
}

function TruncatedErrorText({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const { isTruncated, tooltipOpen, setTooltipOpen } = useIsTruncated(ref);

  return (
    <Tooltip open={isTruncated && tooltipOpen} onOpenChange={setTooltipOpen}>
      <TooltipTrigger>
        <p ref={ref} className={cn('truncate text-2xs text-error-foreground')}>
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
