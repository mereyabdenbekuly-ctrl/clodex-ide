import { agenticAppRuntimeDogfoodEventName } from './agentic-app-runtime-telemetry';
import {
  parseAgenticAppRuntimeDogfoodAggregate,
  type AgenticAppRuntimeDogfoodAggregate,
} from './agentic-app-runtime-promotion';

export const AGENTIC_APP_RUNTIME_AGGREGATE_COLUMNS = [
  'observed_build_count',
  'observed_install_count',
  'preview_session_count',
  'distinct_generated_app_count',
  'capability_invocation_count',
  'sensitive_approval_count',
  'write_approval_count',
  'async_operation_count',
  'inspector_review_count',
  'package_trust_review_count',
  'failure_count',
  'replay_violation_count',
  'isolation_violation_count',
  'secret_leak_count',
  'trust_bypass_count',
] as const;

type AggregateColumn = (typeof AGENTIC_APP_RUNTIME_AGGREGATE_COLUMNS)[number];

export function buildAgenticAppRuntimeAggregateHogQl(options: {
  observationStartedAt: string;
  observationEndedAt: string;
}): string {
  const observationStartedAt = readCanonicalTimestamp(
    options.observationStartedAt,
    'observationStartedAt',
  );
  const observationEndedAt = readCanonicalTimestamp(
    options.observationEndedAt,
    'observationEndedAt',
  );
  if (Date.parse(observationEndedAt) <= Date.parse(observationStartedAt)) {
    throw new Error('observationEndedAt must be after observationStartedAt');
  }

  return `
SELECT
  uniqIf(
    properties.app_version,
    properties.activity = 'preview-session'
      AND properties.outcome = 'started'
  ) AS observed_build_count,
  uniqIf(
    distinct_id,
    properties.activity = 'preview-session'
      AND properties.outcome = 'started'
  ) AS observed_install_count,
  countIf(
    properties.activity = 'preview-session'
      AND properties.outcome = 'started'
  ) AS preview_session_count,
  uniqIf(
    properties.app_instance_hash,
    properties.activity = 'preview-session'
      AND properties.outcome = 'started'
  ) AS distinct_generated_app_count,
  countIf(properties.activity = 'capability-invocation') AS capability_invocation_count,
  countIf(
    properties.activity = 'sensitive-approval'
      AND properties.outcome = 'success'
  ) AS sensitive_approval_count,
  countIf(
    properties.activity = 'write-approval'
      AND properties.outcome = 'success'
  ) AS write_approval_count,
  countIf(
    properties.activity = 'async-operation'
      AND properties.outcome = 'started'
  ) AS async_operation_count,
  countIf(
    properties.activity = 'runtime-inspector'
      AND properties.outcome = 'success'
  ) AS inspector_review_count,
  countIf(
    properties.activity = 'package-trust-review'
      AND properties.outcome = 'success'
  ) AS package_trust_review_count,
  countIf(properties.outcome = 'failure') AS failure_count,
  countIf(
    properties.activity = 'security-control'
      AND properties.security_control = 'session-replay'
      AND properties.outcome = 'violation'
  ) AS replay_violation_count,
  countIf(
    properties.activity = 'security-control'
      AND properties.security_control = 'principal-isolation'
      AND properties.outcome = 'violation'
  ) AS isolation_violation_count,
  countIf(
    properties.activity = 'security-control'
      AND properties.security_control = 'secret-egress'
      AND properties.outcome = 'violation'
  ) AS secret_leak_count,
  countIf(
    properties.activity = 'security-control'
      AND properties.security_control = 'package-trust'
      AND properties.outcome = 'violation'
  ) AS trust_bypass_count
FROM events
WHERE timestamp >= parseDateTimeBestEffort('${observationStartedAt}')
  AND timestamp < parseDateTimeBestEffort('${observationEndedAt}')
  AND properties.app_release_channel = 'prerelease'
  AND event = '${agenticAppRuntimeDogfoodEventName}'
`.trim();
}

export function parseAgenticAppRuntimeAggregateResult(options: {
  response: unknown;
  observationStartedAt: string;
  observationEndedAt: string;
}): AgenticAppRuntimeDogfoodAggregate {
  const result = readRecord(options.response, 'PostHog response');
  const columns = readStringArray(result.columns, 'PostHog response.columns');
  const rows = readArray(result.results, 'PostHog response.results');
  if (rows.length !== 1) {
    throw new Error(
      `PostHog aggregate query must return exactly one row; received ${rows.length}`,
    );
  }

  const unexpected = columns.filter(
    (column) =>
      !AGENTIC_APP_RUNTIME_AGGREGATE_COLUMNS.includes(
        column as AggregateColumn,
      ),
  );
  const missing = AGENTIC_APP_RUNTIME_AGGREGATE_COLUMNS.filter(
    (column) => !columns.includes(column),
  );
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      [
        unexpected.length > 0
          ? `unexpected columns: ${unexpected.join(', ')}`
          : null,
        missing.length > 0 ? `missing columns: ${missing.join(', ')}` : null,
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
      readCount(row[index], `PostHog response.results[0].${column}`),
    ]),
  ) as Record<AggregateColumn, number>;

  return parseAgenticAppRuntimeDogfoodAggregate({
    schemaVersion: 1,
    sourceChannel: 'prerelease',
    observationStartedAt: options.observationStartedAt,
    observationEndedAt: options.observationEndedAt,
    observedBuildCount: counts.observed_build_count,
    observedInstallCount: counts.observed_install_count,
    dogfood: {
      previewSessions: counts.preview_session_count,
      distinctGeneratedApps: counts.distinct_generated_app_count,
      capabilityInvocations: counts.capability_invocation_count,
      sensitiveApprovals: counts.sensitive_approval_count,
      writeApprovals: counts.write_approval_count,
      asyncOperations: counts.async_operation_count,
      inspectorReviews: counts.inspector_review_count,
      packageTrustReviews: counts.package_trust_review_count,
      failures: counts.failure_count,
      replayViolations: counts.replay_violation_count,
      isolationViolations: counts.isolation_violation_count,
      secretLeaks: counts.secret_leak_count,
      trustBypasses: counts.trust_bypass_count,
    },
  });
}

function readCanonicalTimestamp(value: unknown, path: string): string {
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
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function readStringArray(value: unknown, path: string): string[] {
  const array = readArray(value, path);
  if (!array.every((item) => typeof item === 'string')) {
    throw new Error(`${path} must contain only strings`);
  }
  return array as string[];
}

function readCount(value: unknown, path: string): number {
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
