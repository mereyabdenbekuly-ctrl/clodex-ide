import { randomUUID } from 'node:crypto';
import type { ModelId } from '@shared/available-models';
import {
  guardianShadowClassificationSchema,
  type GuardianAssessmentRequest,
  type GuardianShadowClassifier,
} from '@shared/guardian';
import { generateObject } from 'ai';
import {
  deepMergeProviderOptions,
  type ModelProviderService,
} from '@/agents/model-provider';

const GUARDIAN_SHADOW_MODELS: readonly ModelId[] = [
  'gemini-3.1-flash-lite',
  'gpt-5.4-nano',
  'claude-haiku-4.5',
];
const GUARDIAN_SHADOW_TIMEOUT_MS = 4_000;

const GUARDIAN_SHADOW_SYSTEM_PROMPT = `You are a read-only security risk classifier running in shadow mode.

The input is a fixed-shape capability description produced by trusted local code. It contains no raw command, script, URL, file content, prompt, credential, or tool output.

Classify only:
- risk: low, medium, high, or critical
- narrowlyScoped: whether the action is bounded to one agent/workspace and a specific operation

Critical means credential exfiltration, unbounded destructive host action, or privileged policy bypass. Do not infer user authorization and do not issue an allow/deny decision.`;

type GuardianShadowModelProvider = Pick<
  ModelProviderService,
  'getModelWithOptionsAsync' | 'selectModelForTask'
>;

export function createGuardianModelShadowClassifier(
  modelProviderService: GuardianShadowModelProvider,
): GuardianShadowClassifier {
  return async (request) => {
    const traceId = `guardian-shadow:${randomUUID()}`;
    const routedModel = await resolveShadowModel(modelProviderService, traceId);
    const candidates = [routedModel, ...GUARDIAN_SHADOW_MODELS].filter(
      (modelId, index, values): modelId is ModelId =>
        Boolean(modelId) && values.indexOf(modelId) === index,
    );
    let lastError: unknown;
    for (const modelId of candidates) {
      try {
        const modelWithOptions =
          await modelProviderService.getModelWithOptionsAsync(
            modelId,
            traceId,
            {
              $ai_span_name: 'guardian-shadow-classification',
              $model_request_purpose: 'internal',
              $model_task_role: 'review',
              guardian_shadow: true,
            },
          );
        const abortController = new AbortController();
        const timeout = setTimeout(
          () => abortController.abort(),
          GUARDIAN_SHADOW_TIMEOUT_MS,
        );
        try {
          const { object } = await generateObject({
            model: modelWithOptions.model,
            providerOptions: deepMergeProviderOptions(
              modelWithOptions.providerOptions,
              { anthropic: { thinking: { type: 'disabled' } } },
            ),
            headers: modelWithOptions.headers,
            abortSignal: abortController.signal,
            schema: guardianShadowClassificationSchema,
            system: GUARDIAN_SHADOW_SYSTEM_PROMPT,
            prompt: renderGuardianShadowEvidence(request),
            temperature: 0,
            maxRetries: 0,
          });
          return guardianShadowClassificationSchema.parse(object);
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Guardian shadow classification failed');
  };
}

export function renderGuardianShadowEvidence(
  request: GuardianAssessmentRequest,
): string {
  return JSON.stringify({
    kind: request.kind,
    summary: request.summary,
    readOnly: request.readOnly,
    irreversible: request.irreversible,
    requiresHumanApproval: request.requiresHumanApproval === true,
    context: {
      resourceScope: request.context.resourceScope,
      targetTrust: request.context.targetTrust,
      operation: request.context.operation,
      capabilities: [...request.context.capabilities].sort(),
    },
  });
}

async function resolveShadowModel(
  modelProviderService: GuardianShadowModelProvider,
  traceId: string,
): Promise<ModelId | undefined> {
  try {
    return (await modelProviderService.selectModelForTask({
      currentModelId: 'quick',
      taskRole: 'review',
      agentType: 'guardian-shadow',
      traceId,
    })) as ModelId;
  } catch {
    return undefined;
  }
}
