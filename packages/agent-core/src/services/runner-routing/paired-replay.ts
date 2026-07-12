import { createHash } from 'node:crypto';
import type { RunnerRoutingProviderKind } from './index';

export const runnerPairedReplayProfiles = [
  'local-read-only',
  'node-copy-on-write',
  'cargo-cache',
  'go-cache',
  'ssh-read-only',
  'ssh-node-cache',
  'ssh-cargo-cache',
  'ssh-go-cache',
  'docker-isolated',
] as const;
export type RunnerPairedReplayProfile =
  (typeof runnerPairedReplayProfiles)[number];

export type RunnerPairedReplayDependencyIsolationProfile =
  | 'node-copy-on-write'
  | 'cargo-cache'
  | 'go-cache';

export const runnerPairedReplayRiskClasses = [
  'read-only',
  'workspace-contained',
  'ineligible',
] as const;
export type RunnerPairedReplayRiskClass =
  (typeof runnerPairedReplayRiskClasses)[number];

export const runnerPairedReplayReasonCodes = [
  'admitted',
  'not-execute-command',
  'recommendation-matches-actual',
  'missing-command-class',
  'raw-input',
  'interactive-command',
  'session-affine-command',
  'network-required',
  'local-target-isolation-required',
  'local-read-only-required',
  'local-dependency-isolation-required',
  'workspace-confinement-required',
  'cloud-target-unsupported',
  'command-risk-ineligible',
  'ssh-read-only-required',
  'ssh-dependency-isolation-required',
  'docker-network-isolation-required',
  'allowlist-profile-rejected',
  'sample-not-selected',
] as const;
export type RunnerPairedReplayReasonCode =
  (typeof runnerPairedReplayReasonCodes)[number];

export interface RunnerPairedReplayEligibilityInput {
  decisionId: string;
  operation: 'create-session' | 'execute-command' | 'kill-session';
  commandClassHash: string | null;
  actualProviderKind: RunnerRoutingProviderKind;
  recommendedProviderKind: RunnerRoutingProviderKind;
  rawInput: boolean;
  requiresNetwork: boolean;
  requiresInteractive: boolean;
  hasSessionAffinity: boolean;
  riskClass: RunnerPairedReplayRiskClass;
  targetNetworkAccess: 'none' | 'restricted' | 'host';
  targetIsolation?:
    | 'none'
    | 'disposable-worktree'
    | 'remote-workspace'
    | 'container';
  targetDependencyIsolation?: 'none' | 'copy-on-write' | 'isolated-cache';
  workspaceConfined?: boolean;
}

export interface RunnerPairedReplayPolicyOptions {
  sampleRate?: number;
  allowlistProfile?: RunnerPairedReplayAllowlistProfile;
}

export const runnerPairedReplayAllowlistProfiles = [
  'read-only',
  'build-test',
] as const;
export type RunnerPairedReplayAllowlistProfile =
  (typeof runnerPairedReplayAllowlistProfiles)[number];

export interface RunnerPairedReplayAdmission {
  version: 1;
  admitted: boolean;
  riskClass: RunnerPairedReplayRiskClass;
  sampleBucket: number;
  sampleRate: number;
  reasonCodes: RunnerPairedReplayReasonCode[];
  policyHash: string;
}

export function resolveRunnerPairedReplayProfile(input: {
  targetProviderKind: RunnerRoutingProviderKind;
  dependencyIsolationProfile: RunnerPairedReplayDependencyIsolationProfile | null;
}): RunnerPairedReplayProfile | null {
  if (input.targetProviderKind === 'ssh') {
    if (input.dependencyIsolationProfile === 'node-copy-on-write') {
      return 'ssh-node-cache';
    }
    if (input.dependencyIsolationProfile === 'cargo-cache') {
      return 'ssh-cargo-cache';
    }
    if (input.dependencyIsolationProfile === 'go-cache') {
      return 'ssh-go-cache';
    }
    return 'ssh-read-only';
  }
  if (input.targetProviderKind === 'docker') return 'docker-isolated';
  if (input.targetProviderKind !== 'local') return null;
  return input.dependencyIsolationProfile ?? 'local-read-only';
}

const DEFAULT_SAMPLE_RATE = 0.1;

/**
 * Pure fail-closed admission policy for verified paired runner replays.
 *
 * Sampling is deterministic for a decision and policy version. Local replay
 * requires a disposable worktree and exact read-only commands. SSH is limited
 * to the same read-only class; Docker may additionally run workspace-contained
 * build/test commands only with network disabled.
 */
export function evaluateRunnerPairedReplayAdmission(
  input: RunnerPairedReplayEligibilityInput,
  options: RunnerPairedReplayPolicyOptions = {},
): RunnerPairedReplayAdmission {
  const sampleRate = normalizeSampleRate(
    options.sampleRate ?? DEFAULT_SAMPLE_RATE,
  );
  const allowlistProfile = options.allowlistProfile ?? 'build-test';
  const policyHash = hashCanonical({
    version: 1,
    sampleRate,
    allowlistProfile,
    localReplay: 'disposable-worktree',
    localRiskClasses: ['read-only', 'workspace-contained'],
    localBuildTestDependencyIsolation: ['copy-on-write', 'isolated-cache'],
    sshRiskClasses: ['read-only', 'workspace-contained'],
    sshBuildTestDependencyIsolation: ['copy-on-write', 'isolated-cache'],
    dockerRiskClasses: ['read-only', 'workspace-contained'],
    dockerRequiredNetworkAccess: 'none',
  });
  const sampleBucket = deterministicBucket(`${input.decisionId}:${policyHash}`);
  const reasons: RunnerPairedReplayReasonCode[] = [];

  if (input.operation !== 'execute-command') {
    reasons.push('not-execute-command');
  }
  if (input.actualProviderKind === input.recommendedProviderKind) {
    reasons.push('recommendation-matches-actual');
  }
  if (!input.commandClassHash) reasons.push('missing-command-class');
  if (input.rawInput) reasons.push('raw-input');
  if (input.requiresInteractive) reasons.push('interactive-command');
  if (input.hasSessionAffinity) reasons.push('session-affine-command');
  if (input.requiresNetwork) reasons.push('network-required');
  if (input.riskClass === 'ineligible') {
    reasons.push('command-risk-ineligible');
  }
  if (
    allowlistProfile === 'read-only' &&
    input.riskClass === 'workspace-contained'
  ) {
    reasons.push('allowlist-profile-rejected');
  }

  if (
    input.recommendedProviderKind === 'local' &&
    input.targetIsolation !== 'disposable-worktree'
  ) {
    reasons.push('local-target-isolation-required');
  } else if (
    input.recommendedProviderKind === 'local' &&
    input.riskClass !== 'read-only' &&
    input.riskClass !== 'workspace-contained'
  ) {
    reasons.push('local-read-only-required');
  } else if (
    input.recommendedProviderKind === 'local' &&
    input.riskClass === 'workspace-contained' &&
    input.targetDependencyIsolation !== 'copy-on-write' &&
    input.targetDependencyIsolation !== 'isolated-cache'
  ) {
    reasons.push('local-dependency-isolation-required');
  } else if (
    input.recommendedProviderKind === 'local' &&
    input.workspaceConfined !== true
  ) {
    reasons.push('workspace-confinement-required');
  } else if (input.recommendedProviderKind === 'cloud') {
    reasons.push('cloud-target-unsupported');
  } else if (
    input.recommendedProviderKind === 'ssh' &&
    input.riskClass === 'workspace-contained' &&
    input.targetIsolation !== 'remote-workspace'
  ) {
    reasons.push('ssh-read-only-required');
  } else if (
    input.recommendedProviderKind === 'ssh' &&
    input.riskClass === 'workspace-contained' &&
    input.targetDependencyIsolation !== 'copy-on-write' &&
    input.targetDependencyIsolation !== 'isolated-cache'
  ) {
    reasons.push('ssh-dependency-isolation-required');
  } else if (
    input.recommendedProviderKind === 'ssh' &&
    input.riskClass !== 'read-only' &&
    input.riskClass !== 'workspace-contained'
  ) {
    reasons.push('ssh-read-only-required');
  } else if (
    input.recommendedProviderKind === 'docker' &&
    input.targetNetworkAccess !== 'none'
  ) {
    reasons.push('docker-network-isolation-required');
  }

  if (sampleBucket >= sampleRate) reasons.push('sample-not-selected');
  if (reasons.length === 0) reasons.push('admitted');

  return {
    version: 1,
    admitted: reasons.length === 1 && reasons[0] === 'admitted',
    riskClass: input.riskClass,
    sampleBucket,
    sampleRate,
    reasonCodes: reasons,
    policyHash,
  };
}

function normalizeSampleRate(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Paired replay sample rate must be between 0 and 1');
  }
  return value;
}

function deterministicBucket(value: string): number {
  const digest = createHash('sha256').update(value).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

function hashCanonical(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
