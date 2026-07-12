import type {
  HostedPullRequestBranchRule,
  HostedPullRequestChecksSummary,
  HostedPullRequestMergeGate,
  HostedPullRequestMergeMethod,
  HostedPullRequestMergePolicy,
} from './hosted-pull-request';

export type HostedPullRequestMergePolicyInput = {
  authenticated: boolean;
  repositoryFullName: string;
  number: number;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  mergeable: boolean | null;
  mergeState: string | null;
  checks: HostedPullRequestChecksSummary;
  filesTruncated: boolean;
  repositorySettings: {
    canPush: boolean | null;
    allowedMethods: HostedPullRequestMergeMethod[];
  } | null;
  branchRuleTypes: string[] | null;
};

const BRANCH_RULE_LABELS: Record<string, string> = {
  code_scanning: 'Required code scanning',
  creation: 'Branch creation restriction',
  deletion: 'Branch deletion restriction',
  merge_queue: 'Merge queue',
  non_fast_forward: 'Force-push restriction',
  pull_request: 'Pull request reviews',
  required_deployments: 'Required deployments',
  required_linear_history: 'Linear history',
  required_signatures: 'Signed commits',
  required_status_checks: 'Required status checks',
  required_workflows: 'Required workflows',
  update: 'Branch update restriction',
};

function mergeGate(
  id: HostedPullRequestMergeGate['id'],
  label: string,
  state: HostedPullRequestMergeGate['state'],
  message: string,
): HostedPullRequestMergeGate {
  return { id, label, state, message };
}

function normalizeBranchRules(
  branchRuleTypes: string[] | null,
): HostedPullRequestBranchRule[] {
  if (!branchRuleTypes) return [];
  const normalized = new Map<string, HostedPullRequestBranchRule>();
  for (const rawType of branchRuleTypes) {
    const type = rawType.trim();
    if (!type || normalized.has(type)) continue;
    normalized.set(type, {
      type,
      label:
        BRANCH_RULE_LABELS[type] ??
        type
          .split('_')
          .filter(Boolean)
          .map((part) => part[0]?.toUpperCase() + part.slice(1))
          .join(' '),
    });
  }
  return Array.from(normalized.values());
}

function getChecksGate(
  checks: HostedPullRequestChecksSummary,
  requiredByRule: boolean,
): HostedPullRequestMergeGate {
  if (checks.failed > 0) {
    return mergeGate(
      'checks',
      'Checks',
      'blocked',
      `${checks.failed} visible check${checks.failed === 1 ? '' : 's'} failed.`,
    );
  }
  if (checks.pending > 0) {
    return mergeGate(
      'checks',
      'Checks',
      'blocked',
      `${checks.pending} visible check${checks.pending === 1 ? ' is' : 's are'} still running.`,
    );
  }
  if (checks.neutral > 0) {
    return mergeGate(
      'checks',
      'Checks',
      'blocked',
      `${checks.neutral} visible check${checks.neutral === 1 ? ' is' : 's are'} neutral or skipped.`,
    );
  }
  if (requiredByRule && checks.total === 0) {
    return mergeGate(
      'checks',
      'Checks',
      'blocked',
      'Branch rules require checks, but GitHub has not reported any for this head.',
    );
  }
  return mergeGate(
    'checks',
    'Checks',
    'pass',
    checks.total === 0
      ? 'No visible checks are required.'
      : `All ${checks.total} visible checks passed.`,
  );
}

export function getHostedPullRequestMergeConfirmationText(
  repositoryFullName: string,
  number: number,
): string {
  return `${repositoryFullName}#${number}`;
}

export function buildHostedPullRequestMergePolicy(
  input: HostedPullRequestMergePolicyInput,
): HostedPullRequestMergePolicy {
  const activeRules = normalizeBranchRules(input.branchRuleTypes);
  const ruleTypes = new Set(activeRules.map((rule) => rule.type));
  const rulesAvailable = input.branchRuleTypes !== null;
  const requiresChecks =
    ruleTypes.has('required_status_checks') ||
    ruleTypes.has('required_workflows');
  const mergeQueueRequired = ruleTypes.has('merge_queue');
  const methods = input.repositorySettings?.allowedMethods ?? [];

  const gates: HostedPullRequestMergeGate[] = [
    mergeGate(
      'authenticated',
      'GitHub authentication',
      input.authenticated ? 'pass' : 'blocked',
      input.authenticated
        ? 'A GitHub Personal Access Token is configured.'
        : 'Add a GitHub Personal Access Token before merging.',
    ),
    mergeGate(
      'pull-request-state',
      'Pull request state',
      input.state === 'open' && !input.draft ? 'pass' : 'blocked',
      input.state !== 'open'
        ? 'Only an open pull request can be merged.'
        : input.draft
          ? 'Mark this draft ready for review before merging.'
          : 'The pull request is open and ready for review.',
    ),
    mergeGate(
      'repository-permission',
      'Repository permission',
      input.repositorySettings?.canPush === true
        ? 'pass'
        : input.repositorySettings?.canPush === false
          ? 'blocked'
          : 'unknown',
      input.repositorySettings?.canPush === true
        ? 'The authenticated GitHub user can write to this repository.'
        : input.repositorySettings?.canPush === false
          ? 'The authenticated GitHub user cannot write to this repository.'
          : 'Repository write permission could not be verified.',
    ),
    mergeGate(
      'branch-rules',
      'Branch rules',
      rulesAvailable ? 'pass' : 'unknown',
      rulesAvailable
        ? activeRules.length === 0
          ? 'GitHub reported no active rules for the base branch.'
          : `${activeRules.length} active branch rule${activeRules.length === 1 ? '' : 's'} loaded.`
        : 'Active branch rules could not be loaded, so direct merge is disabled.',
    ),
    mergeGate(
      'merge-queue',
      'Direct merge',
      rulesAvailable ? (mergeQueueRequired ? 'blocked' : 'pass') : 'unknown',
      mergeQueueRequired
        ? 'The base branch requires GitHub merge queue; direct merge is disabled.'
        : rulesAvailable
          ? 'The base branch does not require merge queue.'
          : 'Merge queue requirements could not be verified.',
    ),
    mergeGate(
      'mergeability',
      'Mergeability',
      input.mergeable === null ||
        input.mergeState === null ||
        input.mergeState === 'unknown'
        ? 'unknown'
        : input.mergeable === true && input.mergeState === 'clean'
          ? 'pass'
          : 'blocked',
      input.mergeable === true && input.mergeState === 'clean'
        ? 'GitHub reports a clean merge against the current base.'
        : input.mergeable === null ||
            input.mergeState === null ||
            input.mergeState === 'unknown'
          ? 'GitHub has not finished calculating mergeability.'
          : `GitHub reports merge state “${input.mergeState}”. Refresh or resolve the blocker before merging.`,
    ),
    getChecksGate(input.checks, requiresChecks),
    mergeGate(
      'complete-files',
      'Review coverage',
      input.filesTruncated ? 'blocked' : 'pass',
      input.filesTruncated
        ? 'Clodex could not load every changed file. Complete the merge on GitHub.'
        : 'All changed files are available in this review.',
    ),
    mergeGate(
      'merge-methods',
      'Merge method',
      input.repositorySettings === null
        ? 'unknown'
        : methods.length > 0
          ? 'pass'
          : 'blocked',
      input.repositorySettings === null
        ? 'Repository merge methods could not be loaded.'
        : methods.length > 0
          ? `${methods.length} repository merge method${methods.length === 1 ? ' is' : 's are'} available.`
          : 'This repository has no direct merge method enabled.',
    ),
  ];

  return {
    status: gates.every((gate) => gate.state === 'pass') ? 'ready' : 'blocked',
    confirmationText: getHostedPullRequestMergeConfirmationText(
      input.repositoryFullName,
      input.number,
    ),
    availableMethods: methods,
    defaultMethod: methods.includes('squash') ? 'squash' : (methods[0] ?? null),
    activeRules,
    gates,
  };
}
