export type HostedPullRequestProvider = 'github';

export type HostedPullRequestQuery =
  | {
      workspacePath: string;
      url?: never;
    }
  | {
      url: string;
      workspacePath?: never;
    };

export type HostedPullRequestAuthor = {
  login: string;
  avatarUrl: string | null;
  profileUrl: string;
};

export type HostedPullRequestRef = {
  label: string;
  branch: string;
  sha: string;
  repositoryFullName: string;
};

export type HostedPullRequestCheckState =
  | 'pending'
  | 'success'
  | 'failure'
  | 'neutral'
  | 'skipped';

export type HostedPullRequestCheck = {
  id: string;
  name: string;
  state: HostedPullRequestCheckState;
  detailsUrl: string | null;
  description: string | null;
};

export type HostedPullRequestChecksSummary = {
  total: number;
  pending: number;
  successful: number;
  failed: number;
  neutral: number;
  checks: HostedPullRequestCheck[];
};

export type HostedPullRequestFileStatus =
  | 'added'
  | 'modified'
  | 'removed'
  | 'renamed'
  | 'copied'
  | 'changed'
  | 'unchanged';

export type HostedPullRequestFile = {
  sha: string;
  path: string;
  previousPath: string | null;
  status: HostedPullRequestFileStatus;
  additions: number;
  deletions: number;
  changes: number;
  patch: string | null;
  blobUrl: string;
  rawUrl: string;
};

export type HostedPullRequestMergeMethod = 'merge' | 'squash' | 'rebase';

export type HostedPullRequestMergeGateId =
  | 'authenticated'
  | 'pull-request-state'
  | 'repository-permission'
  | 'branch-rules'
  | 'merge-queue'
  | 'mergeability'
  | 'checks'
  | 'complete-files'
  | 'merge-methods';

export type HostedPullRequestMergeGateState = 'pass' | 'blocked' | 'unknown';

export type HostedPullRequestMergeGate = {
  id: HostedPullRequestMergeGateId;
  label: string;
  state: HostedPullRequestMergeGateState;
  message: string;
};

export type HostedPullRequestBranchRule = {
  type: string;
  label: string;
};

export type HostedPullRequestMergePolicy = {
  status: 'ready' | 'blocked';
  confirmationText: string;
  availableMethods: HostedPullRequestMergeMethod[];
  defaultMethod: HostedPullRequestMergeMethod | null;
  activeRules: HostedPullRequestBranchRule[];
  gates: HostedPullRequestMergeGate[];
};

export type HostedPullRequest = {
  provider: HostedPullRequestProvider;
  repository: {
    owner: string;
    name: string;
    fullName: string;
    url: string;
  };
  number: number;
  url: string;
  title: string;
  body: string | null;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  mergeable: boolean | null;
  mergeState: string | null;
  author: HostedPullRequestAuthor;
  head: HostedPullRequestRef;
  base: HostedPullRequestRef;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  comments: number;
  reviewComments: number;
  checks: HostedPullRequestChecksSummary;
  files: HostedPullRequestFile[];
  filesTruncated: boolean;
  detectedFromWorkspace: string | null;
  mergePolicy: HostedPullRequestMergePolicy;
};

export type HostedPullRequestUnavailableReason =
  | 'invalid-query'
  | 'not-git-repository'
  | 'no-branch'
  | 'no-github-remote'
  | 'not-found'
  | 'authentication-required'
  | 'permission-denied'
  | 'rate-limited'
  | 'unsupported-provider'
  | 'network-error'
  | 'provider-error';

export type HostedPullRequestResult =
  | {
      status: 'ready';
      pullRequest: HostedPullRequest;
      authenticated: boolean;
    }
  | {
      status: 'unavailable';
      reason: HostedPullRequestUnavailableReason;
      message: string;
      authenticated: boolean;
      retryable: boolean;
    };

export type HostedPullRequestReviewEvent =
  | 'COMMENT'
  | 'APPROVE'
  | 'REQUEST_CHANGES';

export type HostedPullRequestCommentSide = 'LEFT' | 'RIGHT';

export type HostedPullRequestInlineCommentInput = {
  path: string;
  line: number;
  side: HostedPullRequestCommentSide;
  body: string;
  startLine?: number;
  startSide?: HostedPullRequestCommentSide;
};

export type HostedPullRequestSubmitReviewInput = {
  repository: {
    owner: string;
    name: string;
  };
  number: number;
  commitId: string;
  event: HostedPullRequestReviewEvent;
  body: string;
  comments: HostedPullRequestInlineCommentInput[];
};

export type HostedPullRequestSubmitReviewFailureReason =
  | 'invalid-input'
  | 'authentication-required'
  | 'permission-denied'
  | 'pull-request-not-reviewable'
  | 'stale-head'
  | 'rate-limited'
  | 'not-found'
  | 'network-error'
  | 'provider-error';

export type HostedPullRequestSubmitReviewResult =
  | {
      ok: true;
      reviewId: number | null;
      reviewUrl: string | null;
      state: string | null;
      submittedAt: string | null;
    }
  | {
      ok: false;
      reason: HostedPullRequestSubmitReviewFailureReason;
      message: string;
      retryable: boolean;
    };

export type HostedPullRequestMergeInput = {
  repository: {
    owner: string;
    name: string;
  };
  number: number;
  expectedHeadSha: string;
  expectedBaseSha: string;
  method: HostedPullRequestMergeMethod;
  confirmationText: string;
};

export type HostedPullRequestMergeFailureReason =
  | 'invalid-input'
  | 'authentication-required'
  | 'permission-denied'
  | 'pull-request-not-mergeable'
  | 'stale-head'
  | 'checks-not-passing'
  | 'branch-rules-unavailable'
  | 'merge-method-not-allowed'
  | 'merge-queue-required'
  | 'rate-limited'
  | 'not-found'
  | 'network-error'
  | 'provider-error';

export type HostedPullRequestMergeResult =
  | {
      ok: true;
      merged: true;
      mergeCommitSha: string | null;
      message: string;
    }
  | {
      ok: false;
      reason: HostedPullRequestMergeFailureReason;
      message: string;
      retryable: boolean;
    };
