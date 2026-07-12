import { describe, expect, it } from 'vitest';
import {
  featureGateOverridesSchema,
  listAvailableFeatureGates,
  resolveFeatureGate,
  type AppReleaseChannel,
  type FeatureGateId,
} from './feature-gates';

describe('feature gates', () => {
  it('keeps non-dogfood Agent OS modules default-disabled on every channel', () => {
    const agentOsGates: FeatureGateId[] = [
      'chronicle-visual-memory',
      'codex-micro-controller',
      'browser-use-policy-engine',
      'desktop-automation-macos-preview',
      'agent-os-debug-inspector',
      'native-skill-install',
      'agent-hooks',
    ];
    const releaseChannels: AppReleaseChannel[] = [
      'dev',
      'prerelease',
      'nightly',
      'release',
    ];

    for (const releaseChannel of releaseChannels) {
      for (const gate of agentOsGates) {
        expect(resolveFeatureGate(gate, {}, releaseChannel)).toMatchObject({
          available: true,
          enabled: false,
          source: 'default',
        });
      }
    }
  });

  it('keeps Guardian model shadow review opt-in and unavailable in release', () => {
    for (const releaseChannel of ['dev', 'prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate('guardian-model-shadow', {}, releaseChannel),
      ).toMatchObject({ available: true, enabled: false, source: 'default' });
    }
    expect(
      resolveFeatureGate('guardian-model-shadow', {}, 'release'),
    ).toMatchObject({ available: false, enabled: false });
  });

  it('keeps model-backed Evidence Memory summaries opt-in', () => {
    for (const releaseChannel of ['dev', 'prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate(
          'evidence-memory-model-summaries',
          {},
          releaseChannel,
        ),
      ).toMatchObject({ available: true, enabled: false, source: 'default' });
    }
    expect(
      resolveFeatureGate('evidence-memory-model-summaries', {}, 'release'),
    ).toMatchObject({ available: false, enabled: false });
  });

  it('enables Remote Control v2 only on dogfood channels by default', () => {
    for (const releaseChannel of ['dev', 'prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate('remote-control-pairing', {}, releaseChannel),
      ).toMatchObject({
        available: true,
        enabled: true,
        source: 'default',
      });
    }
    expect(
      resolveFeatureGate('remote-control-pairing', {}, 'release'),
    ).toMatchObject({
      available: true,
      enabled: false,
      source: 'default',
    });
  });

  it('uses the registry default when no override exists', () => {
    const resolved = resolveFeatureGate('collaboration-presets', {}, 'release');

    expect(resolved).toMatchObject({
      available: true,
      enabled: false,
      source: 'default',
    });
  });

  it('keeps Evidence Memory injection limited to the dev canary policy', () => {
    for (const releaseChannel of ['dev', 'prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate('evidence-memory-shadow', {}, releaseChannel),
      ).toMatchObject({ available: true, enabled: true, source: 'default' });
    }
    expect(
      resolveFeatureGate('evidence-memory-prompt-injection', {}, 'dev'),
    ).toMatchObject({ available: true, enabled: true, source: 'default' });
    for (const releaseChannel of ['prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate(
          'evidence-memory-prompt-injection',
          {},
          releaseChannel,
        ),
      ).toMatchObject({ available: true, enabled: false, source: 'default' });
    }
    expect(
      resolveFeatureGate('evidence-memory-prompt-injection', {}, 'release'),
    ).toMatchObject({ available: false, enabled: false });
  });

  it('enables generated-app lifecycle events only for prerelease dogfood', () => {
    for (const releaseChannel of ['dev', 'nightly', 'release'] as const) {
      const resolved = resolveFeatureGate(
        'artifact-bridge-lifecycle-events',
        {},
        releaseChannel,
      );
      expect(resolved.enabled).toBe(false);
      if (releaseChannel === 'release') {
        expect(resolved.available).toBe(false);
      }
    }
    expect(
      resolveFeatureGate('artifact-bridge-lifecycle-events', {}, 'prerelease'),
    ).toMatchObject({
      available: true,
      enabled: true,
      source: 'default',
    });
    expect(
      resolveFeatureGate(
        'artifact-bridge-lifecycle-events',
        { 'artifact-bridge-lifecycle-events': true },
        'dev',
      ),
    ).toMatchObject({
      available: true,
      enabled: true,
      source: 'override',
    });
  });

  it('enables generated-app ephemeral grants only for prerelease dogfood', () => {
    for (const releaseChannel of ['dev', 'nightly', 'release'] as const) {
      expect(
        resolveFeatureGate(
          'artifact-bridge-ephemeral-grants',
          {},
          releaseChannel,
        ).enabled,
      ).toBe(false);
    }
    expect(
      resolveFeatureGate('artifact-bridge-ephemeral-grants', {}, 'prerelease'),
    ).toMatchObject({
      available: true,
      enabled: true,
      source: 'default',
    });
    expect(
      resolveFeatureGate(
        'artifact-bridge-ephemeral-grants',
        { 'artifact-bridge-ephemeral-grants': true },
        'dev',
      ),
    ).toMatchObject({
      available: true,
      enabled: true,
      source: 'override',
    });
  });

  it('applies an explicit user override', () => {
    const resolved = resolveFeatureGate(
      'collaboration-presets',
      { 'collaboration-presets': true },
      'release',
    );

    expect(resolved).toMatchObject({
      available: true,
      enabled: true,
      source: 'override',
    });
  });

  it('enables the isolated runtime by default through prerelease canary', () => {
    expect(
      resolveFeatureGate('isolated-agent-runtime', {}, 'dev'),
    ).toMatchObject({
      available: true,
      enabled: true,
      source: 'default',
    });
    expect(
      resolveFeatureGate('isolated-agent-runtime', {}, 'prerelease'),
    ).toMatchObject({
      available: true,
      enabled: true,
      source: 'default',
    });
    expect(
      resolveFeatureGate('isolated-agent-runtime', {}, 'nightly'),
    ).toMatchObject({
      available: true,
      enabled: true,
      source: 'default',
    });
    expect(
      resolveFeatureGate('isolated-agent-runtime', {}, 'release'),
    ).toMatchObject({
      available: true,
      enabled: false,
      source: 'default',
    });
  });

  it.each([
    'dev',
    'nightly',
    'prerelease',
  ] as const)('allows a %s user to explicitly disable the isolated runtime', (releaseChannel) => {
    expect(
      resolveFeatureGate(
        'isolated-agent-runtime',
        { 'isolated-agent-runtime': false },
        releaseChannel,
      ),
    ).toMatchObject({
      available: true,
      enabled: false,
      source: 'override',
    });
  });

  it('enables Guardian by default only on dogfood channels', () => {
    for (const releaseChannel of ['dev', 'prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate('multi-agent-guardian', {}, releaseChannel),
      ).toMatchObject({
        available: true,
        enabled: true,
        source: 'default',
      });
    }
    expect(
      resolveFeatureGate('multi-agent-guardian', {}, 'release'),
    ).toMatchObject({
      available: true,
      enabled: false,
      source: 'default',
    });
  });

  it('keeps runner abstraction on the local dev dogfood channel', () => {
    expect(resolveFeatureGate('runner-abstraction', {}, 'dev')).toMatchObject({
      available: true,
      enabled: true,
      source: 'default',
    });
    for (const releaseChannel of ['prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate('runner-abstraction', {}, releaseChannel),
      ).toMatchObject({
        available: true,
        enabled: false,
        source: 'default',
      });
    }
    expect(
      resolveFeatureGate('runner-abstraction', {}, 'release'),
    ).toMatchObject({
      available: false,
      enabled: false,
      source: 'unavailable',
    });
  });

  it('keeps SSH runner explicit and unavailable in release builds', () => {
    for (const releaseChannel of ['dev', 'prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate('ssh-runner', {}, releaseChannel),
      ).toMatchObject({
        available: true,
        enabled: false,
        source: 'default',
      });
    }
    expect(resolveFeatureGate('ssh-runner', {}, 'release')).toMatchObject({
      available: false,
      enabled: false,
      source: 'unavailable',
    });
  });

  it('keeps SSH heavyweight caching behind a separate explicit gate', () => {
    for (const releaseChannel of ['dev', 'prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate('ssh-heavyweight-cache', {}, releaseChannel),
      ).toMatchObject({
        available: true,
        enabled: false,
        source: 'default',
      });
    }
    expect(
      resolveFeatureGate('ssh-heavyweight-cache', {}, 'release'),
    ).toMatchObject({
      available: false,
      enabled: false,
      source: 'unavailable',
    });
  });

  it('keeps the SSH multiplexed protocol behind a separate explicit gate', () => {
    for (const releaseChannel of ['dev', 'prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate('ssh-multiplexed-protocol', {}, releaseChannel),
      ).toMatchObject({
        available: true,
        enabled: false,
        source: 'default',
      });
    }
    expect(
      resolveFeatureGate('ssh-multiplexed-protocol', {}, 'release'),
    ).toMatchObject({
      available: false,
      enabled: false,
      source: 'unavailable',
    });
  });

  it('keeps the SSH Artifact Manifest fast path behind a separate explicit gate', () => {
    for (const releaseChannel of ['dev', 'prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate(
          'ssh-artifact-manifest-fast-path',
          {},
          releaseChannel,
        ),
      ).toMatchObject({
        available: true,
        enabled: false,
        source: 'default',
      });
    }
    expect(
      resolveFeatureGate('ssh-artifact-manifest-fast-path', {}, 'release'),
    ).toMatchObject({
      available: false,
      enabled: false,
      source: 'unavailable',
    });
  });

  it('keeps Docker runner explicit and unavailable in release builds', () => {
    for (const releaseChannel of ['dev', 'prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate('docker-runner', {}, releaseChannel),
      ).toMatchObject({
        available: true,
        enabled: false,
        source: 'default',
      });
    }
    expect(resolveFeatureGate('docker-runner', {}, 'release')).toMatchObject({
      available: false,
      enabled: false,
      source: 'unavailable',
    });
  });

  it('keeps the egress policy engine explicit and unavailable in release', () => {
    for (const gate of [
      'egress-policy-engine',
      'egress-transparent-proxy',
      'egress-controlled-browser',
      'egress-control-center',
    ] as const) {
      for (const releaseChannel of ['dev', 'prerelease', 'nightly'] as const) {
        expect(resolveFeatureGate(gate, {}, releaseChannel)).toMatchObject({
          available: true,
          enabled: false,
          source: 'default',
        });
      }
      expect(resolveFeatureGate(gate, {}, 'release')).toMatchObject({
        available: false,
        enabled: false,
        source: 'unavailable',
      });
    }
  });

  it('enables runner shadow routing only for dev dogfood by default', () => {
    expect(
      resolveFeatureGate('runner-shadow-routing', {}, 'dev'),
    ).toMatchObject({
      available: true,
      enabled: true,
      source: 'default',
    });
    for (const releaseChannel of ['prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate('runner-shadow-routing', {}, releaseChannel),
      ).toMatchObject({
        available: true,
        enabled: false,
        source: 'default',
      });
    }
    expect(
      resolveFeatureGate('runner-shadow-routing', {}, 'release'),
    ).toMatchObject({
      available: false,
      enabled: false,
      source: 'unavailable',
    });
  });

  it('keeps guarded automatic runner routing explicit and unavailable in release', () => {
    for (const releaseChannel of ['dev', 'prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate('runner-automatic-routing', {}, releaseChannel),
      ).toMatchObject({
        available: true,
        enabled: false,
        source: 'default',
      });
    }
    expect(
      resolveFeatureGate('runner-automatic-routing', {}, 'release'),
    ).toMatchObject({
      available: false,
      enabled: false,
      source: 'unavailable',
    });
  });

  it('keeps paired replay explicit and unavailable in release', () => {
    for (const releaseChannel of ['dev', 'prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate('runner-paired-replay', {}, releaseChannel),
      ).toMatchObject({
        available: true,
        enabled: false,
        source: 'default',
      });
    }
    expect(
      resolveFeatureGate('runner-paired-replay', {}, 'release'),
    ).toMatchObject({
      available: false,
      enabled: false,
      source: 'unavailable',
    });
  });

  it('keeps BYO Runner SDK registration explicit and unavailable in release', () => {
    for (const releaseChannel of ['dev', 'prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate('byo-runner-sdk', {}, releaseChannel),
      ).toMatchObject({
        available: true,
        enabled: false,
        source: 'default',
      });
    }
    expect(resolveFeatureGate('byo-runner-sdk', {}, 'release')).toMatchObject({
      available: false,
      enabled: false,
      source: 'unavailable',
    });
  });

  it.each([
    'dev',
    'prerelease',
    'nightly',
  ] as const)('allows Guardian dogfood to be explicitly disabled on %s', (releaseChannel) => {
    expect(
      resolveFeatureGate(
        'multi-agent-guardian',
        { 'multi-agent-guardian': false },
        releaseChannel,
      ),
    ).toMatchObject({
      available: true,
      enabled: false,
      source: 'override',
    });
  });

  it('enables Plugin Marketplace only on dogfood channels by default', () => {
    for (const releaseChannel of ['dev', 'prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate('plugin-marketplace', {}, releaseChannel),
      ).toMatchObject({
        available: true,
        enabled: true,
        source: 'default',
      });
    }
    expect(
      resolveFeatureGate('plugin-marketplace', {}, 'release'),
    ).toMatchObject({
      available: true,
      enabled: false,
      source: 'default',
    });
  });

  it('enables Cloud Tasks only on dogfood channels by default', () => {
    for (const releaseChannel of ['dev', 'prerelease', 'nightly'] as const) {
      expect(
        resolveFeatureGate('cloud-tasks', {}, releaseChannel),
      ).toMatchObject({
        available: true,
        enabled: true,
        source: 'default',
      });
    }
    expect(resolveFeatureGate('cloud-tasks', {}, 'release')).toMatchObject({
      available: true,
      enabled: false,
      source: 'default',
    });
    expect(
      resolveFeatureGate('cloud-tasks', { 'cloud-tasks': false }, 'prerelease'),
    ).toMatchObject({
      available: true,
      enabled: false,
      source: 'override',
    });
  });

  it('enables the complete Agentic App Runtime only for prerelease dogfood', () => {
    for (const gate of [
      'artifact-bridge-writes',
      'artifact-bridge-runtime-quotas',
      'artifact-bridge-lifecycle-events',
      'artifact-bridge-ephemeral-grants',
      'artifact-bridge-sensitive-egress',
      'artifact-bridge-async-operations',
      'artifact-bridge-runtime-inspector',
      'generated-app-packages',
      'generated-app-package-capabilities',
    ] as const) {
      for (const releaseChannel of ['dev', 'nightly'] as const) {
        expect(resolveFeatureGate(gate, {}, releaseChannel)).toMatchObject({
          available: true,
          enabled: false,
          source: 'default',
        });
      }
      expect(resolveFeatureGate(gate, {}, 'prerelease')).toMatchObject({
        available: true,
        enabled: true,
        source: 'default',
      });
      expect(resolveFeatureGate(gate, {}, 'release')).toMatchObject({
        available: false,
        enabled: false,
        source: 'unavailable',
      });
    }
  });

  it('keeps Model Fabric accounting and shadow routing dev-only and opt-in', () => {
    for (const gate of [
      'model-fabric-usage-ledger',
      'model-fabric-shadow-routing',
      'model-fabric-active-routing',
      'model-fabric-budget-policy',
      'model-fabric-evaluation-priors',
      'model-fabric-control-plane-refresh',
      'model-fabric-inspector',
    ] as const) {
      expect(resolveFeatureGate(gate, {}, 'dev')).toMatchObject({
        available: true,
        enabled: false,
        source: 'default',
      });
      for (const releaseChannel of [
        'prerelease',
        'nightly',
        'release',
      ] as const) {
        expect(resolveFeatureGate(gate, {}, releaseChannel)).toMatchObject({
          available: false,
          enabled: false,
          source: 'unavailable',
        });
      }
    }
  });

  it('drops unknown persisted feature ids without losing valid overrides', () => {
    const parsed = featureGateOverridesSchema.parse({
      'collaboration-presets': true,
      'removed-feature': false,
    });

    expect(parsed).toEqual({ 'collaboration-presets': true });
  });

  it('lists only gates available for the release channel', () => {
    const availableGateIds = listAvailableFeatureGates('release').map(
      (gate) => gate.id,
    );

    expect(availableGateIds).toContain('collaboration-presets');
    expect(availableGateIds).toContain('mascot-overlay');
    expect(availableGateIds).toContain('memory-notes');
    expect(availableGateIds).toContain('global-dictation');
    expect(availableGateIds).toContain('realtime-dictation');
    expect(availableGateIds).toContain('desktop-automation-macos-preview');
    expect(availableGateIds).toContain('isolated-agent-runtime');
    expect(availableGateIds).toContain('multi-agent-guardian');
    expect(availableGateIds).toContain('plugin-marketplace');
    expect(availableGateIds).toContain('cloud-tasks');
    expect(availableGateIds).toContain('automations');
    expect(availableGateIds).toContain('artifact-bridge');
    expect(availableGateIds).toContain('executable-extensions');
    expect(availableGateIds).toContain('spaces');
    expect(availableGateIds).toContain('session-continuity');
  });
});
