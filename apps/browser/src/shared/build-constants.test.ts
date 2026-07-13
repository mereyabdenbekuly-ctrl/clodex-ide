import { describe, expect, it } from 'vitest';
import { resolveAppIdentity } from './local-build-identity';

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
