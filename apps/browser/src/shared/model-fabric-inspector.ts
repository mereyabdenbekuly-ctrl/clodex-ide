import { z } from 'zod';
import type {
  ModelBudgetEvent,
  ModelBudgetPolicy,
  ModelEndpointHealthSnapshot,
} from '@clodex/agent-core/model-fabric';
import type {
  ModelPerformanceStats,
  ModelRouteDecisionRecord,
  ModelUsageRecord,
  ModelUsageStats,
  ModelUsageTaskResetResult,
} from '@clodex/agent-core/model-usage';
export const modelBudgetPolicySchema = z.object({
  id: z.string().trim().min(1).max(256),
  scope: z.enum(['global', 'task', 'workspace', 'provider']),
  scopeRef: z.string().trim().min(1).max(4_096),
  windowMs: z
    .number()
    .int()
    .min(1)
    .max(366 * 24 * 60 * 60_000),
  limitUsd: z.number().finite().min(0).max(1_000_000),
  mode: z.enum(['soft', 'hard']),
});

export const DEFAULT_MODEL_FABRIC_BUDGET_POLICIES: ModelBudgetPolicy[] = [
  {
    id: 'task-daily-hard',
    scope: 'task',
    scopeRef: '*',
    windowMs: 24 * 60 * 60_000,
    limitUsd: 5,
    mode: 'hard',
  },
  {
    id: 'workspace-daily-soft',
    scope: 'workspace',
    scopeRef: '*',
    windowMs: 24 * 60 * 60_000,
    limitUsd: 20,
    mode: 'soft',
  },
  {
    id: 'provider-daily-hard',
    scope: 'provider',
    scopeRef: '*',
    windowMs: 24 * 60 * 60_000,
    limitUsd: 50,
    mode: 'hard',
  },
  {
    id: 'global-daily-hard',
    scope: 'global',
    scopeRef: 'global',
    windowMs: 24 * 60 * 60_000,
    limitUsd: 100,
    mode: 'hard',
  },
];

export const modelBudgetPoliciesSchema = z
  .array(modelBudgetPolicySchema)
  .max(64)
  .superRefine((policies, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < policies.length; index += 1) {
      const policy = policies[index]!;
      if (seen.has(policy.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Duplicate budget policy id: ${policy.id}`,
        });
      }
      seen.add(policy.id);
    }
  });

export const modelFabricPreferencesSchema = z
  .object({
    budgetPolicies: modelBudgetPoliciesSchema,
  })
  .default({
    budgetPolicies: DEFAULT_MODEL_FABRIC_BUDGET_POLICIES,
  })
  .catch({
    budgetPolicies: DEFAULT_MODEL_FABRIC_BUDGET_POLICIES,
  });

export const modelFabricInspectorTaskIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096);

export const modelFabricInspectorSnapshotInputSchema = z.object({
  taskId: modelFabricInspectorTaskIdSchema,
  usageLimit: z.number().int().min(1).max(500).default(100),
  routeLimit: z.number().int().min(1).max(500).default(100),
  budgetLimit: z.number().int().min(1).max(500).default(100),
});
export type ModelFabricInspectorSnapshotInput = z.input<
  typeof modelFabricInspectorSnapshotInputSchema
>;

export interface ModelFabricInspectorSnapshot {
  taskId: string;
  generatedAt: number;
  usage: {
    stats: ModelUsageStats;
    records: ModelUsageRecord[];
    modelPerformance: ModelPerformanceStats[];
  };
  routes: ModelRouteDecisionRecord[];
  budgets: ModelBudgetEvent[];
  endpoints: ModelEndpointHealthSnapshot[];
  budgetPolicyConfiguration: ModelFabricBudgetPolicyConfiguration;
}

export interface ModelFabricBudgetPolicyConfiguration {
  source: 'user' | 'managed';
  managedSource: 'environment' | 'signed-file' | 'control-plane' | null;
  cached: boolean;
  policyRevision?: number | null;
  keysetRevision?: number | null;
  signingKeyId?: string | null;
  rootsetRevision?: number | null;
  rootSigningKeyId?: string | null;
  activeRootCount?: number | null;
  revokedRootCount?: number | null;
  expiresAt?: number | null;
  locked: boolean;
  policies: ModelBudgetPolicy[];
  error: string | null;
}

export interface ModelFabricInspectorExportResult {
  canceled: boolean;
  taskId: string;
  usageRecordCount: number;
  routeDecisionCount: number;
  budgetEventCount: number;
  bounded: true;
  filePath?: string;
}

export type ModelFabricInspectorResetResult = ModelUsageTaskResetResult;
