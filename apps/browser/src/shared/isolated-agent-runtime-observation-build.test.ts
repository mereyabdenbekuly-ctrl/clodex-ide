import { describe, expect, it } from 'vitest';
import { assertIsolatedAgentRuntimeObservationBuildReady } from './isolated-agent-runtime-observation-build';

describe('isolated agent runtime observation build readiness', () => {
  it('accepts an instrumented prerelease canary build', () => {
    expect(
      assertIsolatedAgentRuntimeObservationBuildReady({
        releaseChannel: 'prerelease',
        appVersion: '1.16.1-alpha001',
        posthogApiKey: 'configured-project-token',
      }),
    ).toMatchObject({
      releaseChannel: 'prerelease',
      appVersion: '1.16.1-alpha001',
      eventNames: [
        'isolated-agent-runtime-rollout-observed',
        'agent-step-runtime-finished',
        'agent-host-process-lifecycle',
        'agent-step-runtime-circuit-breaker',
      ],
    });
  });

  it('rejects nightly and stable builds for prerelease evidence collection', () => {
    expect(() =>
      assertIsolatedAgentRuntimeObservationBuildReady({
        releaseChannel: 'nightly',
        appVersion: '1.16.1-nightly20260710c001',
        posthogApiKey: 'configured-project-token',
      }),
    ).toThrow('releaseChannel="prerelease"');
    expect(() =>
      assertIsolatedAgentRuntimeObservationBuildReady({
        releaseChannel: 'release',
        appVersion: '1.16.1',
        posthogApiKey: 'configured-project-token',
      }),
    ).toThrow('releaseChannel="prerelease"');
  });

  it('rejects legacy or malformed prerelease versions', () => {
    for (const appVersion of [
      '1.16.1-alpha.1',
      '1.16.1-alpha1',
      '1.16.1-nightly20260710c001',
      '1.16.1',
    ]) {
      expect(() =>
        assertIsolatedAgentRuntimeObservationBuildReady({
          releaseChannel: 'prerelease',
          appVersion,
          posthogApiKey: 'configured-project-token',
        }),
      ).toThrow('alphaNNN or betaNNN');
    }
  });

  it('fails closed when the PostHog ingestion key is unavailable', () => {
    expect(() =>
      assertIsolatedAgentRuntimeObservationBuildReady({
        releaseChannel: 'prerelease',
        appVersion: '1.16.1-beta001',
        posthogApiKey: '',
      }),
    ).toThrow('POSTHOG_API_KEY is required');
  });
});
