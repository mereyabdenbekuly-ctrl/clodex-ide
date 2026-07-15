#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { appendFile, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CANONICAL_NPM_REGISTRY = 'https://registry.npmjs.org/';
const DEFAULT_ATTEMPTS = 12;
const DEFAULT_DELAY_MS = 10_000;
const NPM_MAX_SAFE_SEMVER_COMPONENT = 9_007_199_254_740_991n;
const REQUEST_TIMEOUT_MS = 30_000;
const STABLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

function fail(message) {
  throw new Error(message);
}

export class NpmPublicationPendingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NpmPublicationPendingError';
  }
}

function pending(message) {
  throw new NpmPublicationPendingError(message);
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

function assertPositiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function assertNonNegativeInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(`${label} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

function digest(bytes, algorithm, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function parseCanonicalStableSemVer(value, label) {
  assertSingleLine(value, label);
  const match = STABLE_SEMVER.exec(value);
  if (match === null) {
    fail(`${label} must be canonical stable SemVer`);
  }
  const components = match.slice(1).map((component) => BigInt(component));
  if (
    components.some((component) => component > NPM_MAX_SAFE_SEMVER_COMPONENT)
  ) {
    fail(`${label} is outside npm SemVer numeric range`);
  }
  return components;
}

export function compareCanonicalStableSemVer(left, right) {
  const leftComponents = parseCanonicalStableSemVer(left, 'candidate version');
  const rightComponents = parseCanonicalStableSemVer(
    right,
    'npm latest version',
  );
  for (let index = 0; index < leftComponents.length; index += 1) {
    if (leftComponents[index] < rightComponents[index]) return -1;
    if (leftComponents[index] > rightComponents[index]) return 1;
  }
  return 0;
}

function assertRegistryOrigin(value) {
  let registry;
  try {
    registry = new URL(value);
  } catch {
    fail('npm registry origin is invalid');
  }
  if (registry.href !== CANONICAL_NPM_REGISTRY) {
    fail(`npm registry must be exactly ${CANONICAL_NPM_REGISTRY}`);
  }
  return registry;
}

export function assertLocalNpmArtifact({
  artifactBytes,
  identity,
  packageName,
  version,
}) {
  if (!Buffer.isBuffer(artifactBytes) || artifactBytes.length === 0) {
    fail('local npm artifact must be a non-empty Buffer');
  }
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    fail('local npm package identity is invalid');
  }
  assertSingleLine(packageName, 'package name');
  parseCanonicalStableSemVer(version, 'package version');
  if (identity.filename !== 'karton-package.tgz') {
    fail('local npm package identity has an unexpected filename');
  }
  if (identity.name !== packageName || identity.version !== version) {
    fail('local npm package identity does not match the release identity');
  }

  const integrity = `sha512-${digest(artifactBytes, 'sha512', 'base64')}`;
  const shasum = digest(artifactBytes, 'sha1', 'hex');
  if (identity.integrity !== integrity) {
    fail('local npm artifact SHA-512 integrity does not match its identity');
  }
  if (identity.shasum !== shasum) {
    fail('local npm artifact SHA-1 shasum does not match its identity');
  }
  if (identity.size !== artifactBytes.length) {
    fail('local npm artifact size does not match its identity');
  }

  return {
    bytes: artifactBytes,
    integrity,
    packageName,
    shasum,
    size: artifactBytes.length,
    version,
  };
}

function retryableStatus(response, label, { allowNotFound = false } = {}) {
  if (allowNotFound && response.status === 404) return;
  if (
    response.status === 404 ||
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500
  ) {
    pending(`${label} is not ready (HTTP ${response.status})`);
  }
  if (!response.ok) {
    fail(`${label} failed with terminal HTTP ${response.status}`);
  }
}

async function fetchRegistry(
  fetchImpl,
  url,
  label,
  accept,
  { allowNotFound = false } = {},
) {
  let response;
  try {
    response = await fetchImpl(url, {
      cache: 'no-store',
      headers: accept ? { accept } : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    pending(
      `${label} failed before an HTTP response: ${error instanceof Error ? error.message : error}`,
    );
  }
  retryableStatus(response, label, { allowNotFound });
  return response;
}

async function readJsonResponse(response, label) {
  try {
    return await response.json();
  } catch {
    pending(`${label} returned invalid JSON`);
  }
}

function assertCanonicalTarballUrl({
  packageName,
  registry,
  tarball,
  version,
}) {
  let tarballUrl;
  try {
    tarballUrl = new URL(tarball);
  } catch {
    fail('npm version metadata returned an invalid tarball URL');
  }
  const packageBasename = packageName.slice(packageName.lastIndexOf('/') + 1);
  const expectedPath = `/${packageName}/-/${packageBasename}-${version}.tgz`;
  if (
    tarballUrl.origin !== registry.origin ||
    tarballUrl.pathname !== expectedPath ||
    tarballUrl.username !== '' ||
    tarballUrl.password !== '' ||
    tarballUrl.search !== '' ||
    tarballUrl.hash !== ''
  ) {
    fail('npm version metadata tarball URL is not canonical');
  }
  return tarballUrl;
}

function assertVerifierInputs({ artifact, fetchImpl, registryOrigin }) {
  if (typeof fetchImpl !== 'function') fail('fetch implementation is required');
  if (!artifact || typeof artifact !== 'object') {
    fail('validated local npm artifact is required');
  }
  parseCanonicalStableSemVer(artifact.version, 'package version');
  return assertRegistryOrigin(registryOrigin);
}

async function verifyExactVersionArtifact({
  allowMissing,
  artifact,
  fetchImpl,
  registry,
}) {
  const encodedPackage = encodeURIComponent(artifact.packageName);
  const encodedVersion = encodeURIComponent(artifact.version);
  const versionUrl = new URL(`${encodedPackage}/${encodedVersion}`, registry);
  const versionResponse = await fetchRegistry(
    fetchImpl,
    versionUrl,
    'npm exact-version metadata',
    'application/json',
    { allowNotFound: allowMissing },
  );
  if (versionResponse.status === 404) return null;
  const versionMetadata = await readJsonResponse(
    versionResponse,
    'npm exact-version metadata',
  );
  if (
    versionMetadata?.name !== artifact.packageName ||
    versionMetadata?.version !== artifact.version ||
    versionMetadata?._id !== `${artifact.packageName}@${artifact.version}`
  ) {
    fail('npm exact-version metadata does not match the release identity');
  }
  if (versionMetadata?.dist?.integrity !== artifact.integrity) {
    fail('npm exact-version SHA-512 integrity differs from the local artifact');
  }
  if (versionMetadata?.dist?.shasum !== artifact.shasum) {
    fail('npm exact-version SHA-1 shasum differs from the local artifact');
  }

  const tarballUrl = assertCanonicalTarballUrl({
    packageName: artifact.packageName,
    registry,
    tarball: versionMetadata?.dist?.tarball,
    version: artifact.version,
  });
  const tarballResponse = await fetchRegistry(
    fetchImpl,
    tarballUrl,
    'npm exact-version tarball',
  );
  let registryTarball;
  try {
    registryTarball = Buffer.from(await tarballResponse.arrayBuffer());
  } catch {
    pending('npm exact-version tarball could not be read');
  }
  if (
    `sha512-${digest(registryTarball, 'sha512', 'base64')}` !==
    artifact.integrity
  ) {
    fail('npm tarball SHA-512 integrity differs from the local artifact');
  }
  if (digest(registryTarball, 'sha1', 'hex') !== artifact.shasum) {
    fail('npm tarball SHA-1 shasum differs from the local artifact');
  }
  if (registryTarball.length !== artifact.size) {
    fail('npm tarball size differs from the local artifact');
  }
  if (!registryTarball.equals(artifact.bytes)) {
    fail('npm tarball bytes differ from the local artifact');
  }

  return { tarballUrl };
}

async function readLatestDistTag({
  allowMissing,
  artifact,
  fetchImpl,
  registry,
}) {
  const encodedPackage = encodeURIComponent(artifact.packageName);

  const distTagsUrl = new URL(
    `-/package/${encodedPackage}/dist-tags`,
    registry,
  );
  const distTagsResponse = await fetchRegistry(
    fetchImpl,
    distTagsUrl,
    'npm dist-tags metadata',
    'application/json',
    { allowNotFound: allowMissing },
  );
  if (distTagsResponse.status === 404) return null;
  const distTags = await readJsonResponse(
    distTagsResponse,
    'npm dist-tags metadata',
  );
  if (!distTags || typeof distTags !== 'object' || Array.isArray(distTags)) {
    fail('npm dist-tags metadata is not an object');
  }
  if (!Object.hasOwn(distTags, 'latest')) {
    if (allowMissing) return null;
    pending('npm dist-tags.latest is not ready');
  }
  parseCanonicalStableSemVer(distTags.latest, 'npm latest version');
  return distTags.latest;
}

function exactPublicationResult({ artifact, latestVersion, tarballUrl }) {
  const latestComparison = compareCanonicalStableSemVer(
    latestVersion,
    artifact.version,
  );
  if (latestComparison < 0) {
    pending(
      `npm dist-tags.latest is ${latestVersion} behind ${artifact.version}`,
    );
  }

  return {
    distTag: 'latest',
    distTagRelation: latestComparison === 0 ? 'exact' : 'superseded',
    distTagVersion: latestVersion,
    existingExact: true,
    integrity: artifact.integrity,
    packageName: artifact.packageName,
    publishRequired: false,
    shasum: artifact.shasum,
    size: artifact.size,
    state: 'verified',
    tarballUrl: tarballUrl.href,
    version: artifact.version,
  };
}

/**
 * Inspect registry state immediately before npm publish. An absent version may
 * use --tag latest only when it strictly advances the current canonical latest
 * version (or when the package has no latest tag yet). Existing exact versions
 * never republish and may be safely recovered after a newer latest exists.
 */
export async function inspectNpmPublicationStateOnce({
  artifact,
  fetchImpl = globalThis.fetch,
  registryOrigin = CANONICAL_NPM_REGISTRY,
}) {
  const registry = assertVerifierInputs({
    artifact,
    fetchImpl,
    registryOrigin,
  });
  const exact = await verifyExactVersionArtifact({
    allowMissing: true,
    artifact,
    fetchImpl,
    registry,
  });
  const latestVersion = await readLatestDistTag({
    allowMissing: exact === null,
    artifact,
    fetchImpl,
    registry,
  });

  if (exact !== null) {
    return exactPublicationResult({
      artifact,
      latestVersion,
      tarballUrl: exact.tarballUrl,
    });
  }

  if (latestVersion !== null) {
    const candidateComparison = compareCanonicalStableSemVer(
      artifact.version,
      latestVersion,
    );
    if (candidateComparison < 0) {
      fail(
        `refusing to publish absent ${artifact.packageName}@${artifact.version} with npm --tag latest because npm latest is newer (${latestVersion})`,
      );
    }
    if (candidateComparison === 0) {
      fail(
        `npm latest points to absent exact version ${artifact.version}; refusing an ambiguous publish`,
      );
    }
  }

  return {
    distTag: 'latest',
    distTagRelation: latestVersion === null ? 'initial' : 'advances',
    distTagVersion: latestVersion,
    existingExact: false,
    integrity: artifact.integrity,
    packageName: artifact.packageName,
    publishRequired: true,
    shasum: artifact.shasum,
    size: artifact.size,
    state: 'absent',
    tarballUrl: null,
    version: artifact.version,
  };
}

export async function verifyExactNpmPublicationOnce({
  artifact,
  fetchImpl = globalThis.fetch,
  registryOrigin = CANONICAL_NPM_REGISTRY,
}) {
  const registry = assertVerifierInputs({
    artifact,
    fetchImpl,
    registryOrigin,
  });
  const exact = await verifyExactVersionArtifact({
    allowMissing: false,
    artifact,
    fetchImpl,
    registry,
  });
  const latestVersion = await readLatestDistTag({
    allowMissing: false,
    artifact,
    fetchImpl,
    registry,
  });
  return exactPublicationResult({
    artifact,
    latestVersion,
    tarballUrl: exact.tarballUrl,
  });
}

export async function pollExactNpmPublication({
  artifact,
  attempts = DEFAULT_ATTEMPTS,
  delayMs = DEFAULT_DELAY_MS,
  fetchImpl = globalThis.fetch,
  onPending,
  registryOrigin = CANONICAL_NPM_REGISTRY,
  sleepImpl = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  assertPositiveInteger(attempts, 'attempt count', 100);
  assertNonNegativeInteger(delayMs, 'poll delay', 300_000);
  if (typeof sleepImpl !== 'function') fail('sleep implementation is required');
  if (onPending !== undefined && typeof onPending !== 'function') {
    fail('onPending must be a function');
  }

  let lastPending = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verifyExactNpmPublicationOnce({
        artifact,
        fetchImpl,
        registryOrigin,
      });
    } catch (error) {
      if (!(error instanceof NpmPublicationPendingError)) throw error;
      lastPending = error;
      if (onPending) await onPending({ attempt, attempts, error });
      if (attempt < attempts) await sleepImpl(delayMs);
    }
  }
  fail(
    `npm publication did not reach its exact terminal state after ${attempts} attempts: ${lastPending?.message ?? 'unknown pending state'}`,
  );
}

function parseInteger(value, label) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value ?? '')) {
    fail(`${label} must be a canonical non-negative integer`);
  }
  return Number.parseInt(value, 10);
}

function parseArguments(values) {
  const options = {};
  const allowed = new Set([
    'artifact',
    'attempts',
    'delay-ms',
    'github-output',
    'identity',
    'mode',
    'package',
    'registry',
    'version',
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

async function assertRegularFile(filePath, label) {
  const resolved = path.resolve(filePath ?? '');
  const stats = await lstat(resolved).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    fail(`${label} must be a non-empty regular file`);
  }
  return resolved;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  for (const required of [
    'artifact',
    'github-output',
    'identity',
    'package',
    'registry',
    'version',
  ]) {
    if (!options[required]) fail(`--${required} is required`);
  }
  const artifactPath = await assertRegularFile(options.artifact, 'artifact');
  const identityPath = await assertRegularFile(options.identity, 'identity');
  const outputPath = path.resolve(options['github-output']);
  const outputStats = await lstat(outputPath).catch(() => null);
  if (outputStats?.isSymbolicLink())
    fail('GitHub output path must not be a symlink');

  let identity;
  try {
    identity = JSON.parse(await readFile(identityPath, 'utf8'));
  } catch {
    fail('local npm package identity is not valid JSON');
  }
  const artifact = assertLocalNpmArtifact({
    artifactBytes: await readFile(artifactPath),
    identity,
    packageName: options.package,
    version: options.version,
  });
  const mode = options.mode ?? 'terminal';
  if (mode !== 'prepublish' && mode !== 'terminal') {
    fail('--mode must be prepublish or terminal');
  }
  const attempts = options.attempts
    ? parseInteger(options.attempts, 'attempt count')
    : DEFAULT_ATTEMPTS;
  const delayMs = options['delay-ms']
    ? parseInteger(options['delay-ms'], 'poll delay')
    : DEFAULT_DELAY_MS;
  const result =
    mode === 'prepublish'
      ? await inspectNpmPublicationStateOnce({
          artifact,
          registryOrigin: options.registry,
        })
      : await pollExactNpmPublication({
          artifact,
          attempts,
          delayMs,
          onPending: ({ attempt, attempts: total, error }) =>
            console.warn(
              `[npm-publication] attempt ${attempt}/${total}: ${error.message}`,
            ),
          registryOrigin: options.registry,
        });

  await appendFile(
    outputPath,
    [
      `publish_required=${result.publishRequired}`,
      `npm_exact_version_state=${result.existingExact ? 'present' : 'absent'}`,
      `npm_publication_state=${result.state}`,
      `npm_integrity=${result.integrity}`,
      `npm_shasum=${result.shasum}`,
      `npm_size=${result.size}`,
      `npm_dist_tag=${result.distTag}`,
      `npm_dist_tag_relation=${result.distTagRelation}`,
      `npm_dist_tag_version=${result.distTagVersion ?? ''}`,
      '',
    ].join('\n'),
    { encoding: 'utf8', flag: 'a' },
  );
  console.log(JSON.stringify(result));
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((error) => {
    console.error(
      `[verify-npm-publication] ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
