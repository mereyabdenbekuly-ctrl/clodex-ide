import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AeadDataProtection } from '../../host/data-protection';
import type { Logger } from '../../host/logger';
import { createClient } from '@libsql/client';
import { ModelUsageLedgerService } from './index';

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const services: ModelUsageLedgerService[] = [];

async function createService(
  _suffix: string,
  options: Parameters<typeof ModelUsageLedgerService.createWithUrl>[1] = {
    logger,
  },
) {
  const service = await ModelUsageLedgerService.createWithUrl(
    await freshDbUrl(),
    options,
  );
  services.push(service);
  return service;
}

async function freshDbUrl(): Promise<string> {
  const directory = path.join(os.tmpdir(), 'model-usage-tests');
  await fs.mkdir(directory, { recursive: true });
  return `file:${path.join(directory, `${randomUUID()}.sqlite`)}`;
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.teardown()));
});

describe('ModelUsageLedgerService', () => {
  it('records, lists, filters, and aggregates content-free usage', async () => {
    let nextId = 0;
    const service = await createService('basic', {
      logger,
      now: () => 1_000 + nextId,
      idGenerator: () => `usage-${++nextId}`,
    });

    await service.record({
      taskId: 'task-a',
      purpose: 'agent-step',
      modelId: 'model-a',
      providerMode: 'official',
      taskRole: 'coding',
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningTokens: 5,
      totalTokens: 120,
      estimatedCostUsd: 0.25,
      latencyMs: 900,
      outcome: 'success',
    });
    await service.record({
      taskId: 'task-a',
      purpose: 'history-compression',
      modelId: 'model-b',
      inputTokens: 30,
      outputTokens: 10,
      latencyMs: 300,
      outcome: 'fallback',
      fallbackAttempt: 1,
    });
    await service.record({
      taskId: 'task-b',
      purpose: 'agent-step',
      modelId: 'model-c',
      latencyMs: 100,
      outcome: 'success',
    });

    const records = await service.list({ taskId: 'task-a' });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      purpose: 'history-compression',
      fallbackAttempt: 1,
    });
    await expect(
      service.list({
        taskId: 'task-a',
        purposes: ['agent-step'],
        outcomes: ['success'],
      }),
    ).resolves.toHaveLength(1);
    await expect(service.getStats('task-a')).resolves.toEqual({
      requestCount: 2,
      inputTokens: 130,
      cachedInputTokens: 40,
      outputTokens: 30,
      reasoningTokens: 5,
      totalTokens: 160,
      estimatedCostUsd: 0.25,
    });
    await expect(service.getModelPerformanceStats()).resolves.toEqual([
      {
        modelId: 'model-a',
        requestCount: 1,
        pricedRequestCount: 1,
        successCount: 1,
        failureCount: 0,
        rateLimitedCount: 0,
        cancelledCount: 0,
        averageLatencyMs: 900,
        averageEstimatedCostUsd: 0.25,
      },
      {
        modelId: 'model-b',
        requestCount: 1,
        pricedRequestCount: 0,
        successCount: 0,
        failureCount: 0,
        rateLimitedCount: 0,
        cancelledCount: 0,
        averageLatencyMs: 300,
        averageEstimatedCostUsd: null,
      },
      {
        modelId: 'model-c',
        requestCount: 1,
        pricedRequestCount: 0,
        successCount: 1,
        failureCount: 0,
        rateLimitedCount: 0,
        cancelledCount: 0,
        averageLatencyMs: 100,
        averageEstimatedCostUsd: null,
      },
    ]);
  });

  it('protects task identifiers at rest while preserving hashed lookup', async () => {
    const protection = new AeadDataProtection(Buffer.alloc(32, 7));
    const url = await freshDbUrl();
    const service = await ModelUsageLedgerService.createWithUrl(url, {
      logger,
      dataProtection: protection,
      idGenerator: () => 'usage-protected',
    });
    services.push(service);

    await service.record({
      taskId: '/private/workspace/task',
      purpose: 'agent-step',
      modelId: 'model-a',
      latencyMs: 1,
      outcome: 'success',
    });

    await expect(
      service.list({ taskId: '/private/workspace/task' }),
    ).resolves.toMatchObject([
      {
        id: 'usage-protected',
        taskId: '/private/workspace/task',
      },
    ]);
    const inspectionClient = createClient({ url });
    const result = await inspectionClient.execute(
      'SELECT task_id FROM model_usage_records',
    );
    inspectionClient.close();
    expect(String(result.rows[0]?.task_id)).not.toContain('/private/workspace');
    expect(String(result.rows[0]?.task_id)).toMatch(/^clodex-protected:v1:/);
  });

  it('validates counters and never accepts negative billing data', async () => {
    const service = await createService('validation');
    await expect(
      service.record({
        taskId: 'task-a',
        purpose: 'agent-step',
        modelId: 'model-a',
        inputTokens: -1,
        latencyMs: 1,
        outcome: 'success',
      }),
    ).rejects.toThrow('Input tokens');
    await expect(
      service.record({
        taskId: 'task-a',
        purpose: 'agent-step',
        modelId: 'model-a',
        estimatedCostUsd: Number.NaN,
        latencyMs: 1,
        outcome: 'success',
      }),
    ).rejects.toThrow('Estimated cost');
  });

  it('persists content-free shadow route decisions by protected task scope', async () => {
    const protection = new AeadDataProtection(Buffer.alloc(32, 9));
    const url = await freshDbUrl();
    const service = await ModelUsageLedgerService.createWithUrl(url, {
      logger,
      dataProtection: protection,
      idGenerator: () => 'route-1',
      now: () => 42,
    });
    services.push(service);

    await service.recordRouteDecision({
      taskId: '/private/task-a',
      purpose: 'agent-step',
      taskRole: 'coding',
      activeModelId: 'active-model',
      activeEndpointId: 'official:openai',
      proposedModelId: 'local-model',
      proposedEndpointId: 'profile:ollama',
      selectedModelId: 'local-model',
      selectedEndpointId: 'profile:ollama',
      activeRoutingAdmitted: true,
      candidateCount: 3,
      excludedCount: 1,
      replaySafety: 'safe-before-tool-dispatch',
    });

    await expect(
      service.listRouteDecisions({ taskId: '/private/task-a' }),
    ).resolves.toEqual([
      {
        id: 'route-1',
        taskId: '/private/task-a',
        purpose: 'agent-step',
        taskRole: 'coding',
        activeModelId: 'active-model',
        activeEndpointId: 'official:openai',
        proposedModelId: 'local-model',
        proposedEndpointId: 'profile:ollama',
        selectedModelId: 'local-model',
        selectedEndpointId: 'profile:ollama',
        activeRoutingAdmitted: true,
        candidateCount: 3,
        excludedCount: 1,
        replaySafety: 'safe-before-tool-dispatch',
        createdAt: 42,
      },
    ]);

    const inspectionClient = createClient({ url });
    const result = await inspectionClient.execute(
      'SELECT task_id FROM model_route_decisions',
    );
    inspectionClient.close();
    expect(String(result.rows[0]?.task_id)).toMatch(/^clodex-protected:v1:/);
    expect(String(result.rows[0]?.task_id)).not.toContain('/private/task-a');
  });

  it('persists content-free budget lifecycle events with protected scopes', async () => {
    const protection = new AeadDataProtection(Buffer.alloc(32, 11));
    const url = await freshDbUrl();
    const service = await ModelUsageLedgerService.createWithUrl(url, {
      logger,
      dataProtection: protection,
    });
    services.push(service);

    await service.recordBudgetEvent({
      id: 'budget-event-1',
      reservationId: 'reservation-1',
      policyIds: ['task-daily-hard', 'workspace-daily-soft'],
      taskId: '/private/task',
      workspaceId: '/private/workspace',
      providerId: 'openai',
      amountUsd: 0.25,
      status: 'committed',
      createdAt: 100,
      expiresAt: null,
    });

    await expect(
      service.listBudgetEvents({
        since: 50,
        statuses: ['committed'],
      }),
    ).resolves.toEqual([
      {
        id: 'budget-event-1',
        reservationId: 'reservation-1',
        policyIds: ['task-daily-hard', 'workspace-daily-soft'],
        taskId: '/private/task',
        workspaceId: '/private/workspace',
        providerId: 'openai',
        amountUsd: 0.25,
        status: 'committed',
        createdAt: 100,
        expiresAt: null,
      },
    ]);

    const inspectionClient = createClient({ url });
    const result = await inspectionClient.execute(
      'SELECT task_id, workspace_id, policy_ids_json FROM model_budget_events',
    );
    inspectionClient.close();
    expect(String(result.rows[0]?.task_id)).toMatch(/^clodex-protected:v1:/);
    expect(String(result.rows[0]?.workspace_id)).toMatch(
      /^clodex-protected:v1:/,
    );
    expect(String(result.rows[0]?.task_id)).not.toContain('/private/task');
    expect(String(result.rows[0]?.workspace_id)).not.toContain(
      '/private/workspace',
    );
    expect(String(result.rows[0]?.policy_ids_json)).not.toContain('prompt');
  });

  it('persists protected provider quota windows and clears them by hashed endpoint scope', async () => {
    const protection = new AeadDataProtection(Buffer.alloc(32, 13));
    let now = 100;
    const url = await freshDbUrl();
    const service = await ModelUsageLedgerService.createWithUrl(url, {
      logger,
      dataProtection: protection,
      now: () => now,
    });
    services.push(service);

    await expect(
      service.recordProviderQuotaWindow({
        endpointKey: 'profile:private-openai',
        rateLimitedUntil: 500,
        observedAt: 90,
      }),
    ).resolves.toEqual({
      endpointKey: 'profile:private-openai',
      rateLimitedUntil: 500,
      observedAt: 90,
      updatedAt: 100,
    });
    await expect(
      service.listActiveProviderQuotaWindows({ at: 100 }),
    ).resolves.toEqual([
      {
        endpointKey: 'profile:private-openai',
        rateLimitedUntil: 500,
        observedAt: 90,
        updatedAt: 100,
      },
    ]);

    const inspectionClient = createClient({ url });
    const result = await inspectionClient.execute(
      'SELECT endpoint_key, endpoint_key_hash FROM model_provider_quota_windows',
    );
    expect(String(result.rows[0]?.endpoint_key)).toMatch(
      /^clodex-protected:v1:/,
    );
    expect(String(result.rows[0]?.endpoint_key)).not.toContain(
      'private-openai',
    );
    expect(String(result.rows[0]?.endpoint_key_hash)).toMatch(/^[a-f0-9]{64}$/);
    inspectionClient.close();

    now = 500;
    await expect(service.listActiveProviderQuotaWindows()).resolves.toEqual([]);
    await service.clearProviderQuotaWindow('profile:private-openai');
    const verificationClient = createClient({ url });
    const cleared = await verificationClient.execute(
      'SELECT count(*) AS count FROM model_provider_quota_windows',
    );
    verificationClient.close();
    expect(Number(cleared.rows[0]?.count)).toBe(0);
  });

  it('atomically clears only the requested task across all Model Fabric ledgers', async () => {
    let id = 0;
    const service = await createService('clear-task', {
      logger,
      idGenerator: () => `record-${++id}`,
    });
    for (const taskId of ['task-a', 'task-b']) {
      await service.record({
        taskId,
        purpose: 'agent-step',
        modelId: 'model',
        latencyMs: 1,
        outcome: 'success',
      });
      await service.recordRouteDecision({
        taskId,
        purpose: 'agent-step',
        activeModelId: 'model',
        selectedModelId: 'model',
        activeRoutingAdmitted: false,
        candidateCount: 1,
        excludedCount: 0,
        replaySafety: 'safe-before-tool-dispatch',
      });
      await service.recordBudgetEvent({
        id: `budget-${taskId}`,
        reservationId: null,
        policyIds: ['task-daily-hard'],
        taskId,
        workspaceId: null,
        providerId: 'openai',
        amountUsd: 0.1,
        status: 'committed',
        createdAt: 1,
        expiresAt: null,
      });
    }

    await expect(service.clearTask('task-a')).resolves.toEqual({
      taskId: 'task-a',
      deletedUsageRecords: 1,
      deletedRouteDecisions: 1,
      deletedBudgetEvents: 1,
    });
    await expect(service.list({ taskId: 'task-a' })).resolves.toEqual([]);
    await expect(
      service.listRouteDecisions({ taskId: 'task-a' }),
    ).resolves.toEqual([]);
    await expect(
      service.listBudgetEvents({ taskId: 'task-a' }),
    ).resolves.toEqual([]);
    await expect(service.list({ taskId: 'task-b' })).resolves.toHaveLength(1);
    await expect(
      service.listRouteDecisions({ taskId: 'task-b' }),
    ).resolves.toHaveLength(1);
    await expect(
      service.listBudgetEvents({ taskId: 'task-b' }),
    ).resolves.toHaveLength(1);
  });

  it('migrates v2 route decisions to v3 with the active route as the safe default', async () => {
    const url = await freshDbUrl();
    const taskId = 'task-from-v2';
    const taskIdHash = createHash('sha256')
      .update(`model-usage:task\0${taskId}`)
      .digest('hex');
    const setupClient = createClient({ url });
    await setupClient.executeMultiple(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('version', '2');
      CREATE TABLE model_route_decisions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_id_hash TEXT NOT NULL,
        purpose TEXT NOT NULL,
        task_role TEXT,
        active_model_id TEXT NOT NULL,
        active_endpoint_id TEXT,
        proposed_model_id TEXT,
        proposed_endpoint_id TEXT,
        candidate_count INTEGER NOT NULL,
        excluded_count INTEGER NOT NULL,
        replay_safety TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO model_route_decisions (
        id,
        task_id,
        task_id_hash,
        purpose,
        task_role,
        active_model_id,
        active_endpoint_id,
        proposed_model_id,
        proposed_endpoint_id,
        candidate_count,
        excluded_count,
        replay_safety,
        created_at
      ) VALUES (
        'route-v2',
        '${taskId}',
        '${taskIdHash}',
        'agent-step',
        'coding',
        'compatibility-model',
        'official:compatibility',
        'shadow-model',
        'profile:shadow',
        2,
        0,
        'safe-before-tool-dispatch',
        77
      );
    `);
    setupClient.close();

    const service = await ModelUsageLedgerService.createWithUrl(url, {
      logger,
    });
    services.push(service);

    await expect(service.listRouteDecisions({ taskId })).resolves.toEqual([
      {
        id: 'route-v2',
        taskId,
        purpose: 'agent-step',
        taskRole: 'coding',
        activeModelId: 'compatibility-model',
        activeEndpointId: 'official:compatibility',
        proposedModelId: 'shadow-model',
        proposedEndpointId: 'profile:shadow',
        selectedModelId: 'compatibility-model',
        selectedEndpointId: null,
        activeRoutingAdmitted: false,
        candidateCount: 2,
        excludedCount: 0,
        replaySafety: 'safe-before-tool-dispatch',
        createdAt: 77,
      },
    ]);
  });

  it('migrates a v3 ledger through budget events and provider quota windows', async () => {
    const url = await freshDbUrl();
    const setupClient = createClient({ url });
    await setupClient.executeMultiple(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('version', '3');
    `);
    setupClient.close();

    const service = await ModelUsageLedgerService.createWithUrl(url, {
      logger,
    });
    services.push(service);

    await expect(
      service.recordBudgetEvent({
        id: 'migrated-budget-event',
        reservationId: null,
        policyIds: ['global-daily-hard'],
        taskId: 'task',
        workspaceId: null,
        providerId: 'openai',
        amountUsd: 0.5,
        status: 'denied',
        createdAt: 10,
        expiresAt: null,
      }),
    ).resolves.toMatchObject({
      id: 'migrated-budget-event',
      status: 'denied',
    });

    const inspectionClient = createClient({ url });
    const version = await inspectionClient.execute(
      "SELECT value FROM meta WHERE key = 'version'",
    );
    inspectionClient.close();
    expect(version.rows[0]?.value).toBe('5');
  });
});
