#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API_ORIGIN = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const MAX_INPUT_BYTES = 1024 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export const CANONICAL_RELEASE_REPOSITORY = 'mereyabdenbekuly-ctrl/clodex-ide';
export const TRUSTED_RELEASE_SOURCE_REF = 'refs/heads/main';
export const STABLE_PUBLICATION_LEASE_SCHEMA_VERSION = 1;
export const STABLE_PUBLICATION_LEASE_RECEIPT_KIND =
  'stable-github-release-publication-lease';
export const STABLE_PUBLICATION_LEASE_MAX_TTL_MS = 15 * 60 * 1000;
export const STABLE_PUBLICATION_LEASE_RECOVERY_MAX_AGE_MS = 72 * 60 * 60 * 1000;

const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const STABLE_TAG = /^clodex@(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const NONCE = /^[A-Za-z0-9_-]{43}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/#-]{0,255}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function fail(message, options) {
  throw new Error(message, options);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  assert(isObject(value), `${label} must be an object`);
  assert(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort()),
    `${label} contains missing or unsupported fields`,
  );
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseCanonicalInstant(value, label) {
  assert(typeof value === 'string', `${label} is invalid`);
  const instant = new Date(value);
  assert(
    !Number.isNaN(instant.getTime()) && instant.toISOString() === value,
    `${label} must be a canonical UTC instant`,
  );
  return instant.getTime();
}

function parseGitHubInstant(value, label) {
  assert(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value),
    `${label} is invalid`,
  );
  const instant = new Date(value);
  assert(!Number.isNaN(instant.getTime()), `${label} is invalid`);
  return instant.getTime();
}

function assertRepository(value, label) {
  assert(
    typeof value === 'string' && REPOSITORY.test(value),
    `${label} is invalid`,
  );
  return value;
}

function assertPositiveInteger(value, label) {
  assert(Number.isSafeInteger(value) && value > 0, `${label} is invalid`);
  return value;
}

function assertSha256(value, label) {
  assert(SHA256.test(String(value ?? '')), `${label} is invalid`);
  return value;
}

function assertCommit(value, label) {
  assert(COMMIT.test(String(value ?? '')), `${label} is invalid`);
  return value;
}

function assertWorkflow(value, repository, label) {
  assert(
    typeof value === 'string' && value.length <= 240,
    `${label} is invalid`,
  );
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  assert(
    new RegExp(
      `^${escapedRepository}/\\.github/workflows/[A-Za-z0-9_.-]+\\.ya?ml$`,
      'u',
    ).test(value),
    `${label} is invalid`,
  );
  return value;
}

function assertSafeManifestPath(value) {
  assert(
    typeof value === 'string' &&
      value.length <= 160 &&
      !value.includes('\\') &&
      path.posix.normalize(value) === value &&
      path.posix.dirname(value) === '.release-notes' &&
      /^[A-Za-z0-9._-]+\.json$/u.test(path.posix.basename(value)),
    'stable manifest path is invalid',
  );
  return value;
}

function assertStableTag(value) {
  assert(
    typeof value === 'string' && STABLE_TAG.test(value),
    'stable tag is invalid',
  );
  return value;
}

function assertAssetFileName(value) {
  assert(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 255 &&
      value === path.basename(value) &&
      !/[\\/\r\n\0]/u.test(value),
    'publication asset filename is invalid',
  );
  return value;
}

function validateAssetRecord(value, label = 'publication asset') {
  assertExactKeys(
    value,
    ['bytes', 'fileName', 'releaseAssetId', 'sha256'],
    label,
  );
  assertPositiveInteger(value.bytes, `${label} byte count`);
  assertAssetFileName(value.fileName);
  assertPositiveInteger(value.releaseAssetId, `${label} release asset ID`);
  assertSha256(value.sha256, `${label} SHA-256`);
  return {
    bytes: value.bytes,
    fileName: value.fileName,
    releaseAssetId: value.releaseAssetId,
    sha256: value.sha256,
  };
}

function expectedLeaseBindings(receipt) {
  return {
    epoch: receipt.lease.epoch,
    holder: receipt.holder,
    manifest: receipt.manifest,
    producer: receipt.producer,
    publication: {
      draftSnapshotSha256: receipt.publication.draftSnapshotSha256,
    },
    resource: receipt.resource,
    source: receipt.source,
  };
}

function validateExpectedBindings(value) {
  assertExactKeys(
    value,
    [
      'epoch',
      'holder',
      'manifest',
      'producer',
      'publication',
      'resource',
      'source',
    ],
    'expected lease bindings',
  );
  assertPositiveInteger(value.epoch, 'expected lease epoch');
  validateHolder(value.holder, 'expected holder');
  validateManifest(value.manifest, 'expected manifest');
  validateProducer(value.producer, 'expected producer');
  assertExactKeys(
    value.publication,
    ['draftSnapshotSha256'],
    'expected publication binding',
  );
  assertSha256(
    value.publication.draftSnapshotSha256,
    'expected draft snapshot SHA-256',
  );
  validateResource(value.resource, 'expected resource');
  validateSource(value.source, 'expected source');
  return value;
}

function validateResource(value, label = 'lease resource') {
  assertExactKeys(value, ['kind', 'releaseId', 'repository', 'tag'], label);
  assert(value.kind === 'github-release', `${label} kind is invalid`);
  assertRepository(value.repository, `${label} repository`);
  assertPositiveInteger(value.releaseId, `${label} release ID`);
  assertStableTag(value.tag);
  return value;
}

function validateSource(value, label = 'lease source') {
  assertExactKeys(value, ['commit', 'ref'], label);
  assertCommit(value.commit, `${label} commit`);
  assert(value.ref === TRUSTED_RELEASE_SOURCE_REF, `${label} ref is invalid`);
  return value;
}

function validateManifest(value, label = 'lease manifest') {
  assertExactKeys(value, ['path', 'sha256'], label);
  assertSafeManifestPath(value.path);
  assertSha256(value.sha256, `${label} SHA-256`);
  return value;
}

function validateHolder(value, label = 'lease holder') {
  assertExactKeys(
    value,
    ['id', 'repository', 'runAttempt', 'runId', 'workflow'],
    label,
  );
  assert(
    typeof value.id === 'string' && SAFE_IDENTIFIER.test(value.id),
    `${label} ID is invalid`,
  );
  const repository = assertRepository(value.repository, `${label} repository`);
  assertWorkflow(value.workflow, repository, `${label} workflow`);
  assertPositiveInteger(value.runId, `${label} run ID`);
  assertPositiveInteger(value.runAttempt, `${label} run attempt`);
  return value;
}

function validateProducer(value, label = 'lease producer') {
  assertExactKeys(
    value,
    [
      'repository',
      'runAttempt',
      'runId',
      'sourceCommit',
      'sourceRef',
      'workflow',
      'workflowCommit',
    ],
    label,
  );
  const repository = assertRepository(value.repository, `${label} repository`);
  assertWorkflow(value.workflow, repository, `${label} workflow`);
  assertCommit(value.sourceCommit, `${label} source commit`);
  assertCommit(value.workflowCommit, `${label} workflow commit`);
  assert(
    value.sourceCommit === value.workflowCommit,
    `${label} source and workflow commits differ`,
  );
  assert(
    typeof value.sourceRef === 'string' &&
      /^refs\/heads\/[A-Za-z0-9._/-]+$/u.test(value.sourceRef) &&
      !value.sourceRef.includes('..'),
    `${label} source ref is invalid`,
  );
  assertPositiveInteger(value.runId, `${label} run ID`);
  assertPositiveInteger(value.runAttempt, `${label} run attempt`);
  return value;
}

function validateConstraints(value) {
  assertExactKeys(
    value,
    [
      'maximumPatchAttempts',
      'requireConditionalRequest',
      'requireTerminalImmutable',
    ],
    'lease constraints',
  );
  assert(
    value.maximumPatchAttempts === 1 &&
      value.requireConditionalRequest === true &&
      value.requireTerminalImmutable === true,
    'lease constraints are not fail-closed',
  );
  return value;
}

function validateLeaseWindow(value, { now, requireActive }) {
  assertExactKeys(
    value,
    ['epoch', 'expiresAt', 'issuedAt', 'nonce'],
    'lease window',
  );
  assertPositiveInteger(value.epoch, 'lease epoch');
  assert(
    typeof value.nonce === 'string' && NONCE.test(value.nonce),
    'lease nonce must be a 256-bit base64url value',
  );
  const issuedAt = parseCanonicalInstant(value.issuedAt, 'lease issuedAt');
  const expiresAt = parseCanonicalInstant(value.expiresAt, 'lease expiresAt');
  const nowMs = now.getTime();
  assert(!Number.isNaN(nowMs), 'lease verification clock is invalid');
  assert(expiresAt > issuedAt, 'lease expiry must follow issuance');
  assert(
    expiresAt - issuedAt <= STABLE_PUBLICATION_LEASE_MAX_TTL_MS,
    'lease lifetime exceeds the maximum',
  );
  assert(issuedAt <= nowMs + CLOCK_SKEW_MS, 'lease issuance is in the future');
  assert(
    nowMs - expiresAt <= STABLE_PUBLICATION_LEASE_RECOVERY_MAX_AGE_MS,
    'lease is too old for bounded idempotent recovery',
  );
  if (requireActive) {
    assert(
      nowMs + CLOCK_SKEW_MS >= issuedAt && nowMs <= expiresAt,
      'lease is not active for a publication effect',
    );
  }
  return { expiresAt, issuedAt, nowMs };
}

/**
 * Strictly validates the content-free external lease receipt. Authenticity is
 * deliberately outside this function: the caller must first verify the exact
 * receipt bytes against a reviewed producer attestation.
 */
export function validateStablePublicationLeaseReceipt(
  value,
  { expected, now = new Date(), requireActive = false } = {},
) {
  assertExactKeys(
    value,
    [
      'constraints',
      'holder',
      'lease',
      'manifest',
      'producer',
      'publication',
      'receiptKind',
      'resource',
      'schemaVersion',
      'source',
    ],
    'stable publication lease receipt',
  );
  assert(
    value.schemaVersion === STABLE_PUBLICATION_LEASE_SCHEMA_VERSION &&
      value.receiptKind === STABLE_PUBLICATION_LEASE_RECEIPT_KIND,
    'stable publication lease receipt schema is invalid',
  );
  validateResource(value.resource);
  validateSource(value.source);
  validateManifest(value.manifest);
  validateHolder(value.holder);
  validateProducer(value.producer);
  validateConstraints(value.constraints);
  assertExactKeys(
    value.publication,
    [
      'assetsSnapshotSha256',
      'draftSnapshotSha256',
      'releaseBodySha256',
      'releaseNameSha256',
    ],
    'lease publication binding',
  );
  assertSha256(
    value.publication.assetsSnapshotSha256,
    'lease assets snapshot SHA-256',
  );
  assertSha256(
    value.publication.draftSnapshotSha256,
    'lease draft snapshot SHA-256',
  );
  assertSha256(
    value.publication.releaseBodySha256,
    'lease release body SHA-256',
  );
  assertSha256(
    value.publication.releaseNameSha256,
    'lease release name SHA-256',
  );
  const leaseWindow = validateLeaseWindow(value.lease, { now, requireActive });

  assert(
    value.resource.repository === CANONICAL_RELEASE_REPOSITORY &&
      value.holder.repository === CANONICAL_RELEASE_REPOSITORY,
    'lease is not bound to the canonical release repository',
  );

  if (expected) {
    validateExpectedBindings(expected);
    assert(
      canonicalJson(expectedLeaseBindings(value)) === canonicalJson(expected),
      'lease receipt does not match the expected trusted bindings',
    );
  }
  return { leaseWindow, receipt: value };
}

export function validateStablePublicationSnapshot(value) {
  assertExactKeys(
    value,
    [
      'assets',
      'createdAt',
      'releaseId',
      'reportAsset',
      'reportSha256',
      'repository',
      'sourceCommit',
      'tag',
    ],
    'stable publication snapshot',
  );
  assert(
    value.repository === CANONICAL_RELEASE_REPOSITORY,
    'publication snapshot repository is not canonical',
  );
  assertPositiveInteger(value.releaseId, 'publication snapshot release ID');
  assertStableTag(value.tag);
  assertCommit(value.sourceCommit, 'publication snapshot source commit');
  parseCanonicalInstant(value.createdAt, 'publication snapshot createdAt');
  assertSha256(value.reportSha256, 'publication snapshot report SHA-256');
  assert(
    Array.isArray(value.assets) && value.assets.length > 1,
    'publication snapshot assets are missing',
  );
  const assets = value.assets.map((asset, index) =>
    validateAssetRecord(asset, `publication snapshot asset ${index}`),
  );
  const sorted = [...assets].sort((left, right) =>
    left.fileName.localeCompare(right.fileName),
  );
  assert(
    canonicalJson(assets) === canonicalJson(sorted),
    'publication snapshot assets are not canonically ordered',
  );
  assert(
    new Set(assets.map((asset) => asset.fileName)).size === assets.length &&
      new Set(assets.map((asset) => asset.releaseAssetId)).size ===
        assets.length,
    'publication snapshot assets contain duplicate names or IDs',
  );
  const reportAsset = validateAssetRecord(
    value.reportAsset,
    'publication snapshot report asset',
  );
  assert(
    assets.some(
      (asset) => canonicalJson(asset) === canonicalJson(reportAsset),
    ) && reportAsset.sha256 === value.reportSha256,
    'publication snapshot report asset binding is invalid',
  );
  return { ...value, assets, reportAsset };
}

export function stablePublicationAssetsSnapshotSha256(snapshot) {
  const validated = validateStablePublicationSnapshot(snapshot);
  return sha256(canonicalJson(validated.assets));
}

export function validateStablePublicationHandoff({
  expected,
  expectedLeaseSha256,
  expectedSnapshotSha256,
  lease,
  leaseBytes,
  now = new Date(),
  requireActive = false,
  snapshot,
  snapshotBytes,
}) {
  assertSha256(expectedLeaseSha256, 'expected lease receipt SHA-256');
  assertSha256(expectedSnapshotSha256, 'expected draft snapshot SHA-256');
  assert(
    sha256(leaseBytes) === expectedLeaseSha256,
    'lease receipt bytes differ from the verified handoff',
  );
  assert(
    sha256(snapshotBytes) === expectedSnapshotSha256,
    'draft snapshot bytes differ from the verified handoff',
  );
  const validatedLease = validateStablePublicationLeaseReceipt(lease, {
    expected,
    now,
    requireActive,
  });
  const validatedSnapshot = validateStablePublicationSnapshot(snapshot);
  assert(
    lease.publication.draftSnapshotSha256 === expectedSnapshotSha256,
    'lease does not bind the exact attested draft snapshot bytes',
  );
  assert(
    lease.publication.assetsSnapshotSha256 ===
      stablePublicationAssetsSnapshotSha256(validatedSnapshot),
    'lease assets snapshot digest is invalid',
  );
  assert(
    validatedSnapshot.repository === lease.resource.repository &&
      validatedSnapshot.releaseId === lease.resource.releaseId &&
      validatedSnapshot.tag === lease.resource.tag &&
      validatedSnapshot.sourceCommit === lease.source.commit,
    'lease and attested draft snapshot identities differ',
  );
  return {
    leaseWindow: validatedLease.leaseWindow,
    receipt: validatedLease.receipt,
    snapshot: validatedSnapshot,
  };
}

function liveAssetProjection(release) {
  assert(
    Array.isArray(release?.assets),
    'live GitHub Release assets are missing',
  );
  const assets = release.assets.map((asset) => {
    assert(
      isObject(asset) &&
        Number.isSafeInteger(asset.id) &&
        asset.id > 0 &&
        typeof asset.name === 'string' &&
        asset.state === 'uploaded' &&
        Number.isSafeInteger(asset.size) &&
        asset.size > 0 &&
        asset.digest === `sha256:${String(asset.digest ?? '').slice(7)}` &&
        SHA256.test(String(asset.digest ?? '').slice(7)),
      'live GitHub Release asset metadata is invalid',
    );
    return {
      bytes: asset.size,
      fileName: assertAssetFileName(asset.name),
      releaseAssetId: asset.id,
      sha256: asset.digest.slice('sha256:'.length),
    };
  });
  assert(
    new Set(assets.map((asset) => asset.fileName)).size === assets.length &&
      new Set(assets.map((asset) => asset.releaseAssetId)).size ===
        assets.length,
    'live GitHub Release assets contain duplicate names or IDs',
  );
  return assets.sort((left, right) =>
    left.fileName.localeCompare(right.fileName),
  );
}

function classifyLiveReleaseState(release) {
  if (release?.draft === true && release.published_at === null) return 'draft';
  if (
    release?.draft === false &&
    typeof release.published_at === 'string' &&
    release.published_at.length > 0
  ) {
    return 'published';
  }
  return 'invalid';
}

export function validateLeaseBoundLiveRelease({
  lease,
  now = new Date(),
  release,
  snapshot,
  state,
}) {
  assert(isObject(release), 'live GitHub Release response is invalid');
  assert(
    state === 'draft' || state === 'published',
    'live release state is invalid',
  );
  const expectedApiUrl = `${API_ORIGIN}/repos/${lease.resource.repository}/releases/${lease.resource.releaseId}`;
  const liveCreatedAt = parseGitHubInstant(
    release.created_at,
    'GitHub Release created_at',
  );
  const snapshotCreatedAt = parseCanonicalInstant(
    snapshot.createdAt,
    'publication snapshot createdAt',
  );
  assert(
    release.id === lease.resource.releaseId &&
      release.url === expectedApiUrl &&
      release.tag_name === lease.resource.tag &&
      release.target_commitish === lease.source.commit &&
      release.prerelease === false &&
      liveCreatedAt === snapshotCreatedAt,
    'live GitHub Release identity differs from the lease',
  );
  assert(
    typeof release.name === 'string' &&
      sha256(release.name) === lease.publication.releaseNameSha256 &&
      typeof release.body === 'string' &&
      sha256(release.body) === lease.publication.releaseBodySha256,
    'live GitHub Release name or body differs from the lease',
  );
  assert(
    canonicalJson(liveAssetProjection(release)) ===
      canonicalJson(snapshot.assets),
    'live GitHub Release asset snapshot differs from the lease',
  );
  const actualState = classifyLiveReleaseState(release);
  assert(
    actualState === state,
    'live GitHub Release state differs from expected',
  );

  if (state === 'draft') {
    assert(
      release.immutable === false,
      'draft GitHub Release unexpectedly reports immutable state',
    );
  } else {
    assert(
      release.immutable === true,
      'terminal GitHub Release is not immutable',
    );
    const publishedAt = parseGitHubInstant(
      release.published_at,
      'GitHub Release published_at',
    );
    const issuedAt = parseCanonicalInstant(
      lease.lease.issuedAt,
      'lease issuedAt',
    );
    const expiresAt = parseCanonicalInstant(
      lease.lease.expiresAt,
      'lease expiresAt',
    );
    const nowMs = now.getTime();
    assert(
      publishedAt >= liveCreatedAt &&
        publishedAt >= issuedAt - CLOCK_SKEW_MS &&
        publishedAt <= expiresAt + CLOCK_SKEW_MS &&
        publishedAt <= nowMs + CLOCK_SKEW_MS,
      'GitHub Release publication time is outside the lease window',
    );
  }
  return release;
}

function assertConditionalEtag(value) {
  assert(
    typeof value === 'string' &&
      value.length <= 256 &&
      !/[\r\n\0]/u.test(value) &&
      /^(?:W\/)?"[^"\r\n]{1,220}"$/u.test(value),
    'GitHub Release response is missing a usable conditional ETag',
  );
  return value;
}

function readPublicationClock(clock) {
  assert(typeof clock === 'function', 'publication clock is invalid');
  const value = clock();
  assert(
    value instanceof Date && !Number.isNaN(value.getTime()),
    'publication clock returned an invalid instant',
  );
  return new Date(value.getTime());
}

export class GitHubStablePublicationApi {
  constructor({
    fetchImpl = globalThis.fetch,
    token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  } = {}) {
    assert(typeof fetchImpl === 'function', 'fetch implementation is required');
    assert(
      typeof token === 'string' && token.length > 0 && !/[\r\n]/u.test(token),
      'GH_TOKEN or GITHUB_TOKEN is required',
    );
    this.fetchImpl = fetchImpl;
    this.token = token;
  }

  async request(
    endpoint,
    { body, expectedStatuses, headers = {}, method = 'GET' },
  ) {
    let response;
    try {
      response = await this.fetchImpl(endpoint, {
        body,
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'User-Agent': 'clodex-stable-lease-publisher',
          'X-GitHub-Api-Version': API_VERSION,
          ...headers,
        },
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      fail(`GitHub API ${method} failed before an HTTP response`, {
        cause: error,
      });
    }
    const responseText = await response.text();
    if (!expectedStatuses.includes(response.status)) {
      fail(
        `GitHub API ${method} failed with HTTP ${response.status}: ${responseText.slice(0, 1_000)}`,
      );
    }
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      fail(`GitHub API ${method} returned invalid JSON`);
    }
    return {
      data,
      etag: response.headers.get('etag'),
      status: response.status,
    };
  }

  async getRelease(repository, releaseId) {
    assert(
      repository === CANONICAL_RELEASE_REPOSITORY,
      'release repository is not canonical',
    );
    assertPositiveInteger(releaseId, 'release ID');
    const endpoint = new URL(
      `/repos/${repository}/releases/${releaseId}`,
      API_ORIGIN,
    );
    const response = await this.request(endpoint, { expectedStatuses: [200] });
    return { etag: response.etag, release: response.data };
  }

  async publishRelease(repository, releaseId, etag) {
    assert(
      repository === CANONICAL_RELEASE_REPOSITORY,
      'release repository is not canonical',
    );
    assertPositiveInteger(releaseId, 'release ID');
    const endpoint = new URL(
      `/repos/${repository}/releases/${releaseId}`,
      API_ORIGIN,
    );
    const response = await this.request(endpoint, {
      body: JSON.stringify({ draft: false }),
      expectedStatuses: [200, 412],
      headers: {
        'Content-Type': 'application/json',
        'If-Match': assertConditionalEtag(etag),
      },
      method: 'PATCH',
    });
    return {
      etag: response.etag,
      release: response.data,
      status: response.status,
    };
  }
}

function publicationResult(receipt, status, patched) {
  return {
    leaseEpoch: receipt.lease.epoch,
    leaseNonceSha256: sha256(receipt.lease.nonce),
    patched,
    releaseId: receipt.resource.releaseId,
    state: 'published',
    status,
    tag: receipt.resource.tag,
  };
}

async function recoverAfterUncertainEffect({ api, clock, handoff, status }) {
  const terminal = await api.getRelease(
    handoff.receipt.resource.repository,
    handoff.receipt.resource.releaseId,
  );
  if (classifyLiveReleaseState(terminal.release) === 'published') {
    validateLeaseBoundLiveRelease({
      lease: handoff.receipt,
      now: readPublicationClock(clock),
      release: terminal.release,
      snapshot: handoff.snapshot,
      state: 'published',
    });
    return publicationResult(handoff.receipt, status, true);
  }
  fail(
    'stable publication outcome is uncertain; no automatic second PATCH was attempted',
  );
}

/**
 * Performs at most one PATCH. Replays are idempotent only when the exact live
 * release is already public, immutable, and was published inside this lease's
 * bounded time window.
 */
export async function publishStableReleaseWithLease({
  api,
  clock = () => new Date(),
  expected,
  expectedLeaseSha256,
  expectedSnapshotSha256,
  lease,
  leaseBytes,
  snapshot,
  snapshotBytes,
}) {
  assert(api && typeof api.getRelease === 'function', 'release API is invalid');
  assert(
    typeof api.publishRelease === 'function',
    'release publication API is invalid',
  );
  const handoff = validateStablePublicationHandoff({
    expected,
    expectedLeaseSha256,
    expectedSnapshotSha256,
    lease,
    leaseBytes,
    now: readPublicationClock(clock),
    snapshot,
    snapshotBytes,
  });
  const initial = await api.getRelease(
    handoff.receipt.resource.repository,
    handoff.receipt.resource.releaseId,
  );
  const initialState = classifyLiveReleaseState(initial.release);
  if (initialState === 'published') {
    const replayNow = readPublicationClock(clock);
    validateStablePublicationLeaseReceipt(handoff.receipt, {
      expected,
      now: replayNow,
    });
    validateLeaseBoundLiveRelease({
      lease: handoff.receipt,
      now: replayNow,
      release: initial.release,
      snapshot: handoff.snapshot,
      state: 'published',
    });
    return publicationResult(handoff.receipt, 'already-published', false);
  }
  assert(
    initialState === 'draft',
    'live GitHub Release is neither draft nor published',
  );
  validateLeaseBoundLiveRelease({
    lease: handoff.receipt,
    now: readPublicationClock(clock),
    release: initial.release,
    snapshot: handoff.snapshot,
    state: 'draft',
  });
  const etag = assertConditionalEtag(initial.etag);

  // Re-authorize against a fresh clock sample after the potentially slow
  // observation GET and immediately before entering the single effect call.
  // There is deliberately no await between this check and publishRelease().
  validateStablePublicationLeaseReceipt(handoff.receipt, {
    expected,
    now: readPublicationClock(clock),
    requireActive: true,
  });

  let effect;
  try {
    effect = await api.publishRelease(
      handoff.receipt.resource.repository,
      handoff.receipt.resource.releaseId,
      etag,
    );
  } catch (error) {
    try {
      return await recoverAfterUncertainEffect({
        api,
        clock,
        handoff,
        status: 'published-after-uncertain-response',
      });
    } catch (recoveryError) {
      fail(
        'stable publication outcome is uncertain; retain the same lease for terminal inspection',
        { cause: recoveryError ?? error },
      );
    }
  }

  if (effect.status === 412) {
    return recoverAfterUncertainEffect({
      api,
      clock,
      handoff,
      status: 'published-after-precondition-race',
    });
  }
  assert(
    effect.status === 200,
    'stable publication returned an unexpected status',
  );
  validateLeaseBoundLiveRelease({
    lease: handoff.receipt,
    now: readPublicationClock(clock),
    release: effect.release,
    snapshot: handoff.snapshot,
    state: 'published',
  });
  const terminal = await api.getRelease(
    handoff.receipt.resource.repository,
    handoff.receipt.resource.releaseId,
  );
  validateLeaseBoundLiveRelease({
    lease: handoff.receipt,
    now: readPublicationClock(clock),
    release: terminal.release,
    snapshot: handoff.snapshot,
    state: 'published',
  });
  return publicationResult(handoff.receipt, 'published', true);
}

function parseArguments(values) {
  const allowed = new Set([
    'draft-snapshot-sha256',
    'epoch',
    'github-output',
    'holder-id',
    'holder-run-attempt',
    'holder-run-id',
    'holder-workflow',
    'lease',
    'lease-sha256',
    'manifest-path',
    'manifest-sha256',
    'producer-commit',
    'producer-repository',
    'producer-run-attempt',
    'producer-run-id',
    'producer-source-ref',
    'producer-workflow',
    'release-id',
    'repository',
    'snapshot',
    'source-commit',
    'tag',
  ]);
  const options = {};
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

function parsePositiveOption(value, label) {
  assert(/^[1-9][0-9]*$/u.test(value ?? ''), `${label} is invalid`);
  return assertPositiveInteger(Number.parseInt(value, 10), label);
}

async function readBoundedJson(filePath, label) {
  const resolved = path.resolve(filePath ?? '');
  let handle;
  try {
    handle = await open(
      resolved,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const stats = await handle.stat();
    assert(
      stats.isFile() && stats.size > 0,
      `${label} path must be a non-empty regular file`,
    );
    assert(stats.size <= MAX_INPUT_BYTES, `${label} exceeds the size limit`);
    const bytes = await handle.readFile();
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail(`${label} is not valid JSON`);
    }
    return { bytes, resolved, value };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    fail(`${label} path must be a non-empty regular file`, { cause: error });
  } finally {
    await handle?.close();
  }
}

async function appendGitHubOutput(outputPath, result) {
  const resolved = path.resolve(outputPath ?? '');
  let handle;
  try {
    handle = await open(
      resolved,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    );
    const stats = await handle.stat();
    assert(stats.isFile(), 'GitHub output path must be a regular file');
    await handle.writeFile(
      [
        `release_id=${result.releaseId}`,
        `release_state=${result.state}`,
        `publication_result=${result.status}`,
        `lease_epoch=${result.leaseEpoch}`,
        `lease_nonce_sha256=${result.leaseNonceSha256}`,
        `patched=${result.patched}`,
        '',
      ].join('\n'),
      'utf8',
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'GitHub output path must be a regular file'
    ) {
      throw error;
    }
    fail('GitHub output path must be an existing regular file', {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  for (const name of [
    'draft-snapshot-sha256',
    'epoch',
    'github-output',
    'holder-id',
    'holder-run-attempt',
    'holder-run-id',
    'holder-workflow',
    'lease',
    'lease-sha256',
    'manifest-path',
    'manifest-sha256',
    'producer-commit',
    'producer-repository',
    'producer-run-attempt',
    'producer-run-id',
    'producer-source-ref',
    'producer-workflow',
    'release-id',
    'repository',
    'snapshot',
    'source-commit',
    'tag',
  ]) {
    if (!options[name]) fail(`--${name} is required`);
  }
  assert(
    options.repository === CANONICAL_RELEASE_REPOSITORY,
    'release repository is not canonical',
  );
  const releaseId = parsePositiveOption(options['release-id'], 'release ID');
  const holderRunId = parsePositiveOption(
    options['holder-run-id'],
    'holder run ID',
  );
  const holderRunAttempt = parsePositiveOption(
    options['holder-run-attempt'],
    'holder run attempt',
  );
  const producerRunId = parsePositiveOption(
    options['producer-run-id'],
    'producer run ID',
  );
  const producerRunAttempt = parsePositiveOption(
    options['producer-run-attempt'],
    'producer run attempt',
  );
  const epoch = parsePositiveOption(options.epoch, 'lease epoch');
  const leaseInput = await readBoundedJson(options.lease, 'lease receipt');
  const snapshotInput = await readBoundedJson(
    options.snapshot,
    'draft publication snapshot',
  );
  const expected = {
    epoch,
    holder: {
      id: options['holder-id'],
      repository: options.repository,
      runAttempt: holderRunAttempt,
      runId: holderRunId,
      workflow: options['holder-workflow'],
    },
    manifest: {
      path: options['manifest-path'],
      sha256: options['manifest-sha256'],
    },
    producer: {
      repository: options['producer-repository'],
      runAttempt: producerRunAttempt,
      runId: producerRunId,
      sourceCommit: options['producer-commit'],
      sourceRef: options['producer-source-ref'],
      workflow: options['producer-workflow'],
      workflowCommit: options['producer-commit'],
    },
    publication: {
      draftSnapshotSha256: options['draft-snapshot-sha256'],
    },
    resource: {
      kind: 'github-release',
      releaseId,
      repository: options.repository,
      tag: options.tag,
    },
    source: {
      commit: options['source-commit'],
      ref: TRUSTED_RELEASE_SOURCE_REF,
    },
  };
  const api = new GitHubStablePublicationApi();
  const result = await publishStableReleaseWithLease({
    api,
    expected,
    expectedLeaseSha256: options['lease-sha256'],
    expectedSnapshotSha256: options['draft-snapshot-sha256'],
    lease: leaseInput.value,
    leaseBytes: leaseInput.bytes,
    snapshot: snapshotInput.value,
    snapshotBytes: snapshotInput.bytes,
  });
  await appendGitHubOutput(options['github-output'], result);
  console.log(
    `[stable-lease-publisher] state=${result.state} result=${result.status} patched=${result.patched}`,
  );
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error(
      `[stable-lease-publisher] ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
