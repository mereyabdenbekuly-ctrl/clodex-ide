import { describe, expect, it } from 'vitest';
import { readRunnerPairedReplayDogfoodConfig } from './dogfood-config';

describe('readRunnerPairedReplayDogfoodConfig', () => {
  it('uses conservative dogfood defaults', () => {
    expect(readRunnerPairedReplayDogfoodConfig({})).toEqual({
      sampleRate: 0.1,
      executionBudgetMs: 60_000,
      allowlistProfile: 'build-test',
    });
  });

  it('accepts bounded operator tuning values', () => {
    expect(
      readRunnerPairedReplayDogfoodConfig({
        CLODEX_RUNNER_PAIRED_REPLAY_SAMPLE_RATE: '0.25',
        CLODEX_RUNNER_PAIRED_REPLAY_BUDGET_MS: '45000',
        CLODEX_RUNNER_PAIRED_REPLAY_ALLOWLIST: 'read-only',
      }),
    ).toEqual({
      sampleRate: 0.25,
      executionBudgetMs: 45_000,
      allowlistProfile: 'read-only',
    });
  });

  it('fails closed to defaults for malformed or excessive values', () => {
    expect(
      readRunnerPairedReplayDogfoodConfig({
        CLODEX_RUNNER_PAIRED_REPLAY_SAMPLE_RATE: '2',
        CLODEX_RUNNER_PAIRED_REPLAY_BUDGET_MS: '999999',
        CLODEX_RUNNER_PAIRED_REPLAY_ALLOWLIST: 'unsafe',
      }),
    ).toEqual({
      sampleRate: 0.1,
      executionBudgetMs: 60_000,
      allowlistProfile: 'build-test',
    });
  });
});
