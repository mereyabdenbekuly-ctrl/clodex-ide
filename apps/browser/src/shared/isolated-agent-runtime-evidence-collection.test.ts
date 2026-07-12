import { describe, expect, it } from 'vitest';
import {
  buildIsolatedAgentRuntimeAggregateHogQl,
  createIsolatedAgentRuntimePromotionEvidence,
  ISOLATED_AGENT_RUNTIME_AGGREGATE_COLUMNS,
  parseIsolatedAgentRuntimeAggregateResult,
} from './isolated-agent-runtime-evidence-collection';

describe('isolated agent runtime evidence collection', () => {
  it('builds a prerelease-only aggregate query without returning raw rows', () => {
    const query = buildIsolatedAgentRuntimeAggregateHogQl({
      observationStartedAt: '2026-07-01T00:00:00.000Z',
      observationEndedAt: '2026-07-05T00:00:00.000Z',
    });

    expect(query).toContain("properties.app_release_channel = 'prerelease'");
    expect(query).toContain('properties.effective_enabled = true');
    expect(query).toContain('uniqIf(');
    expect(query).toContain('countIf(');
    expect(query).not.toMatch(/\bSELECT\s+\*/i);
    expect(query).not.toMatch(/\bGROUP BY\b/i);
    expect(query).not.toMatch(/\bLIMIT\b/i);
  });

  it('parses only the expected one-row aggregate response', () => {
    const aggregates = parseIsolatedAgentRuntimeAggregateResult({
      columns: [...ISOLATED_AGENT_RUNTIME_AGGREGATE_COLUMNS],
      results: [['3', 100, 990, 5, 5, 1, 1, 0, 0, 1]],
    });

    expect(aggregates).toEqual({
      observedBuildCount: 3,
      observedInstallCount: 100,
      stepOutcomes: {
        completed: 990,
        failed: 5,
        aborted: 5,
      },
      workerLifecycle: {
        crashed: 1,
        restartSucceeded: 1,
        restartSpawnFailed: 0,
        restartBudgetExhausted: 0,
      },
      circuitBreakerOpened: 1,
    });
  });

  it('rejects extra columns that could expose raw telemetry', () => {
    expect(() =>
      parseIsolatedAgentRuntimeAggregateResult({
        columns: [...ISOLATED_AGENT_RUNTIME_AGGREGATE_COLUMNS, 'distinct_id'],
        results: [[3, 100, 990, 5, 5, 1, 1, 0, 0, 1, 'install-1']],
      }),
    ).toThrow('unexpected columns: distinct_id');
  });

  it('creates schema-validated promotion evidence', () => {
    const evidence = createIsolatedAgentRuntimePromotionEvidence({
      observationStartedAt: '2026-07-01T00:00:00.000Z',
      observationEndedAt: '2026-07-05T00:00:00.000Z',
      aggregates: {
        observedBuildCount: 3,
        observedInstallCount: 100,
        stepOutcomes: {
          completed: 990,
          failed: 5,
          aborted: 5,
        },
        workerLifecycle: {
          crashed: 1,
          restartSucceeded: 1,
          restartSpawnFailed: 0,
          restartBudgetExhausted: 0,
        },
        circuitBreakerOpened: 1,
      },
      qualityGates: {
        happySmokePassed: true,
        faultSmokePassed: true,
        contentFreeTelemetryAuditPassed: true,
        noPostDispatchReplayAuditPassed: true,
      },
    });

    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.sourceChannel).toBe('prerelease');
    expect(evidence.observedInstallCount).toBe(100);
  });

  it('rejects non-canonical or inverted observation windows', () => {
    expect(() =>
      buildIsolatedAgentRuntimeAggregateHogQl({
        observationStartedAt: '2026-07-05T00:00:00Z',
        observationEndedAt: '2026-07-01T00:00:00.000Z',
      }),
    ).toThrow('canonical ISO-8601');
    expect(() =>
      buildIsolatedAgentRuntimeAggregateHogQl({
        observationStartedAt: '2026-07-05T00:00:00.000Z',
        observationEndedAt: '2026-07-01T00:00:00.000Z',
      }),
    ).toThrow('must be after');
  });
});
