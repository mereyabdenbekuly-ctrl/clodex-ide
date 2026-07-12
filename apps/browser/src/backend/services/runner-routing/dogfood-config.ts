import {
  runnerPairedReplayAllowlistProfiles,
  type RunnerPairedReplayAllowlistProfile,
} from '@clodex/agent-core/runner-routing';

export interface RunnerPairedReplayDogfoodConfig {
  sampleRate: number;
  executionBudgetMs: number;
  allowlistProfile: RunnerPairedReplayAllowlistProfile;
}

const DEFAULT_CONFIG: RunnerPairedReplayDogfoodConfig = Object.freeze({
  sampleRate: 0.1,
  executionBudgetMs: 60_000,
  allowlistProfile: 'build-test',
});

export function readRunnerPairedReplayDogfoodConfig(
  env: NodeJS.ProcessEnv = process.env,
): RunnerPairedReplayDogfoodConfig {
  return {
    sampleRate: readBoundedNumber(
      env.CLODEX_RUNNER_PAIRED_REPLAY_SAMPLE_RATE,
      DEFAULT_CONFIG.sampleRate,
      0,
      1,
    ),
    executionBudgetMs: Math.round(
      readBoundedNumber(
        env.CLODEX_RUNNER_PAIRED_REPLAY_BUDGET_MS,
        DEFAULT_CONFIG.executionBudgetMs,
        1_000,
        120_000,
      ),
    ),
    allowlistProfile: readAllowlistProfile(
      env.CLODEX_RUNNER_PAIRED_REPLAY_ALLOWLIST,
    ),
  };
}

function readAllowlistProfile(
  value: string | undefined,
): RunnerPairedReplayAllowlistProfile {
  const normalized = value?.trim();
  return runnerPairedReplayAllowlistProfiles.includes(
    normalized as RunnerPairedReplayAllowlistProfile,
  )
    ? (normalized as RunnerPairedReplayAllowlistProfile)
    : DEFAULT_CONFIG.allowlistProfile;
}

function readBoundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    return fallback;
  }
  return parsed;
}
