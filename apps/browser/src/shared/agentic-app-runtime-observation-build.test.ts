import { describe, expect, it } from 'vitest';
import {
  agenticAppRuntimeObservationGateIds,
  assertAgenticAppRuntimeObservationBuildReady,
} from './agentic-app-runtime-observation-build';

describe('Agentic App Runtime observation build', () => {
  it('accepts an instrumented prerelease build with every runtime gate on', () => {
    expect(
      assertAgenticAppRuntimeObservationBuildReady({
        releaseChannel: 'prerelease',
        appVersion: '1.16.1-alpha001',
        posthogApiKey: 'phc_test',
      }),
    ).toMatchObject({
      releaseChannel: 'prerelease',
      appVersion: '1.16.1-alpha001',
      eventName: 'agentic-app-runtime-dogfood',
      enabledGateIds: agenticAppRuntimeObservationGateIds,
    });
  });

  it('accepts the explicit technical-preview version with telemetry configured', () => {
    expect(
      assertAgenticAppRuntimeObservationBuildReady({
        releaseChannel: 'prerelease',
        appVersion: '1.16.0-preview.2',
        posthogApiKey: 'phc_test',
      }),
    ).toMatchObject({
      releaseChannel: 'prerelease',
      appVersion: '1.16.0-preview.2',
    });
  });

  it('rejects stable channels, malformed versions and missing ingestion', () => {
    expect(() =>
      assertAgenticAppRuntimeObservationBuildReady({
        releaseChannel: 'release',
        appVersion: '1.16.1',
        posthogApiKey: 'phc_test',
      }),
    ).toThrow('releaseChannel="prerelease"');
    expect(() =>
      assertAgenticAppRuntimeObservationBuildReady({
        releaseChannel: 'prerelease',
        appVersion: '1.16.1-alpha1',
        posthogApiKey: 'phc_test',
      }),
    ).toThrow('alphaNNN, betaNNN, or the explicit preview.N');
    expect(() =>
      assertAgenticAppRuntimeObservationBuildReady({
        releaseChannel: 'prerelease',
        appVersion: '1.16.1-rc.1',
        posthogApiKey: 'phc_test',
      }),
    ).toThrow('alphaNNN, betaNNN, or the explicit preview.N');
    expect(() =>
      assertAgenticAppRuntimeObservationBuildReady({
        releaseChannel: 'prerelease',
        appVersion: '1.16.1-beta001',
        posthogApiKey: '',
      }),
    ).toThrow('POSTHOG_API_KEY');
  });
});
