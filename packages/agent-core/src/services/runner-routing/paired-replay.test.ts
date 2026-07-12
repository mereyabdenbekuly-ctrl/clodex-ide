import { describe, expect, it } from 'vitest';
import {
  evaluateRunnerPairedReplayAdmission,
  resolveRunnerPairedReplayProfile,
} from './paired-replay';

const base = {
  decisionId: '00000000-0000-4000-8000-000000000001',
  operation: 'execute-command' as const,
  commandClassHash: 'a'.repeat(64),
  actualProviderKind: 'local' as const,
  recommendedProviderKind: 'docker' as const,
  rawInput: false,
  requiresNetwork: false,
  requiresInteractive: false,
  hasSessionAffinity: false,
  riskClass: 'workspace-contained' as const,
  targetNetworkAccess: 'none' as const,
};

describe('evaluateRunnerPairedReplayAdmission', () => {
  it.each([
    ['local', null, 'local-read-only'],
    ['local', 'node-copy-on-write', 'node-copy-on-write'],
    ['local', 'cargo-cache', 'cargo-cache'],
    ['local', 'go-cache', 'go-cache'],
    ['ssh', null, 'ssh-read-only'],
    ['ssh', 'node-copy-on-write', 'ssh-node-cache'],
    ['ssh', 'cargo-cache', 'ssh-cargo-cache'],
    ['ssh', 'go-cache', 'ssh-go-cache'],
    ['docker', null, 'docker-isolated'],
    ['cloud', null, null],
  ] as const)('resolves %s with %s to replay profile %s', (targetProviderKind, dependencyIsolationProfile, expected) => {
    expect(
      resolveRunnerPairedReplayProfile({
        targetProviderKind,
        dependencyIsolationProfile,
      }),
    ).toBe(expected);
  });

  it('samples deterministically and admits isolated Docker replay', () => {
    const first = evaluateRunnerPairedReplayAdmission(base, { sampleRate: 1 });
    const second = evaluateRunnerPairedReplayAdmission(base, { sampleRate: 1 });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      admitted: true,
      reasonCodes: ['admitted'],
      riskClass: 'workspace-contained',
    });
    expect(first.sampleBucket).toBeGreaterThanOrEqual(0);
    expect(first.sampleBucket).toBeLessThan(1);
  });

  it.each([
    [{ rawInput: true }, 'raw-input'],
    [{ requiresInteractive: true }, 'interactive-command'],
    [{ hasSessionAffinity: true }, 'session-affine-command'],
    [{ requiresNetwork: true }, 'network-required'],
    [{ riskClass: 'ineligible' as const }, 'command-risk-ineligible'],
    [
      { recommendedProviderKind: 'local' as const },
      'local-target-isolation-required',
    ],
    [{ recommendedProviderKind: 'cloud' as const }, 'cloud-target-unsupported'],
  ])('rejects unsafe replay input %#', (override, reason) => {
    const result = evaluateRunnerPairedReplayAdmission(
      { ...base, ...override },
      { sampleRate: 1 },
    );
    expect(result.admitted).toBe(false);
    expect(result.reasonCodes).toContain(reason);
  });

  it('allows read-only and dependency-isolated heavyweight commands on SSH', () => {
    const rejected = evaluateRunnerPairedReplayAdmission(
      {
        ...base,
        recommendedProviderKind: 'ssh',
        targetNetworkAccess: 'host',
      },
      { sampleRate: 1 },
    );
    const admitted = evaluateRunnerPairedReplayAdmission(
      {
        ...base,
        recommendedProviderKind: 'ssh',
        targetNetworkAccess: 'host',
        riskClass: 'read-only',
      },
      { sampleRate: 1 },
    );
    const heavyweight = evaluateRunnerPairedReplayAdmission(
      {
        ...base,
        recommendedProviderKind: 'ssh',
        targetNetworkAccess: 'host',
        targetIsolation: 'remote-workspace',
        targetDependencyIsolation: 'isolated-cache',
      },
      { sampleRate: 1 },
    );

    expect(rejected.reasonCodes).toContain('ssh-read-only-required');
    expect(admitted.admitted).toBe(true);
    expect(heavyweight.admitted).toBe(true);
  });

  it('allows only isolated read-only local worktree replay', () => {
    const admitted = evaluateRunnerPairedReplayAdmission(
      {
        ...base,
        actualProviderKind: 'ssh',
        recommendedProviderKind: 'local',
        riskClass: 'read-only',
        targetNetworkAccess: 'host',
        targetIsolation: 'disposable-worktree',
        workspaceConfined: true,
      },
      { sampleRate: 1 },
    );
    const rejected = evaluateRunnerPairedReplayAdmission(
      {
        ...base,
        actualProviderKind: 'ssh',
        recommendedProviderKind: 'local',
        riskClass: 'ineligible',
        targetNetworkAccess: 'host',
        targetIsolation: 'disposable-worktree',
        workspaceConfined: true,
      },
      { sampleRate: 1 },
    );

    expect(admitted.admitted).toBe(true);
    expect(rejected.reasonCodes).toContain('local-read-only-required');
  });

  it('requires copy-on-write or isolated-cache dependencies for local build/test replay', () => {
    const rejected = evaluateRunnerPairedReplayAdmission(
      {
        ...base,
        actualProviderKind: 'ssh',
        recommendedProviderKind: 'local',
        targetNetworkAccess: 'host',
        targetIsolation: 'disposable-worktree',
        workspaceConfined: true,
      },
      { sampleRate: 1 },
    );
    const admitted = evaluateRunnerPairedReplayAdmission(
      {
        ...base,
        actualProviderKind: 'ssh',
        recommendedProviderKind: 'local',
        targetNetworkAccess: 'host',
        targetIsolation: 'disposable-worktree',
        targetDependencyIsolation: 'copy-on-write',
        workspaceConfined: true,
      },
      { sampleRate: 1 },
    );
    const isolatedCacheAdmitted = evaluateRunnerPairedReplayAdmission(
      {
        ...base,
        actualProviderKind: 'ssh',
        recommendedProviderKind: 'local',
        targetNetworkAccess: 'host',
        targetIsolation: 'disposable-worktree',
        targetDependencyIsolation: 'isolated-cache',
        workspaceConfined: true,
      },
      { sampleRate: 1 },
    );

    expect(rejected.reasonCodes).toContain(
      'local-dependency-isolation-required',
    );
    expect(admitted.admitted).toBe(true);
    expect(isolatedCacheAdmitted.admitted).toBe(true);
  });

  it('requires network-disabled Docker isolation', () => {
    const result = evaluateRunnerPairedReplayAdmission(
      { ...base, targetNetworkAccess: 'host' },
      { sampleRate: 1 },
    );
    expect(result.admitted).toBe(false);
    expect(result.reasonCodes).toContain('docker-network-isolation-required');
  });

  it('supports a read-only dogfood allowlist profile', () => {
    const result = evaluateRunnerPairedReplayAdmission(base, {
      sampleRate: 1,
      allowlistProfile: 'read-only',
    });
    expect(result.admitted).toBe(false);
    expect(result.reasonCodes).toContain('allowlist-profile-rejected');
  });

  it('does not admit decisions outside the deterministic sample', () => {
    const result = evaluateRunnerPairedReplayAdmission(base, { sampleRate: 0 });
    expect(result.admitted).toBe(false);
    expect(result.reasonCodes).toContain('sample-not-selected');
  });
});
