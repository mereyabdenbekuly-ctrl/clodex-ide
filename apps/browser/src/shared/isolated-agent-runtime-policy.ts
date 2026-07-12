export type IsolatedAgentRuntimeReleaseChannel =
  | 'dev'
  | 'prerelease'
  | 'nightly'
  | 'release';

export interface IsolatedAgentRuntimeRolloutPolicy {
  defaultEnabled: boolean;
  rolloutStage: 'canary' | 'next' | 'hold';
  failureThreshold: number;
  cooldownMs: number;
}

/**
 * Single rollout table for the isolated agent-step lane.
 *
 * Dev, nightly, and prerelease are default-on canary channels. Nightly and
 * prerelease keep stricter circuit breakers so regressions quarantine the
 * isolated lane faster than in local development. Stable is the next
 * promotion candidate but remains default-off until aggregate prerelease
 * evidence passes the release gate.
 */
export const ISOLATED_AGENT_RUNTIME_ROLLOUT_POLICY = {
  dev: {
    defaultEnabled: true,
    rolloutStage: 'canary',
    failureThreshold: 3,
    cooldownMs: 60_000,
  },
  nightly: {
    defaultEnabled: true,
    rolloutStage: 'canary',
    failureThreshold: 2,
    cooldownMs: 5 * 60_000,
  },
  prerelease: {
    defaultEnabled: true,
    rolloutStage: 'canary',
    failureThreshold: 2,
    cooldownMs: 10 * 60_000,
  },
  release: {
    defaultEnabled: false,
    rolloutStage: 'next',
    failureThreshold: 2,
    cooldownMs: 10 * 60_000,
  },
} as const satisfies Record<
  IsolatedAgentRuntimeReleaseChannel,
  IsolatedAgentRuntimeRolloutPolicy
>;

export const isolatedAgentRuntimeDefaultEnabledChannels = Object.entries(
  ISOLATED_AGENT_RUNTIME_ROLLOUT_POLICY,
).flatMap(([channel, policy]) =>
  policy.defaultEnabled ? [channel as IsolatedAgentRuntimeReleaseChannel] : [],
);

export const ISOLATED_AGENT_RUNTIME_DISABLE_SWITCH =
  'disable-isolated-agent-runtime';
export const ISOLATED_AGENT_RUNTIME_DISABLE_ENV =
  'CLODEX_DISABLE_ISOLATED_AGENT_RUNTIME';

export function getIsolatedAgentRuntimeRolloutPolicy(
  releaseChannel: IsolatedAgentRuntimeReleaseChannel,
): IsolatedAgentRuntimeRolloutPolicy {
  return ISOLATED_AGENT_RUNTIME_ROLLOUT_POLICY[releaseChannel];
}

export function isIsolatedAgentRuntimeDisabledByEnvironment(
  value: string | undefined,
): boolean {
  switch (value?.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      return false;
  }
}
