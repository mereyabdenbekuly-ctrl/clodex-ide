import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import {
  and,
  avg,
  count,
  desc,
  eq,
  gte,
  gt,
  inArray,
  sql,
  sum,
} from 'drizzle-orm';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import {
  isDataProtectionEnvelopeString,
  type DataProtection,
} from '../../host/data-protection';
import type { Logger } from '../../host/logger';
import type {
  ModelExecutionPurpose,
  ModelReplaySafety,
  ModelTaskRole,
  ProviderMode,
} from '../../host/models';
import type { HostPaths } from '../../host/paths';
import { migrateDatabase } from '../../migrate-database';
import { mkdir } from '../../fs';
import { DisposableService } from '../shared/disposable';
import type {
  ModelBudgetEvent,
  ModelBudgetEventStatus,
} from '../model-fabric/budget';
import { registry, schemaVersion } from './migrations';
import {
  meta,
  modelBudgetEvents,
  modelProviderQuotaWindows,
  modelRouteDecisions,
  modelUsageRecords,
} from './schema';
import initSql from './schema.sql?raw';

export const modelUsageOutcomes = [
  'success',
  'provider-error',
  'rate-limited',
  'cancelled',
  'fallback',
] as const;
export type ModelUsageOutcome = (typeof modelUsageOutcomes)[number];

export interface ModelUsageRecord {
  id: string;
  taskId: string;
  purpose: ModelExecutionPurpose;
  modelId: string;
  providerMode: ProviderMode | null;
  taskRole: ModelTaskRole | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  latencyMs: number;
  outcome: ModelUsageOutcome;
  fallbackAttempt: number;
  createdAt: number;
}

export interface RecordModelUsageInput {
  id?: string;
  taskId: string;
  purpose: ModelExecutionPurpose;
  modelId: string;
  providerMode?: ProviderMode | null;
  taskRole?: ModelTaskRole | null;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number | null;
  latencyMs: number;
  outcome: ModelUsageOutcome;
  fallbackAttempt?: number;
  createdAt?: number;
}

export interface ListModelUsageInput {
  taskId: string;
  purposes?: readonly ModelExecutionPurpose[];
  outcomes?: readonly ModelUsageOutcome[];
  limit?: number;
}

export interface ModelUsageStats {
  requestCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface ModelPerformanceStats {
  modelId: string;
  requestCount: number;
  pricedRequestCount: number;
  successCount: number;
  failureCount: number;
  rateLimitedCount: number;
  cancelledCount: number;
  averageLatencyMs: number | null;
  averageEstimatedCostUsd: number | null;
}

export interface ModelUsageTaskResetResult {
  taskId: string;
  deletedUsageRecords: number;
  deletedRouteDecisions: number;
  deletedBudgetEvents: number;
}

export interface ModelProviderQuotaWindow {
  endpointKey: string;
  rateLimitedUntil: number;
  observedAt: number;
  updatedAt: number;
}

export interface RecordModelProviderQuotaWindowInput {
  endpointKey: string;
  rateLimitedUntil: number;
  observedAt?: number;
}

export interface ModelRouteDecisionRecord {
  id: string;
  taskId: string;
  purpose: ModelExecutionPurpose;
  taskRole: ModelTaskRole | null;
  activeModelId: string;
  activeEndpointId: string | null;
  proposedModelId: string | null;
  proposedEndpointId: string | null;
  selectedModelId: string;
  selectedEndpointId: string | null;
  activeRoutingAdmitted: boolean;
  candidateCount: number;
  excludedCount: number;
  replaySafety: ModelReplaySafety;
  createdAt: number;
}

export interface RecordModelRouteDecisionInput {
  id?: string;
  taskId: string;
  purpose: ModelExecutionPurpose;
  taskRole?: ModelTaskRole | null;
  activeModelId: string;
  activeEndpointId?: string | null;
  proposedModelId?: string | null;
  proposedEndpointId?: string | null;
  selectedModelId: string;
  selectedEndpointId?: string | null;
  activeRoutingAdmitted: boolean;
  candidateCount: number;
  excludedCount: number;
  replaySafety: ModelReplaySafety;
  createdAt?: number;
}

export interface ModelUsageLedgerServiceOptions {
  host: HostPaths;
  logger: Logger;
  dataProtection?: DataProtection;
  now?: () => number;
  idGenerator?: () => string;
}

type Schema = {
  modelUsageRecords: typeof modelUsageRecords;
  modelRouteDecisions: typeof modelRouteDecisions;
  modelBudgetEvents: typeof modelBudgetEvents;
  modelProviderQuotaWindows: typeof modelProviderQuotaWindows;
  meta: typeof meta;
};
type ModelUsageRow = typeof modelUsageRecords.$inferSelect;
type ModelRouteDecisionRow = typeof modelRouteDecisions.$inferSelect;
type ModelBudgetEventRow = typeof modelBudgetEvents.$inferSelect;
type ModelProviderQuotaWindowRow =
  typeof modelProviderQuotaWindows.$inferSelect;

const MAX_TASK_ID_LENGTH = 4_096;
const MAX_MODEL_ID_LENGTH = 1_024;
const MAX_LIST_LIMIT = 500;

/**
 * Content-free local ledger for model execution accounting.
 *
 * The ledger stores token counters, latency, route mode, and outcome only. It
 * never stores prompts, responses, tool inputs, or tool outputs. Task IDs are
 * protected at rest and queried through a stable SHA-256 scope hash.
 */
export class ModelUsageLedgerService extends DisposableService {
  private constructor(
    private readonly db: LibSQLDatabase<Schema>,
    private readonly dbDriver: Client,
    private readonly options: {
      logger: Logger;
      dataProtection?: DataProtection;
      now?: () => number;
      idGenerator?: () => string;
    },
  ) {
    super();
  }

  public static async create(
    options: ModelUsageLedgerServiceOptions,
  ): Promise<ModelUsageLedgerService> {
    const dbPath = path.join(options.host.dataDir(), 'model-usage.sqlite');
    await mkdir(path.dirname(dbPath), { recursive: true });
    return await ModelUsageLedgerService.createWithUrl(
      `file:${dbPath}`,
      options,
    );
  }

  public static async createWithUrl(
    url: string,
    options: Omit<ModelUsageLedgerServiceOptions, 'host'>,
  ): Promise<ModelUsageLedgerService> {
    options.logger.debug(`[ModelUsage] Opening DB at ${url}`);
    const dbDriver = createClient({ url });
    const db = drizzle(dbDriver, {
      schema: {
        modelUsageRecords,
        modelRouteDecisions,
        modelBudgetEvents,
        modelProviderQuotaWindows,
        meta,
      },
    }) as LibSQLDatabase<Schema>;
    const service = new ModelUsageLedgerService(db, dbDriver, options);
    try {
      await migrateDatabase({
        db: db as never,
        client: dbDriver,
        schemaVersion,
        initSql,
        registry,
      });
      options.logger.debug('[ModelUsage] Migrations complete');
      return service;
    } catch (error) {
      await service.teardown().catch(() => {});
      throw error;
    }
  }

  public async record(input: RecordModelUsageInput): Promise<ModelUsageRecord> {
    this.assertNotDisposed();
    const id = normalizeRequired(
      input.id ?? this.idGenerator(),
      'Usage id',
      128,
    );
    const taskId = normalizeRequired(
      input.taskId,
      'Task id',
      MAX_TASK_ID_LENGTH,
    );
    const modelId = normalizeRequired(
      input.modelId,
      'Model id',
      MAX_MODEL_ID_LENGTH,
    );
    const purpose = normalizePurpose(input.purpose);
    const providerMode =
      input.providerMode == null
        ? null
        : normalizeProviderMode(input.providerMode);
    const taskRole =
      input.taskRole == null ? null : normalizeTaskRole(input.taskRole);
    const inputTokens = normalizeCounter(
      input.inputTokens ?? 0,
      'Input tokens',
    );
    const cachedInputTokens = normalizeCounter(
      input.cachedInputTokens ?? 0,
      'Cached input tokens',
    );
    const outputTokens = normalizeCounter(
      input.outputTokens ?? 0,
      'Output tokens',
    );
    const reasoningTokens = normalizeCounter(
      input.reasoningTokens ?? 0,
      'Reasoning tokens',
    );
    const totalTokens = normalizeCounter(
      input.totalTokens ?? inputTokens + outputTokens,
      'Total tokens',
    );
    const estimatedCostUsd = normalizeCost(input.estimatedCostUsd ?? null);
    const latencyMs = normalizeCounter(input.latencyMs, 'Latency');
    const outcome = normalizeOutcome(input.outcome);
    const fallbackAttempt = normalizeCounter(
      input.fallbackAttempt ?? 0,
      'Fallback attempt',
    );
    const createdAt = normalizeTimestamp(input.createdAt ?? this.now());

    await this.db
      .insert(modelUsageRecords)
      .values({
        id,
        taskId: this.protect(taskId, fieldContext(id, 'taskId')),
        taskIdHash: hashScope(taskId),
        purpose,
        modelId,
        providerMode,
        taskRole,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningTokens,
        totalTokens,
        estimatedCostUsd,
        latencyMs,
        outcome,
        fallbackAttempt,
        createdAt,
      })
      .onConflictDoNothing({ target: modelUsageRecords.id });

    const [row] = await this.db
      .select()
      .from(modelUsageRecords)
      .where(eq(modelUsageRecords.id, id))
      .limit(1);
    if (!row) throw new Error('Model usage record was not persisted');
    return this.decode(row);
  }

  public async list(input: ListModelUsageInput): Promise<ModelUsageRecord[]> {
    this.assertNotDisposed();
    const taskId = normalizeRequired(
      input.taskId,
      'Task id',
      MAX_TASK_ID_LENGTH,
    );
    const limit = normalizeLimit(input.limit);
    const filters = [eq(modelUsageRecords.taskIdHash, hashScope(taskId))];
    if (input.purposes?.length) {
      filters.push(
        inArray(
          modelUsageRecords.purpose,
          input.purposes.map(normalizePurpose),
        ),
      );
    }
    if (input.outcomes?.length) {
      filters.push(
        inArray(
          modelUsageRecords.outcome,
          input.outcomes.map(normalizeOutcome),
        ),
      );
    }
    const rows = await this.db
      .select()
      .from(modelUsageRecords)
      .where(and(...filters))
      .orderBy(desc(modelUsageRecords.createdAt), desc(modelUsageRecords.id))
      .limit(limit);
    return rows.map((row) => this.decode(row));
  }

  public async getStats(taskIdValue: string): Promise<ModelUsageStats> {
    this.assertNotDisposed();
    const taskId = normalizeRequired(
      taskIdValue,
      'Task id',
      MAX_TASK_ID_LENGTH,
    );
    const [row] = await this.db
      .select({
        requestCount: count(),
        inputTokens: sum(modelUsageRecords.inputTokens),
        cachedInputTokens: sum(modelUsageRecords.cachedInputTokens),
        outputTokens: sum(modelUsageRecords.outputTokens),
        reasoningTokens: sum(modelUsageRecords.reasoningTokens),
        totalTokens: sum(modelUsageRecords.totalTokens),
        estimatedCostUsd: sum(modelUsageRecords.estimatedCostUsd),
      })
      .from(modelUsageRecords)
      .where(eq(modelUsageRecords.taskIdHash, hashScope(taskId)));
    return {
      requestCount: Number(row?.requestCount ?? 0),
      inputTokens: Number(row?.inputTokens ?? 0),
      cachedInputTokens: Number(row?.cachedInputTokens ?? 0),
      outputTokens: Number(row?.outputTokens ?? 0),
      reasoningTokens: Number(row?.reasoningTokens ?? 0),
      totalTokens: Number(row?.totalTokens ?? 0),
      estimatedCostUsd: Number(row?.estimatedCostUsd ?? 0),
    };
  }

  /**
   * Returns content-free historical priors for route calibration.
   *
   * Model IDs and aggregate counters are intentionally global: task scopes,
   * prompts, responses, and tool payloads are not returned.
   */
  public async getModelPerformanceStats(): Promise<ModelPerformanceStats[]> {
    this.assertNotDisposed();
    const rows = await this.db
      .select({
        modelId: modelUsageRecords.modelId,
        requestCount: count(),
        pricedRequestCount: sql<number>`sum(case when ${modelUsageRecords.estimatedCostUsd} is not null then 1 else 0 end)`,
        successCount: sql<number>`sum(case when ${modelUsageRecords.outcome} = 'success' then 1 else 0 end)`,
        failureCount: sql<number>`sum(case when ${modelUsageRecords.outcome} = 'provider-error' then 1 else 0 end)`,
        rateLimitedCount: sql<number>`sum(case when ${modelUsageRecords.outcome} = 'rate-limited' then 1 else 0 end)`,
        cancelledCount: sql<number>`sum(case when ${modelUsageRecords.outcome} = 'cancelled' then 1 else 0 end)`,
        averageLatencyMs: avg(modelUsageRecords.latencyMs),
        averageEstimatedCostUsd: avg(modelUsageRecords.estimatedCostUsd),
      })
      .from(modelUsageRecords)
      .groupBy(modelUsageRecords.modelId)
      .orderBy(desc(count()), modelUsageRecords.modelId);
    return rows.map((row) => ({
      modelId: row.modelId,
      requestCount: Number(row.requestCount ?? 0),
      pricedRequestCount: Number(row.pricedRequestCount ?? 0),
      successCount: Number(row.successCount ?? 0),
      failureCount: Number(row.failureCount ?? 0),
      rateLimitedCount: Number(row.rateLimitedCount ?? 0),
      cancelledCount: Number(row.cancelledCount ?? 0),
      averageLatencyMs:
        row.averageLatencyMs === null ? null : Number(row.averageLatencyMs),
      averageEstimatedCostUsd:
        row.averageEstimatedCostUsd === null
          ? null
          : Number(row.averageEstimatedCostUsd),
    }));
  }

  public async clearTask(
    taskIdValue: string,
  ): Promise<ModelUsageTaskResetResult> {
    this.assertNotDisposed();
    const taskId = normalizeRequired(
      taskIdValue,
      'Task id',
      MAX_TASK_ID_LENGTH,
    );
    const taskIdHash = hashScope(taskId);
    return await this.db.transaction(async (tx) => {
      const [usageRow] = await tx
        .select({ value: count() })
        .from(modelUsageRecords)
        .where(eq(modelUsageRecords.taskIdHash, taskIdHash));
      const [routeRow] = await tx
        .select({ value: count() })
        .from(modelRouteDecisions)
        .where(eq(modelRouteDecisions.taskIdHash, taskIdHash));
      const [budgetRow] = await tx
        .select({ value: count() })
        .from(modelBudgetEvents)
        .where(eq(modelBudgetEvents.taskIdHash, taskIdHash));

      await tx
        .delete(modelUsageRecords)
        .where(eq(modelUsageRecords.taskIdHash, taskIdHash));
      await tx
        .delete(modelRouteDecisions)
        .where(eq(modelRouteDecisions.taskIdHash, taskIdHash));
      await tx
        .delete(modelBudgetEvents)
        .where(eq(modelBudgetEvents.taskIdHash, taskIdHash));

      return {
        taskId,
        deletedUsageRecords: Number(usageRow?.value ?? 0),
        deletedRouteDecisions: Number(routeRow?.value ?? 0),
        deletedBudgetEvents: Number(budgetRow?.value ?? 0),
      };
    });
  }

  public async recordBudgetEvent(
    event: ModelBudgetEvent,
  ): Promise<ModelBudgetEvent> {
    this.assertNotDisposed();
    const id = normalizeRequired(event.id, 'Budget event id', 128);
    const taskId = normalizeRequired(
      event.taskId,
      'Task id',
      MAX_TASK_ID_LENGTH,
    );
    const workspaceId = normalizeOptional(
      event.workspaceId,
      'Workspace id',
      MAX_TASK_ID_LENGTH,
    );
    const providerId = normalizeRequired(
      event.providerId,
      'Provider id',
      MAX_MODEL_ID_LENGTH,
    );
    const policyIds = normalizePolicyIds(event.policyIds);
    const values = {
      id,
      reservationId: normalizeOptional(
        event.reservationId,
        'Reservation id',
        128,
      ),
      policyIdsJson: JSON.stringify(policyIds),
      taskId: this.protect(taskId, fieldContext(id, 'taskId')),
      taskIdHash: hashScope(taskId),
      workspaceId:
        workspaceId === null
          ? null
          : this.protect(workspaceId, fieldContext(id, 'workspaceId')),
      workspaceIdHash:
        workspaceId === null ? null : hashWorkspaceScope(workspaceId),
      providerId,
      amountUsd: normalizeCost(event.amountUsd) ?? 0,
      status: normalizeBudgetStatus(event.status),
      createdAt: normalizeTimestamp(event.createdAt),
      expiresAt:
        event.expiresAt === null ? null : normalizeTimestamp(event.expiresAt),
    };
    await this.db
      .insert(modelBudgetEvents)
      .values(values)
      .onConflictDoNothing({ target: modelBudgetEvents.id });
    const [row] = await this.db
      .select()
      .from(modelBudgetEvents)
      .where(eq(modelBudgetEvents.id, id))
      .limit(1);
    if (!row) throw new Error('Model budget event was not persisted');
    return this.decodeBudgetEvent(row);
  }

  public async listBudgetEvents(
    input: {
      taskId?: string;
      since?: number;
      statuses?: readonly ModelBudgetEventStatus[];
      limit?: number;
    } = {},
  ): Promise<ModelBudgetEvent[]> {
    this.assertNotDisposed();
    const filters = [];
    if (input.taskId !== undefined) {
      const taskId = normalizeRequired(
        input.taskId,
        'Task id',
        MAX_TASK_ID_LENGTH,
      );
      filters.push(eq(modelBudgetEvents.taskIdHash, hashScope(taskId)));
    }
    if (input.since !== undefined) {
      filters.push(
        gte(modelBudgetEvents.createdAt, normalizeTimestamp(input.since)),
      );
    }
    if (input.statuses?.length) {
      filters.push(
        inArray(
          modelBudgetEvents.status,
          input.statuses.map(normalizeBudgetStatus),
        ),
      );
    }
    const rows = await this.db
      .select()
      .from(modelBudgetEvents)
      .where(and(...filters))
      .orderBy(desc(modelBudgetEvents.createdAt), desc(modelBudgetEvents.id))
      .limit(normalizeBudgetLimit(input.limit));
    return rows.map((row) => this.decodeBudgetEvent(row));
  }

  public async recordProviderQuotaWindow(
    input: RecordModelProviderQuotaWindowInput,
  ): Promise<ModelProviderQuotaWindow> {
    this.assertNotDisposed();
    const endpointKey = normalizeRequired(
      input.endpointKey,
      'Endpoint key',
      MAX_MODEL_ID_LENGTH,
    );
    const endpointKeyHash = hashEndpointScope(endpointKey);
    const observedAt = normalizeTimestamp(input.observedAt ?? this.now());
    const rateLimitedUntil = normalizeTimestamp(input.rateLimitedUntil);
    if (rateLimitedUntil <= observedAt) {
      throw new Error('Provider quota deadline must be after observation time');
    }
    const updatedAt = this.now();
    await this.db
      .insert(modelProviderQuotaWindows)
      .values({
        endpointKeyHash,
        endpointKey: this.protect(
          endpointKey,
          providerQuotaFieldContext(endpointKeyHash),
        ),
        rateLimitedUntil,
        observedAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: modelProviderQuotaWindows.endpointKeyHash,
        set: {
          endpointKey: this.protect(
            endpointKey,
            providerQuotaFieldContext(endpointKeyHash),
          ),
          rateLimitedUntil,
          observedAt,
          updatedAt,
        },
      });
    const [row] = await this.db
      .select()
      .from(modelProviderQuotaWindows)
      .where(eq(modelProviderQuotaWindows.endpointKeyHash, endpointKeyHash))
      .limit(1);
    if (!row) throw new Error('Provider quota window was not persisted');
    return this.decodeProviderQuotaWindow(row);
  }

  public async clearProviderQuotaWindow(
    endpointKeyValue: string,
  ): Promise<void> {
    this.assertNotDisposed();
    const endpointKey = normalizeRequired(
      endpointKeyValue,
      'Endpoint key',
      MAX_MODEL_ID_LENGTH,
    );
    await this.db
      .delete(modelProviderQuotaWindows)
      .where(
        eq(
          modelProviderQuotaWindows.endpointKeyHash,
          hashEndpointScope(endpointKey),
        ),
      );
  }

  public async listActiveProviderQuotaWindows(
    input: { at?: number; limit?: number } = {},
  ): Promise<ModelProviderQuotaWindow[]> {
    this.assertNotDisposed();
    const at = normalizeTimestamp(input.at ?? this.now());
    const rows = await this.db
      .select()
      .from(modelProviderQuotaWindows)
      .where(gt(modelProviderQuotaWindows.rateLimitedUntil, at))
      .orderBy(
        desc(modelProviderQuotaWindows.rateLimitedUntil),
        desc(modelProviderQuotaWindows.endpointKeyHash),
      )
      .limit(normalizeLimit(input.limit));
    return rows.map((row) => this.decodeProviderQuotaWindow(row));
  }

  public async recordRouteDecision(
    input: RecordModelRouteDecisionInput,
  ): Promise<ModelRouteDecisionRecord> {
    this.assertNotDisposed();
    const id = normalizeRequired(
      input.id ?? this.idGenerator(),
      'Route decision id',
      128,
    );
    const taskId = normalizeRequired(
      input.taskId,
      'Task id',
      MAX_TASK_ID_LENGTH,
    );
    const activeModelId = normalizeRequired(
      input.activeModelId,
      'Active model id',
      MAX_MODEL_ID_LENGTH,
    );
    const values = {
      id,
      taskId: this.protect(taskId, fieldContext(id, 'taskId')),
      taskIdHash: hashScope(taskId),
      purpose: normalizePurpose(input.purpose),
      taskRole:
        input.taskRole == null ? null : normalizeTaskRole(input.taskRole),
      activeModelId,
      activeEndpointId: normalizeOptional(
        input.activeEndpointId,
        'Active endpoint id',
        MAX_MODEL_ID_LENGTH,
      ),
      proposedModelId: normalizeOptional(
        input.proposedModelId,
        'Proposed model id',
        MAX_MODEL_ID_LENGTH,
      ),
      proposedEndpointId: normalizeOptional(
        input.proposedEndpointId,
        'Proposed endpoint id',
        MAX_MODEL_ID_LENGTH,
      ),
      selectedModelId: normalizeRequired(
        input.selectedModelId,
        'Selected model id',
        MAX_MODEL_ID_LENGTH,
      ),
      selectedEndpointId: normalizeOptional(
        input.selectedEndpointId,
        'Selected endpoint id',
        MAX_MODEL_ID_LENGTH,
      ),
      activeRoutingAdmitted: input.activeRoutingAdmitted ? 1 : 0,
      candidateCount: normalizeCounter(input.candidateCount, 'Candidate count'),
      excludedCount: normalizeCounter(input.excludedCount, 'Excluded count'),
      replaySafety: normalizeReplaySafety(input.replaySafety),
      createdAt: normalizeTimestamp(input.createdAt ?? this.now()),
    };
    await this.db
      .insert(modelRouteDecisions)
      .values(values)
      .onConflictDoNothing({ target: modelRouteDecisions.id });
    const [row] = await this.db
      .select()
      .from(modelRouteDecisions)
      .where(eq(modelRouteDecisions.id, id))
      .limit(1);
    if (!row) throw new Error('Model route decision was not persisted');
    return this.decodeRouteDecision(row);
  }

  public async listRouteDecisions(input: {
    taskId: string;
    limit?: number;
  }): Promise<ModelRouteDecisionRecord[]> {
    this.assertNotDisposed();
    const taskId = normalizeRequired(
      input.taskId,
      'Task id',
      MAX_TASK_ID_LENGTH,
    );
    const rows = await this.db
      .select()
      .from(modelRouteDecisions)
      .where(eq(modelRouteDecisions.taskIdHash, hashScope(taskId)))
      .orderBy(
        desc(modelRouteDecisions.createdAt),
        desc(modelRouteDecisions.id),
      )
      .limit(normalizeLimit(input.limit));
    return rows.map((row) => this.decodeRouteDecision(row));
  }

  private decode(row: ModelUsageRow): ModelUsageRecord {
    return {
      id: row.id,
      taskId: this.unprotect(row.taskId, fieldContext(row.id, 'taskId')),
      purpose: normalizePurpose(row.purpose),
      modelId: row.modelId,
      providerMode:
        row.providerMode === null
          ? null
          : normalizeProviderMode(row.providerMode),
      taskRole: row.taskRole === null ? null : normalizeTaskRole(row.taskRole),
      inputTokens: row.inputTokens,
      cachedInputTokens: row.cachedInputTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens,
      totalTokens: row.totalTokens,
      estimatedCostUsd: row.estimatedCostUsd,
      latencyMs: row.latencyMs,
      outcome: normalizeOutcome(row.outcome),
      fallbackAttempt: row.fallbackAttempt,
      createdAt: row.createdAt,
    };
  }

  private decodeRouteDecision(
    row: ModelRouteDecisionRow,
  ): ModelRouteDecisionRecord {
    return {
      id: row.id,
      taskId: this.unprotect(row.taskId, fieldContext(row.id, 'taskId')),
      purpose: normalizePurpose(row.purpose),
      taskRole: row.taskRole === null ? null : normalizeTaskRole(row.taskRole),
      activeModelId: row.activeModelId,
      activeEndpointId: row.activeEndpointId,
      proposedModelId: row.proposedModelId,
      proposedEndpointId: row.proposedEndpointId,
      selectedModelId: row.selectedModelId,
      selectedEndpointId: row.selectedEndpointId,
      activeRoutingAdmitted: row.activeRoutingAdmitted === 1,
      candidateCount: row.candidateCount,
      excludedCount: row.excludedCount,
      replaySafety: normalizeReplaySafety(row.replaySafety),
      createdAt: row.createdAt,
    };
  }

  private decodeBudgetEvent(row: ModelBudgetEventRow): ModelBudgetEvent {
    return {
      id: row.id,
      reservationId: row.reservationId,
      policyIds: normalizePolicyIds(JSON.parse(row.policyIdsJson) as unknown),
      taskId: this.unprotect(row.taskId, fieldContext(row.id, 'taskId')),
      workspaceId:
        row.workspaceId === null
          ? null
          : this.unprotect(
              row.workspaceId,
              fieldContext(row.id, 'workspaceId'),
            ),
      providerId: row.providerId,
      amountUsd: normalizeCost(row.amountUsd) ?? 0,
      status: normalizeBudgetStatus(row.status),
      createdAt: normalizeTimestamp(row.createdAt),
      expiresAt:
        row.expiresAt === null ? null : normalizeTimestamp(row.expiresAt),
    };
  }

  private decodeProviderQuotaWindow(
    row: ModelProviderQuotaWindowRow,
  ): ModelProviderQuotaWindow {
    return {
      endpointKey: this.unprotect(
        row.endpointKey,
        providerQuotaFieldContext(row.endpointKeyHash),
      ),
      rateLimitedUntil: normalizeTimestamp(row.rateLimitedUntil),
      observedAt: normalizeTimestamp(row.observedAt),
      updatedAt: normalizeTimestamp(row.updatedAt),
    };
  }

  private protect(value: string, context: string): string {
    return this.options.dataProtection?.protectString(value, context) ?? value;
  }

  private unprotect(value: string, context: string): string {
    if (!isDataProtectionEnvelopeString(value)) return value;
    if (!this.options.dataProtection) {
      throw new Error(
        `Protected model usage requires data protection (${context})`,
      );
    }
    return this.options.dataProtection.unprotectString(value, context);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private idGenerator(): string {
    return (this.options.idGenerator ?? randomUUID)();
  }

  protected async onTeardown(): Promise<void> {
    this.dbDriver.close();
  }
}

function hashScope(taskId: string): string {
  return createHash('sha256')
    .update(`model-usage:task\0${taskId}`)
    .digest('hex');
}

function hashEndpointScope(endpointKey: string): string {
  return createHash('sha256')
    .update(`model-usage:endpoint\0${endpointKey}`)
    .digest('hex');
}

function providerQuotaFieldContext(endpointKeyHash: string): string {
  return `model-provider-quota:${endpointKeyHash}:endpointKey`;
}

function hashWorkspaceScope(workspaceId: string): string {
  return createHash('sha256')
    .update(`model-usage:workspace\0${workspaceId}`)
    .digest('hex');
}

function fieldContext(id: string, field: string): string {
  return `model-usage:${id}:${field}`;
}

function normalizeRequired(
  value: string,
  label: string,
  maximumLength: number,
): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maximumLength) {
    throw new Error(`${label} must be at most ${maximumLength} characters`);
  }
  if (normalized.includes('\0'))
    throw new Error(`${label} contains null bytes`);
  return normalized;
}

function normalizeOptional(
  value: string | null | undefined,
  label: string,
  maximumLength: number,
): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximumLength) {
    throw new Error(`${label} must be at most ${maximumLength} characters`);
  }
  if (normalized.includes('\0'))
    throw new Error(`${label} contains null bytes`);
  return normalized;
}

function normalizeCounter(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeTimestamp(value: number): number {
  return normalizeCounter(value, 'Timestamp');
}

function normalizeCost(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Estimated cost must be a non-negative finite number');
  }
  return value;
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new Error(`Usage limit must be between 1 and ${MAX_LIST_LIMIT}`);
  }
  return limit;
}

function normalizeBudgetLimit(value: number | undefined): number {
  const limit = value ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error('Budget event limit must be between 1 and 10000');
  }
  return limit;
}

function normalizePurpose(value: string): ModelExecutionPurpose {
  const purposes: readonly ModelExecutionPurpose[] = [
    'agent-step',
    'history-compression',
    'claim-extraction',
    'reranking',
    'embedding',
    'title-generation',
    'vision',
    'internal',
  ];
  if (!purposes.includes(value as ModelExecutionPurpose)) {
    throw new Error(`Unsupported model execution purpose: ${value}`);
  }
  return value as ModelExecutionPurpose;
}

function normalizeProviderMode(value: string): ProviderMode {
  if (value !== 'clodex' && value !== 'official' && value !== 'custom') {
    throw new Error(`Unsupported provider mode: ${value}`);
  }
  return value;
}

function normalizeTaskRole(value: string): ModelTaskRole {
  if (value !== 'analysis' && value !== 'coding' && value !== 'review') {
    throw new Error(`Unsupported model task role: ${value}`);
  }
  return value;
}

function normalizeReplaySafety(value: string): ModelReplaySafety {
  const values: readonly ModelReplaySafety[] = [
    'safe',
    'safe-before-first-token',
    'safe-before-output-commit',
    'safe-before-tool-dispatch',
    'never-replay',
  ];
  if (!values.includes(value as ModelReplaySafety)) {
    throw new Error(`Unsupported model replay safety: ${value}`);
  }
  return value as ModelReplaySafety;
}

function normalizeOutcome(value: string): ModelUsageOutcome {
  if (!(modelUsageOutcomes as readonly string[]).includes(value)) {
    throw new Error(`Unsupported model usage outcome: ${value}`);
  }
  return value as ModelUsageOutcome;
}

function normalizeBudgetStatus(value: string): ModelBudgetEventStatus {
  const statuses: readonly ModelBudgetEventStatus[] = [
    'reserved',
    'committed',
    'released',
    'denied',
  ];
  if (!statuses.includes(value as ModelBudgetEventStatus)) {
    throw new Error(`Unsupported model budget event status: ${value}`);
  }
  return value as ModelBudgetEventStatus;
}

function normalizePolicyIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error('Budget policy ids must be an array of at most 64 items');
  }
  return value.map((item) =>
    normalizeRequired(String(item), 'Budget policy id', 256),
  );
}
