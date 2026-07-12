import {
  parseIsolatedAgentRuntimePromotionEvidence,
  type IsolatedAgentRuntimePromotionEvidence,
} from './isolated-agent-runtime-promotion';
import { isolatedAgentRuntimeObservationEventNames } from './agent-runtime-telemetry';

export const ISOLATED_AGENT_RUNTIME_AGGREGATE_COLUMNS = [
  'observed_build_count',
  'observed_install_count',
  'completed_count',
  'failed_count',
  'aborted_count',
  'worker_crashed_count',
  'restart_succeeded_count',
  'restart_spawn_failed_count',
  'restart_budget_exhausted_count',
  'circuit_breaker_opened_count',
] as const;

type IsolatedAgentRuntimeAggregateColumn =
  (typeof ISOLATED_AGENT_RUNTIME_AGGREGATE_COLUMNS)[number];

export interface IsolatedAgentRuntimeAggregates {
  observedBuildCount: number;
  observedInstallCount: number;
  stepOutcomes: {
    completed: number;
    failed: number;
    aborted: number;
  };
  workerLifecycle: {
    crashed: number;
    restartSucceeded: number;
    restartSpawnFailed: number;
    restartBudgetExhausted: number;
  };
  circuitBreakerOpened: number;
}

export interface PostHogHogQlResult {
  columns: unknown;
  results: unknown;
}

/**
 * Builds one aggregate-only HogQL query.
 *
 * The query never returns event rows, distinct IDs, app versions, prompts,
 * messages, tool data, trace IDs, or agent IDs. `distinct_id` and
 * `app_version` are used only inside `uniqIf` aggregate functions.
 */
export function buildIsolatedAgentRuntimeAggregateHogQl(options: {
  observationStartedAt: string;
  observationEndedAt: string;
}): string {
  const observationStartedAt = readCanonicalIsoTimestamp(
    options.observationStartedAt,
    'observationStartedAt',
  );
  const observationEndedAt = readCanonicalIsoTimestamp(
    options.observationEndedAt,
    'observationEndedAt',
  );

  if (Date.parse(observationEndedAt) <= Date.parse(observationStartedAt)) {
    throw new Error('observationEndedAt must be after observationStartedAt');
  }

  const [rolloutObserved, stepFinished, workerLifecycle, circuitBreaker] =
    isolatedAgentRuntimeObservationEventNames;

  return `
SELECT
  uniqIf(
    properties.app_version,
    event = '${rolloutObserved}'
      AND properties.effective_enabled = true
  ) AS observed_build_count,
  uniqIf(
    distinct_id,
    event = '${rolloutObserved}'
      AND properties.effective_enabled = true
  ) AS observed_install_count,
  countIf(
    event = '${stepFinished}'
      AND properties.outcome = 'completed'
  ) AS completed_count,
  countIf(
    event = '${stepFinished}'
      AND properties.outcome = 'failed'
  ) AS failed_count,
  countIf(
    event = '${stepFinished}'
      AND properties.outcome = 'aborted'
  ) AS aborted_count,
  countIf(
    event = '${workerLifecycle}'
      AND properties.phase = 'worker-crashed'
  ) AS worker_crashed_count,
  countIf(
    event = '${workerLifecycle}'
      AND properties.phase = 'restart-succeeded'
  ) AS restart_succeeded_count,
  countIf(
    event = '${workerLifecycle}'
      AND properties.phase = 'restart-spawn-failed'
  ) AS restart_spawn_failed_count,
  countIf(
    event = '${workerLifecycle}'
      AND properties.phase = 'restart-budget-exhausted'
  ) AS restart_budget_exhausted_count,
  countIf(
    event = '${circuitBreaker}'
      AND properties.state = 'open'
  ) AS circuit_breaker_opened_count
FROM events
WHERE timestamp >= parseDateTimeBestEffort('${observationStartedAt}')
  AND timestamp < parseDateTimeBestEffort('${observationEndedAt}')
  AND properties.app_release_channel = 'prerelease'
  AND event IN (
    '${rolloutObserved}',
    '${stepFinished}',
    '${workerLifecycle}',
    '${circuitBreaker}'
  )
`.trim();
}

export function parseIsolatedAgentRuntimeAggregateResult(
  value: unknown,
): IsolatedAgentRuntimeAggregates {
  const result = readRecord(value, 'PostHog response');
  const columns = readStringArray(result.columns, 'PostHog response.columns');
  const rows = readArray(result.results, 'PostHog response.results');

  if (rows.length !== 1) {
    throw new Error(
      `PostHog aggregate query must return exactly one row; received ${rows.length}`,
    );
  }

  const unexpectedColumns = columns.filter(
    (column) =>
      !ISOLATED_AGENT_RUNTIME_AGGREGATE_COLUMNS.includes(
        column as IsolatedAgentRuntimeAggregateColumn,
      ),
  );
  const missingColumns = ISOLATED_AGENT_RUNTIME_AGGREGATE_COLUMNS.filter(
    (column) => !columns.includes(column),
  );
  if (unexpectedColumns.length > 0 || missingColumns.length > 0) {
    throw new Error(
      [
        unexpectedColumns.length > 0
          ? `unexpected columns: ${unexpectedColumns.join(', ')}`
          : null,
        missingColumns.length > 0
          ? `missing columns: ${missingColumns.join(', ')}`
          : null,
      ]
        .filter(Boolean)
        .join('; '),
    );
  }

  const row = readArray(rows[0], 'PostHog response.results[0]');
  if (row.length !== columns.length) {
    throw new Error(
      `PostHog aggregate row has ${row.length} values for ${columns.length} columns`,
    );
  }

  const counts = Object.fromEntries(
    columns.map((column, index) => [
      column,
      readAggregateCount(row[index], `PostHog response.results[0].${column}`),
    ]),
  ) as Record<IsolatedAgentRuntimeAggregateColumn, number>;

  return {
    observedBuildCount: counts.observed_build_count,
    observedInstallCount: counts.observed_install_count,
    stepOutcomes: {
      completed: counts.completed_count,
      failed: counts.failed_count,
      aborted: counts.aborted_count,
    },
    workerLifecycle: {
      crashed: counts.worker_crashed_count,
      restartSucceeded: counts.restart_succeeded_count,
      restartSpawnFailed: counts.restart_spawn_failed_count,
      restartBudgetExhausted: counts.restart_budget_exhausted_count,
    },
    circuitBreakerOpened: counts.circuit_breaker_opened_count,
  };
}

export function createIsolatedAgentRuntimePromotionEvidence(options: {
  observationStartedAt: string;
  observationEndedAt: string;
  aggregates: IsolatedAgentRuntimeAggregates;
  qualityGates: IsolatedAgentRuntimePromotionEvidence['qualityGates'];
}): IsolatedAgentRuntimePromotionEvidence {
  return parseIsolatedAgentRuntimePromotionEvidence({
    schemaVersion: 1,
    sourceChannel: 'prerelease',
    observationStartedAt: options.observationStartedAt,
    observationEndedAt: options.observationEndedAt,
    ...options.aggregates,
    qualityGates: options.qualityGates,
  });
}

function readCanonicalIsoTimestamp(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a canonical ISO-8601 timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${path} must be a canonical ISO-8601 timestamp`);
  }
  return value;
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  return value;
}

function readStringArray(value: unknown, path: string): string[] {
  const array = readArray(value, path);
  if (!array.every((item) => typeof item === 'string')) {
    throw new Error(`${path} must contain only strings`);
  }
  return array as string[];
}

function readAggregateCount(value: unknown, path: string): number {
  const count =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return count;
}
