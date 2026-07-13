import type { HostPaths } from '@clodex/agent-core';
import type { AttachmentsService } from '@clodex/agent-core/attachments';
import {
  MODEL_REQUEST_PURPOSE_METADATA_KEY,
  MODEL_TASK_ROLE_METADATA_KEY,
  type DataProtection,
} from '@clodex/agent-core/host';
import type { AgentCorePersistence } from '@clodex/agent-core/persistence';
import { generateText, stepCountIs, tool } from 'ai';
import path from 'node:path';
import { readFile as readFsFile } from 'node:fs/promises';
import { z } from 'zod';
import { ModelProviderService } from '../../agents/model-provider';
import { AppMenuService } from '../../services/app-menu';
import { AssetCacheService } from '../../services/asset-cache';
import type { AuthService } from '../../services/auth';
import type { CredentialsService } from '../../services/credentials';
import { DictationService } from '../../services/dictation';
import { createEvidenceMemoryModelSummarizer } from '../../services/evidence-memory-model-summarizer';
import type { KartonService } from '../../services/karton';
import type { Logger } from '../../services/logger';
import type { PreferencesService } from '../../services/preferences';
import type { TelemetryService } from '../../services/telemetry';
import type { ToolboxService } from '../../services/toolbox';
import type { WindowLayoutService } from '../../services/window-layout';
import {
  resolveFeatureGate,
  type AppReleaseChannel,
} from '@shared/feature-gates';

export interface ModelToolboxRuntimePhaseOptions {
  logger: Logger;
  releaseChannel: AppReleaseChannel;
  uiKarton: KartonService;
  authService: AuthService;
  windowLayoutService: WindowLayoutService;
  telemetryService: TelemetryService;
  preferencesService: PreferencesService;
  credentialsService: CredentialsService;
  persistence: AgentCorePersistence;
  toolboxService: ToolboxService;
  isClodexCloudEnabled: () => boolean;
  dataProtection: DataProtection;
  hostPaths: HostPaths;
  attachments: AttachmentsService;
}

export interface ModelToolboxRuntimePhaseResult {
  modelProviderService: ModelProviderService;
  dictationService: DictationService;
  runManualGeminiDiagnostic: () => Promise<void>;
  assetCacheService: AssetCacheService;
  updateEvidenceMemorySummaryModel: () => void;
}

interface ManualGeminiDiagnosticOptions {
  logger: Logger;
  modelProviderService: ModelProviderService;
}

export function createManualGeminiDiagnostic({
  logger,
  modelProviderService,
}: ManualGeminiDiagnosticOptions): () => Promise<void> {
  return async () => {
    const modelId = process.env.CLODEX_DIAG_GEMINI_MODEL ?? 'gemini-3.5-flash';
    const traceBase = `manual-gemini-diagnostic:${crypto.randomUUID()}`;
    const truncate = (value: string, maxLength = 900) =>
      value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
    const stringifyErrorPart = (value: unknown): string => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return value.message;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };
    const getErrorSearchText = (
      error: unknown,
      seen = new WeakSet<object>(),
    ): string => {
      if (error === null || error === undefined) return '';
      if (typeof error !== 'object') return String(error);
      if (seen.has(error)) return '';
      seen.add(error);

      const record = error as Record<string, unknown>;
      const parts = [
        error instanceof Error ? error.name : undefined,
        error instanceof Error ? error.message : undefined,
        record.message,
        record.statusText,
        record.responseBody,
        record.body,
        record.data,
        record.error,
        record.errors,
        record.cause,
      ];

      return parts
        .flatMap((part) => [
          stringifyErrorPart(part),
          getErrorSearchText(part, seen),
        ])
        .filter(Boolean)
        .join('\n');
    };
    const withTimeout = async <T>(
      name: string,
      run: (abortSignal: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 45_000);
      try {
        return await run(abortController.signal);
      } catch (error) {
        if (abortController.signal.aborted) {
          throw new Error(`${name} timed out after 45s`, { cause: error });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    };
    const runCase = async <
      TResult extends {
        finishReason: string;
        text: string;
        usage: { totalTokens?: number | null };
      },
    >(
      name: string,
      run: (abortSignal: AbortSignal) => Promise<TResult>,
    ) => {
      logger.info(`[GeminiDiag] ${name}: START model=${modelId}`);
      try {
        const result = await withTimeout(name, run);
        logger.info(
          `[GeminiDiag] ${name}: PASS finishReason=${result.finishReason} totalTokens=${result.usage.totalTokens ?? 'unknown'} text="${truncate(result.text.trim(), 220)}"`,
        );
        return true;
      } catch (error) {
        logger.error(
          `[GeminiDiag] ${name}: FAIL ${truncate(getErrorSearchText(error))}`,
        );
        return false;
      }
    };

    logger.info(
      `[GeminiDiag] Starting manual Gemini route test for ${modelId}`,
    );
    try {
      const modelWithOptions =
        await modelProviderService.getModelWithOptionsAsync(
          modelId,
          traceBase,
          {
            $ai_span_name: 'manual-gemini-diagnostic',
            [MODEL_REQUEST_PURPOSE_METADATA_KEY]: 'manual-gemini-diagnostic',
            [MODEL_TASK_ROLE_METADATA_KEY]: 'analysis',
            preferred_model_id: modelId,
          },
        );
      logger.info(
        `[GeminiDiag] Model resolved providerMode=${modelWithOptions.providerMode} contextWindow=${modelWithOptions.contextWindowSize}`,
      );

      const minimalPassed = await runCase('minimal-no-tools', (abortSignal) =>
        generateText({
          model: modelWithOptions.model,
          headers: modelWithOptions.headers,
          abortSignal,
          messages: [
            {
              role: 'user',
              content: 'Reply exactly: GEMINI_OK',
            },
          ],
          temperature: 0,
          maxOutputTokens: 32,
          maxRetries: 0,
        }),
      );

      const providerOptionsPassed = await runCase(
        'provider-options-no-tools',
        (abortSignal) =>
          generateText({
            model: modelWithOptions.model,
            providerOptions: modelWithOptions.providerOptions,
            headers: modelWithOptions.headers,
            abortSignal,
            messages: [
              {
                role: 'user',
                content: 'Reply exactly: GEMINI_OPTIONS_OK',
              },
            ],
            temperature: 0,
            maxOutputTokens: 32,
            maxRetries: 0,
          }),
      );

      const toolsPassed = await runCase('required-tool-call', (abortSignal) =>
        generateText({
          model: modelWithOptions.model,
          providerOptions: modelWithOptions.providerOptions,
          headers: modelWithOptions.headers,
          abortSignal,
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
          tools: {
            echo: tool({
              description:
                'Diagnostic echo tool. Use it when the user asks for a Gemini tool-call test.',
              inputSchema: z.object({
                value: z.string(),
              }),
              execute: async ({ value }) => ({ value }),
            }),
          },
          toolChoice: 'required',
          stopWhen: stepCountIs(2),
        }),
      );

      logger.info(
        `[GeminiDiag] Summary minimal=${minimalPassed ? 'PASS' : 'FAIL'} providerOptions=${providerOptionsPassed ? 'PASS' : 'FAIL'} tools=${toolsPassed ? 'PASS' : 'FAIL'}`,
      );
    } catch (error) {
      logger.error(
        `[GeminiDiag] Setup failed: ${truncate(getErrorSearchText(error))}`,
      );
    }
  };
}

export async function runModelToolboxRuntimePhase({
  logger,
  releaseChannel,
  uiKarton,
  authService,
  windowLayoutService,
  telemetryService,
  preferencesService,
  credentialsService,
  persistence,
  toolboxService,
  isClodexCloudEnabled,
  dataProtection,
  hostPaths,
  attachments,
}: ModelToolboxRuntimePhaseOptions): Promise<ModelToolboxRuntimePhaseResult> {
  const _appMenuService = new AppMenuService(
    logger,
    authService,
    windowLayoutService,
  );

  const modelProviderService = new ModelProviderService(
    telemetryService,
    authService,
    preferencesService,
    credentialsService,
  );
  const evidenceMemoryModelSummarizer =
    createEvidenceMemoryModelSummarizer(modelProviderService);
  const updateEvidenceMemorySummaryModel = () => {
    const enabled = resolveFeatureGate(
      'evidence-memory-model-summaries',
      preferencesService.get().featureGates.overrides,
      releaseChannel,
    ).enabled;
    persistence.evidenceMemorySummaryScheduler?.setSummarizer(
      enabled ? evidenceMemoryModelSummarizer : undefined,
    );
  };
  updateEvidenceMemorySummaryModel();
  preferencesService.addListener(updateEvidenceMemorySummaryModel);
  uiKarton.registerServerProcedureHandler(
    'preferences.testProviderProfile',
    async (_callingClientId: string, profileId: string) =>
      modelProviderService.validateProviderProfile(profileId),
  );
  uiKarton.registerServerProcedureHandler(
    'preferences.listProviderProfileModels',
    async (_callingClientId: string, profileId: string) =>
      modelProviderService.listProviderProfileModels(profileId),
  );
  const dictationService = DictationService.create({
    logger,
    karton: uiKarton,
    modelProvider: modelProviderService,
    isFeatureEnabled: (feature) =>
      resolveFeatureGate(
        feature,
        preferencesService.get().featureGates.overrides,
        releaseChannel,
      ).enabled,
  });
  const runManualGeminiDiagnostic = createManualGeminiDiagnostic({
    logger,
    modelProviderService,
  });

  // Wire the model-provider into the toolbox so the shell tool can run the
  // smart-approval classifier on demand. Done here because
  // `ModelProviderService` depends on `preferencesService`, which is
  // constructed after the toolbox itself.
  toolboxService.setModelProviderService(modelProviderService);

  const assetCacheService = await AssetCacheService.create(
    () => (isClodexCloudEnabled() ? authService.accessToken : undefined),
    logger,
    {
      dataProtection,
      readFile: async (filePath) => {
        const relative = path.relative(hostPaths.agentsDir(), filePath);
        const parts = relative.split(path.sep);
        if (
          !relative.startsWith(`..${path.sep}`) &&
          parts.length === 3 &&
          parts[0] &&
          parts[1] === 'data-attachments' &&
          parts[2]
        ) {
          return attachments.read(parts[0], parts[2]);
        }
        return readFsFile(filePath);
      },
    },
  );

  return {
    modelProviderService,
    dictationService,
    runManualGeminiDiagnostic,
    assetCacheService,
    updateEvidenceMemorySummaryModel,
  };
}
