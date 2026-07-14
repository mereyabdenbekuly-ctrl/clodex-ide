import { toolApprovalModeSchema } from '@clodex/agent-core/types/tool-approval';
import { z } from 'zod';

export const automationExecutionTargetSchema = z.enum(['local', 'cloud']);
export type AutomationExecutionTarget = z.infer<
  typeof automationExecutionTargetSchema
>;

export const automationMissedRunPolicySchema = z.enum([
  'skip',
  'run-on-wake',
  'coalesce',
]);
export type AutomationMissedRunPolicy = z.infer<
  typeof automationMissedRunPolicySchema
>;

export const automationScheduleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('once'),
    runAt: z.string().datetime(),
  }),
  z.object({
    kind: z.literal('interval'),
    everyMs: z
      .number()
      .int()
      .min(60_000)
      .max(365 * 24 * 60 * 60 * 1_000),
    anchorAt: z.string().datetime().optional(),
  }),
  z.object({
    kind: z.literal('cron'),
    expression: z.string().trim().min(9).max(128),
    timezone: z.string().trim().min(1).max(128).default('UTC'),
  }),
]);
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;

export const automationRetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(1),
  initialBackoffMs: z
    .number()
    .int()
    .min(1_000)
    .max(60 * 60 * 1_000)
    .default(5_000),
  maxBackoffMs: z
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60 * 1_000)
    .default(5 * 60_000),
});
export type AutomationRetryPolicy = z.infer<typeof automationRetryPolicySchema>;

export const automationCapabilitySchema = z.enum([
  'workspace:read',
  'workspace:write',
  'network',
  'shell',
  'mcp',
  'desktop',
]);
export type AutomationCapability = z.infer<typeof automationCapabilitySchema>;

export const automationGrantSchema = z.object({
  capabilities: z.array(automationCapabilitySchema).max(16).default([]),
  expiresAt: z.string().datetime().nullable().default(null),
});
export type AutomationGrant = z.infer<typeof automationGrantSchema>;

const automationFieldsSchema = z.object({
  title: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(100_000),
  enabled: z.boolean().default(true),
  schedule: automationScheduleSchema,
  missedRunPolicy: automationMissedRunPolicySchema.default('run-on-wake'),
  retryPolicy: automationRetryPolicySchema.default({
    maxAttempts: 1,
    initialBackoffMs: 5_000,
    maxBackoffMs: 5 * 60_000,
  }),
  executionTarget: automationExecutionTargetSchema.default('local'),
  workspacePaths: z
    .array(z.string().trim().min(1).max(4_096))
    .max(32)
    .default([]),
  modelId: z.string().trim().min(1).max(256).nullable().default(null),
  approvalMode: toolApprovalModeSchema.default('alwaysAsk'),
  grant: automationGrantSchema.default({
    capabilities: [],
    expiresAt: null,
  }),
});

export const createAutomationInputSchema = automationFieldsSchema;
export type CreateAutomationInput = z.infer<typeof createAutomationInputSchema>;

export const updateAutomationInputSchema = automationFieldsSchema
  .partial()
  .extend({
    id: z.string().uuid(),
  });
export type UpdateAutomationInput = z.infer<typeof updateAutomationInputSchema>;

export const automationDefinitionSchema = automationFieldsSchema.extend({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  nextRunAt: z.string().datetime().nullable(),
  lastRunAt: z.string().datetime().nullable(),
});
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;

export const automationRunStatusSchema = z.enum([
  'running',
  'succeeded',
  'failed',
  'uncertain',
  'cancelled',
  'skipped',
]);
export type AutomationRunStatus = z.infer<typeof automationRunStatusSchema>;

export const automationRunSchema = z.object({
  id: z.string().uuid(),
  automationId: z.string().uuid(),
  scheduledFor: z.string().datetime(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  status: automationRunStatusSchema,
  attemptCount: z.number().int().min(0).max(10),
  agentId: z.string().nullable(),
  reason: z.string().max(1_000).nullable(),
});
export type AutomationRun = z.infer<typeof automationRunSchema>;

export const automationStoreSchema = z.object({
  version: z.literal(1),
  automations: z.array(automationDefinitionSchema).max(1_000),
  runs: z.array(automationRunSchema).max(500),
});
export type AutomationStoreData = z.infer<typeof automationStoreSchema>;

export const emptyAutomationStore: AutomationStoreData = {
  version: 1,
  automations: [],
  runs: [],
};

export interface AutomationSnapshot {
  automations: AutomationDefinition[];
  recentRuns: AutomationRun[];
  nextWakeAt: string | null;
  wakeScheduler: AutomationWakeSchedulerStatus;
}

export interface AutomationWakeSchedulerStatus {
  platform: NodeJS.Platform;
  mode: 'native' | 'resume-only' | 'unavailable';
  canWakeSystem: boolean;
  scheduledFor: string | null;
  registeredAt: string | null;
  message: string;
}

export interface AutomationOperationResult {
  ok: boolean;
  message: string;
  snapshot: AutomationSnapshot;
}
