#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { appendFile, lstat, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API_ORIGIN = 'https://api.github.com';
const UPLOAD_ORIGIN = 'https://uploads.github.com';
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

function assertReleaseId(value, label = 'release ID') {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} is invalid`);
  }
  return value;
}

function assertSha(value) {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) {
    fail('target commit must be an immutable lowercase 40-character SHA');
  }
  return value;
}

function assertAssetName(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value !== path.basename(value) ||
    /[\\/\r\n\0]/.test(value)
  ) {
    fail(`unsafe release asset filename: ${value || '<missing>'}`);
  }
  return value;
}

function assertExpectedAsset(asset) {
  const name = assertAssetName(asset?.name);
  if (!Number.isSafeInteger(asset?.bytes) || asset.bytes <= 0) {
    fail(`staged release asset ${name} has an invalid size`);
  }
  if (!/^[0-9a-f]{64}$/.test(asset?.sha256 ?? '')) {
    fail(`staged release asset ${name} has an invalid SHA-256`);
  }
  return asset;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function assertAssetState(asset, expected, { requireDigest = true } = {}) {
  assertReleaseId(asset?.id, 'release asset ID');
  const name = assertAssetName(asset?.name);
  if (
    !Number.isSafeInteger(asset?.size) ||
    asset.size <= 0 ||
    asset.state !== 'uploaded'
  ) {
    fail(`GitHub Release asset ${name} is not a complete non-empty upload`);
  }
  if (!expected) {
    fail(`GitHub Release contains unexpected asset ${name}`);
  }
  assertExpectedAsset(expected);
  if (asset.size !== expected.bytes || name !== expected.name) {
    fail(`GitHub Release asset ${name} does not match the staged file`);
  }
  if (asset.digest === undefined || asset.digest === null) {
    if (requireDigest) {
      fail(`GitHub Release asset ${name} is missing its SHA-256 digest`);
    }
  } else if (asset.digest !== `sha256:${expected.sha256}`) {
    fail(`GitHub Release asset ${name} digest does not match the staged file`);
  }
  return name;
}

export function assertProtectedDraftState({
  allowMissingAssets = false,
  assets,
  body,
  expectedAssets,
  name,
  prerelease,
  release,
  releaseId,
  tag,
  targetCommitish,
}) {
  assertReleaseId(releaseId);
  if (
    !release ||
    release.id !== releaseId ||
    release.tag_name !== tag ||
    release.draft !== true ||
    release.prerelease !== prerelease ||
    release.published_at !== null ||
    release.target_commitish !== targetCommitish ||
    release.name !== name ||
    release.body !== body
  ) {
    fail('GitHub Release does not match the exact protected draft identity');
  }

  if (expectedAssets) {
    if (!Array.isArray(assets)) {
      fail('GitHub Release assets are missing');
    }
    const expectedByName = new Map(
      expectedAssets.map((asset) => {
        assertExpectedAsset(asset);
        return [asset.name, asset];
      }),
    );
    if (expectedByName.size !== expectedAssets.length) {
      fail('staged release asset names are not unique');
    }
    const actualNames = assets.map((asset) =>
      assertAssetState(asset, expectedByName.get(asset?.name)),
    );
    if (new Set(actualNames).size !== actualNames.length) {
      fail('GitHub Release contains duplicate asset names');
    }
    const expectedNames = expectedAssets.map((asset) => asset.name);
    const missingNames = expectedNames.filter(
      (assetName) => !actualNames.includes(assetName),
    );
    if (!allowMissingAssets && missingNames.length !== 0) {
      fail('GitHub Release asset set does not match the staged asset set');
    }
    return expectedAssets.filter((asset) => missingNames.includes(asset.name));
  }
  return [];
}

export function exactUploadEndpoint({ repository, releaseId, uploadUrl }) {
  assertRepository(repository);
  assertReleaseId(releaseId);
  if (typeof uploadUrl !== 'string' || uploadUrl.length === 0) {
    fail('GitHub Release is missing its upload URL');
  }
  const untemplated = uploadUrl.replace(/\{.*$/u, '');
  let parsed;
  try {
    parsed = new URL(untemplated);
  } catch {
    fail('GitHub Release returned an invalid upload URL');
  }
  const expectedPath = `/repos/${repository}/releases/${releaseId}/assets`;
  if (
    parsed.origin !== UPLOAD_ORIGIN ||
    parsed.pathname !== expectedPath ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    fail('GitHub Release upload URL is not bound to the exact release ID');
  }
  return parsed;
}

export async function collectReleaseAssets(assetsDirectory) {
  const directory = path.resolve(assetsDirectory ?? '');
  const directoryStats = await lstat(directory).catch(() => null);
  if (!directoryStats?.isDirectory() || directoryStats.isSymbolicLink()) {
    fail('release assets path must be a real directory');
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const assets = [];
  for (const entry of entries) {
    const name = assertAssetName(entry.name);
    const filePath = path.join(directory, name);
    const stats = await lstat(filePath);
    if (!entry.isFile() || !stats.isFile() || stats.isSymbolicLink()) {
      fail(`release asset must be a real regular file: ${name}`);
    }
    if (stats.size <= 0) fail(`release asset must not be empty: ${name}`);
    assets.push({
      bytes: stats.size,
      filePath,
      name,
      sha256: await sha256File(filePath),
    });
  }
  if (assets.length === 0) {
    fail('release assets directory is empty');
  }
  return assets.sort((left, right) => left.name.localeCompare(right.name));
}

export class GitHubReleaseApi {
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
    { body, expectedStatus, headers = {}, method = 'GET', parseJson = true },
  ) {
    const response = await this.fetchImpl(url, {
      body,
      duplex: body && typeof body.pipe === 'function' ? 'half' : undefined,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'clodex-protected-release-publisher',
        'X-GitHub-Api-Version': API_VERSION,
        ...headers,
      },
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15 * 60 * 1_000),
    });
    const responseText = await response.text();
    if (response.status !== expectedStatus) {
      fail(
        `GitHub API ${method} failed with HTTP ${response.status}: ${responseText.slice(0, 1_000)}`,
      );
    }
    if (!parseJson) return null;
    try {
      return JSON.parse(responseText);
    } catch {
      fail(`GitHub API ${method} returned invalid JSON`);
    }
  }

  listReleases(repository, page) {
    const endpoint = new URL(
      `/repos/${assertRepository(repository)}/releases`,
      API_ORIGIN,
    );
    endpoint.searchParams.set('per_page', String(RELEASE_PAGE_SIZE));
    endpoint.searchParams.set('page', String(page));
    return this.request(endpoint, { expectedStatus: 200 });
  }

  createDraft({ body, name, prerelease, repository, tag, targetCommitish }) {
    const endpoint = new URL(
      `/repos/${assertRepository(repository)}/releases`,
      API_ORIGIN,
    );
    return this.request(endpoint, {
      body: JSON.stringify({
        body,
        draft: true,
        name,
        prerelease,
        tag_name: tag,
        target_commitish: targetCommitish,
      }),
      expectedStatus: 201,
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
  }

  getRelease(repository, releaseId) {
    const endpoint = new URL(
      `/repos/${assertRepository(repository)}/releases/${assertReleaseId(releaseId)}`,
      API_ORIGIN,
    );
    return this.request(endpoint, { expectedStatus: 200 });
  }

  uploadAsset({ asset, uploadEndpoint }) {
    const endpoint = new URL(uploadEndpoint);
    endpoint.searchParams.set('name', asset.name);
    return this.request(endpoint, {
      body: createReadStream(asset.filePath),
      expectedStatus: 201,
      headers: {
        'Content-Length': String(asset.bytes),
        'Content-Type': 'application/octet-stream',
      },
      method: 'POST',
    });
  }
}

export async function listExactTagReleases({ api, repository, tag }) {
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

export async function stageProtectedReleaseDraft({
  api,
  assetsDirectory,
  body,
  name,
  onVerified,
  prerelease,
  repository,
  tag,
  targetCommitish,
}) {
  assertRepository(repository);
  assertSingleLine(tag, 'tag');
  assertSingleLine(name, 'release name');
  assertSha(targetCommitish);
  if (typeof body !== 'string') fail('release body must be a string');
  if (typeof prerelease !== 'boolean') fail('prerelease must be a boolean');
  const assets = await collectReleaseAssets(assetsDirectory);
  const assetNames = assets.map((asset) => asset.name);

  const existing = await listExactTagReleases({ api, repository, tag });
  if (existing.length > 1) {
    fail(
      `refusing to stage ${tag}: ${existing.length} GitHub Release record(s) already use this tag`,
    );
  }

  let releaseId = null;
  let resumed = false;
  try {
    let exactRelease;
    let missingAssets;
    if (existing.length === 1) {
      resumed = true;
      releaseId = assertReleaseId(existing[0]?.id, 'existing release ID');
      assertProtectedDraftState({
        allowMissingAssets: true,
        assets: existing[0].assets,
        body,
        expectedAssets: assets,
        name,
        prerelease,
        release: existing[0],
        releaseId,
        tag,
        targetCommitish,
      });
      exactRelease = await api.getRelease(repository, releaseId);
      missingAssets = assertProtectedDraftState({
        allowMissingAssets: true,
        assets: exactRelease.assets,
        body,
        expectedAssets: assets,
        name,
        prerelease,
        release: exactRelease,
        releaseId,
        tag,
        targetCommitish,
      });
    } else {
      exactRelease = await api.createDraft({
        body,
        name,
        prerelease,
        repository,
        tag,
        targetCommitish,
      });
      releaseId = assertReleaseId(exactRelease?.id, 'created release ID');
      assertProtectedDraftState({
        assets: exactRelease.assets,
        body,
        expectedAssets: [],
        name,
        prerelease,
        release: exactRelease,
        releaseId,
        tag,
        targetCommitish,
      });
      missingAssets = assets;
    }

    const uploadEndpoint = exactUploadEndpoint({
      releaseId,
      repository,
      uploadUrl: exactRelease.upload_url,
    });

    for (const asset of missingAssets) {
      const uploaded = await api.uploadAsset({ asset, uploadEndpoint });
      assertAssetState(uploaded, asset, { requireDigest: false });
    }

    exactRelease = await api.getRelease(repository, releaseId);
    assertProtectedDraftState({
      assets: exactRelease.assets,
      body,
      expectedAssets: assets,
      name,
      prerelease,
      release: exactRelease,
      releaseId,
      tag,
      targetCommitish,
    });

    const finalMatches = await listExactTagReleases({ api, repository, tag });
    if (finalMatches.length !== 1 || finalMatches[0]?.id !== releaseId) {
      fail(
        'concurrent duplicate or public GitHub Release detected for the protected tag',
      );
    }
    assertProtectedDraftState({
      assets: finalMatches[0].assets,
      body,
      expectedAssets: assets,
      name,
      prerelease,
      release: finalMatches[0],
      releaseId,
      tag,
      targetCommitish,
    });

    const result = { assetNames, releaseId, resumed };
    if (onVerified !== undefined) {
      if (typeof onVerified !== 'function')
        fail('onVerified must be a function');
      await onVerified(result);
    }
    return result;
  } catch (error) {
    if (releaseId === null) throw error;
    const disposition = resumed
      ? `existing GitHub Release ID ${releaseId} was left untouched for manual protected inspection`
      : `created GitHub Release ID ${releaseId} was left untouched as a protected orphan for manual protected inspection`;
    throw new Error(
      `${error instanceof Error ? error.message : error}; ${disposition}`,
      { cause: error },
    );
  }
}

function parseBoolean(value, label) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail(`${label} must be true or false`);
}

export function parseProtectedDraftArguments(values) {
  const options = {};
  for (const value of values) {
    if (!value.startsWith('--') || !value.includes('=')) {
      fail(`Invalid argument: ${value}`);
    }
    const [name, ...parts] = value.slice(2).split('=');
    if (
      ![
        'assets',
        'body-file',
        'github-output',
        'name',
        'prerelease',
        'report-name',
        'repository',
        'tag',
        'target-commitish',
      ].includes(name)
    ) {
      fail(`Unknown argument: ${value}`);
    }
    if (Object.hasOwn(options, name)) {
      fail(`Duplicate argument: --${name}`);
    }
    options[name] = parts.join('=');
  }
  return options;
}

async function main() {
  const options = parseProtectedDraftArguments(process.argv.slice(2));
  for (const required of [
    'assets',
    'body-file',
    'github-output',
    'name',
    'prerelease',
    'repository',
    'tag',
    'target-commitish',
  ]) {
    if (!options[required]) fail(`--${required} is required`);
  }
  const body = await readFile(path.resolve(options['body-file']), 'utf8');
  const prerelease = parseBoolean(options.prerelease, 'prerelease');
  const reportName = options['report-name'] ?? '';
  if (/\r|\n/.test(reportName)) fail('report name must be a single-line value');
  const outputPath = path.resolve(options['github-output']);
  const outputStats = await lstat(outputPath).catch(() => null);
  if (outputStats?.isSymbolicLink())
    fail('GitHub output path must not be a symlink');
  const result = await stageProtectedReleaseDraft({
    api: new GitHubReleaseApi(),
    assetsDirectory: options.assets,
    body,
    name: options.name,
    onVerified: ({ releaseId }) =>
      appendFile(
        outputPath,
        `release_id=${releaseId}\nreport_name=${reportName}\n`,
        { encoding: 'utf8', flag: 'a' },
      ),
    prerelease,
    repository: options.repository,
    tag: options.tag,
    targetCommitish: options['target-commitish'],
  });
  console.log(
    JSON.stringify({
      assetNames: result.assetNames,
      draft: true,
      prerelease,
      releaseId: result.releaseId,
      repository: options.repository,
      resumed: result.resumed,
      tag: options.tag,
      targetCommitish: options['target-commitish'],
    }),
  );
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((error) => {
    console.error(
      `[protected-release-draft] ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
