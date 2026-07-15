#!/usr/bin/env node

import { appendFile, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const RELEASE_PAGE_SIZE = 100;
const MAX_RELEASE_PAGES = 1_000;

function fail(message) {
  throw new Error(message);
}

function assertRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) {
    fail('repository must be provided as owner/name');
  }
  return repository;
}

function assertSingleLine(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\r\n\0]/.test(value)
  ) {
    fail(`${label} must be a non-empty single-line value`);
  }
  return value;
}

function assertSha(value) {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) {
    fail('target commit must be an immutable lowercase 40-character SHA');
  }
  return value;
}

function assertReleaseId(value, label = 'release ID') {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} is invalid`);
  }
  return value;
}

function assertPublishedAt(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail('GitHub Release is missing a valid published timestamp');
  }
  return value;
}

export function assertExactPublishedRelease({
  body,
  name,
  release,
  releaseId,
  repository,
  tag,
  targetCommitish,
}) {
  assertRepository(repository);
  assertReleaseId(releaseId);
  assertSingleLine(tag, 'tag');
  assertSingleLine(name, 'release name');
  assertSha(targetCommitish);
  if (typeof body !== 'string') fail('release body must be a string');

  const expectedApiUrl = `${API_ORIGIN}/repos/${repository}/releases/${releaseId}`;
  if (
    !release ||
    release.id !== releaseId ||
    release.url !== expectedApiUrl ||
    release.tag_name !== tag ||
    release.target_commitish !== targetCommitish ||
    release.name !== name ||
    release.body !== body ||
    release.draft !== false ||
    release.prerelease !== false
  ) {
    fail('GitHub Release does not match the exact published release identity');
  }
  assertPublishedAt(release.published_at);

  return {
    releaseId,
    state: 'published',
    tag,
    targetCommitish,
  };
}

export class GitHubPublicReleaseApi {
  constructor({
    fetchImpl = globalThis.fetch,
    token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  } = {}) {
    if (typeof fetchImpl !== 'function')
      fail('fetch implementation is required');
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      /[\r\n]/.test(token)
    ) {
      fail('GH_TOKEN or GITHUB_TOKEN is required');
    }
    this.fetchImpl = fetchImpl;
    this.token = token;
  }

  async request(
    url,
    { body, expectedStatuses, method = 'GET', parseJson = true },
  ) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        body,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'clodex-exact-public-release-publisher',
          'X-GitHub-Api-Version': API_VERSION,
        },
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      fail(
        `GitHub API ${method} failed before an HTTP response: ${error instanceof Error ? error.message : error}`,
      );
    }
    const responseText = await response.text();
    if (!expectedStatuses.includes(response.status)) {
      fail(
        `GitHub API ${method} failed with HTTP ${response.status}: ${responseText.slice(0, 1_000)}`,
      );
    }
    if (!parseJson) return { data: null, status: response.status };
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      fail(`GitHub API ${method} returned invalid JSON`);
    }
    return { data, status: response.status };
  }

  async listReleases(repository, page) {
    const endpoint = new URL(
      `/repos/${assertRepository(repository)}/releases`,
      API_ORIGIN,
    );
    endpoint.searchParams.set('per_page', String(RELEASE_PAGE_SIZE));
    endpoint.searchParams.set('page', String(page));
    const response = await this.request(endpoint, {
      expectedStatuses: [200],
    });
    return response.data;
  }

  async createRelease({ body, name, repository, tag, targetCommitish }) {
    const endpoint = new URL(
      `/repos/${assertRepository(repository)}/releases`,
      API_ORIGIN,
    );
    return this.request(endpoint, {
      body: JSON.stringify({
        body,
        draft: false,
        name,
        prerelease: false,
        tag_name: tag,
        target_commitish: targetCommitish,
      }),
      expectedStatuses: [201, 422],
      method: 'POST',
    });
  }

  async getRelease(repository, releaseId) {
    const endpoint = new URL(
      `/repos/${assertRepository(repository)}/releases/${assertReleaseId(releaseId)}`,
      API_ORIGIN,
    );
    const response = await this.request(endpoint, {
      expectedStatuses: [200],
    });
    return response.data;
  }
}

export async function listExactPublicTagReleases({ api, repository, tag }) {
  const matches = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const releases = await api.listReleases(repository, page);
    if (!Array.isArray(releases)) {
      fail('GitHub releases response is not an array');
    }
    for (const release of releases) {
      if (release?.tag_name === tag) matches.push(release);
    }
    if (releases.length < RELEASE_PAGE_SIZE) return matches;
  }
  fail('GitHub releases pagination exceeded its fail-closed limit');
}

export async function verifyExactPublicRelease({
  api,
  body,
  name,
  releaseId,
  repository,
  tag,
  targetCommitish,
}) {
  const exactRelease = await api.getRelease(repository, releaseId);
  const result = assertExactPublishedRelease({
    body,
    name,
    release: exactRelease,
    releaseId,
    repository,
    tag,
    targetCommitish,
  });
  const matches = await listExactPublicTagReleases({ api, repository, tag });
  if (matches.length !== 1 || matches[0]?.id !== releaseId) {
    fail('GitHub Release tag does not resolve to the one exact release ID');
  }
  assertExactPublishedRelease({
    body,
    name,
    release: matches[0],
    releaseId,
    repository,
    tag,
    targetCommitish,
  });
  return result;
}

export async function createOrRecoverExactPublicRelease({
  api,
  body,
  name,
  repository,
  tag,
  targetCommitish,
}) {
  assertRepository(repository);
  assertSingleLine(tag, 'tag');
  assertSingleLine(name, 'release name');
  assertSha(targetCommitish);
  if (typeof body !== 'string') fail('release body must be a string');

  const existing = await listExactPublicTagReleases({ api, repository, tag });
  if (existing.length > 1) {
    fail('multiple GitHub Release records already use the exact tag');
  }
  if (existing.length === 1) {
    const releaseId = assertReleaseId(existing[0]?.id);
    const result = await verifyExactPublicRelease({
      api,
      body,
      name,
      releaseId,
      repository,
      tag,
      targetCommitish,
    });
    return { ...result, created: false };
  }

  const creation = await api.createRelease({
    body,
    name,
    repository,
    tag,
    targetCommitish,
  });
  if (creation.status === 201) {
    const releaseId = assertReleaseId(creation.data?.id, 'created release ID');
    assertExactPublishedRelease({
      body,
      name,
      release: creation.data,
      releaseId,
      repository,
      tag,
      targetCommitish,
    });
    const result = await verifyExactPublicRelease({
      api,
      body,
      name,
      releaseId,
      repository,
      tag,
      targetCommitish,
    });
    return { ...result, created: true };
  }

  // HTTP 422 is accepted only as a concurrent create race. The winner must
  // already be the one exact published release; every other 422 fails closed.
  const concurrent = await listExactPublicTagReleases({ api, repository, tag });
  if (concurrent.length !== 1) {
    fail(
      'GitHub Release create returned 422 without one exact concurrent release',
    );
  }
  const releaseId = assertReleaseId(concurrent[0]?.id, 'concurrent release ID');
  assertExactPublishedRelease({
    body,
    name,
    release: concurrent[0],
    releaseId,
    repository,
    tag,
    targetCommitish,
  });
  const result = await verifyExactPublicRelease({
    api,
    body,
    name,
    releaseId,
    repository,
    tag,
    targetCommitish,
  });
  return { ...result, created: false };
}

function parseReleaseId(value) {
  if (!/^[1-9][0-9]*$/.test(value ?? '')) fail('release ID must be canonical');
  return assertReleaseId(Number.parseInt(value, 10));
}

function parseArguments(values) {
  const options = {};
  const allowed = new Set([
    'body-file',
    'github-output',
    'name',
    'release-id',
    'repository',
    'tag',
    'target-commitish',
  ]);
  for (const value of values) {
    if (!value.startsWith('--') || !value.includes('=')) {
      fail(`Invalid argument: ${value}`);
    }
    const [name, ...parts] = value.slice(2).split('=');
    if (!allowed.has(name)) fail(`Unknown argument: ${value}`);
    if (Object.hasOwn(options, name)) fail(`Duplicate argument: --${name}`);
    options[name] = parts.join('=');
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  for (const required of [
    'body-file',
    'name',
    'repository',
    'tag',
    'target-commitish',
  ]) {
    if (!options[required]) fail(`--${required} is required`);
  }
  const bodyPath = path.resolve(options['body-file']);
  const bodyStats = await lstat(bodyPath).catch(() => null);
  if (!bodyStats?.isFile() || bodyStats.isSymbolicLink()) {
    fail('release body path must be a regular file');
  }
  const body = await readFile(bodyPath, 'utf8');
  const api = new GitHubPublicReleaseApi();
  let result;

  if (options['release-id']) {
    result = await verifyExactPublicRelease({
      api,
      body,
      name: options.name,
      releaseId: parseReleaseId(options['release-id']),
      repository: options.repository,
      tag: options.tag,
      targetCommitish: options['target-commitish'],
    });
  } else {
    if (!options['github-output'])
      fail('--github-output is required for create');
    const outputPath = path.resolve(options['github-output']);
    const outputStats = await lstat(outputPath).catch(() => null);
    if (outputStats?.isSymbolicLink()) {
      fail('GitHub output path must not be a symlink');
    }
    result = await createOrRecoverExactPublicRelease({
      api,
      body,
      name: options.name,
      repository: options.repository,
      tag: options.tag,
      targetCommitish: options['target-commitish'],
    });
    await appendFile(
      outputPath,
      [
        `release_id=${result.releaseId}`,
        `release_state=${result.state}`,
        `release_target=${result.targetCommitish}`,
        `release_tag=${result.tag}`,
        `release_created=${result.created}`,
        '',
      ].join('\n'),
      { encoding: 'utf8', flag: 'a' },
    );
  }

  console.log(JSON.stringify(result));
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((error) => {
    console.error(
      `[exact-public-release] ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
