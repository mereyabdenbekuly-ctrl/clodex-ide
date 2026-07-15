import { Combobox as ComboboxBase } from '@base-ui/react/combobox';
import {
  IconBrainOutline18,
  IconChevronDownFill18,
  IconXmarkOutline18,
} from '@clodex/icons';
import { Button } from '@clodex/stage-ui/components/button';
import {
  Combobox,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
} from '@clodex/stage-ui/components/combobox';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@clodex/stage-ui/components/tooltip';
import type { BuiltInModel, ModelId } from '@shared/available-models';
import type { KartonContract } from '@shared/karton-contracts/ui';
import {
  getAvailableModel,
  getModelAlias,
  getSelectableBuiltInModels,
} from '@shared/available-models';
import { HotkeyActions } from '@shared/hotkeys';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '@ui/utils';
import { useScrollFadeMask } from '@ui/hooks/use-scroll-fade-mask';
import { useHotKeyListener } from '@ui/hooks/use-hotkey-listener';
import { HotkeyCombo } from '@ui/components/hotkey-combo';
import { ModelThinkingPanel } from '@ui/components/model-thinking-panel';
import {
  getEnabledModelThinkingOption,
  getModelThinkingDisplayState,
  getNextModelThinkingOption,
  getModelThinkingOptions,
  type ModelForThinking,
} from '@ui/utils/model-thinking';
import type { UserPreferences } from '@shared/karton-contracts/ui/shared-types';
import { enablePatches, produceWithPatches } from 'immer';

enablePatches();

interface ModelOption {
  modelId: string;
  displayName: string;
  description: string;
  context: string;
  thinkingEnabled: boolean;
  thinkingLabel?: string;
  isAlias?: boolean;
  thinkingModel?: ModelForThinking;
  targetModelId?: string;
  pricingMultiplier?: number;
  providerLabel: string;
  group: 'Recommended' | 'Clodex' | 'Custom';
}

type ClodexModel = NonNullable<
  KartonContract['state']['userAccount']['models']
>[number];

function ModelTooltipContent({
  model,
  description,
  context,
  pricingMultiplier,
}: {
  model: string;
  description: string;
  context: string;
  pricingMultiplier?: number;
}): React.ReactNode {
  return (
    <div className="flex w-48 flex-col gap-1.5">
      <div className="font-semibold">{model}</div>
      <div className="text-muted-foreground">{description}</div>
      <div className="text-[10px] text-muted-foreground/70">
        {context}
        {pricingMultiplier != null && (
          <>
            {' · '}
            <span className="inline-inline-flex items-center">
              {pricingMultiplier}
              <IconXmarkOutline18 className="inline size-2" />$
            </span>
          </>
        )}
      </div>
    </div>
  );
}

interface ModelSelectProps {
  onModelChange?: () => void;
}

function getThinkingDefaultOptionsForModel(
  model: ModelForThinking,
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

function getBareModelId(modelId: string): string {
  return modelId.split('/').pop() ?? modelId;
}

function formatProviderName(provider: string | undefined): string {
  if (!provider) return 'Clodex';
  return provider
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getCatalogModelForClodexModel(
  model: ClodexModel,
): BuiltInModel | undefined {
  return (
    getAvailableModel(model.id) ?? getAvailableModel(getBareModelId(model.id))
  );
}

function getDynamicThinkingModelForClodexModel(
  model: ClodexModel,
): ModelForThinking | undefined {
  const bareModelId = getBareModelId(model.id).toLowerCase();
  const provider = model.provider?.toLowerCase();
  if (
    !/^gpt-5(?:\.|$)/.test(bareModelId) ||
    (provider && provider !== 'openai' && provider !== 'openai-compatible')
  ) {
    return undefined;
  }

  return {
    modelId: model.id,
    modelDisplayName: model.name?.trim() || model.id,
    officialProvider: 'openai',
    thinkingEnabled: true,
    providerOptions: {
      clodex: { reasoning: { effort: 'medium' } },
    },
  };
}

function createClodexModelOption(
  model: ClodexModel,
  preferences: UserPreferences,
  modelThinkingOverrides: UserPreferences['agent']['modelThinkingOverrides'],
): ModelOption {
  const catalogModel = getCatalogModelForClodexModel(model);
  const thinkingModel =
    catalogModel ?? getDynamicThinkingModelForClodexModel(model);
  const displayName =
    model.name?.trim() || catalogModel?.modelDisplayName || model.id;
  const providerLabel = formatProviderName(
    model.provider ?? catalogModel?.officialProvider,
  );
  const thinkingDisplay = thinkingModel
    ? getModelThinkingDisplayState(
        thinkingModel,
        modelThinkingOverrides[thinkingModel.modelId],
        getThinkingDefaultOptionsForModel(thinkingModel, preferences),
      )
    : null;

  return {
    modelId: model.id,
    displayName,
    description:
      catalogModel?.modelDescription ??
      `${providerLabel} model from the active Clodex key.`,
    context: catalogModel?.modelContext ?? providerLabel,
    thinkingEnabled: thinkingDisplay !== null,
    thinkingLabel: thinkingDisplay?.label,
    thinkingModel,
    targetModelId: thinkingModel?.modelId,
    pricingMultiplier: catalogModel?.pricing?.relativeMultiplier,
    providerLabel: 'Clodex Cloud',
    group: 'Clodex',
  };
}

function createBuiltInModelOption(
  model: BuiltInModel,
  preferences: UserPreferences,
  modelThinkingOverrides: UserPreferences['agent']['modelThinkingOverrides'],
  group: ModelOption['group'] = 'Custom',
): ModelOption {
  const thinkingDisplay = getModelThinkingDisplayState(
    model,
    modelThinkingOverrides[model.modelId],
    getThinkingDefaultOptionsForModel(model, preferences),
  );

  return {
    modelId: model.modelId,
    displayName: model.modelDisplayName,
    description: model.modelDescription,
    context: model.modelContext,
    thinkingEnabled: thinkingDisplay !== null,
    thinkingLabel: thinkingDisplay?.label,
    thinkingModel: model,
    targetModelId: model.modelId,
    pricingMultiplier: model.pricing?.relativeMultiplier,
    providerLabel: formatProviderName(model.officialProvider),
    group,
  };
}

function createBuiltInAliasOption(
  model: ReturnType<typeof getSelectableBuiltInModels>[number],
  preferences: UserPreferences,
): ModelOption | null {
  if (model.kind !== 'alias') return null;
  const thinkingDisplay = getModelThinkingDisplayState(
    model.targetModel,
    model.alias.thinkingPreset,
    getThinkingDefaultOptionsForModel(model.targetModel, preferences),
  );

  return {
    modelId: model.modelId,
    displayName: model.modelDisplayName,
    description: model.modelDescription,
    context: model.modelContext,
    thinkingEnabled: thinkingDisplay !== null,
    thinkingLabel: thinkingDisplay?.label,
    isAlias: true,
    thinkingModel: undefined,
    targetModelId: model.targetModelId,
    pricingMultiplier: model.pricing?.relativeMultiplier,
    providerLabel: formatProviderName(model.targetModel.officialProvider),
    group: 'Recommended',
  };
}

// Sentinel value for the "Open model settings" row. Picked to be
// impossible to collide with any real `ModelId` (leading `@@` + spaces).
const OPEN_MODEL_SETTINGS_VALUE = '@@open model settings@@';

const EMPTY_CUSTOM_MODELS: UserPreferences['customModels'] = [];
const EMPTY_DISABLED_MODEL_IDS: UserPreferences['agent']['disabledModelIds'] =
  [];
const EMPTY_MODEL_THINKING_OVERRIDES: UserPreferences['agent']['modelThinkingOverrides'] =
  {};

export const ModelSelect = memo(function ModelSelect({
  onModelChange,
}: ModelSelectProps) {
  const [openAgent] = useOpenAgent();
  const selectedModel = useKartonState((s) =>
    openAgent ? s.agents.instances[openAgent]?.state.activeModelId : null,
  );
  const setSelectedModel = useKartonProcedure((p) => p.agents.setActiveModelId);
  const openSettings = useKartonProcedure((p) => p.appScreen.openSettings);
  const updatePreferences = useKartonProcedure((p) => p.preferences.update);
  const preferences = useKartonState((s) => s.preferences);
  const customModels = useKartonState(
    (s) => s.preferences.customModels ?? EMPTY_CUSTOM_MODELS,
  );
  const disabledModelIds = useKartonState(
    (s) => s.preferences.agent.disabledModelIds ?? EMPTY_DISABLED_MODEL_IDS,
  );
  const modelThinkingOverrides = useKartonState(
    (s) =>
      s.preferences.agent.modelThinkingOverrides ??
      EMPTY_MODEL_THINKING_OVERRIDES,
  );
  const clodexModels = useKartonState((s) => s.userAccount.models ?? []);
  const activeProviderProfile = preferences.providerProfiles.find(
    (profile) => profile.id === preferences.defaultProviderProfileId,
  );
  const hasClodexModels =
    activeProviderProfile?.providerType === 'clodex' && clodexModels.length > 0;

  // Build flat model options list
  const modelOptions = useMemo<ModelOption[]>(() => {
    const disabled = new Set(disabledModelIds);
    if (hasClodexModels) {
      return clodexModels
        .filter((model) => model.enabled !== false)
        .map((model) =>
          createClodexModelOption(model, preferences, modelThinkingOverrides),
        );
    }

    const discoveredModels = activeProviderProfile
      ? (preferences.providerModelCatalogs[activeProviderProfile.id] ?? [])
      : [];
    if (activeProviderProfile && discoveredModels.length > 0) {
      return discoveredModels
        .filter((model) => !disabled.has(model.id))
        .map((model) => ({
          modelId: `${activeProviderProfile.id}:${model.id}`,
          displayName: model.displayName,
          description: `${activeProviderProfile.displayName} model`,
          context: model.capabilities.contextWindow
            ? `${Math.round(model.capabilities.contextWindow / 1000)}k context`
            : activeProviderProfile.displayName,
          thinkingEnabled: model.capabilities.reasoning,
          thinkingLabel: model.capabilities.reasoning ? 'Reasoning' : undefined,
          providerLabel: activeProviderProfile.displayName,
          group: 'Custom' as const,
        }));
    }

    let selectableBuiltIns = getSelectableBuiltInModels({
      disabledModelIds,
    });
    if (
      activeProviderProfile?.providerType === 'openai' ||
      activeProviderProfile?.providerType === 'anthropic'
    ) {
      selectableBuiltIns = selectableBuiltIns.filter(
        (model) =>
          model.targetModel.officialProvider ===
          activeProviderProfile.providerType,
      );
    }
    const builtIn: ModelOption[] = selectableBuiltIns.map((model) =>
      model.kind === 'alias'
        ? createBuiltInAliasOption(model, preferences)!
        : createBuiltInModelOption(
            model.targetModel,
            preferences,
            modelThinkingOverrides,
            'Custom',
          ),
    );
    const qualifiedBuiltIn = activeProviderProfile
      ? builtIn.map((model) => ({
          ...model,
          modelId: `${activeProviderProfile.id}:${
            model.targetModelId ?? model.modelId
          }`,
          providerLabel: activeProviderProfile.displayName,
        }))
      : builtIn;

    const custom: ModelOption[] = customModels
      .filter((m) => !disabled.has(m.modelId))
      .map((model) => ({
        modelId: model.modelId,
        displayName: model.displayName,
        description: model.description,
        context: `${Math.round(model.contextWindowSize / 1000)}k context`,
        thinkingEnabled: !!model.thinkingEnabled,
        thinkingLabel: model.thinkingEnabled ? 'Thinking' : undefined,
        providerLabel:
          preferences.providerProfiles.find(
            (profile) =>
              profile.id === model.endpointId ||
              profile.id === `custom-${model.endpointId}`,
          )?.displayName ?? 'Custom endpoint',
        group: 'Custom',
      }));

    return [...qualifiedBuiltIn, ...custom];
  }, [
    activeProviderProfile,
    clodexModels,
    customModels,
    disabledModelIds,
    hasClodexModels,
    modelThinkingOverrides,
    preferences,
    selectedModel,
  ]);

  // Index by modelId for fast lookups
  const modelMap = useMemo(() => {
    const map = new Map<string, ModelOption>();
    for (const m of modelOptions) {
      map.set(m.modelId, m);
    }
    return map;
  }, [modelOptions]);

  // Group models for rendering (recommended aliases first, then the rest).
  const groupedModels = useMemo(() => {
    const recommended: ModelOption[] = [];
    const clodex: ModelOption[] = [];
    const custom: ModelOption[] = [];

    for (const model of modelOptions) {
      if (model.group === 'Recommended') {
        recommended.push(model);
      } else if (model.group === 'Clodex') {
        clodex.push(model);
      } else {
        custom.push(model);
      }
    }

    return [
      { label: 'Recommended', models: recommended },
      { label: 'Clodex key', models: clodex },
      { label: 'Custom', models: custom },
    ].filter(({ models }) => models.length > 0);
  }, [modelOptions]);

  const [open, setOpen] = useState(false);

  // Search / filter state
  const [query, setQuery] = useState('');

  const filteredGroupedModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return groupedModels;

    return groupedModels
      .map(({ label, models }) => ({
        label,
        models: models.filter(
          (m) =>
            m.displayName.toLowerCase().includes(q) ||
            m.modelId.toLowerCase().includes(q),
        ),
      }))
      .filter(({ models }) => models.length > 0);
  }, [groupedModels, query]);

  const filteredModelIds = useMemo(
    () =>
      filteredGroupedModels.flatMap(({ models }) =>
        models.map((model) => model.modelId),
      ),
    [filteredGroupedModels],
  );

  const allModelItemValues = useMemo(
    () => [
      ...modelOptions.map((model) => model.modelId),
      OPEN_MODEL_SETTINGS_VALUE,
    ],
    [modelOptions],
  );

  const filteredItemValues = useMemo(
    () =>
      query.trim() === ''
        ? allModelItemValues
        : filteredModelIds.length > 0
          ? [...filteredModelIds, OPEN_MODEL_SETTINGS_VALUE]
          : [],
    [allModelItemValues, filteredModelIds, query],
  );

  const hasFilteredResults = filteredModelIds.length > 0;

  // Display labels for the trigger
  const selectedModelOption = selectedModel
    ? modelMap.get(selectedModel)
    : undefined;

  const selectedDisplayName =
    selectedModelOption?.displayName ?? selectedModel ?? 'Select model';

  const selectedThinkingLabel = selectedModelOption?.isAlias
    ? undefined
    : selectedModelOption?.thinkingLabel;

  const inputRef = useRef<HTMLInputElement>(null);

  // Side-panel hover state
  const containerRef = useRef<HTMLDivElement>(null);
  const sidePanelRef = useRef<HTMLDivElement>(null);
  const [hoveredModel, setHoveredModel] = useState<ModelOption | null>(null);
  const [editingThinkingModelId, setEditingThinkingModelId] = useState<
    string | null
  >(null);
  const [itemCenterY, setItemCenterY] = useState(0);
  const [sidePanelOffset, setSidePanelOffset] = useState(0);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const cancelPendingClear = useCallback(() => {
    if (clearTimerRef.current !== undefined) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = undefined;
    }
  }, []);

  const scheduleClear = useCallback(() => {
    cancelPendingClear();
    clearTimerRef.current = setTimeout(() => {
      setHoveredModel(null);
      setEditingThinkingModelId(null);
      clearTimerRef.current = undefined;
    }, 150);
  }, [cancelPendingClear]);

  useEffect(() => () => cancelPendingClear(), [cancelPendingClear]);

  const listScrollRef = useRef<HTMLDivElement>(null);
  const { maskStyle: listMaskStyle } = useScrollFadeMask(listScrollRef, {
    axis: 'vertical',
    fadeDistance: 16,
  });

  const editingThinkingModel = useMemo(
    () =>
      editingThinkingModelId
        ? modelMap.get(editingThinkingModelId)?.thinkingModel
        : undefined,
    [editingThinkingModelId, modelMap],
  );

  useLayoutEffect(() => {
    if (!hoveredModel || !sidePanelRef.current || !containerRef.current) return;
    const panelHeight = sidePanelRef.current.offsetHeight;
    const containerHeight = containerRef.current.offsetHeight;

    let offset = itemCenterY - panelHeight / 2;
    offset = Math.max(0, offset);
    offset = Math.min(offset, Math.max(0, containerHeight - panelHeight));

    setSidePanelOffset(offset);
  }, [hoveredModel, itemCenterY, editingThinkingModelId]);

  const handleItemHover = useCallback(
    (model: ModelOption, element: HTMLElement) => {
      cancelPendingClear();
      const container = containerRef.current;
      if (!container) {
        setHoveredModel(model);
        setEditingThinkingModelId((current) =>
          current === model.modelId ? current : null,
        );
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const itemRect = element.getBoundingClientRect();
      const centerY = itemRect.top + itemRect.height / 2 - containerRect.top;

      setItemCenterY(centerY);
      setHoveredModel(model);
      setEditingThinkingModelId((current) =>
        current === model.modelId ? current : null,
      );
    },
    [cancelPendingClear],
  );

  const handleValueChange = useCallback(
    (value: string | null) => {
      if (!value) return;
      if (value === OPEN_MODEL_SETTINGS_VALUE) {
        void openSettings({ section: 'models-providers' });
        return;
      }
      if (!openAgent) return;
      setSelectedModel(openAgent, value as ModelId);
      onModelChange?.();
    },
    [openAgent, openSettings, setSelectedModel, onModelChange],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        cancelPendingClear();
        setHoveredModel(null);
        setEditingThinkingModelId(null);
        setQuery('');
      }
    },
    [cancelPendingClear],
  );

  const handleEditThinking = useCallback(
    (modelId: string, event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setEditingThinkingModelId((current) =>
        current === modelId ? null : modelId,
      );
    },
    [],
  );

  const handleSetThinkingEnabled = useCallback(
    async (modelId: string, enabled: boolean) => {
      const model =
        modelMap.get(modelId)?.thinkingModel ?? getAvailableModel(modelId);
      if (!model) return;
      const targetModelId = model.modelId;

      const route = getThinkingDefaultOptionsForModel(model, preferences);
      const option = enabled
        ? getEnabledModelThinkingOption(
            model,
            modelThinkingOverrides[targetModelId]?.value,
            route,
          )
        : (getModelThinkingOptions(model, route).find(
            (item) =>
              item.value === modelThinkingOverrides[targetModelId]?.value,
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
    [modelMap, modelThinkingOverrides, preferences, updatePreferences],
  );

  const handleSetThinkingValue = useCallback(
    async (modelId: string, value: string) => {
      const model =
        modelMap.get(modelId)?.thinkingModel ?? getAvailableModel(modelId);
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
    [modelMap, preferences, updatePreferences],
  );

  const handleResetThinkingOverride = useCallback(
    async (modelId: string) => {
      const targetModelId =
        modelMap.get(modelId)?.thinkingModel?.modelId ??
        getAvailableModel(modelId)?.modelId ??
        modelId;
      const [, patches] = produceWithPatches(preferences, (draft) => {
        delete draft.agent.modelThinkingOverrides[targetModelId];
      });
      await updatePreferences(patches);
    },
    [modelMap, preferences, updatePreferences],
  );

  const handleCycleThinkingEffort = useCallback(() => {
    if (!selectedModel) return false;

    // Aliases use fixed thinking presets — cycling is disabled for them.
    if (getModelAlias(selectedModel)) return false;

    const model =
      modelMap.get(selectedModel)?.thinkingModel ??
      getAvailableModel(selectedModel);
    if (!model) return false;
    const targetModelId = model.modelId;

    const display = getModelThinkingDisplayState(
      model,
      modelThinkingOverrides[targetModelId],
      getThinkingDefaultOptionsForModel(model, preferences),
    );
    if (!display) return false;

    const route = getThinkingDefaultOptionsForModel(model, preferences);
    const nextOption = getNextModelThinkingOption(model, display.value, route);
    const [, patches] = produceWithPatches(preferences, (draft) => {
      draft.agent.modelThinkingOverrides[targetModelId] = {
        enabled: true,
        provider: nextOption.provider,
        value: nextOption.value,
      };
    });
    void updatePreferences(patches);
  }, [
    modelMap,
    modelThinkingOverrides,
    preferences,
    selectedModel,
    updatePreferences,
  ]);

  useHotKeyListener(
    useCallback(() => {
      setOpen(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          inputRef.current?.focus();
        });
      });
    }, []),
    HotkeyActions.OPEN_MODEL_SELECT,
  );

  useHotKeyListener(
    handleCycleThinkingEffort,
    HotkeyActions.CYCLE_MODEL_THINKING_EFFORT,
  );

  return (
    <Combobox
      value={selectedModel}
      open={open}
      inputValue={query}
      items={allModelItemValues}
      filteredItems={filteredItemValues}
      autoHighlight
      onValueChange={handleValueChange}
      onOpenChange={handleOpenChange}
      onInputValueChange={setQuery}
      filter={null}
    >
      <Tooltip>
        <TooltipTrigger>
          <ComboboxBase.Trigger
            className={cn(
              'group/trigger inline-flex min-w-0 max-w-full cursor-pointer items-center justify-between gap-1 rounded-lg p-0 font-normal text-xs shadow-none transition-colors',
              'focus-visible:outline-1 focus-visible:outline-muted-foreground/35 focus-visible:-outline-offset-2',
              'has-disabled:pointer-events-none has-disabled:opacity-50',
              'bg-transparent text-muted-foreground hover:text-foreground data-popup-open:text-foreground',
              'h-4 w-auto',
            )}
          >
            <span className="min-w-0 truncate">{selectedDisplayName}</span>
            {selectedThinkingLabel && (
              <span className="shrink-0 text-subtle-foreground transition-colors group-hover/trigger:text-muted-foreground group-data-[popup-open]/trigger:text-muted-foreground">
                {selectedThinkingLabel}
              </span>
            )}
            <ComboboxBase.Icon className="shrink-0">
              <IconChevronDownFill18 className="size-3" />
            </ComboboxBase.Icon>
          </ComboboxBase.Trigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          <div className="flex flex-col gap-1">
            <span className="flex items-center justify-between gap-2">
              <span>Switch model</span>
              <HotkeyCombo action={HotkeyActions.OPEN_MODEL_SELECT} size="xs" />
            </span>
            <span className="flex items-center justify-between gap-2">
              <span>Change reasoning effort</span>
              <HotkeyCombo
                action={HotkeyActions.CYCLE_MODEL_THINKING_EFFORT}
                size="xs"
              />
            </span>
          </div>
        </TooltipContent>
      </Tooltip>

      <ComboboxBase.Portal>
        <ComboboxBase.Backdrop className="fixed inset-0 z-50" />
        <ComboboxBase.Positioner
          side="top"
          sideOffset={4}
          align="start"
          className="z-50"
        >
          <div
            ref={containerRef}
            className="relative flex flex-row items-start gap-1"
            onMouseLeave={scheduleClear}
          >
            <ComboboxBase.Popup
              className={cn(
                'flex max-w-72 origin-(--transform-origin) flex-col items-stretch gap-0.5 text-xs',
                'rounded-lg border border-border-subtle bg-background p-1 shadow-lg',
                'transition-[transform,scale,opacity] duration-150 ease-out',
                'data-ending-style:scale-90 data-ending-style:opacity-0',
                'data-starting-style:scale-90 data-starting-style:opacity-0',
              )}
            >
              <div className="mb-1 rounded-md">
                <ComboboxInput ref={inputRef} size="xs" placeholder="Search…" />
              </div>

              <ComboboxList>
                <div
                  ref={listScrollRef}
                  className="mask-alpha scrollbar-subtle max-h-48 overflow-y-auto"
                  style={listMaskStyle}
                >
                  {filteredGroupedModels.map(({ label, models }) => (
                    <ComboboxGroup key={label}>
                      <ComboboxGroupLabel className="px-1.5 pt-2 pb-1 font-normal text-sidebar-foreground text-xs first:pt-0">
                        {label}
                      </ComboboxGroupLabel>
                      {models.map((model) => (
                        <ModelItem
                          key={model.modelId}
                          model={model}
                          onHighlight={handleItemHover}
                          onEditThinking={handleEditThinking}
                        />
                      ))}
                    </ComboboxGroup>
                  ))}
                </div>

                {!hasFilteredResults && (
                  <div className="px-2 py-1.5 text-muted-foreground text-xs">
                    No results
                  </div>
                )}

                <ComboboxItem value={OPEN_MODEL_SETTINGS_VALUE} size="xs">
                  <ComboboxItemIndicator />
                  <span className="col-start-2 truncate">Model settings</span>
                </ComboboxItem>
              </ComboboxList>
            </ComboboxBase.Popup>

            {/* Animated side panel for model details */}
            {hoveredModel && (
              <div
                ref={sidePanelRef}
                onMouseEnter={cancelPendingClear}
                className={cn(
                  'absolute left-full ml-1 flex w-64 flex-col rounded-lg border border-derived bg-background text-foreground text-xs shadow-lg transition-[top] duration-100 ease-out',
                  'fade-in-0 slide-in-from-left-1 animate-in duration-150',
                )}
                style={{ top: sidePanelOffset }}
              >
                {editingThinkingModel ? (
                  <ModelThinkingPanel
                    model={editingThinkingModel}
                    override={
                      modelThinkingOverrides[editingThinkingModel.modelId]
                    }
                    defaultOptions={getThinkingDefaultOptionsForModel(
                      editingThinkingModel,
                      preferences,
                    )}
                    onEnabledChange={(enabled) =>
                      handleSetThinkingEnabled(
                        editingThinkingModel.modelId,
                        enabled,
                      )
                    }
                    onValueChange={(value) =>
                      handleSetThinkingValue(
                        editingThinkingModel.modelId,
                        value,
                      )
                    }
                    onReset={() =>
                      handleResetThinkingOverride(editingThinkingModel.modelId)
                    }
                  />
                ) : (
                  <div className="p-2.5">
                    <ModelTooltipContent
                      model={hoveredModel.displayName}
                      description={hoveredModel.description}
                      context={hoveredModel.context}
                      pricingMultiplier={hoveredModel.pricingMultiplier}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </ComboboxBase.Positioner>
      </ComboboxBase.Portal>
    </Combobox>
  );
});

const ModelItem = memo(function ModelItem({
  model,
  onHighlight,
  onEditThinking,
}: {
  model: ModelOption;
  onHighlight: (model: ModelOption, element: HTMLElement) => void;
  onEditThinking: (
    modelId: string,
    event: React.MouseEvent<HTMLElement>,
  ) => void;
}) {
  const itemRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = itemRef.current;
    if (!el) return;

    const observer = new MutationObserver(() => {
      if (el.hasAttribute('data-highlighted')) onHighlight(model, el);
    });

    observer.observe(el, {
      attributes: true,
      attributeFilter: ['data-highlighted'],
    });

    return () => observer.disconnect();
  }, [model, onHighlight]);

  return (
    <ComboboxItem ref={itemRef} value={model.modelId} size="xs">
      <ComboboxItemIndicator />
      <span className="col-start-2 flex min-w-0 flex-row items-center justify-between gap-4 text-xs">
        <div className="flex min-w-0 flex-col">
          <span className="truncate">{model.displayName}</span>
          <span className="truncate text-[9px] text-muted-foreground">
            {model.providerLabel}
          </span>
        </div>
        {model.thinkingLabel && (
          <span
            className={cn(
              'relative flex h-4 shrink-0 items-center justify-end text-[10px]',
              model.isAlias ? 'min-w-3' : 'min-w-14',
            )}
          >
            <span
              className={cn(
                'inline-flex items-center gap-1 text-subtle-foreground',
                !model.isAlias && 'group-data-[highlighted]/item:opacity-0',
              )}
            >
              <IconBrainOutline18 className="size-2.75" />
              {!model.isAlias && model.thinkingLabel}
            </span>
            {model.thinkingModel && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="absolute right-0 h-auto px-0 py-0 text-[10px] opacity-0 group-data-[highlighted]/item:opacity-100"
                onClick={(event) =>
                  onEditThinking(model.targetModelId ?? model.modelId, event)
                }
              >
                Edit
              </Button>
            )}
          </span>
        )}
      </span>
    </ComboboxItem>
  );
});
