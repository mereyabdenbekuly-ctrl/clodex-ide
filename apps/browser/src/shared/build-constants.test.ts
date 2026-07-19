import { describe, expect, it } from 'vitest';
import {
  resolveAppDistributionMode,
  resolveAppDistributionPolicy,
  resolveAppIdentity,
} from './local-build-identity';

describe('build constants local package identity', () => {
  it.each([
    [
      'dev',
      'clodex-dev',
      'Clodex Agentic IDE (Dev-Build)',
      'xyz.clodex.agentic-ide.dev',
    ],
    [
      'prerelease',
      'clodex-prerelease',
      'Clodex Agentic IDE (Pre-Release)',
      'xyz.clodex.agentic-ide.prerelease',
    ],
    [
      'nightly',
      'clodex-nightly',
      'Clodex Agentic IDE Nightly',
      'xyz.clodex.agentic-ide.nightly',
    ],
    ['release', 'clodex', 'Clodex Agentic IDE', 'xyz.clodex.agentic-ide'],
  ] as const)('keeps the canonical %s identity when no local build id is set', (releaseChannel, baseName, appName, bundleId) => {
    const identity = resolveAppIdentity({
      releaseChannel,
      allowUnsignedLocalBuild: false,
    });

    expect(identity).toEqual({
      localBuildId: '',
      baseName,
      appName,
      bundleId,
    });
  });

  it('derives an isolated identity for explicitly allowed local builds', () => {
    const identity = resolveAppIdentity({
      releaseChannel: 'release',
      localBuildId: 'canonical-smoke',
      allowUnsignedLocalBuild: true,
    });

    expect(identity.localBuildId).toBe('canonical-smoke');
    expect(identity.baseName).toBe('clodex-local-canonical-smoke');
    expect(identity.appName).toBe('Clodex Agentic IDE [Local canonical-smoke]');
    expect(identity.bundleId).toBe(
      'xyz.clodex.agentic-ide.local.canonical-smoke',
    );
  });

  it('derives an isolated, non-promotable identity for community artifacts', () => {
    expect(
      resolveAppIdentity({
        distributionMode: 'community-unsigned',
        releaseChannel: 'release',
        allowUnsignedLocalBuild: false,
      }),
    ).toEqual({
      localBuildId: '',
      baseName: 'clodex-community-unsigned',
      appName: 'Clodex Agentic IDE (Community Unsigned)',
      bundleId: 'xyz.clodex.agentic-ide.community-unsigned',
    });
  });

  it('derives a separate identity and profile namespace for observed community artifacts', () => {
    expect(
      resolveAppIdentity({
        distributionMode: 'community-observed',
        releaseChannel: 'release',
        allowUnsignedLocalBuild: false,
      }),
    ).toEqual({
      localBuildId: '',
      baseName: 'clodex-community-observed',
      appName: 'Clodex Agentic IDE (Community Observed)',
      bundleId: 'xyz.clodex.agentic-ide.community-observed',
    });
  });

  it('keeps community distribution orthogonal to release-channel policy', () => {
    expect(
      resolveAppDistributionPolicy({
        distributionMode: 'community-unsigned',
        releaseChannel: 'release',
      }),
    ).toEqual({
      authEnabled: false,
      autoUpdateEnabled: false,
      buildIdentifier: 'community-unsigned',
      exceptionTelemetryEnabled: false,
      managedServicesEnabled: false,
      modelTracingEnabled: false,
      registerDefaultProtocols: false,
      rendererTelemetryEnabled: false,
      telemetryEnabled: false,
      telemetryMode: 'disabled',
      telemetryPrivacyMode: true,
    });
    expect(() =>
      resolveAppDistributionPolicy({
        distributionMode: 'community-unsigned',
        releaseChannel: 'prerelease',
      }),
    ).toThrow(
      'community-unsigned distribution requires RELEASE_CHANNEL=release',
    );
  });

  it('keeps observed community builds unsigned while enabling secure account handoff and anonymous backend telemetry', () => {
    expect(
      resolveAppDistributionPolicy({
        distributionMode: 'community-observed',
        releaseChannel: 'release',
      }),
    ).toEqual({
      authEnabled: true,
      autoUpdateEnabled: false,
      buildIdentifier: 'community-observed',
      exceptionTelemetryEnabled: false,
      managedServicesEnabled: false,
      modelTracingEnabled: false,
      registerDefaultProtocols: false,
      rendererTelemetryEnabled: false,
      telemetryEnabled: true,
      telemetryMode: 'anonymous-backend-only',
      telemetryPrivacyMode: true,
    });
    expect(() =>
      resolveAppDistributionPolicy({
        distributionMode: 'community-observed',
        releaseChannel: 'nightly',
      }),
    ).toThrow(
      'community-observed distribution requires RELEASE_CHANNEL=release',
    );
  });

  it('parses only canonical distribution modes', () => {
    expect(resolveAppDistributionMode(undefined)).toBe('official');
    expect(resolveAppDistributionMode('')).toBe('official');
    expect(resolveAppDistributionMode(' official ')).toBe('official');
    expect(resolveAppDistributionMode('community-unsigned')).toBe(
      'community-unsigned',
    );
    expect(resolveAppDistributionMode('community-observed')).toBe(
      'community-observed',
    );
    expect(() => resolveAppDistributionMode('community')).toThrow(
      'Unsupported CLODEX_DISTRIBUTION_MODE: community',
    );
  });

  it('keeps managed service connectors outside community distributions', () => {
    for (const distributionMode of [
      'community-unsigned',
      'community-observed',
    ] as const) {
      expect(
        resolveAppDistributionPolicy({
          distributionMode,
          releaseChannel: 'release',
        }).managedServicesEnabled,
      ).toBe(false);
    }

    expect(
      resolveAppDistributionPolicy({
        distributionMode: 'official',
        releaseChannel: 'release',
      }).managedServicesEnabled,
    ).toBe(false);
    expect(
      resolveAppDistributionPolicy({
        distributionMode: 'official',
        managedServicesEnabled: true,
        releaseChannel: 'release',
      }).managedServicesEnabled,
    ).toBe(true);
    expect(() =>
      resolveAppDistributionPolicy({
        distributionMode: 'community-observed',
        managedServicesEnabled: true,
        releaseChannel: 'release',
      }),
    ).toThrow('community-observed distribution cannot enable managed services');
  });

  it('rejects mixing community and local unsigned identities', () => {
    expect(() =>
      resolveAppIdentity({
        distributionMode: 'community-unsigned',
        releaseChannel: 'release',
        localBuildId: 'smoke',
        allowUnsignedLocalBuild: true,
      }),
    ).toThrow(
      'community-unsigned distribution cannot use unsigned local-build overrides',
    );
    expect(() =>
      resolveAppIdentity({
        distributionMode: 'community-observed',
        releaseChannel: 'release',
        localBuildId: 'smoke',
        allowUnsignedLocalBuild: true,
      }),
    ).toThrow(
      'community-observed distribution cannot use unsigned local-build overrides',
    );
  });

  it('rejects a local build id unless unsigned local packaging is explicit', () => {
    expect(() =>
      resolveAppIdentity({
        releaseChannel: 'release',
        localBuildId: 'canonical-smoke',
        allowUnsignedLocalBuild: false,
      }),
    ).toThrow(
      'CLODEX_LOCAL_BUILD_ID requires CLODEX_ALLOW_UNSIGNED_LOCAL_BUILD=true',
    );
  });

  it.each([
    'Uppercase',
    '-leading-dash',
    'contains space',
    'x'.repeat(41),
  ])('rejects invalid local build id %s', (localBuildId) => {
    expect(() =>
      resolveAppIdentity({
        releaseChannel: 'release',
        localBuildId,
        allowUnsignedLocalBuild: true,
      }),
    ).toThrow(
      'CLODEX_LOCAL_BUILD_ID must be 1-40 lowercase letters, numbers, or hyphens',
    );
  });
});
