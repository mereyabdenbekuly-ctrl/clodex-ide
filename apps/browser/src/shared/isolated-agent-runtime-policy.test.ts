import { describe, expect, it } from 'vitest';
import {
  getIsolatedAgentRuntimeRolloutPolicy,
  isolatedAgentRuntimeDefaultEnabledChannels,
  isIsolatedAgentRuntimeDisabledByEnvironment,
} from './isolated-agent-runtime-policy';

describe('isolated agent runtime rollout policy', () => {
  it('enables dev, nightly, and prerelease as default-on canary channels', () => {
    expect(isolatedAgentRuntimeDefaultEnabledChannels).toEqual([
      'dev',
      'nightly',
      'prerelease',
    ]);
    expect(getIsolatedAgentRuntimeRolloutPolicy('dev')).toMatchObject({
      defaultEnabled: true,
      rolloutStage: 'canary',
    });
  });

  it('uses a more conservative circuit breaker for nightly', () => {
    expect(getIsolatedAgentRuntimeRolloutPolicy('nightly')).toEqual({
      defaultEnabled: true,
      rolloutStage: 'canary',
      failureThreshold: 2,
      cooldownMs: 5 * 60_000,
    });
  });

  it('uses the strictest canary cooldown for prerelease', () => {
    expect(getIsolatedAgentRuntimeRolloutPolicy('prerelease')).toEqual({
      defaultEnabled: true,
      rolloutStage: 'canary',
      failureThreshold: 2,
      cooldownMs: 10 * 60_000,
    });
  });

  it('arms stable release as the next default-on promotion candidate', () => {
    expect(getIsolatedAgentRuntimeRolloutPolicy('release')).toEqual({
      defaultEnabled: false,
      rolloutStage: 'next',
      failureThreshold: 2,
      cooldownMs: 10 * 60_000,
    });
  });

  it.each([
    '1',
    'true',
    'TRUE',
    'yes',
    'on',
    ' on ',
  ])('recognizes the emergency environment kill switch value %s', (value) => {
    expect(isIsolatedAgentRuntimeDisabledByEnvironment(value)).toBe(true);
  });

  it.each([
    undefined,
    '',
    '0',
    'false',
    'off',
    'disabled',
  ])('does not disable the runtime for value %s', (value) => {
    expect(isIsolatedAgentRuntimeDisabledByEnvironment(value)).toBe(false);
  });
});
