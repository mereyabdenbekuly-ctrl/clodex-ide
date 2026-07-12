import { describe, expect, it } from 'vitest';
import type { HostedPullRequestChecksSummary } from './hosted-pull-request';
import {
  buildHostedPullRequestMergePolicy,
  type HostedPullRequestMergePolicyInput,
} from './hosted-pull-request-merge';

const passingChecks: HostedPullRequestChecksSummary = {
  total: 2,
  pending: 0,
  successful: 2,
  failed: 0,
  neutral: 0,
  checks: [],
};

function policyInput(
  overrides?: Partial<HostedPullRequestMergePolicyInput>,
): HostedPullRequestMergePolicyInput {
  return {
    authenticated: true,
    repositoryFullName: 'openai/clodex',
    number: 418,
    state: 'open',
    draft: false,
    mergeable: true,
    mergeState: 'clean',
    checks: passingChecks,
    filesTruncated: false,
    repositorySettings: {
      canPush: true,
      allowedMethods: ['merge', 'squash', 'rebase'],
    },
    branchRuleTypes: ['pull_request', 'required_status_checks'],
    ...overrides,
  };
}

describe('buildHostedPullRequestMergePolicy', () => {
  it('allows a protected merge only when every gate passes', () => {
    const policy = buildHostedPullRequestMergePolicy(policyInput());

    expect(policy).toMatchObject({
      status: 'ready',
      confirmationText: 'openai/clodex#418',
      defaultMethod: 'squash',
      availableMethods: ['merge', 'squash', 'rebase'],
    });
    expect(policy.gates.every((gate) => gate.state === 'pass')).toBe(true);
    expect(policy.activeRules.map((rule) => rule.label)).toEqual([
      'Pull request reviews',
      'Required status checks',
    ]);
  });

  it('blocks pending, failed, neutral, and missing required checks', () => {
    for (const checks of [
      { ...passingChecks, pending: 1, successful: 1 },
      { ...passingChecks, failed: 1, successful: 1 },
      { ...passingChecks, neutral: 1, successful: 1 },
      { ...passingChecks, total: 0, successful: 0 },
    ]) {
      const policy = buildHostedPullRequestMergePolicy(policyInput({ checks }));
      expect(policy.status).toBe('blocked');
      expect(policy.gates.find((gate) => gate.id === 'checks')?.state).toBe(
        'blocked',
      );
    }
  });

  it('blocks direct merge when branch rules are unavailable or require merge queue', () => {
    const unavailable = buildHostedPullRequestMergePolicy(
      policyInput({ branchRuleTypes: null }),
    );
    expect(unavailable.status).toBe('blocked');
    expect(
      unavailable.gates.find((gate) => gate.id === 'branch-rules')?.state,
    ).toBe('unknown');

    const queued = buildHostedPullRequestMergePolicy(
      policyInput({ branchRuleTypes: ['merge_queue'] }),
    );
    expect(queued.status).toBe('blocked');
    expect(queued.gates.find((gate) => gate.id === 'merge-queue')?.state).toBe(
      'blocked',
    );
  });

  it('blocks conflicts, incomplete file coverage, and missing write permission', () => {
    const policy = buildHostedPullRequestMergePolicy(
      policyInput({
        mergeable: false,
        mergeState: 'dirty',
        filesTruncated: true,
        repositorySettings: {
          canPush: false,
          allowedMethods: ['squash'],
        },
      }),
    );

    expect(policy.status).toBe('blocked');
    expect(
      policy.gates
        .filter((gate) => gate.state !== 'pass')
        .map((gate) => gate.id),
    ).toEqual(['repository-permission', 'mergeability', 'complete-files']);
  });
});
