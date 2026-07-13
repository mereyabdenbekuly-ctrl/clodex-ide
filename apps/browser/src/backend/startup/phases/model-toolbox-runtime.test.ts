import type { AgentCorePersistence } from '@clodex/agent-core/persistence';
import type { AttachmentsService } from '@clodex/agent-core/attachments';
import type { HostPaths } from '@clodex/agent-core';
import type { DataProtection } from '@clodex/agent-core/host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from '../../services/auth';
import type { CredentialsService } from '../../services/credentials';
import type { KartonService } from '../../services/karton';
import type { Logger } from '../../services/logger';
import type { PreferencesService } from '../../services/preferences';
import type { TelemetryService } from '../../services/telemetry';
import type { ToolboxService } from '../../services/toolbox';
import type { WindowLayoutService } from '../../services/window-layout';

type RpcHandler = (...args: unknown[]) => unknown;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  const rpcHandlers = new Map<string, RpcHandler>();
  const evidenceMemoryModelSummarizer = vi.fn();
  const modelProviderService = {
    getModelWithOptionsAsync: vi.fn(),
    listProviderProfileModels: vi.fn(),
    validateProviderProfile: vi.fn(),
  };
  const dictationService = { service: 'dictation' };
  const assetCacheService = { service: 'asset-cache' };
  const capture = {
    assetAccessTokenProvider: undefined as
      | (() => string | undefined)
      | undefined,
    assetCreateOptions: undefined as
      | {
          dataProtection: unknown;
          readFile: (filePath: string) => Promise<Buffer>;
        }
      | undefined,
  };

  return {
    calls,
    rpcHandlers,
    featureGateOverrides: {} as Record<string, boolean>,
    evidenceMemoryModelSummarizer,
    modelProviderService,
    dictationService,
    assetCacheService,
    capture,
    AppMenuService: vi.fn(() => {
      calls.push('app-menu');
      return { service: 'app-menu' };
    }),
    ModelProviderService: vi.fn(() => {
      calls.push('model-provider');
      return modelProviderService;
    }),
    createEvidenceMemoryModelSummarizer: vi.fn(() => {
      calls.push('evidence-memory-summarizer');
      return evidenceMemoryModelSummarizer;
    }),
    dictationCreate: vi.fn(() => {
      calls.push('dictation');
      return dictationService;
    }),
    assetCacheCreate: vi.fn(
      async (
        getAccessToken: () => string | undefined,
        _logger: unknown,
        options: {
          dataProtection: unknown;
          readFile: (filePath: string) => Promise<Buffer>;
        },
      ) => {
        calls.push('asset-cache');
        capture.assetAccessTokenProvider = getAccessToken;
        capture.assetCreateOptions = options;
        return assetCacheService;
      },
    ),
    generateText: vi.fn(),
    readFsFile: vi.fn(),
    resolveFeatureGate: vi.fn(
      (feature: string, overrides: Record<string, boolean>) => ({
        enabled: overrides[feature] ?? false,
      }),
    ),
    stepCountIs: vi.fn((count: number) => ({ count })),
    tool: vi.fn((definition: unknown) => ({ definition })),
  };
});

vi.mock('ai', () => ({
  generateText: mocks.generateText,
  stepCountIs: mocks.stepCountIs,
  tool: mocks.tool,
}));

vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFsFile,
}));

vi.mock('@shared/feature-gates', () => ({
  resolveFeatureGate: mocks.resolveFeatureGate,
}));

vi.mock('../../agents/model-provider', () => ({
  ModelProviderService: mocks.ModelProviderService,
}));

vi.mock('../../services/app-menu', () => ({
  AppMenuService: mocks.AppMenuService,
}));

vi.mock('../../services/asset-cache', () => ({
  AssetCacheService: { create: mocks.assetCacheCreate },
}));

vi.mock('../../services/dictation', () => ({
  DictationService: { create: mocks.dictationCreate },
}));

vi.mock('../../services/evidence-memory-model-summarizer', () => ({
  createEvidenceMemoryModelSummarizer:
    mocks.createEvidenceMemoryModelSummarizer,
}));

import {
  runModelToolboxRuntimePhase,
  type ModelToolboxRuntimePhaseOptions,
} from './model-toolbox-runtime';

interface Harness {
  options: ModelToolboxRuntimePhaseOptions;
  logger: Logger;
  authService: AuthService;
  windowLayoutService: WindowLayoutService;
  telemetryService: TelemetryService;
  preferencesService: PreferencesService;
  credentialsService: CredentialsService;
  persistence: AgentCorePersistence;
  uiKarton: KartonService;
  toolboxService: ToolboxService;
  dataProtection: DataProtection;
  hostPaths: HostPaths;
  attachments: AttachmentsService;
  setSummarizer: ReturnType<typeof vi.fn>;
  addPreferenceListener: ReturnType<typeof vi.fn>;
  registerRpc: ReturnType<typeof vi.fn>;
  setModelProviderService: ReturnType<typeof vi.fn>;
  attachmentsRead: ReturnType<typeof vi.fn>;
  cloudEnabled: { value: boolean };
}

function createHarness(): Harness {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger;
  const authService = { accessToken: 'account-token' } as AuthService;
  const windowLayoutService = {} as WindowLayoutService;
  const telemetryService = {} as TelemetryService;
  const credentialsService = {} as CredentialsService;
  const setSummarizer = vi.fn((summarizer: unknown) => {
    mocks.calls.push(
      summarizer === undefined
        ? 'set-summarizer:disabled'
        : 'set-summarizer:enabled',
    );
  });
  const persistence = {
    evidenceMemorySummaryScheduler: { setSummarizer },
  } as unknown as AgentCorePersistence;
  const addPreferenceListener = vi.fn((listener: unknown) => {
    mocks.calls.push('add-preference-listener');
    return listener;
  });
  const preferencesService = {
    addListener: addPreferenceListener,
    get: vi.fn(() => ({
      featureGates: { overrides: mocks.featureGateOverrides },
    })),
  } as unknown as PreferencesService;
  const registerRpc = vi.fn((name: string, handler: RpcHandler) => {
    mocks.calls.push(`rpc:${name}`);
    mocks.rpcHandlers.set(name, handler);
  });
  const uiKarton = {
    registerServerProcedureHandler: registerRpc,
  } as unknown as KartonService;
  const setModelProviderService = vi.fn(() => {
    mocks.calls.push('toolbox-model-provider');
  });
  const toolboxService = {
    setModelProviderService,
  } as unknown as ToolboxService;
  const dataProtection = {
    service: 'data-protection',
  } as unknown as DataProtection;
  const hostPaths = {
    agentsDir: () => '/data/agents',
  } as unknown as HostPaths;
  const attachmentsRead = vi.fn();
  const attachments = {
    read: attachmentsRead,
  } as unknown as AttachmentsService;
  const cloudEnabled = { value: true };

  return {
    logger,
    authService,
    windowLayoutService,
    telemetryService,
    preferencesService,
    credentialsService,
    persistence,
    uiKarton,
    toolboxService,
    dataProtection,
    hostPaths,
    attachments,
    setSummarizer,
    addPreferenceListener,
    registerRpc,
    setModelProviderService,
    attachmentsRead,
    cloudEnabled,
    options: {
      logger,
      releaseChannel: 'prerelease',
      uiKarton,
      authService,
      windowLayoutService,
      telemetryService,
      preferencesService,
      credentialsService,
      persistence,
      toolboxService,
      isClodexCloudEnabled: () => cloudEnabled.value,
      dataProtection,
      hostPaths,
      attachments,
    },
  };
}

describe('runModelToolboxRuntimePhase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.rpcHandlers.clear();
    mocks.featureGateOverrides = {};
    mocks.capture.assetAccessTokenProvider = undefined;
    mocks.capture.assetCreateOptions = undefined;
    mocks.modelProviderService.getModelWithOptionsAsync.mockReset();
    mocks.modelProviderService.listProviderProfileModels.mockReset();
    mocks.modelProviderService.validateProviderProfile.mockReset();
    mocks.generateText.mockReset();
    mocks.readFsFile.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('constructs and wires the runtime in the original order and returns only consumed values', async () => {
    const harness = createHarness();

    const result = await runModelToolboxRuntimePhase(harness.options);

    expect(mocks.calls).toEqual([
      'app-menu',
      'model-provider',
      'evidence-memory-summarizer',
      'set-summarizer:disabled',
      'add-preference-listener',
      'rpc:preferences.testProviderProfile',
      'rpc:preferences.listProviderProfileModels',
      'dictation',
      'toolbox-model-provider',
      'asset-cache',
    ]);
    expect(mocks.AppMenuService).toHaveBeenCalledWith(
      harness.logger,
      harness.authService,
      harness.windowLayoutService,
    );
    expect(mocks.ModelProviderService).toHaveBeenCalledWith(
      harness.telemetryService,
      harness.authService,
      harness.preferencesService,
      harness.credentialsService,
    );
    expect(harness.setModelProviderService).toHaveBeenCalledWith(
      mocks.modelProviderService,
    );
    expect(Object.keys(result)).toEqual([
      'modelProviderService',
      'dictationService',
      'runManualGeminiDiagnostic',
      'assetCacheService',
      'updateEvidenceMemorySummaryModel',
    ]);
    expect(result).toMatchObject({
      modelProviderService: mocks.modelProviderService,
      dictationService: mocks.dictationService,
      assetCacheService: mocks.assetCacheService,
    });
    expect(result.runManualGeminiDiagnostic).toEqual(expect.any(Function));
    expect(result.updateEvidenceMemorySummaryModel).toEqual(
      expect.any(Function),
    );
  });

  it('runs model wiring synchronously before the asset-cache await', async () => {
    const harness = createHarness();
    const pendingAssetCache = deferred<typeof mocks.assetCacheService>();
    mocks.assetCacheCreate.mockImplementationOnce(
      async (getAccessToken, _logger, options) => {
        mocks.calls.push('asset-cache');
        mocks.capture.assetAccessTokenProvider = getAccessToken;
        mocks.capture.assetCreateOptions = options;
        return await pendingAssetCache.promise;
      },
    );

    let settled = false;
    const phase = runModelToolboxRuntimePhase(harness.options).then(
      (result) => {
        settled = true;
        return result;
      },
    );

    expect(mocks.calls).toEqual([
      'app-menu',
      'model-provider',
      'evidence-memory-summarizer',
      'set-summarizer:disabled',
      'add-preference-listener',
      'rpc:preferences.testProviderProfile',
      'rpc:preferences.listProviderProfileModels',
      'dictation',
      'toolbox-model-provider',
      'asset-cache',
    ]);
    expect(settled).toBe(false);

    pendingAssetCache.resolve(mocks.assetCacheService);
    await expect(phase).resolves.toMatchObject({
      assetCacheService: mocks.assetCacheService,
    });
    expect(settled).toBe(true);
  });

  it('updates the evidence-memory summarizer from the live feature gate', async () => {
    const harness = createHarness();
    mocks.featureGateOverrides = {
      'evidence-memory-model-summaries': false,
    };

    const result = await runModelToolboxRuntimePhase(harness.options);

    expect(harness.setSummarizer).toHaveBeenCalledTimes(1);
    expect(harness.setSummarizer).toHaveBeenLastCalledWith(undefined);
    expect(harness.addPreferenceListener).toHaveBeenCalledWith(
      result.updateEvidenceMemorySummaryModel,
    );
    expect(mocks.resolveFeatureGate).toHaveBeenLastCalledWith(
      'evidence-memory-model-summaries',
      mocks.featureGateOverrides,
      'prerelease',
    );

    mocks.featureGateOverrides = {
      'evidence-memory-model-summaries': true,
    };
    result.updateEvidenceMemorySummaryModel();

    expect(harness.setSummarizer).toHaveBeenCalledTimes(2);
    expect(harness.setSummarizer).toHaveBeenLastCalledWith(
      mocks.evidenceMemoryModelSummarizer,
    );
    expect(mocks.resolveFeatureGate).toHaveBeenLastCalledWith(
      'evidence-memory-model-summaries',
      mocks.featureGateOverrides,
      'prerelease',
    );
  });

  it('forwards provider-profile RPC calls and returns the provider results', async () => {
    const harness = createHarness();
    const validation = { valid: true };
    const models = [{ id: 'profile-model' }];
    mocks.modelProviderService.validateProviderProfile.mockResolvedValue(
      validation,
    );
    mocks.modelProviderService.listProviderProfileModels.mockResolvedValue(
      models,
    );

    await runModelToolboxRuntimePhase(harness.options);

    const testProfile = mocks.rpcHandlers.get(
      'preferences.testProviderProfile',
    );
    const listModels = mocks.rpcHandlers.get(
      'preferences.listProviderProfileModels',
    );
    expect(testProfile).toEqual(expect.any(Function));
    expect(listModels).toEqual(expect.any(Function));
    await expect(testProfile?.('client-a', 'profile-a')).resolves.toBe(
      validation,
    );
    await expect(listModels?.('client-b', 'profile-b')).resolves.toBe(models);
    expect(
      mocks.modelProviderService.validateProviderProfile,
    ).toHaveBeenCalledWith('profile-a');
    expect(
      mocks.modelProviderService.listProviderProfileModels,
    ).toHaveBeenCalledWith('profile-b');
  });

  it('uses protected attachment reads only for canonical agent attachment paths', async () => {
    const harness = createHarness();
    const attachment = Buffer.from('protected attachment');
    const ordinaryFile = Buffer.from('ordinary file');
    harness.attachmentsRead.mockResolvedValue(attachment);
    mocks.readFsFile.mockResolvedValue(ordinaryFile);

    await runModelToolboxRuntimePhase(harness.options);

    expect(mocks.capture.assetCreateOptions?.dataProtection).toBe(
      harness.dataProtection,
    );
    await expect(
      mocks.capture.assetCreateOptions?.readFile(
        '/data/agents/agent-a/data-attachments/blob-a',
      ),
    ).resolves.toBe(attachment);
    expect(harness.attachmentsRead).toHaveBeenCalledWith('agent-a', 'blob-a');
    expect(mocks.readFsFile).not.toHaveBeenCalled();

    await expect(
      mocks.capture.assetCreateOptions?.readFile('/data/outside/file.txt'),
    ).resolves.toBe(ordinaryFile);
    expect(mocks.readFsFile).toHaveBeenCalledWith('/data/outside/file.txt');

    expect(mocks.capture.assetAccessTokenProvider?.()).toBe('account-token');
    harness.cloudEnabled.value = false;
    expect(mocks.capture.assetAccessTokenProvider?.()).toBeUndefined();
  });

  it('preserves the manual Gemini diagnostic prompts, options, timeout, and logging', async () => {
    const harness = createHarness();
    const modelWithOptions = {
      model: { modelId: 'gemini-custom' },
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
      headers: { 'x-test': 'header' },
      providerMode: 'google',
      contextWindowSize: 123_456,
    };
    mocks.modelProviderService.getModelWithOptionsAsync.mockResolvedValue(
      modelWithOptions,
    );
    mocks.generateText
      .mockResolvedValueOnce({
        finishReason: 'stop',
        text: ' GEMINI_OK ',
        usage: { totalTokens: 3 },
      })
      .mockResolvedValueOnce({
        finishReason: 'stop',
        text: ' GEMINI_OPTIONS_OK ',
        usage: { totalTokens: 4 },
      })
      .mockResolvedValueOnce({
        finishReason: 'tool-calls',
        text: ' GEMINI_TOOL_OK ',
        usage: { totalTokens: 5 },
      });
    vi.stubEnv('CLODEX_DIAG_GEMINI_MODEL', 'gemini-custom');
    vi.stubGlobal('crypto', { randomUUID: () => 'diagnostic-id' });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const result = await runModelToolboxRuntimePhase(harness.options);
    await result.runManualGeminiDiagnostic();

    expect(
      mocks.modelProviderService.getModelWithOptionsAsync,
    ).toHaveBeenCalledWith(
      'gemini-custom',
      'manual-gemini-diagnostic:diagnostic-id',
      {
        $ai_span_name: 'manual-gemini-diagnostic',
        $model_request_purpose: 'manual-gemini-diagnostic',
        $model_task_role: 'analysis',
        preferred_model_id: 'gemini-custom',
      },
    );
    expect(mocks.generateText).toHaveBeenCalledTimes(3);
    expect(mocks.generateText.mock.calls[0]?.[0]).toMatchObject({
      model: modelWithOptions.model,
      headers: modelWithOptions.headers,
      messages: [{ role: 'user', content: 'Reply exactly: GEMINI_OK' }],
      temperature: 0,
      maxOutputTokens: 32,
      maxRetries: 0,
    });
    expect(mocks.generateText.mock.calls[0]?.[0]).not.toHaveProperty(
      'providerOptions',
    );
    expect(mocks.generateText.mock.calls[1]?.[0]).toMatchObject({
      model: modelWithOptions.model,
      providerOptions: modelWithOptions.providerOptions,
      headers: modelWithOptions.headers,
      messages: [{ role: 'user', content: 'Reply exactly: GEMINI_OPTIONS_OK' }],
      temperature: 0,
      maxOutputTokens: 32,
      maxRetries: 0,
    });
    expect(mocks.generateText.mock.calls[2]?.[0]).toMatchObject({
      model: modelWithOptions.model,
      providerOptions: modelWithOptions.providerOptions,
      headers: modelWithOptions.headers,
      messages: [
        {
          role: 'user',
          content:
            'Call the echo diagnostic tool with value "GEMINI_TOOL_OK", then reply with the returned value.',
        },
      ],
      temperature: 0,
      maxOutputTokens: 96,
      maxRetries: 0,
      toolChoice: 'required',
      stopWhen: { count: 2 },
    });
    expect(mocks.tool).toHaveBeenCalledWith(
      expect.objectContaining({
        description:
          'Diagnostic echo tool. Use it when the user asks for a Gemini tool-call test.',
        execute: expect.any(Function),
      }),
    );
    const echoDefinition = mocks.tool.mock.calls[0]?.[0] as {
      execute: (input: { value: string }) => Promise<{ value: string }>;
    };
    await expect(
      echoDefinition.execute({ value: 'GEMINI_TOOL_OK' }),
    ).resolves.toEqual({ value: 'GEMINI_TOOL_OK' });
    expect(
      setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 45_000),
    ).toHaveLength(3);
    expect(harness.logger.info).toHaveBeenCalledWith(
      '[GeminiDiag] Starting manual Gemini route test for gemini-custom',
    );
    expect(harness.logger.info).toHaveBeenCalledWith(
      '[GeminiDiag] Model resolved providerMode=google contextWindow=123456',
    );
    expect(harness.logger.info).toHaveBeenCalledWith(
      '[GeminiDiag] Summary minimal=PASS providerOptions=PASS tools=PASS',
    );
  });

  it('aborts a timed-out diagnostic case, logs it, and continues the remaining probes', async () => {
    const harness = createHarness();
    mocks.modelProviderService.getModelWithOptionsAsync.mockResolvedValue({
      model: { modelId: 'gemini-timeout' },
      providerOptions: { google: {} },
      headers: {},
      providerMode: 'google',
      contextWindowSize: 64_000,
    });
    mocks.generateText
      .mockImplementationOnce(
        ({ abortSignal }: { abortSignal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            abortSignal.addEventListener(
              'abort',
              () => reject(new Error('request aborted')),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce({
        finishReason: 'stop',
        text: 'GEMINI_OPTIONS_OK',
        usage: { totalTokens: 4 },
      })
      .mockResolvedValueOnce({
        finishReason: 'stop',
        text: 'GEMINI_TOOL_OK',
        usage: { totalTokens: 5 },
      });
    vi.stubGlobal('crypto', { randomUUID: () => 'timeout-id' });
    vi.useFakeTimers();

    const result = await runModelToolboxRuntimePhase(harness.options);
    const diagnostic = result.runManualGeminiDiagnostic();
    await vi.advanceTimersByTimeAsync(45_000);
    await diagnostic;

    expect(harness.logger.error).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[GeminiDiag\] minimal-no-tools: FAIL .*minimal-no-tools timed out after 45s/s,
      ),
    );
    expect(harness.logger.info).toHaveBeenCalledWith(
      '[GeminiDiag] Summary minimal=FAIL providerOptions=PASS tools=PASS',
    );
  });
});
