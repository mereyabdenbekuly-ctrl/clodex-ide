import type { CredentialsService } from '@/services/credentials';
import { DisposableService } from '@/services/disposable';
import type { GitService } from '@/services/git';
import type { Logger } from '@/services/logger';
import type { TelemetryService } from '@/services/telemetry';
import { createHash } from 'node:crypto';
import {
  buildHostedPullRequestMergePolicy,
  getHostedPullRequestMergeConfirmationText,
} from '@shared/hosted-pull-request-merge';
import { isHostedPullRequestPatchTarget } from '@shared/hosted-pull-request-patch';
import type {
  HostedPullRequest,
  HostedPullRequestCheck,
  HostedPullRequestCheckState,
  HostedPullRequestChecksSummary,
  HostedPullRequestCommentSide,
  HostedPullRequestFile,
  HostedPullRequestFileStatus,
  HostedPullRequestInlineCommentInput,
  HostedPullRequestMergeFailureReason,
  HostedPullRequestMergeInput,
  HostedPullRequestMergeMethod,
  HostedPullRequestMergePolicy,
  HostedPullRequestMergeResult,
  HostedPullRequestQuery,
  HostedPullRequestResult,
  HostedPullRequestReviewEvent,
  HostedPullRequestSubmitReviewFailureReason,
  HostedPullRequestSubmitReviewInput,
  HostedPullRequestSubmitReviewResult,
  HostedPullRequestUnavailableReason,
} from '@shared/hosted-pull-request';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const MAX_FILE_PAGES = 10;
const FILES_PER_PAGE = 100;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REVIEW_BODY_LENGTH = 65_536;
const MAX_INLINE_COMMENT_BODY_LENGTH = 65_536;
const MAX_INLINE_COMMENTS = 50;
const MAX_PATH_LENGTH = 4_096;

type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

type HostedPullRequestServiceDeps = {
  logger: Logger;
  telemetryService: TelemetryService;
  credentialsService: CredentialsService;
  gitService: GitService;
  fetchImpl?: FetchLike;
};

type GitHubRepositoryReference = {
  owner: string;
  repo: string;
};

type GitHubPullRequestReference = GitHubRepositoryReference & {
  number: number;
};

type GitHubApiFailure = {
  kind:
    | 'authentication-required'
    | 'permission-denied'
    | 'rate-limited'
    | 'not-found'
    | 'network-error'
    | 'provider-error';
  message: string;
  retryable: boolean;
  status: number | null;
};

class GitHubRequestError extends Error {
  public readonly failure: GitHubApiFailure;

  constructor(failure: GitHubApiFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

type NormalizedHostedPullRequestSubmitReviewInput = {
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

type NormalizedHostedPullRequestMergeInput = {
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

type ReviewInputValidationResult =
  | {
      ok: true;
      input: NormalizedHostedPullRequestSubmitReviewInput;
    }
  | {
      ok: false;
      result: HostedPullRequestSubmitReviewResult;
    };

type MergeInputValidationResult =
  | {
      ok: true;
      input: NormalizedHostedPullRequestMergeInput;
    }
  | {
      ok: false;
      result: HostedPullRequestMergeResult;
    };

type GitHubRequestOptions = {
  optional?: boolean;
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  operation?: 'read' | 'review' | 'merge';
};

function parseGitHubRepositoryUrl(
  rawUrl: string,
): GitHubRepositoryReference | null {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const [owner, repo, ...rest] = url.pathname
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
    if (!owner || !repo || rest.length > 0) return null;
    return { owner, repo: repo.replace(/\.git$/i, '') };
  } catch {
    return null;
  }
}

export function parseGitHubPullRequestUrl(
  rawUrl: string,
): GitHubPullRequestReference | null {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const [owner, repo, pullSegment, numberSegment] = url.pathname
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
    if (
      !owner ||
      !repo ||
      pullSegment !== 'pull' ||
      !numberSegment ||
      !/^\d+$/.test(numberSegment)
    ) {
      return null;
    }
    const number = Number.parseInt(numberSegment, 10);
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    return { owner, repo: repo.replace(/\.git$/i, ''), number };
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function mapCheckState(
  status: string,
  conclusion: string | null,
): HostedPullRequestCheckState {
  if (status !== 'completed' && status !== 'success' && status !== 'failure') {
    return 'pending';
  }
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'cancelled':
    case 'action_required':
    case 'startup_failure':
      return 'failure';
    case 'skipped':
      return 'skipped';
    case 'neutral':
    case 'stale':
      return 'neutral';
    default:
      return status === 'success'
        ? 'success'
        : status === 'failure'
          ? 'failure'
          : 'pending';
  }
}

function summarizeChecks(
  checkRunsValue: unknown,
  combinedStatusValue: unknown,
): HostedPullRequestChecksSummary {
  const checks = new Map<string, HostedPullRequestCheck>();
  const checkRuns = asRecord(checkRunsValue).check_runs;
  if (Array.isArray(checkRuns)) {
    for (const rawRun of checkRuns) {
      const run = asRecord(rawRun);
      const name = asString(run.name, 'Check');
      const appName = asString(asRecord(run.app).name);
      const id = `check:${asString(run.id, `${appName}:${name}`)}`;
      checks.set(id, {
        id,
        name: appName ? `${name} · ${appName}` : name,
        state: mapCheckState(
          asString(run.status, 'queued'),
          asNullableString(run.conclusion),
        ),
        detailsUrl: asNullableString(run.details_url),
        description: asNullableString(asRecord(run.output).summary),
      });
    }
  }

  const statuses = asRecord(combinedStatusValue).statuses;
  if (Array.isArray(statuses)) {
    for (const rawStatus of statuses) {
      const status = asRecord(rawStatus);
      const context = asString(status.context, 'Commit status');
      const id = `status:${context}`;
      checks.set(id, {
        id,
        name: context,
        state: mapCheckState(
          asString(status.state, 'pending'),
          asNullableString(status.state),
        ),
        detailsUrl: asNullableString(status.target_url),
        description: asNullableString(status.description),
      });
    }
  }

  const normalized = [...checks.values()];
  return {
    total: normalized.length,
    pending: normalized.filter((check) => check.state === 'pending').length,
    successful: normalized.filter((check) => check.state === 'success').length,
    failed: normalized.filter((check) => check.state === 'failure').length,
    neutral: normalized.filter(
      (check) => check.state === 'neutral' || check.state === 'skipped',
    ).length,
    checks: normalized,
  };
}

function normalizeFileStatus(value: unknown): HostedPullRequestFileStatus {
  switch (value) {
    case 'added':
    case 'modified':
    case 'removed':
    case 'renamed':
    case 'copied':
    case 'changed':
    case 'unchanged':
      return value;
    default:
      return 'changed';
  }
}

function mapPullRequestFile(value: unknown): HostedPullRequestFile {
  const file = asRecord(value);
  return {
    sha: asString(file.sha),
    path: asString(file.filename),
    previousPath: asNullableString(file.previous_filename),
    status: normalizeFileStatus(file.status),
    additions: asNumber(file.additions),
    deletions: asNumber(file.deletions),
    changes: asNumber(file.changes),
    patch: asNullableString(file.patch),
    blobUrl: asString(file.blob_url),
    rawUrl: asString(file.raw_url),
  };
}

function normalizeApiMessage(body: unknown, fallback: string): string {
  const message = asString(asRecord(body).message);
  return message || fallback;
}

function reviewFailure(
  reason: HostedPullRequestSubmitReviewFailureReason,
  message: string,
  retryable: boolean,
): HostedPullRequestSubmitReviewResult {
  return { ok: false, reason, message, retryable };
}

function mergeFailure(
  reason: HostedPullRequestMergeFailureReason,
  message: string,
  retryable: boolean,
): HostedPullRequestMergeResult {
  return { ok: false, reason, message, retryable };
}

function normalizeReviewInput(
  value: HostedPullRequestSubmitReviewInput,
): ReviewInputValidationResult {
  const input = asRecord(value);
  const repository = asRecord(input.repository);
  const owner = asString(repository.owner).trim();
  const name = asString(repository.name).trim();
  const number = asNumber(input.number);
  const commitId = asString(input.commitId).trim();
  const event = input.event;
  const body = asString(input.body).trim();
  const rawComments = input.comments;

  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(name) ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    !commitId ||
    commitId.length > 100 ||
    /\s/.test(commitId) ||
    (event !== 'COMMENT' &&
      event !== 'APPROVE' &&
      event !== 'REQUEST_CHANGES') ||
    typeof input.body !== 'string' ||
    !Array.isArray(rawComments)
  ) {
    return {
      ok: false,
      result: reviewFailure(
        'invalid-input',
        'The review draft is invalid. Refresh the pull request and try again.',
        false,
      ),
    };
  }

  if (body.length > MAX_REVIEW_BODY_LENGTH) {
    return {
      ok: false,
      result: reviewFailure(
        'invalid-input',
        `The review summary must be ${MAX_REVIEW_BODY_LENGTH.toLocaleString()} characters or fewer.`,
        false,
      ),
    };
  }

  if (rawComments.length > MAX_INLINE_COMMENTS) {
    return {
      ok: false,
      result: reviewFailure(
        'invalid-input',
        `A review can contain at most ${MAX_INLINE_COMMENTS} inline comments.`,
        false,
      ),
    };
  }

  const comments: HostedPullRequestInlineCommentInput[] = [];
  const targets = new Set<string>();
  for (const rawComment of rawComments) {
    const comment = asRecord(rawComment);
    const path = asString(comment.path).trim();
    const line = asNumber(comment.line);
    const side = comment.side;
    const commentBody = asString(comment.body).trim();
    const hasStartLine = comment.startLine !== undefined;
    const hasStartSide = comment.startSide !== undefined;
    const startLine = hasStartLine ? asNumber(comment.startLine) : undefined;
    const startSide = hasStartSide ? comment.startSide : undefined;

    if (
      !path ||
      path.length > MAX_PATH_LENGTH ||
      path.includes('\0') ||
      !Number.isSafeInteger(line) ||
      line <= 0 ||
      (side !== 'LEFT' && side !== 'RIGHT') ||
      !commentBody ||
      commentBody.length > MAX_INLINE_COMMENT_BODY_LENGTH ||
      hasStartLine !== hasStartSide ||
      (startLine !== undefined &&
        (!Number.isSafeInteger(startLine) ||
          startLine <= 0 ||
          startLine > line)) ||
      (startSide !== undefined && startSide !== side)
    ) {
      return {
        ok: false,
        result: reviewFailure(
          'invalid-input',
          'One or more inline comments are invalid. Check their line and content, then try again.',
          false,
        ),
      };
    }

    const targetKey = `${path}\0${side}\0${line}`;
    if (targets.has(targetKey)) {
      return {
        ok: false,
        result: reviewFailure(
          'invalid-input',
          'Only one pending comment can be submitted for the same line.',
          false,
        ),
      };
    }
    targets.add(targetKey);

    comments.push({
      path,
      line,
      side,
      body: commentBody,
      ...(startLine !== undefined && startSide !== undefined
        ? {
            startLine,
            startSide: startSide as HostedPullRequestCommentSide,
          }
        : {}),
    });
  }

  if (
    (event === 'COMMENT' || event === 'REQUEST_CHANGES') &&
    !body &&
    comments.length === 0
  ) {
    return {
      ok: false,
      result: reviewFailure(
        'invalid-input',
        event === 'REQUEST_CHANGES'
          ? 'Add a review summary or an inline comment before requesting changes.'
          : 'Add a review summary or an inline comment before submitting.',
        false,
      ),
    };
  }

  return {
    ok: true,
    input: {
      repository: { owner, name },
      number,
      commitId,
      event,
      body,
      comments,
    },
  };
}

function normalizeMergeInput(
  value: HostedPullRequestMergeInput,
): MergeInputValidationResult {
  const input = asRecord(value);
  const repository = asRecord(input.repository);
  const owner = asString(repository.owner).trim();
  const name = asString(repository.name).trim();
  const number = asNumber(input.number);
  const expectedHeadSha = asString(input.expectedHeadSha).trim();
  const expectedBaseSha = asString(input.expectedBaseSha).trim();
  const method = input.method;
  const confirmationText = asString(input.confirmationText).trim();

  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(name) ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    !expectedHeadSha ||
    expectedHeadSha.length > 100 ||
    /\s/.test(expectedHeadSha) ||
    !expectedBaseSha ||
    expectedBaseSha.length > 100 ||
    /\s/.test(expectedBaseSha) ||
    (method !== 'merge' && method !== 'squash' && method !== 'rebase') ||
    confirmationText !==
      getHostedPullRequestMergeConfirmationText(`${owner}/${name}`, number)
  ) {
    return {
      ok: false,
      result: mergeFailure(
        'invalid-input',
        'The protected merge confirmation is invalid. Refresh the pull request and try again.',
        false,
      ),
    };
  }

  return {
    ok: true,
    input: {
      repository: { owner, name },
      number,
      expectedHeadSha,
      expectedBaseSha,
      method,
      confirmationText,
    },
  };
}

function mergePolicyFailure(
  policy: HostedPullRequestMergePolicy,
): HostedPullRequestMergeResult {
  const blockedGate =
    policy.gates.find((gate) => gate.id === 'repository-permission')?.state !==
    'pass'
      ? policy.gates.find((gate) => gate.id === 'repository-permission')
      : policy.gates.find((gate) => gate.id === 'branch-rules')?.state !==
          'pass'
        ? policy.gates.find((gate) => gate.id === 'branch-rules')
        : policy.gates.find((gate) => gate.id === 'merge-queue')?.state !==
            'pass'
          ? policy.gates.find((gate) => gate.id === 'merge-queue')
          : policy.gates.find((gate) => gate.id === 'checks')?.state !== 'pass'
            ? policy.gates.find((gate) => gate.id === 'checks')
            : policy.gates.find((gate) => gate.id === 'merge-methods')
                  ?.state !== 'pass'
              ? policy.gates.find((gate) => gate.id === 'merge-methods')
              : policy.gates.find((gate) => gate.state !== 'pass');

  switch (blockedGate?.id) {
    case 'repository-permission':
      return mergeFailure(
        'permission-denied',
        blockedGate.message,
        blockedGate.state === 'unknown',
      );
    case 'branch-rules':
      return mergeFailure(
        'branch-rules-unavailable',
        blockedGate.message,
        true,
      );
    case 'merge-queue':
      return mergeFailure('merge-queue-required', blockedGate.message, false);
    case 'checks':
      return mergeFailure('checks-not-passing', blockedGate.message, true);
    case 'merge-methods':
      return mergeFailure(
        'merge-method-not-allowed',
        blockedGate.message,
        false,
      );
    default:
      return mergeFailure(
        'pull-request-not-mergeable',
        blockedGate?.message ??
          'The protected merge policy is not satisfied. Refresh the pull request and try again.',
        blockedGate?.state === 'unknown',
      );
  }
}

export class HostedPullRequestService extends DisposableService {
  private readonly logger: Logger;
  private readonly telemetryService: TelemetryService;
  private readonly credentialsService: CredentialsService;
  private readonly gitService: GitService;
  private readonly fetchImpl: FetchLike;
  private readonly inFlightReviewSubmissions = new Map<
    string,
    Promise<HostedPullRequestSubmitReviewResult>
  >();
  private readonly inFlightMerges = new Map<
    string,
    Promise<HostedPullRequestMergeResult>
  >();

  private constructor(deps: HostedPullRequestServiceDeps) {
    super();
    this.logger = deps.logger;
    this.telemetryService = deps.telemetryService;
    this.credentialsService = deps.credentialsService;
    this.gitService = deps.gitService;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  public static async create(
    deps: HostedPullRequestServiceDeps,
  ): Promise<HostedPullRequestService> {
    return new HostedPullRequestService(deps);
  }

  public async getPullRequest(
    query: HostedPullRequestQuery,
  ): Promise<HostedPullRequestResult> {
    this.assertNotDisposed();
    const token = await this.getGitHubToken();
    const authenticated = token !== null;

    try {
      if (typeof query.url === 'string') {
        const reference = parseGitHubPullRequestUrl(query.url.trim());
        if (!reference) {
          let reason: HostedPullRequestUnavailableReason;
          try {
            const parsed = new URL(query.url);
            reason =
              parsed.hostname.toLowerCase() === 'github.com'
                ? 'invalid-query'
                : 'unsupported-provider';
          } catch {
            reason = 'invalid-query';
          }
          return {
            status: 'unavailable',
            reason,
            message:
              reason === 'unsupported-provider'
                ? 'Hosted review currently supports GitHub pull requests.'
                : 'Enter a GitHub pull request URL such as https://github.com/owner/repo/pull/123.',
            authenticated,
            retryable: false,
          };
        }
        const pullRequest = await this.loadPullRequest(reference, token, null);
        return { status: 'ready', pullRequest, authenticated };
      }

      const workspacePath = query.workspacePath.trim();
      if (!workspacePath) {
        return {
          status: 'unavailable',
          reason: 'invalid-query',
          message: 'Choose a workspace or enter a GitHub pull request URL.',
          authenticated,
          retryable: false,
        };
      }

      const worktree = await this.gitService.getWorktreeInfo(workspacePath);
      if (!worktree) {
        return {
          status: 'unavailable',
          reason: 'not-git-repository',
          message: 'The selected workspace is not a Git repository.',
          authenticated,
          retryable: false,
        };
      }
      if (!worktree.branch) {
        return {
          status: 'unavailable',
          reason: 'no-branch',
          message:
            'The selected workspace is in detached HEAD state, so Clodex cannot detect its pull request.',
          authenticated,
          retryable: false,
        };
      }

      const remotes = (
        await this.gitService.getRepositoryRemotes(workspacePath)
      )
        .map((remote) => ({
          ...remote,
          repository: remote.webUrl
            ? parseGitHubRepositoryUrl(remote.webUrl)
            : null,
        }))
        .filter(
          (
            remote,
          ): remote is typeof remote & {
            repository: GitHubRepositoryReference;
          } => remote.repository !== null,
        );

      if (remotes.length === 0) {
        return {
          status: 'unavailable',
          reason: 'no-github-remote',
          message:
            'No GitHub remote was found for this workspace. Add a github.com remote or enter a pull request URL.',
          authenticated,
          retryable: false,
        };
      }

      const origin =
        remotes.find((remote) => remote.remoteName === 'origin') ?? remotes[0]!;
      const candidateRepositories = [
        ...remotes.filter((remote) => remote.remoteName === 'upstream'),
        ...remotes.filter((remote) => remote.remoteName !== 'upstream'),
      ];
      let authFailure: GitHubApiFailure | null = null;

      for (const remote of candidateRepositories) {
        try {
          const candidates = await this.requestJson(
            `/repos/${encodeURIComponent(remote.repository.owner)}/${encodeURIComponent(
              remote.repository.repo,
            )}/pulls?state=all&head=${encodeURIComponent(
              `${origin.repository.owner}:${worktree.branch}`,
            )}&sort=updated&direction=desc&per_page=20`,
            token,
          );
          if (!Array.isArray(candidates) || candidates.length === 0) continue;

          const preferred =
            candidates.find((candidate) => {
              const pull = asRecord(candidate);
              return asString(pull.state) === 'open';
            }) ?? candidates[0];
          const number = asNumber(asRecord(preferred).number);
          if (!number) continue;

          const pullRequest = await this.loadPullRequest(
            {
              owner: remote.repository.owner,
              repo: remote.repository.repo,
              number,
            },
            token,
            workspacePath,
          );
          return { status: 'ready', pullRequest, authenticated };
        } catch (error) {
          if (
            error instanceof GitHubRequestError &&
            error.failure.kind === 'authentication-required'
          ) {
            authFailure = error.failure;
            continue;
          }
          throw error;
        }
      }

      if (authFailure) throw new GitHubRequestError(authFailure);
      return {
        status: 'unavailable',
        reason: 'not-found',
        message: `No hosted pull request was found for branch “${worktree.branch}”.`,
        authenticated,
        retryable: true,
      };
    } catch (error) {
      if (error instanceof GitHubRequestError) {
        return {
          status: 'unavailable',
          reason: error.failure.kind,
          message: error.failure.message,
          authenticated,
          retryable: error.failure.retryable,
        };
      }

      const normalized =
        error instanceof Error ? error : new Error(String(error));
      this.logger.warn('[HostedPullRequestService] Failed to load review', {
        error: normalized.message,
      });
      this.telemetryService.captureException(normalized, {
        service: 'hosted-pull-request',
        operation: 'getPullRequest',
      });
      return {
        status: 'unavailable',
        reason: 'provider-error',
        message: 'GitHub returned an unexpected response. Try again.',
        authenticated,
        retryable: true,
      };
    }
  }

  public async submitReview(
    input: HostedPullRequestSubmitReviewInput,
  ): Promise<HostedPullRequestSubmitReviewResult> {
    this.assertNotDisposed();
    const validation = normalizeReviewInput(input);
    if (!validation.ok) return validation.result;

    const submissionKey = createHash('sha256')
      .update(JSON.stringify(validation.input))
      .digest('hex');
    const existing = this.inFlightReviewSubmissions.get(submissionKey);
    if (existing) return existing;

    const submission = this.submitReviewOnce(validation.input);
    this.inFlightReviewSubmissions.set(submissionKey, submission);
    try {
      return await submission;
    } finally {
      if (this.inFlightReviewSubmissions.get(submissionKey) === submission) {
        this.inFlightReviewSubmissions.delete(submissionKey);
      }
    }
  }

  public async mergePullRequest(
    input: HostedPullRequestMergeInput,
  ): Promise<HostedPullRequestMergeResult> {
    this.assertNotDisposed();
    const validation = normalizeMergeInput(input);
    if (!validation.ok) return validation.result;

    const mergeKey = createHash('sha256')
      .update(JSON.stringify(validation.input))
      .digest('hex');
    const existing = this.inFlightMerges.get(mergeKey);
    if (existing) return existing;

    const merge = this.mergePullRequestOnce(validation.input);
    this.inFlightMerges.set(mergeKey, merge);
    try {
      return await merge;
    } finally {
      if (this.inFlightMerges.get(mergeKey) === merge) {
        this.inFlightMerges.delete(mergeKey);
      }
    }
  }

  private async mergePullRequestOnce(
    input: NormalizedHostedPullRequestMergeInput,
  ): Promise<HostedPullRequestMergeResult> {
    try {
      const token = await this.getGitHubToken();
      if (!token) {
        return mergeFailure(
          'authentication-required',
          'Add a GitHub Personal Access Token in Settings → Plugins before merging.',
          false,
        );
      }

      const reference: GitHubPullRequestReference = {
        owner: input.repository.owner,
        repo: input.repository.name,
        number: input.number,
      };
      const basePath = `/repos/${encodeURIComponent(
        reference.owner,
      )}/${encodeURIComponent(reference.repo)}`;
      const pullPath = `${basePath}/pulls/${reference.number}`;
      const pull = asRecord(await this.requestJson(pullPath, token));
      const headSha = asString(asRecord(pull.head).sha);
      const baseSha = asString(asRecord(pull.base).sha);

      if (
        headSha !== input.expectedHeadSha ||
        baseSha !== input.expectedBaseSha
      ) {
        return mergeFailure(
          'stale-head',
          headSha !== input.expectedHeadSha
            ? 'The pull request head changed after this review was opened. Refresh and review the latest commit before merging.'
            : 'The base branch changed after this review was opened. Refresh the pull request before merging.',
          true,
        );
      }

      const { policy } = await this.loadMergePolicy(reference, pull, token);
      if (policy.status !== 'ready') return mergePolicyFailure(policy);
      if (!policy.availableMethods.includes(input.method)) {
        return mergeFailure(
          'merge-method-not-allowed',
          `The ${input.method} merge method is no longer enabled for this repository. Refresh the pull request and choose an available method.`,
          true,
        );
      }

      const response = asRecord(
        await this.requestJson(`${pullPath}/merge`, token, {
          method: 'PUT',
          operation: 'merge',
          body: {
            sha: input.expectedHeadSha,
            merge_method: input.method,
          },
        }),
      );
      if (response.merged !== true) {
        return mergeFailure(
          'pull-request-not-mergeable',
          normalizeApiMessage(
            response,
            'GitHub did not merge the pull request. Refresh it and review the latest protection status.',
          ),
          true,
        );
      }

      return {
        ok: true,
        merged: true,
        mergeCommitSha: asNullableString(response.sha),
        message: normalizeApiMessage(
          response,
          'Pull request merged on GitHub.',
        ),
      };
    } catch (error) {
      if (error instanceof GitHubRequestError) {
        if (error.failure.status === 409) {
          return mergeFailure(
            'stale-head',
            'GitHub rejected the merge because the pull request changed. Refresh and review the latest commit.',
            true,
          );
        }
        if (error.failure.status === 405 || error.failure.status === 422) {
          return mergeFailure(
            'pull-request-not-mergeable',
            error.failure.message,
            true,
          );
        }
        return mergeFailure(
          error.failure.kind,
          error.failure.message,
          error.failure.retryable,
        );
      }

      const normalized =
        error instanceof Error ? error : new Error('Unknown merge error');
      this.logger.warn('[HostedPullRequestService] Merge failed unexpectedly', {
        errorName: normalized.name,
      });
      this.telemetryService.captureException(
        new Error('Hosted pull request merge failed unexpectedly.'),
        {
          service: 'hosted-pull-request',
          operation: 'mergePullRequest',
        },
      );
      return mergeFailure(
        'provider-error',
        'GitHub returned an unexpected response while merging. Refresh the pull request and try again.',
        true,
      );
    }
  }

  private async submitReviewOnce(
    input: NormalizedHostedPullRequestSubmitReviewInput,
  ): Promise<HostedPullRequestSubmitReviewResult> {
    try {
      const token = await this.getGitHubToken();
      if (!token) {
        return reviewFailure(
          'authentication-required',
          'Add a GitHub Personal Access Token in Settings → Plugins before submitting a review.',
          false,
        );
      }

      const basePath = `/repos/${encodeURIComponent(
        input.repository.owner,
      )}/${encodeURIComponent(input.repository.name)}`;
      const pullPath = `${basePath}/pulls/${input.number}`;
      const pull = asRecord(await this.requestJson(pullPath, token));
      const headSha = asString(asRecord(pull.head).sha);
      const merged = Boolean(pull.merged_at) || pull.merged === true;
      if (merged || asString(pull.state) !== 'open' || pull.draft === true) {
        return reviewFailure(
          'pull-request-not-reviewable',
          pull.draft === true
            ? 'This pull request is still a draft. Mark it ready for review on GitHub first.'
            : 'This pull request is no longer open for review.',
          false,
        );
      }
      if (!headSha || headSha !== input.commitId) {
        return reviewFailure(
          'stale-head',
          'The pull request changed after this review was opened. Refresh it and review the latest commit before submitting.',
          true,
        );
      }

      const files = await this.loadFiles(pullPath, token);
      const filesByPath = new Map(files.map((file) => [file.path, file]));
      for (const comment of input.comments) {
        const file = filesByPath.get(comment.path);
        if (
          !file?.patch ||
          !isHostedPullRequestPatchTarget(
            file.patch,
            comment.line,
            comment.side,
          ) ||
          (comment.startLine !== undefined &&
            comment.startSide !== undefined &&
            !isHostedPullRequestPatchTarget(
              file.patch,
              comment.startLine,
              comment.startSide,
            ))
        ) {
          return reviewFailure(
            'invalid-input',
            `The selected line in ${comment.path} is no longer available for review. Refresh the pull request and try again.`,
            true,
          );
        }
      }

      const response = asRecord(
        await this.requestJson(`${pullPath}/reviews`, token, {
          method: 'POST',
          operation: 'review',
          body: {
            commit_id: input.commitId,
            body: input.body,
            event: input.event,
            comments: input.comments.map((comment) => ({
              path: comment.path,
              line: comment.line,
              side: comment.side,
              body: comment.body,
              ...(comment.startLine !== undefined &&
              comment.startSide !== undefined
                ? {
                    start_line: comment.startLine,
                    start_side: comment.startSide,
                  }
                : {}),
            })),
          },
        }),
      );

      return {
        ok: true,
        reviewId:
          typeof response.id === 'number' && Number.isFinite(response.id)
            ? response.id
            : null,
        reviewUrl: asNullableString(response.html_url),
        state: asNullableString(response.state),
        submittedAt: asNullableString(response.submitted_at),
      };
    } catch (error) {
      if (error instanceof GitHubRequestError) {
        return reviewFailure(
          error.failure.kind,
          error.failure.message,
          error.failure.retryable,
        );
      }

      const normalized =
        error instanceof Error ? error : new Error('Unknown review error');
      this.logger.warn(
        '[HostedPullRequestService] Review submission failed unexpectedly',
        { errorName: normalized.name },
      );
      this.telemetryService.captureException(
        new Error('Hosted pull request review submission failed unexpectedly.'),
        {
          service: 'hosted-pull-request',
          operation: 'submitReview',
        },
      );
      return reviewFailure(
        'provider-error',
        'GitHub returned an unexpected response while submitting the review. Try again.',
        true,
      );
    }
  }

  private async loadMergePolicy(
    reference: GitHubPullRequestReference,
    pull: Record<string, unknown>,
    token: string | null,
  ): Promise<{
    policy: HostedPullRequestMergePolicy;
    checks: HostedPullRequestChecksSummary;
    files: HostedPullRequestFile[];
  }> {
    const basePath = `/repos/${encodeURIComponent(
      reference.owner,
    )}/${encodeURIComponent(reference.repo)}`;
    const pullPath = `${basePath}/pulls/${reference.number}`;
    const head = asRecord(pull.head);
    const base = asRecord(pull.base);
    const baseRepo = asRecord(base.repo);
    const headSha = asString(head.sha);
    const baseBranch = asString(base.ref);

    const [
      files,
      checkRuns,
      combinedStatus,
      repositoryValue,
      branchRulesValue,
    ] = await Promise.all([
      this.loadFiles(pullPath, token),
      headSha
        ? this.requestJson(`${basePath}/commits/${headSha}/check-runs`, token, {
            optional: true,
          })
        : null,
      headSha
        ? this.requestJson(`${basePath}/commits/${headSha}/status`, token, {
            optional: true,
          })
        : null,
      this.requestJson(basePath, token, { optional: true }),
      baseBranch
        ? this.requestJson(
            `${basePath}/rules/branches/${encodeURIComponent(baseBranch)}`,
            token,
            { optional: true },
          )
        : null,
    ]);

    const checks = summarizeChecks(checkRuns, combinedStatus);
    const repository =
      repositoryValue === null ? null : asRecord(repositoryValue);
    const repositoryPermissions =
      repository === null ? null : asRecord(repository.permissions);
    const allowedMethods: HostedPullRequestMergeMethod[] = [];
    if (repository?.allow_merge_commit === true) allowedMethods.push('merge');
    if (repository?.allow_squash_merge === true) allowedMethods.push('squash');
    if (repository?.allow_rebase_merge === true) allowedMethods.push('rebase');

    const branchRuleTypes = Array.isArray(branchRulesValue)
      ? branchRulesValue
          .map((rule) => asString(asRecord(rule).type).trim())
          .filter(Boolean)
      : null;
    const merged = Boolean(pull.merged_at) || pull.merged === true;
    const changedFiles = asNumber(pull.changed_files, files.length);
    const repositoryFullName = asString(
      baseRepo.full_name,
      `${reference.owner}/${reference.repo}`,
    );

    return {
      checks,
      files,
      policy: buildHostedPullRequestMergePolicy({
        authenticated: token !== null,
        repositoryFullName,
        number: reference.number,
        state: merged
          ? 'merged'
          : asString(pull.state) === 'open'
            ? 'open'
            : 'closed',
        draft: pull.draft === true,
        mergeable: typeof pull.mergeable === 'boolean' ? pull.mergeable : null,
        mergeState: asNullableString(pull.mergeable_state),
        checks,
        filesTruncated: files.length < changedFiles,
        repositorySettings:
          repository === null
            ? null
            : {
                canPush:
                  typeof repositoryPermissions?.push === 'boolean'
                    ? repositoryPermissions.push
                    : null,
                allowedMethods,
              },
        branchRuleTypes,
      }),
    };
  }

  private async loadPullRequest(
    reference: GitHubPullRequestReference,
    token: string | null,
    workspacePath: string | null,
  ): Promise<HostedPullRequest> {
    const basePath = `/repos/${encodeURIComponent(
      reference.owner,
    )}/${encodeURIComponent(reference.repo)}`;
    const pullPath = `${basePath}/pulls/${reference.number}`;
    const pullValue = await this.requestJson(pullPath, token);
    const pull = asRecord(pullValue);
    const head = asRecord(pull.head);
    const base = asRecord(pull.base);
    const headRepo = asRecord(head.repo);
    const baseRepo = asRecord(base.repo);
    const headSha = asString(head.sha);

    const { checks, files, policy } = await this.loadMergePolicy(
      reference,
      pull,
      token,
    );

    const user = asRecord(pull.user);
    const repositoryFullName = asString(
      baseRepo.full_name,
      `${reference.owner}/${reference.repo}`,
    );
    const merged = Boolean(pull.merged_at) || pull.merged === true;
    const changedFiles = asNumber(pull.changed_files, files.length);

    return {
      provider: 'github',
      repository: {
        owner: reference.owner,
        name: reference.repo,
        fullName: asString(
          baseRepo.full_name,
          `${reference.owner}/${reference.repo}`,
        ),
        url: asString(
          baseRepo.html_url,
          `https://github.com/${reference.owner}/${reference.repo}`,
        ),
      },
      number: reference.number,
      url: asString(
        pull.html_url,
        `https://github.com/${reference.owner}/${reference.repo}/pull/${reference.number}`,
      ),
      title: asString(pull.title, `Pull request #${reference.number}`),
      body: asNullableString(pull.body),
      state: merged
        ? 'merged'
        : asString(pull.state) === 'open'
          ? 'open'
          : 'closed',
      draft: pull.draft === true,
      mergeable: typeof pull.mergeable === 'boolean' ? pull.mergeable : null,
      mergeState: asNullableString(pull.mergeable_state),
      author: {
        login: asString(user.login, 'unknown'),
        avatarUrl: asNullableString(user.avatar_url),
        profileUrl: asString(user.html_url, 'https://github.com'),
      },
      head: {
        label: asString(head.label),
        branch: asString(head.ref),
        sha: headSha,
        repositoryFullName: asString(headRepo.full_name, repositoryFullName),
      },
      base: {
        label: asString(base.label),
        branch: asString(base.ref),
        sha: asString(base.sha),
        repositoryFullName: asString(baseRepo.full_name, repositoryFullName),
      },
      createdAt: asString(pull.created_at),
      updatedAt: asString(pull.updated_at),
      additions: asNumber(pull.additions),
      deletions: asNumber(pull.deletions),
      changedFiles,
      commits: asNumber(pull.commits),
      comments: asNumber(pull.comments),
      reviewComments: asNumber(pull.review_comments),
      checks,
      files,
      filesTruncated: files.length < changedFiles,
      detectedFromWorkspace: workspacePath,
      mergePolicy: policy,
    };
  }

  private async loadFiles(
    pullPath: string,
    token: string | null,
  ): Promise<HostedPullRequestFile[]> {
    const files: HostedPullRequestFile[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const value = await this.requestJson(
        `${pullPath}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
        token,
      );
      if (!Array.isArray(value)) break;
      files.push(...value.map(mapPullRequestFile));
      if (value.length < FILES_PER_PAGE) break;
    }
    return files;
  }

  private async requestJson(
    apiPath: string,
    token: string | null,
    options?: GitHubRequestOptions,
  ): Promise<unknown> {
    const method = options?.method ?? 'GET';
    let response: Response;
    try {
      response = await this.fetchImpl(`${GITHUB_API_ORIGIN}${apiPath}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Clodex-Desktop',
          ...(options?.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(options?.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      });
    } catch (error) {
      if (options?.optional) return null;
      throw new GitHubRequestError({
        kind: 'network-error',
        message:
          error instanceof Error && error.name === 'TimeoutError'
            ? 'GitHub did not respond in time. Try again.'
            : 'Clodex could not reach GitHub. Check your connection and try again.',
        retryable: true,
        status: null,
      });
    }

    const body = await response.json().catch(() => null);
    if (response.ok) return body;
    if (options?.optional) return null;

    if (
      response.status === 403 &&
      response.headers.get('x-ratelimit-remaining') === '0'
    ) {
      throw new GitHubRequestError({
        kind: 'rate-limited',
        message:
          'GitHub API rate limit reached. Add a GitHub Personal Access Token in Settings → Plugins or try again later.',
        retryable: true,
        status: response.status,
      });
    }
    if (response.status === 401) {
      throw new GitHubRequestError({
        kind: 'authentication-required',
        message:
          'The configured GitHub Personal Access Token is invalid or expired. Update it in Settings → Plugins.',
        retryable: false,
        status: response.status,
      });
    }
    if (
      response.status === 403 &&
      (options?.operation === 'review' || options?.operation === 'merge')
    ) {
      throw new GitHubRequestError({
        kind: 'permission-denied',
        message:
          options.operation === 'merge'
            ? 'GitHub denied permission to merge this pull request. Check that the Personal Access Token can write repository contents and that branch protection permits the merge.'
            : 'GitHub denied permission to submit this review. Check that the Personal Access Token can write pull request reviews.',
        retryable: false,
        status: response.status,
      });
    }
    if (response.status === 404) {
      throw new GitHubRequestError({
        kind: token ? 'not-found' : 'authentication-required',
        message: token
          ? 'GitHub could not find this pull request or the token does not have access to it.'
          : 'This pull request may be private. Add a GitHub Personal Access Token in Settings → Plugins.',
        retryable: false,
        status: response.status,
      });
    }
    if (options?.operation === 'review' || options?.operation === 'merge') {
      throw new GitHubRequestError({
        kind: 'provider-error',
        message:
          options.operation === 'merge'
            ? normalizeApiMessage(
                body,
                `GitHub could not merge the pull request (status ${response.status}). Refresh and try again.`,
              )
            : response.status === 422
              ? 'GitHub rejected the review. Refresh the pull request and verify the selected lines before trying again.'
              : `GitHub could not submit the review (status ${response.status}). Try again.`,
        retryable: response.status >= 500 || response.status === 422,
        status: response.status,
      });
    }
    throw new GitHubRequestError({
      kind: 'provider-error',
      message: normalizeApiMessage(
        body,
        `GitHub request failed with status ${response.status}.`,
      ),
      retryable: response.status >= 500,
      status: response.status,
    });
  }

  private async getGitHubToken(): Promise<string | null> {
    const credential = await this.credentialsService.resolve('github-pat');
    if (!credential) return null;
    const placeholder = credential.data.token;
    return placeholder
      ? (credential.secretMap.get(placeholder)?.value ?? null)
      : null;
  }

  protected onTeardown(): void {
    this.logger.debug('[HostedPullRequestService] Teardown complete');
  }
}
