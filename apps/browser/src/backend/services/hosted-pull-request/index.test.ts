import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialsService } from '@/services/credentials';
import type { GitService } from '@/services/git';
import type { Logger } from '@/services/logger';
import type { TelemetryService } from '@/services/telemetry';
import type {
  HostedPullRequestMergeInput,
  HostedPullRequestSubmitReviewInput,
} from '@shared/hosted-pull-request';
import { HostedPullRequestService, parseGitHubPullRequestUrl } from './index';

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
} as unknown as Logger;

const telemetryService = {
  captureException: vi.fn(),
} as unknown as TelemetryService;

function githubResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function pullFixture(number = 42) {
  return {
    number,
    html_url: `https://github.com/mereyabdenbekuly-ctrl/clodex-ide/pull/${number}`,
    title: 'Add hosted review',
    body: 'Review the changes from inside Clodex.',
    state: 'open',
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: 'clean',
    user: {
      login: 'octocat',
      avatar_url: 'https://avatars.githubusercontent.com/u/1',
      html_url: 'https://github.com/octocat',
    },
    head: {
      label: 'octocat:feature/review',
      ref: 'feature/review',
      sha: 'head-sha',
      repo: {
        full_name: 'octocat/clodex',
      },
    },
    base: {
      label: 'mereyabdenbekuly-ctrl:main',
      ref: 'main',
      sha: 'base-sha',
      repo: {
        full_name: 'mereyabdenbekuly-ctrl/clodex-ide',
        html_url: 'https://github.com/mereyabdenbekuly-ctrl/clodex-ide',
      },
    },
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-10T10:00:00Z',
    additions: 18,
    deletions: 4,
    changed_files: 1,
    commits: 2,
    comments: 3,
    review_comments: 1,
  };
}

function createCredentialsService(token: string | null): CredentialsService {
  return {
    resolve: vi.fn(async () => {
      if (!token) return null;
      const placeholder = '{{CRED:github-pat:token:test}}';
      return {
        data: { token: placeholder },
        secretMap: new Map([
          [
            placeholder,
            { value: token, allowedOrigins: ['https://api.github.com'] },
          ],
        ]),
      };
    }),
  } as unknown as CredentialsService;
}

function createGitService(overrides?: Partial<GitService>): GitService {
  return {
    getWorktreeInfo: vi.fn(async () => ({
      worktreeId: '/repo',
      path: '/repo',
      branch: 'feature/review',
      headSha: 'head-sha',
      isDetached: false,
      isMainWorktree: true,
      createdAt: null,
    })),
    getRepositoryRemotes: vi.fn(async () => [
      {
        remoteName: 'origin',
        url: 'git@github.com:octocat/clodex.git',
        webUrl: 'https://github.com/octocat/clodex',
      },
      {
        remoteName: 'upstream',
        url: 'git@github.com:mereyabdenbekuly-ctrl/clodex-ide.git',
        webUrl: 'https://github.com/mereyabdenbekuly-ctrl/clodex-ide',
      },
    ]),
    ...overrides,
  } as unknown as GitService;
}

function createFetchMock(options?: {
  pull?: ReturnType<typeof pullFixture>;
  reviewResponse?: unknown;
  mergeResponse?: unknown;
  repository?: Record<string, unknown>;
  branchRules?: readonly unknown[] | null;
  checkRuns?: unknown;
  combinedStatus?: unknown;
}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/pulls/42/merge') && init?.method === 'PUT') {
      return githubResponse(
        options?.mergeResponse ?? {
          sha: 'merge-sha',
          merged: true,
          message: 'Pull Request successfully merged',
        },
      );
    }
    if (url.pathname.endsWith('/pulls/42/reviews') && init?.method === 'POST') {
      return githubResponse(
        options?.reviewResponse ?? {
          id: 91,
          html_url:
            'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/pull/42#pullrequestreview-91',
          state: 'COMMENTED',
          submitted_at: '2026-07-10T12:30:00Z',
        },
      );
    }
    if (url.pathname.endsWith('/pulls/42')) {
      return githubResponse(options?.pull ?? pullFixture());
    }
    if (url.pathname.endsWith('/pulls/42/files')) {
      return githubResponse([
        {
          sha: 'file-sha',
          filename: 'src/review.ts',
          status: 'modified',
          additions: 18,
          deletions: 4,
          changes: 22,
          patch: '@@ -1 +1 @@\n-old\n+new',
          blob_url:
            'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/blob/head/src/review.ts',
          raw_url: 'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/raw/head/src/review.ts',
        },
      ]);
    }
    if (url.pathname.endsWith('/commits/head-sha/check-runs')) {
      return githubResponse(
        options?.checkRuns ?? {
          check_runs: [
            {
              id: 1,
              name: 'Typecheck',
              status: 'completed',
              conclusion: 'success',
              details_url: 'https://github.com/checks/1',
              app: { name: 'CI' },
              output: { summary: 'Passed' },
            },
          ],
        },
      );
    }
    if (url.pathname.endsWith('/commits/head-sha/status')) {
      return githubResponse(
        options?.combinedStatus ?? {
          statuses: [
            {
              context: 'deploy-preview',
              state: 'failure',
              target_url: 'https://github.com/status/1',
              description: 'Preview failed',
            },
          ],
        },
      );
    }
    if (url.pathname.endsWith('/rules/branches/main')) {
      return options?.branchRules === null
        ? githubResponse({ message: 'Not Found' }, { status: 404 })
        : githubResponse(
            options?.branchRules ?? [
              { type: 'pull_request' },
              { type: 'required_status_checks' },
            ],
          );
    }
    if (url.pathname === '/repos/mereyabdenbekuly-ctrl/clodex-ide') {
      return githubResponse(
        options?.repository ?? {
          allow_merge_commit: true,
          allow_squash_merge: true,
          allow_rebase_merge: true,
          permissions: {
            push: true,
          },
        },
      );
    }
    throw new Error(`Unexpected request: ${url.toString()}`);
  });
}

function reviewInput(
  overrides?: Partial<HostedPullRequestSubmitReviewInput>,
): HostedPullRequestSubmitReviewInput {
  return {
    repository: { owner: 'mereyabdenbekuly-ctrl', name: 'clodex' },
    number: 42,
    commitId: 'head-sha',
    event: 'COMMENT',
    body: 'Review summary',
    comments: [
      {
        path: 'src/review.ts',
        line: 1,
        side: 'RIGHT',
        body: 'Please keep this branch covered by a test.',
      },
    ],
    ...overrides,
  };
}

function mergeInput(
  overrides?: Partial<HostedPullRequestMergeInput>,
): HostedPullRequestMergeInput {
  return {
    repository: { owner: 'mereyabdenbekuly-ctrl', name: 'clodex' },
    number: 42,
    expectedHeadSha: 'head-sha',
    expectedBaseSha: 'base-sha',
    method: 'squash',
    confirmationText: 'mereyabdenbekuly-ctrl/clodex-ide#42',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseGitHubPullRequestUrl', () => {
  it('parses a canonical GitHub pull request URL', () => {
    expect(
      parseGitHubPullRequestUrl(
        'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/pull/42/files',
      ),
    ).toEqual({ owner: 'mereyabdenbekuly-ctrl', repo: 'clodex', number: 42 });
  });

  it('rejects non-GitHub and malformed URLs', () => {
    expect(
      parseGitHubPullRequestUrl('https://gitlab.com/a/b/pull/1'),
    ).toBeNull();
    expect(
      parseGitHubPullRequestUrl('https://github.com/a/b/issues/1'),
    ).toBeNull();
  });
});

describe('HostedPullRequestService', () => {
  it('loads pull request metadata, files, and checks by URL', async () => {
    const fetchImpl = createFetchMock();
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService('secret-token'),
      gitService: createGitService(),
      fetchImpl,
    });

    const result = await service.getPullRequest({
      url: 'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/pull/42',
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.authenticated).toBe(true);
    expect(result.pullRequest).toMatchObject({
      number: 42,
      title: 'Add hosted review',
      state: 'open',
      additions: 18,
      deletions: 4,
      changedFiles: 1,
      filesTruncated: false,
    });
    expect(result.pullRequest.files[0]).toMatchObject({
      path: 'src/review.ts',
      status: 'modified',
      patch: '@@ -1 +1 @@\n-old\n+new',
    });
    expect(result.pullRequest.checks).toMatchObject({
      total: 2,
      successful: 1,
      failed: 1,
    });
    expect(result.pullRequest.mergePolicy).toMatchObject({
      status: 'blocked',
      confirmationText: 'mereyabdenbekuly-ctrl/clodex-ide#42',
      defaultMethod: 'squash',
      availableMethods: ['merge', 'squash', 'rebase'],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token',
        }),
      }),
    );
  });

  it('detects a fork pull request against the upstream remote', async () => {
    const fetchImpl = createFetchMock();
    fetchImpl.mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/pulls') && url.searchParams.has('head')) {
        expect(url.pathname).toBe('/repos/mereyabdenbekuly-ctrl/clodex-ide/pulls');
        expect(url.searchParams.get('head')).toBe('octocat:feature/review');
        return githubResponse([{ number: 42, state: 'open' }]);
      }
      return createFetchMock()(input);
    });
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService(null),
      gitService: createGitService(),
      fetchImpl,
    });

    const result = await service.getPullRequest({
      workspacePath: '/repo',
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.pullRequest.detectedFromWorkspace).toBe('/repo');
    expect(result.pullRequest.repository.fullName).toBe('mereyabdenbekuly-ctrl/clodex-ide');
  });

  it('returns an authentication state for an inaccessible private PR', async () => {
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService(null),
      gitService: createGitService(),
      fetchImpl: vi.fn(async () =>
        githubResponse(
          { message: 'Not Found' },
          {
            status: 404,
          },
        ),
      ),
    });

    await expect(
      service.getPullRequest({
        url: 'https://github.com/private/repository/pull/8',
      }),
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'authentication-required',
      authenticated: false,
      retryable: false,
    });
  });

  it('submits a comment review with the current head and inline comments', async () => {
    const fetchImpl = createFetchMock();
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService('secret-token'),
      gitService: createGitService(),
      fetchImpl,
    });

    await expect(service.submitReview(reviewInput())).resolves.toEqual({
      ok: true,
      reviewId: 91,
      reviewUrl:
        'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/pull/42#pullrequestreview-91',
      state: 'COMMENTED',
      submittedAt: '2026-07-10T12:30:00Z',
    });

    const reviewCall = fetchImpl.mock.calls.find(([input, init]) => {
      const url = new URL(String(input));
      return (
        url.pathname.endsWith('/pulls/42/reviews') && init?.method === 'POST'
      );
    });
    expect(reviewCall).toBeDefined();
    expect(reviewCall?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      }),
    });
    expect(JSON.parse(String(reviewCall?.[1]?.body))).toEqual({
      commit_id: 'head-sha',
      body: 'Review summary',
      event: 'COMMENT',
      comments: [
        {
          path: 'src/review.ts',
          line: 1,
          side: 'RIGHT',
          body: 'Please keep this branch covered by a test.',
        },
      ],
    });
  });

  it.each([
    ['APPROVE', 'Looks good to me.'],
    ['REQUEST_CHANGES', 'Please address the inline comment.'],
  ] as const)('submits a %s review event', async (event, body) => {
    const fetchImpl = createFetchMock({
      reviewResponse: {
        id: 92,
        state: event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED',
      },
    });
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService('secret-token'),
      gitService: createGitService(),
      fetchImpl,
    });

    const result = await service.submitReview(
      reviewInput({ event, body, comments: [] }),
    );

    expect(result).toMatchObject({ ok: true, reviewId: 92 });
    const reviewCall = fetchImpl.mock.calls.find(
      ([input, init]) =>
        new URL(String(input)).pathname.endsWith('/pulls/42/reviews') &&
        init?.method === 'POST',
    );
    expect(JSON.parse(String(reviewCall?.[1]?.body))).toMatchObject({
      event,
      body,
      comments: [],
    });
  });

  it('requires an authenticated GitHub token before writing', async () => {
    const fetchImpl = createFetchMock();
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService(null),
      gitService: createGitService(),
      fetchImpl,
    });

    await expect(service.submitReview(reviewInput())).resolves.toMatchObject({
      ok: false,
      reason: 'authentication-required',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a review when the pull request head changed', async () => {
    const stalePull = pullFixture();
    stalePull.head.sha = 'new-head-sha';
    const fetchImpl = createFetchMock({ pull: stalePull });
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService('secret-token'),
      gitService: createGitService(),
      fetchImpl,
    });

    await expect(service.submitReview(reviewInput())).resolves.toMatchObject({
      ok: false,
      reason: 'stale-head',
      retryable: true,
    });
    expect(
      fetchImpl.mock.calls.some(
        ([input]) =>
          new URL(String(input)).pathname ===
          '/repos/mereyabdenbekuly-ctrl/clodex-ide/pulls/42/reviews',
      ),
    ).toBe(false);
  });

  it.each([
    [
      'closed',
      {
        ...pullFixture(),
        state: 'closed',
      },
    ],
    [
      'draft',
      {
        ...pullFixture(),
        draft: true,
      },
    ],
  ])('rejects a %s pull request before writing', async (_label, pull) => {
    const fetchImpl = createFetchMock({ pull });
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService('secret-token'),
      gitService: createGitService(),
      fetchImpl,
    });

    await expect(service.submitReview(reviewInput())).resolves.toMatchObject({
      ok: false,
      reason: 'pull-request-not-reviewable',
      retryable: false,
    });
    expect(
      fetchImpl.mock.calls.some(
        ([input]) =>
          new URL(String(input)).pathname ===
          '/repos/mereyabdenbekuly-ctrl/clodex-ide/pulls/42/reviews',
      ),
    ).toBe(false);
  });

  it.each([
    [
      'an unknown file',
      {
        path: 'src/missing.ts',
        line: 1,
        side: 'RIGHT' as const,
        body: 'Missing file',
      },
    ],
    [
      'a non-commentable line',
      {
        path: 'src/review.ts',
        line: 99,
        side: 'RIGHT' as const,
        body: 'Missing line',
      },
    ],
  ])('rejects %s before creating a review', async (_label, comment) => {
    const fetchImpl = createFetchMock();
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService('secret-token'),
      gitService: createGitService(),
      fetchImpl,
    });

    await expect(
      service.submitReview(reviewInput({ comments: [comment] })),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-input',
    });
    expect(
      fetchImpl.mock.calls.some(
        ([input]) =>
          new URL(String(input)).pathname ===
          '/repos/mereyabdenbekuly-ctrl/clodex-ide/pulls/42/reviews',
      ),
    ).toBe(false);
  });

  it('maps GitHub write permission failures without exposing provider data', async () => {
    const readFetch = createFetchMock();
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return githubResponse(
            { message: 'Resource not accessible by personal access token' },
            { status: 403 },
          );
        }
        return readFetch(input, init);
      },
    );
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService('secret-token'),
      gitService: createGitService(),
      fetchImpl,
    });

    await expect(service.submitReview(reviewInput())).resolves.toMatchObject({
      ok: false,
      reason: 'permission-denied',
      retryable: false,
    });
  });

  it('maps GitHub rate limits for review submission', async () => {
    const readFetch = createFetchMock();
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return githubResponse(
            { message: 'API rate limit exceeded' },
            {
              status: 403,
              headers: { 'x-ratelimit-remaining': '0' },
            },
          );
        }
        return readFetch(input, init);
      },
    );
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService('secret-token'),
      gitService: createGitService(),
      fetchImpl,
    });

    await expect(service.submitReview(reviewInput())).resolves.toMatchObject({
      ok: false,
      reason: 'rate-limited',
      retryable: true,
    });
  });

  it('coalesces identical in-flight submissions', async () => {
    let releaseReview: ((response: Response) => void) | undefined;
    const pendingReview = new Promise<Response>((resolve) => {
      releaseReview = resolve;
    });
    const readFetch = createFetchMock();
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') return pendingReview;
        return readFetch(input, init);
      },
    );
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService('secret-token'),
      gitService: createGitService(),
      fetchImpl,
    });

    const first = service.submitReview(reviewInput());
    const second = service.submitReview(reviewInput());
    await vi.waitFor(() => {
      expect(
        fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST'),
      ).toHaveLength(1);
    });
    releaseReview?.(
      githubResponse({
        id: 93,
        state: 'COMMENTED',
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true, reviewId: 93 }),
      expect.objectContaining({ ok: true, reviewId: 93 }),
    ]);
  });

  it('merges with the selected method only after every protected gate passes', async () => {
    const fetchImpl = createFetchMock({
      combinedStatus: {
        statuses: [
          {
            context: 'deploy-preview',
            state: 'success',
          },
        ],
      },
    });
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService('secret-token'),
      gitService: createGitService(),
      fetchImpl,
    });

    await expect(service.mergePullRequest(mergeInput())).resolves.toEqual({
      ok: true,
      merged: true,
      mergeCommitSha: 'merge-sha',
      message: 'Pull Request successfully merged',
    });

    const mergeCall = fetchImpl.mock.calls.find(
      ([input, init]) =>
        new URL(String(input)).pathname.endsWith('/pulls/42/merge') &&
        init?.method === 'PUT',
    );
    expect(mergeCall?.[1]).toMatchObject({
      method: 'PUT',
      headers: expect.objectContaining({
        Authorization: 'Bearer secret-token',
        'Content-Type': 'application/json',
      }),
    });
    expect(JSON.parse(String(mergeCall?.[1]?.body))).toEqual({
      sha: 'head-sha',
      merge_method: 'squash',
    });
  });

  it('rejects an invalid merge confirmation before reading GitHub', async () => {
    const fetchImpl = createFetchMock();
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService('secret-token'),
      gitService: createGitService(),
      fetchImpl,
    });

    await expect(
      service.mergePullRequest(
        mergeInput({ confirmationText: 'mereyabdenbekuly-ctrl/clodex-ide' }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-input',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires an authenticated GitHub token before protected merge reads', async () => {
    const fetchImpl = createFetchMock();
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService(null),
      gitService: createGitService(),
      fetchImpl,
    });

    await expect(service.mergePullRequest(mergeInput())).resolves.toMatchObject(
      {
        ok: false,
        reason: 'authentication-required',
        retryable: false,
      },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects merge when the reviewed head or base changed', async () => {
    const changedPull = pullFixture();
    changedPull.base.sha = 'new-base-sha';
    const fetchImpl = createFetchMock({ pull: changedPull });
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService('secret-token'),
      gitService: createGitService(),
      fetchImpl,
    });

    await expect(service.mergePullRequest(mergeInput())).resolves.toMatchObject(
      {
        ok: false,
        reason: 'stale-head',
        retryable: true,
      },
    );
    expect(
      fetchImpl.mock.calls.some(
        ([input, init]) =>
          new URL(String(input)).pathname.endsWith('/pulls/42/merge') &&
          init?.method === 'PUT',
      ),
    ).toBe(false);
  });

  it.each([
    ['failed checks', {}, 'checks-not-passing'],
    [
      'unavailable branch rules',
      {
        combinedStatus: { statuses: [] },
        branchRules: null,
      },
      'branch-rules-unavailable',
    ],
    [
      'required merge queue',
      {
        combinedStatus: { statuses: [] },
        branchRules: [{ type: 'merge_queue' }],
      },
      'merge-queue-required',
    ],
    [
      'missing repository write permission',
      {
        combinedStatus: { statuses: [] },
        repository: {
          allow_squash_merge: true,
          permissions: { push: false },
        },
      },
      'permission-denied',
    ],
  ] as const)('blocks merge for %s before writing', async (_label, options, reason) => {
    const fetchImpl = createFetchMock(options);
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService('secret-token'),
      gitService: createGitService(),
      fetchImpl,
    });

    await expect(service.mergePullRequest(mergeInput())).resolves.toMatchObject(
      {
        ok: false,
        reason,
      },
    );
    expect(
      fetchImpl.mock.calls.some(
        ([input, init]) =>
          new URL(String(input)).pathname.endsWith('/pulls/42/merge') &&
          init?.method === 'PUT',
      ),
    ).toBe(false);
  });

  it('re-checks that the selected merge method is still enabled', async () => {
    const fetchImpl = createFetchMock({
      combinedStatus: { statuses: [] },
      repository: {
        allow_merge_commit: false,
        allow_squash_merge: true,
        allow_rebase_merge: false,
        permissions: { push: true },
      },
    });
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService('secret-token'),
      gitService: createGitService(),
      fetchImpl,
    });

    await expect(
      service.mergePullRequest(mergeInput({ method: 'rebase' })),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'merge-method-not-allowed',
      retryable: true,
    });
    expect(
      fetchImpl.mock.calls.some(([, init]) => init?.method === 'PUT'),
    ).toBe(false);
  });

  it('coalesces identical in-flight protected merge requests', async () => {
    let releaseMerge: ((response: Response) => void) | undefined;
    const pendingMerge = new Promise<Response>((resolve) => {
      releaseMerge = resolve;
    });
    const readFetch = createFetchMock({
      combinedStatus: { statuses: [] },
    });
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PUT') return pendingMerge;
        return readFetch(input, init);
      },
    );
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: createCredentialsService('secret-token'),
      gitService: createGitService(),
      fetchImpl,
    });

    const first = service.mergePullRequest(mergeInput());
    const second = service.mergePullRequest(mergeInput());
    await vi.waitFor(() => {
      expect(
        fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PUT'),
      ).toHaveLength(1);
    });
    releaseMerge?.(
      githubResponse({
        sha: 'merge-sha',
        merged: true,
        message: 'Merged',
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true, mergeCommitSha: 'merge-sha' }),
      expect.objectContaining({ ok: true, mergeCommitSha: 'merge-sha' }),
    ]);
  });

  it('does not copy review content into logs or telemetry on unexpected errors', async () => {
    const sensitiveSummary = 'PRIVATE REVIEW SUMMARY';
    const sensitiveComment = 'PRIVATE INLINE COMMENT';
    const service = await HostedPullRequestService.create({
      logger,
      telemetryService,
      credentialsService: {
        resolve: vi.fn(async () => {
          throw new Error(`${sensitiveSummary} ${sensitiveComment}`);
        }),
      } as unknown as CredentialsService,
      gitService: createGitService(),
      fetchImpl: createFetchMock(),
    });

    await service.submitReview(
      reviewInput({
        body: sensitiveSummary,
        comments: [
          {
            path: 'src/review.ts',
            line: 1,
            side: 'RIGHT',
            body: sensitiveComment,
          },
        ],
      }),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      '[HostedPullRequestService] Review submission failed unexpectedly',
      { errorName: 'Error' },
    );
    expect(telemetryService.captureException).toHaveBeenCalled();
    const diagnosticOutput = JSON.stringify({
      logger: (logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      telemetry: (telemetryService.captureException as ReturnType<typeof vi.fn>)
        .mock.calls,
    });
    expect(diagnosticOutput).not.toContain(sensitiveSummary);
    expect(diagnosticOutput).not.toContain(sensitiveComment);
  });
});
