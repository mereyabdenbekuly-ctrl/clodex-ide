import { describe, expect, it } from 'vitest';
import {
  AGENTIC_APP_RUNTIME_AGGREGATE_COLUMNS,
  buildAgenticAppRuntimeAggregateHogQl,
  parseAgenticAppRuntimeAggregateResult,
} from './agentic-app-runtime-evidence-collection';

describe('Agentic App Runtime aggregate evidence collection', () => {
  it('builds an aggregate-only prerelease query', () => {
    const query = buildAgenticAppRuntimeAggregateHogQl({
      observationStartedAt: '2026-07-01T00:00:00.000Z',
      observationEndedAt: '2026-07-05T00:00:00.000Z',
    });

    expect(query).toContain("event = 'agentic-app-runtime-dogfood'");
    expect(query).toContain("properties.app_release_channel = 'prerelease'");
    expect(query).toContain('uniqIf(');
    expect(query).not.toContain('SELECT *');
    expect(query).not.toContain('properties.arguments');
    expect(query).not.toContain('properties.result');
  });

  it('strictly parses the single aggregate row', () => {
    const aggregate = parseAgenticAppRuntimeAggregateResult({
      observationStartedAt: '2026-07-01T00:00:00.000Z',
      observationEndedAt: '2026-07-05T00:00:00.000Z',
      response: {
        columns: [...AGENTIC_APP_RUNTIME_AGGREGATE_COLUMNS],
        results: [[3, 30, 35, 12, 250, 5, 4, 10, 6, 3, 1, 0, 0, 0, 0]],
      },
    });

    expect(aggregate).toMatchObject({
      observedBuildCount: 3,
      observedInstallCount: 30,
      dogfood: {
        previewSessions: 35,
        distinctGeneratedApps: 12,
        capabilityInvocations: 250,
        failures: 1,
        secretLeaks: 0,
      },
    });
  });

  it('rejects unexpected columns and non-count values', () => {
    expect(() =>
      parseAgenticAppRuntimeAggregateResult({
        observationStartedAt: '2026-07-01T00:00:00.000Z',
        observationEndedAt: '2026-07-05T00:00:00.000Z',
        response: {
          columns: [...AGENTIC_APP_RUNTIME_AGGREGATE_COLUMNS, 'prompt'],
          results: [[...Array(15).fill(0), 'private']],
        },
      }),
    ).toThrow('unexpected columns: prompt');
    expect(() =>
      parseAgenticAppRuntimeAggregateResult({
        observationStartedAt: '2026-07-01T00:00:00.000Z',
        observationEndedAt: '2026-07-05T00:00:00.000Z',
        response: {
          columns: [...AGENTIC_APP_RUNTIME_AGGREGATE_COLUMNS],
          results: [[...Array(14).fill(0), -1]],
        },
      }),
    ).toThrow('must be a non-negative safe integer');
  });
});
