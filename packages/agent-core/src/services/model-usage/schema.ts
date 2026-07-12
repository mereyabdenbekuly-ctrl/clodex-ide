import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { metaTable } from '../../migrate-database';

export const meta = metaTable;

export const modelUsageRecords = sqliteTable('model_usage_records', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  taskIdHash: text('task_id_hash').notNull(),
  purpose: text('purpose').notNull(),
  modelId: text('model_id').notNull(),
  providerMode: text('provider_mode'),
  taskRole: text('task_role'),
  inputTokens: integer('input_tokens').notNull(),
  cachedInputTokens: integer('cached_input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  reasoningTokens: integer('reasoning_tokens').notNull(),
  totalTokens: integer('total_tokens').notNull(),
  estimatedCostUsd: real('estimated_cost_usd'),
  latencyMs: integer('latency_ms').notNull(),
  outcome: text('outcome').notNull(),
  fallbackAttempt: integer('fallback_attempt').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const modelRouteDecisions = sqliteTable('model_route_decisions', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  taskIdHash: text('task_id_hash').notNull(),
  purpose: text('purpose').notNull(),
  taskRole: text('task_role'),
  activeModelId: text('active_model_id').notNull(),
  activeEndpointId: text('active_endpoint_id'),
  proposedModelId: text('proposed_model_id'),
  proposedEndpointId: text('proposed_endpoint_id'),
  selectedModelId: text('selected_model_id').notNull(),
  selectedEndpointId: text('selected_endpoint_id'),
  activeRoutingAdmitted: integer('active_routing_admitted').notNull(),
  candidateCount: integer('candidate_count').notNull(),
  excludedCount: integer('excluded_count').notNull(),
  replaySafety: text('replay_safety').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const modelBudgetEvents = sqliteTable('model_budget_events', {
  id: text('id').primaryKey(),
  reservationId: text('reservation_id'),
  policyIdsJson: text('policy_ids_json').notNull(),
  taskId: text('task_id').notNull(),
  taskIdHash: text('task_id_hash').notNull(),
  workspaceId: text('workspace_id'),
  workspaceIdHash: text('workspace_id_hash'),
  providerId: text('provider_id').notNull(),
  amountUsd: real('amount_usd').notNull(),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at'),
});

export const modelProviderQuotaWindows = sqliteTable(
  'model_provider_quota_windows',
  {
    endpointKeyHash: text('endpoint_key_hash').primaryKey(),
    endpointKey: text('endpoint_key').notNull(),
    rateLimitedUntil: integer('rate_limited_until').notNull(),
    observedAt: integer('observed_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
);
