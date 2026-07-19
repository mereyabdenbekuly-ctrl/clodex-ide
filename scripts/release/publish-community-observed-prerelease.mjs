#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertProtectedDraftState,
  collectReleaseAssets,
  stageProtectedReleaseDraft,
} from './create-protected-release-draft.mjs';
import { verifyPublicationCandidate } from './community-observed-publication.mjs';

export const COMMUNITY_OBSERVED_PUBLISH_CONFIRMATION =
  'PUBLISH_COMMUNITY_OBSERVED_PRERELEASE';
export const COMMUNITY_OBSERVED_IMMUTABILITY_CONFIRMATION =
  'RELEASE_IMMUTABILITY_ENABLED';
export const COMMUNITY_OBSERVED_REDISTRIBUTION_CONFIRMATION =
  'COMMUNITY_OBSERVED_REDISTRIBUTION_APPROVED';

const API_ORIGIN = 'https://api.github.com';
const UPLOAD_ORIGIN = 'https://uploads.github.com';
const API_VERSION = '2026-03-10';
const EXPECTED_REPOSITORY = 'mereyabdenbekuly-ctrl/clodex-ide';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+@()-]*$/u;
const MAX_RELEASE_PAGES = 1_000;
const RELEASE_PAGE_SIZE = 100;

function fail(message, options) {
  throw new Error(message, options);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertRepository(value) {
  assert(REPOSITORY_PATTERN.test(value ?? ''), 'repository must be owner/name');
  assert(
    value === EXPECTED_REPOSITORY,
    `repository must be the canonical ${EXPECTED_REPOSITORY}`,
  );
  return value;
}

function assertSourceCommit(value) {
  assert(
    SOURCE_COMMIT_PATTERN.test(value ?? ''),
    'source commit must be an exact lowercase 40-character SHA',
  );
  return value;
}

function assertPositiveInteger(value, label) {
  assert(Number.isSafeInteger(value) && value > 0, `${label} is invalid`);
  return value;
}

function assertSafeFileName(value) {
  assert(
    typeof value === 'string' &&
      SAFE_FILE_NAME.test(value) &&
      value === path.basename(value) &&
      !/[\\/\r\n\0]/u.test(value),
    `unsafe release asset filename: ${String(value ?? '<missing>')}`,
  );
  return value;
}

function expectedAssetsByName(assets) {
  assert(
    Array.isArray(assets) && assets.length === 7,
    'exactly seven staged assets are required',
  );
  const map = new Map();
  for (const asset of assets) {
    const name = assertSafeFileName(asset.name);
    assert(!map.has(name), `duplicate staged asset: ${name}`);
    assert(
      Number.isSafeInteger(asset.bytes) &&
        asset.bytes > 0 &&
        SHA256_PATTERN.test(asset.sha256),
      `staged asset metadata is invalid: ${name}`,
    );
    map.set(name, asset);
  }
  return map;
}

function assertExactReleaseAssets(release, expectedAssets, repository) {
  const expected = expectedAssetsByName(expectedAssets);
  assert(
    Array.isArray(release?.assets),
    'GitHub Release assets are unavailable',
  );
  assert(
    release.assets.length === 7,
    'GitHub Release must contain exactly seven assets',
  );
  const observed = new Set();
  for (const asset of release.assets) {
    const name = assertSafeFileName(asset?.name);
    const record = expected.get(name);
    assert(
      record && !observed.has(name),
      `unexpected or duplicate GitHub Release asset: ${name}`,
    );
    observed.add(name);
    assert(
      Number.isSafeInteger(asset?.id) &&
        asset.id > 0 &&
        asset.state === 'uploaded' &&
        asset.size === record.bytes &&
        asset.digest === `sha256:${record.sha256}`,
      `GitHub Release asset digest differs: ${name}`,
    );
    assert(
      asset.url ===
        `${API_ORIGIN}/repos/${repository}/releases/assets/${asset.id}`,
      `GitHub Release asset URL is invalid: ${name}`,
    );
  }
  assert(observed.size === expected.size, 'GitHub Release asset set differs');
}

function assertReleaseHtmlUrl(value, repository, tag, state) {
  assert(typeof value === 'string', 'GitHub Release HTML URL is missing');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('GitHub Release HTML URL is invalid');
  }
  assert(
    parsed.origin === 'https://github.com' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === '',
    'GitHub Release HTML URL origin is invalid',
  );
  if (state === 'draft') {
    const prefix = `/${repository}/releases/tag/untagged-`;
    const suffix = parsed.pathname.startsWith(prefix)
      ? parsed.pathname.slice(prefix.length)
      : '';
    assert(
      /^[A-Za-z0-9_-]{8,128}$/u.test(suffix),
      'GitHub draft Release HTML URL is invalid',
    );
  } else {
    assert(
      parsed.pathname === `/${repository}/releases/tag/${tag}`,
      'GitHub published Release HTML URL is invalid',
    );
  }
  return value;
}

function assertReleaseIdentity({
  body,
  expectedAssets,
  manifest,
  release,
  releaseId,
  repository,
  sourceCommit,
  state,
}) {
  assertPositiveInteger(releaseId, 'release ID');
  assert(
    release?.id === releaseId &&
      release?.url ===
        `${API_ORIGIN}/repos/${repository}/releases/${releaseId}` &&
      release?.tag_name === manifest.release.tag &&
      release?.target_commitish === sourceCommit &&
      release?.name === manifest.release.name &&
      release?.body === body &&
      release?.prerelease === true,
    'GitHub Release identity differs from the validated publication',
  );
  assertReleaseHtmlUrl(
    release.html_url,
    repository,
    manifest.release.tag,
    state,
  );
  if (state === 'draft') {
    assert(
      release.draft === true &&
        release.published_at === null &&
        release.immutable === false,
      'GitHub Release is not the exact mutable draft',
    );
  } else {
    assert(
      release.draft === false &&
        typeof release.published_at === 'string' &&
        Number.isFinite(Date.parse(release.published_at)) &&
        release.immutable === true,
      'GitHub Release is not the exact immutable public prerelease',
    );
  }
  assertExactReleaseAssets(release, expectedAssets, repository);
  return release;
}

export class CommunityObservedReleaseApi {
  constructor({
    fetchImpl = globalThis.fetch,
    token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  } = {}) {
    assert(typeof fetchImpl === 'function', 'fetch implementation is required');
    assert(
      typeof token === 'string' && token.length > 0 && !/[\r\n\0]/u.test(token),
      'GH_TOKEN is required',
    );
    this.fetchImpl = fetchImpl;
    this.token = token;
  }

  async request(
    endpoint,
    {
      body,
      expectedStatuses = [200],
      headers = {},
      method = 'GET',
      parseJson = true,
    } = {},
  ) {
    const response = await this.fetchImpl(endpoint, {
      body,
      duplex: body && typeof body.pipe === 'function' ? 'half' : undefined,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'clodex-community-observed-prerelease-publisher',
        'X-GitHub-Api-Version': API_VERSION,
        ...headers,
      },
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15 * 60_000),
    });
    const responseText = await response.text();
    assert(
      expectedStatuses.includes(response.status),
      `GitHub API ${method} failed with HTTP ${response.status}: ${responseText.slice(0, 1_000)}`,
    );
    let parsed = null;
    if (parseJson && responseText.length > 0) {
      try {
        parsed = JSON.parse(responseText);
      } catch {
        fail(`GitHub API ${method} returned invalid JSON`);
      }
    }
    return {
      body: parsed,
      etag: response.headers.get('etag'),
      status: response.status,
    };
  }

  async listReleases(repository, page) {
    const endpoint = new URL(
      `/repos/${assertRepository(repository)}/releases`,
      API_ORIGIN,
    );
    endpoint.searchParams.set('per_page', String(RELEASE_PAGE_SIZE));
    endpoint.searchParams.set('page', String(page));
    return (await this.request(endpoint)).body;
  }

  async createDraft({
    body,
    name,
    prerelease,
    repository,
    tag,
    targetCommitish,
  }) {
    return (
      await this.request(
        `${API_ORIGIN}/repos/${assertRepository(repository)}/releases`,
        {
          body: JSON.stringify({
            body,
            draft: true,
            make_latest: 'false',
            name,
            prerelease,
            tag_name: tag,
            target_commitish: targetCommitish,
          }),
          expectedStatuses: [201],
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      )
    ).body;
  }

  async getRelease(repository, releaseId) {
    return (
      await this.request(
        `${API_ORIGIN}/repos/${assertRepository(repository)}/releases/${assertPositiveInteger(releaseId, 'release ID')}`,
      )
    ).body;
  }

  async uploadAsset({ asset, uploadEndpoint }) {
    const endpoint = new URL(uploadEndpoint);
    assert(
      endpoint.origin === UPLOAD_ORIGIN,
      'release upload origin is invalid',
    );
    endpoint.searchParams.set('name', asset.name);
    return (
      await this.request(endpoint, {
        body: createReadStream(asset.filePath),
        expectedStatuses: [201],
        headers: {
          'Content-Length': String(asset.bytes),
          'Content-Type': 'application/octet-stream',
        },
        method: 'POST',
      })
    ).body;
  }

  async getRef(repository, ref) {
    assert(
      typeof ref === 'string' &&
        /^(?:heads\/main|tags\/[A-Za-z0-9._+@()-]+)$/u.test(ref),
      'Git ref is invalid',
    );
    const response = await this.request(
      `${API_ORIGIN}/repos/${assertRepository(repository)}/git/ref/${ref}`,
      { expectedStatuses: [200, 404] },
    );
    return response.status === 404 ? null : response.body;
  }

  async compareCommits(repository, base, head) {
    assertSourceCommit(base);
    assertSourceCommit(head);
    return (
      await this.request(
        `${API_ORIGIN}/repos/${assertRepository(repository)}/compare/${base}...${head}`,
      )
    ).body;
  }

  publishRelease({ body, name, repository, releaseId, sourceCommit, tag }) {
    return this.request(
      `${API_ORIGIN}/repos/${assertRepository(repository)}/releases/${assertPositiveInteger(releaseId, 'release ID')}`,
      {
        body: JSON.stringify({
          body,
          draft: false,
          make_latest: 'false',
          name,
          prerelease: true,
          tag_name: tag,
          target_commitish: assertSourceCommit(sourceCommit),
        }),
        expectedStatuses: [200],
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'PATCH',
      },
    );
  }
}

function assertImmutabilityEnabled(value) {
  assert(
    value === true,
    'repository immutable-release attestation is not enabled; no draft or publication effect is allowed',
  );
  return true;
}

function assertDirectCommitRef(
  ref,
  expectedRef,
  sourceCommit,
  { optional = false } = {},
) {
  if (ref === null && optional) return null;
  assert(
    ref?.ref === `refs/${expectedRef}` &&
      ref?.object?.type === 'commit' &&
      ref?.object?.sha === sourceCommit,
    `Git ref ${expectedRef} does not resolve directly to the exact source commit`,
  );
  return ref;
}

async function assertSourceRefs(
  api,
  repository,
  sourceCommit,
  publisherCommit,
  tag,
  { requireTag },
) {
  assertDirectCommitRef(
    await api.getRef(repository, 'heads/main'),
    'heads/main',
    publisherCommit,
  );
  const comparison = await api.compareCommits(
    repository,
    sourceCommit,
    publisherCommit,
  );
  assert(
    ['ahead', 'identical'].includes(comparison?.status) &&
      comparison?.base_commit?.sha === sourceCommit &&
      comparison?.merge_base_commit?.sha === sourceCommit,
    'observed source commit is not contained in canonical publisher main',
  );
  const tagRef = await api.getRef(repository, `tags/${tag}`);
  assertDirectCommitRef(tagRef, `tags/${tag}`, sourceCommit, {
    optional: !requireTag,
  });
}

async function exactTagReleases(api, repository, tag) {
  const matches = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const releases = await api.listReleases(repository, page);
    assert(Array.isArray(releases), 'GitHub releases response is invalid');
    matches.push(...releases.filter((release) => release?.tag_name === tag));
    if (releases.length < RELEASE_PAGE_SIZE) return matches;
  }
  fail('GitHub release pagination exceeded its fail-closed limit');
}

async function validateTerminal({
  api,
  body,
  expectedAssets,
  manifest,
  releaseId,
  repository,
  sourceCommit,
  publisherCommit,
}) {
  const terminal = await api.getRelease(repository, releaseId);
  assertReleaseIdentity({
    body,
    expectedAssets,
    manifest,
    release: terminal,
    releaseId,
    repository,
    sourceCommit,
    state: 'published',
  });
  const matches = await exactTagReleases(api, repository, manifest.release.tag);
  assert(
    matches.length === 1 && matches[0]?.id === releaseId,
    'terminal release tag is not unique',
  );
  await assertSourceRefs(
    api,
    repository,
    sourceCommit,
    publisherCommit,
    manifest.release.tag,
    { requireTag: true },
  );
  return terminal;
}

/**
 * Stages and publishes one exact seven-asset immutable Community Observed
 * prerelease. It never deletes, replaces, or clobbers a release or asset.
 */
export async function publishCommunityObservedPrerelease({
  api,
  candidateDirectory,
  immutabilityEnabled,
  repository,
  runId,
  sourceCommit,
  publisherCommit,
  tag,
}) {
  assert(api, 'GitHub release API is required');
  const candidate = verifyPublicationCandidate({
    candidateDirectory,
    repository,
    runId,
    sourceCommit,
    tag,
  });
  const manifest = candidate.manifest;
  assertSourceCommit(publisherCommit);
  const assets = await collectReleaseAssets(candidate.assetsDirectory);
  expectedAssetsByName(assets);

  // No write may happen before both repository immutability and exact source
  // identity have been verified.
  assertImmutabilityEnabled(immutabilityEnabled);
  await assertSourceRefs(api, repository, sourceCommit, publisherCommit, tag, {
    requireTag: false,
  });
  const existing = await exactTagReleases(api, repository, tag);
  assert(
    existing.length <= 1,
    'multiple GitHub Releases already use the exact tag',
  );
  if (existing.length === 1 && existing[0]?.draft === false) {
    const releaseId = assertPositiveInteger(
      existing[0]?.id,
      'existing release ID',
    );
    const terminal = await validateTerminal({
      api,
      body: candidate.notes,
      expectedAssets: assets,
      manifest,
      releaseId,
      repository,
      sourceCommit,
      publisherCommit,
    });
    return {
      patched: false,
      release: terminal,
      releaseId,
      status: 'already-published',
    };
  }

  const staged = await stageProtectedReleaseDraft({
    api,
    assetsDirectory: candidate.assetsDirectory,
    body: candidate.notes,
    name: manifest.release.name,
    prerelease: true,
    repository,
    tag,
    targetCommitish: sourceCommit,
  });
  const releaseId = staged.releaseId;
  const draftRelease = await api.getRelease(repository, releaseId);
  assertProtectedDraftState({
    assets: draftRelease?.assets,
    body: candidate.notes,
    expectedAssets: assets,
    name: manifest.release.name,
    prerelease: true,
    release: draftRelease,
    releaseId,
    tag,
    targetCommitish: sourceCommit,
  });
  assertReleaseIdentity({
    body: candidate.notes,
    expectedAssets: assets,
    manifest,
    release: draftRelease,
    releaseId,
    repository,
    sourceCommit,
    state: 'draft',
  });

  // GitHub's Update Release endpoint rejects conditional request headers on
  // PATCH. Keep every automated publication path behind repository concurrency
  // and the protected Release environment. GitHub's immutable-release settings
  // endpoint requires Administration:read, which GITHUB_TOKEN cannot receive,
  // so the typed confirmation plus repository variable are the trusted operator
  // attestation. Privileged repository administrators remain trusted writers.
  assertImmutabilityEnabled(immutabilityEnabled);
  const finalMatches = await exactTagReleases(api, repository, tag);
  assert(
    finalMatches.length === 1 && finalMatches[0]?.id === releaseId,
    'concurrent release appeared before publication',
  );
  await assertSourceRefs(api, repository, sourceCommit, publisherCommit, tag, {
    requireTag: false,
  });
  const finalDraft = await api.getRelease(repository, releaseId);
  assertProtectedDraftState({
    assets: finalDraft?.assets,
    body: candidate.notes,
    expectedAssets: assets,
    name: manifest.release.name,
    prerelease: true,
    release: finalDraft,
    releaseId,
    tag,
    targetCommitish: sourceCommit,
  });
  assertReleaseIdentity({
    body: candidate.notes,
    expectedAssets: assets,
    manifest,
    release: finalDraft,
    releaseId,
    repository,
    sourceCommit,
    state: 'draft',
  });

  let effect;
  try {
    effect = await api.publishRelease({
      body: candidate.notes,
      name: manifest.release.name,
      releaseId,
      repository,
      sourceCommit,
      tag,
    });
  } catch (error) {
    try {
      const terminal = await validateTerminal({
        api,
        body: candidate.notes,
        expectedAssets: assets,
        manifest,
        releaseId,
        repository,
        sourceCommit,
        publisherCommit,
      });
      return {
        patched: true,
        release: terminal,
        releaseId,
        status: 'published-after-uncertain-response',
      };
    } catch (recoveryError) {
      const publicationMessage =
        error instanceof Error ? error.message : String(error);
      const recoveryMessage =
        recoveryError instanceof Error
          ? recoveryError.message
          : String(recoveryError);
      fail(
        `Community Observed publication outcome is uncertain; publication error: ${publicationMessage}; terminal recovery error: ${recoveryMessage}; inspect the exact release ID`,
        {
          cause: error,
        },
      );
    }
  }
  assert(
    effect.status === 200,
    'publication PATCH returned an unexpected status',
  );
  assertReleaseIdentity({
    body: candidate.notes,
    expectedAssets: assets,
    manifest,
    release: effect.body,
    releaseId,
    repository,
    sourceCommit,
    publisherCommit,
    state: 'published',
  });
  const terminal = await validateTerminal({
    api,
    body: candidate.notes,
    expectedAssets: assets,
    manifest,
    releaseId,
    repository,
    sourceCommit,
    publisherCommit,
  });
  return { patched: true, release: terminal, releaseId, status: 'published' };
}

function parseArguments(values) {
  const options = {};
  const allowed = new Set([
    'candidate',
    'confirm',
    'github-output',
    'immutability-confirm',
    'immutability-enabled',
    'repository',
    'run-id',
    'publisher-commit',
    'redistribution-confirm',
    'source-commit',
    'tag',
  ]);
  for (const value of values) {
    const match = /^--([a-z-]+)=(.*)$/u.exec(value);
    assert(match && allowed.has(match[1]), `invalid argument: ${value}`);
    assert(match[2].length > 0, `missing value for --${match[1]}`);
    assert(
      !Object.hasOwn(options, match[1]),
      `duplicate argument: --${match[1]}`,
    );
    options[match[1]] = match[2];
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  for (const required of [
    'candidate',
    'confirm',
    'immutability-confirm',
    'immutability-enabled',
    'repository',
    'run-id',
    'publisher-commit',
    'redistribution-confirm',
    'source-commit',
    'tag',
  ]) {
    assert(options[required], `--${required} is required`);
  }
  assert(
    options.confirm === COMMUNITY_OBSERVED_PUBLISH_CONFIRMATION,
    `confirmation must be ${COMMUNITY_OBSERVED_PUBLISH_CONFIRMATION}`,
  );
  assert(
    options['immutability-enabled'] === 'true',
    'repository variable CLODEX_IMMUTABLE_RELEASES_ENABLED must be exactly true',
  );
  assert(
    options['immutability-confirm'] ===
      COMMUNITY_OBSERVED_IMMUTABILITY_CONFIRMATION,
    `immutability confirmation must be ${COMMUNITY_OBSERVED_IMMUTABILITY_CONFIRMATION}`,
  );
  assert(
    options['redistribution-confirm'] ===
      COMMUNITY_OBSERVED_REDISTRIBUTION_CONFIRMATION,
    `redistribution confirmation must be ${COMMUNITY_OBSERVED_REDISTRIBUTION_CONFIRMATION}`,
  );
  const result = await publishCommunityObservedPrerelease({
    api: new CommunityObservedReleaseApi(),
    candidateDirectory: path.resolve(options.candidate),
    immutabilityEnabled: options['immutability-enabled'] === 'true',
    repository: assertRepository(options.repository),
    runId: assertPositiveInteger(Number(options['run-id']), 'run ID'),
    sourceCommit: assertSourceCommit(options['source-commit']),
    publisherCommit: assertSourceCommit(options['publisher-commit']),
    tag: options.tag,
  });
  if (options['github-output']) {
    await appendFile(
      path.resolve(options['github-output']),
      `release_id=${result.releaseId}\nrelease_tag=${options.tag}\nrelease_url=${result.release.html_url}\nstatus=${result.status}\n`,
    );
  }
  console.log(
    `[community-observed-publisher] release=${result.releaseId} status=${result.status}`,
  );
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(
      `[community-observed-publisher] FAILED: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
