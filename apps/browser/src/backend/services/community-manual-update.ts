import { createHash } from 'node:crypto';
import type { AppDistributionMode } from '@shared/local-build-identity';

const CANONICAL_REPOSITORY = 'mereyabdenbekuly-ctrl/clodex-ide';
const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_WEB_ORIGIN = 'https://github.com';
const RELEASE_PAGE_SIZE = 50;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RELEASES = RELEASE_PAGE_SIZE;
const MAX_RELEASE_ASSET_BYTES = 2 * 1024 ** 3 - 1;
const MAX_CHECKSUM_BYTES = 16 * 1024;
const MAX_TAG_CHARS = 128;
const MAX_URL_CHARS = 1_024;
const MAX_REDIRECT_URL_CHARS = 8_192;
const MAX_ASSET_NAME_CHARS = 255;
const MAX_PUBLISHED_AT_CHARS = 64;
const DEFAULT_TIMEOUT_MS = 8_000;
const CHECKSUM_ASSET_NAME = 'SHA256SUMS.txt';
const REQUEST_USER_AGENT = 'clodex-community-manual-update';

export const COMMUNITY_RELEASES_API_URL =
  `${GITHUB_API_ORIGIN}/repos/${CANONICAL_REPOSITORY}/releases` +
  `?per_page=${RELEASE_PAGE_SIZE}`;

const COMMUNITY_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(community|communityobserved)([1-9]\d*)$/u;
const SAFE_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+@()-]{0,254}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const PUBLISHED_AT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const CHECKSUM_LINE_PATTERN =
  /^([a-f0-9]{64}) {2}([A-Za-z0-9][A-Za-z0-9._+@()-]{0,254})$/u;
const CHECKSUM_REDIRECT_HOSTS = new Set([
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

type CommunityDistributionMode = Extract<
  AppDistributionMode,
  'community-unsigned' | 'community-observed'
>;

export interface ParsedCommunityVersion {
  distributionMode: CommunityDistributionMode;
  version: string;
  base: readonly [number, number, number];
  buildCounter: number;
}

interface ValidatedAsset {
  apiUrl: string;
  digest: string;
  downloadUrl: string;
  id: number;
  name: string;
  size: number;
}

interface ValidatedRelease {
  assets: ReadonlyMap<string, ValidatedAsset>;
  releasePageUrl: string;
}

export interface CommunityManualUpdateRequest {
  distributionMode: CommunityDistributionMode;
  currentVersion: string;
  platform: string;
  architecture: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export type CommunityManualUpdateResult =
  | { status: 'current' }
  | {
      status: 'available';
      releaseName: string;
      releasePageUrl: string;
    };

export class CommunityManualUpdateError extends Error {
  public constructor(
    public readonly code:
      | 'unsupported-build'
      | 'request-failed'
      | 'request-timeout'
      | 'response-invalid'
      | 'response-too-large',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CommunityManualUpdateError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseInvalid(message: string): CommunityManualUpdateError {
  return new CommunityManualUpdateError('response-invalid', message);
}

function parseSafeInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseCommunityBuildVersion(
  version: string,
): ParsedCommunityVersion | null {
  const match = COMMUNITY_VERSION_PATTERN.exec(version);
  if (!match) return null;

  const major = parseSafeInteger(match[1]!);
  const minor = parseSafeInteger(match[2]!);
  const patch = parseSafeInteger(match[3]!);
  const buildCounter = parseSafeInteger(match[5]!);
  if (
    major === null ||
    minor === null ||
    patch === null ||
    buildCounter === null
  ) {
    return null;
  }

  return {
    distributionMode:
      match[4] === 'communityobserved'
        ? 'community-observed'
        : 'community-unsigned',
    version,
    base: [major, minor, patch],
    buildCounter,
  };
}

export function compareCommunityBuildVersions(
  left: ParsedCommunityVersion,
  right: ParsedCommunityVersion,
): number {
  for (let index = 0; index < left.base.length; index += 1) {
    const difference = left.base[index]! - right.base[index]!;
    if (difference !== 0) return difference;
  }
  return left.buildCounter - right.buildCounter;
}

export function isCommunityManualUpdateSupported(options: {
  distributionMode: AppDistributionMode;
  currentVersion: string;
  releaseChannel: string;
  platform: string;
  architecture: string;
}): boolean {
  if (
    options.distributionMode !== 'community-unsigned' &&
    options.distributionMode !== 'community-observed'
  ) {
    return false;
  }
  if (options.releaseChannel !== 'release') return false;
  if (
    !isSupportedPlatformArchitecture(options.platform, options.architecture)
  ) {
    return false;
  }

  const parsed = parseCommunityBuildVersion(options.currentVersion);
  return parsed?.distributionMode === options.distributionMode;
}

function isSupportedPlatformArchitecture(
  platform: string,
  architecture: string,
): boolean {
  return (
    (platform === 'darwin' && ['arm64', 'x64'].includes(architecture)) ||
    ((platform === 'linux' || platform === 'win32') && architecture === 'x64')
  );
}

function canonicalReleasePageUrl(tagName: string): string {
  return `${GITHUB_WEB_ORIGIN}/${CANONICAL_REPOSITORY}/releases/tag/${tagName}`;
}

function canonicalAssetDownloadUrl(tagName: string, assetName: string): string {
  return (
    `${GITHUB_WEB_ORIGIN}/${CANONICAL_REPOSITORY}/releases/download/` +
    `${tagName}/${assetName}`
  );
}

function canonicalAssetApiUrl(assetId: number): string {
  return (
    `${GITHUB_API_ORIGIN}/repos/${CANONICAL_REPOSITORY}/releases/assets/` +
    assetId
  );
}

function requireBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\0\r\n]/u.test(value)
  ) {
    throw responseInvalid(`${label} is invalid`);
  }
  return value;
}

function validateExactHttpsUrl(
  value: unknown,
  expected: string,
  label: string,
): string {
  const raw = requireBoundedString(value, label, MAX_URL_CHARS);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw responseInvalid(`${label} is not a URL`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    parsed.toString() !== expected ||
    raw !== expected
  ) {
    throw responseInvalid(`${label} is not canonical`);
  }
  return raw;
}

function distributionBaseName(
  distributionMode: CommunityDistributionMode,
): string {
  return distributionMode === 'community-observed'
    ? 'clodex-community-observed'
    : 'clodex-community-unsigned';
}

function expectedInstallerAssetNames(
  distributionMode: CommunityDistributionMode,
  version: string,
): string[] {
  const baseName = distributionBaseName(distributionMode);
  return [
    `${baseName}-${version}-arm64.dmg`,
    `${baseName}-${version}-x64.dmg`,
    `${baseName}-${version}-x64-setup.exe`,
    `${baseName}_${version}_amd64.deb`,
    `${baseName}-${version.replace('-', '.')}-1.x86_64.rpm`,
  ].sort((left, right) => left.localeCompare(right));
}

function expectedReleaseAssetNames(
  distributionMode: CommunityDistributionMode,
  version: string,
): string[] {
  const names = [
    ...expectedInstallerAssetNames(distributionMode, version),
    CHECKSUM_ASSET_NAME,
  ];
  if (distributionMode === 'community-observed') {
    names.push(
      `${distributionBaseName(distributionMode)}-${version}-evidence.zip`,
    );
  }
  return names.sort((left, right) => left.localeCompare(right));
}

function validateAsset(
  value: unknown,
  releaseIndex: number,
  assetIndex: number,
  tagName: string,
): ValidatedAsset {
  const label = `release[${releaseIndex}].assets[${assetIndex}]`;
  if (!isRecord(value)) throw responseInvalid(`${label} is not an object`);

  const name = requireBoundedString(
    value.name,
    `${label}.name`,
    MAX_ASSET_NAME_CHARS,
  );
  if (
    !SAFE_ASSET_NAME_PATTERN.test(name) ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw responseInvalid(`${label}.name is unsafe`);
  }
  if (value.state !== 'uploaded') {
    throw responseInvalid(`${label}.state is not uploaded`);
  }
  if (
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0
  ) {
    throw responseInvalid(`${label}.id is invalid`);
  }
  if (
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    value.size > MAX_RELEASE_ASSET_BYTES
  ) {
    throw responseInvalid(`${label}.size is invalid`);
  }
  const digestValue = requireBoundedString(
    value.digest,
    `${label}.digest`,
    'sha256:'.length + 64,
  );
  const digestMatch = /^sha256:([a-f0-9]{64})$/u.exec(digestValue);
  if (!digestMatch) {
    throw responseInvalid(`${label}.digest is invalid`);
  }
  const apiUrl = validateExactHttpsUrl(
    value.url,
    canonicalAssetApiUrl(value.id),
    `${label}.url`,
  );
  const downloadUrl = validateExactHttpsUrl(
    value.browser_download_url,
    canonicalAssetDownloadUrl(tagName, name),
    `${label}.browser_download_url`,
  );
  return {
    apiUrl,
    digest: digestMatch[1]!,
    downloadUrl,
    id: value.id,
    name,
    size: value.size,
  };
}

function validatePublishedAt(value: unknown, label: string): void {
  const publishedAt = requireBoundedString(
    value,
    label,
    MAX_PUBLISHED_AT_CHARS,
  );
  if (!PUBLISHED_AT_PATTERN.test(publishedAt)) {
    throw responseInvalid(`${label} is invalid`);
  }
  const timestamp = Date.parse(publishedAt);
  const canonical = publishedAt.includes('.')
    ? publishedAt
    : publishedAt.replace(/Z$/u, '.000Z');
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== canonical
  ) {
    throw responseInvalid(`${label} is invalid`);
  }
}

function validateReleaseCandidate(
  value: Record<string, unknown>,
  index: number,
  tagName: string,
  version: ParsedCommunityVersion,
): ValidatedRelease {
  const label = `release[${index}]`;
  const releasePageUrl = validateExactHttpsUrl(
    value.html_url,
    canonicalReleasePageUrl(tagName),
    `${label}.html_url`,
  );
  if (value.immutable !== true) {
    throw responseInvalid(`${label}.immutable is not true`);
  }
  validatePublishedAt(value.published_at, `${label}.published_at`);
  const targetCommitish = requireBoundedString(
    value.target_commitish,
    `${label}.target_commitish`,
    40,
  );
  if (!SOURCE_COMMIT_PATTERN.test(targetCommitish)) {
    throw responseInvalid(`${label}.target_commitish is invalid`);
  }
  const expectedAssetNames = expectedReleaseAssetNames(
    version.distributionMode,
    version.version,
  );
  if (
    !Array.isArray(value.assets) ||
    value.assets.length !== expectedAssetNames.length
  ) {
    throw responseInvalid(`${label}.assets is invalid`);
  }

  const expectedAssetNameSet = new Set(expectedAssetNames);
  const assets = new Map<string, ValidatedAsset>();
  const assetIds = new Set<number>();
  for (const [assetIndex, asset] of value.assets.entries()) {
    const validated = validateAsset(asset, index, assetIndex, tagName);
    if (!expectedAssetNameSet.has(validated.name)) {
      throw responseInvalid(`${label}.assets contains an unexpected name`);
    }
    if (assets.has(validated.name)) {
      throw responseInvalid(`${label}.assets contains duplicate names`);
    }
    if (assetIds.has(validated.id)) {
      throw responseInvalid(`${label}.assets contains duplicate IDs`);
    }
    assets.set(validated.name, validated);
    assetIds.add(validated.id);
  }
  if (expectedAssetNames.some((name) => !assets.has(name))) {
    throw responseInvalid(`${label}.assets is incomplete`);
  }

  return {
    assets,
    releasePageUrl,
  };
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup only. Preserve the validation error that caused it.
  }
}

async function rejectResponse(
  response: Response,
  error: CommunityManualUpdateError,
): Promise<never> {
  await cancelResponseBody(response);
  throw error;
}

function responseTooLarge(label: string): CommunityManualUpdateError {
  return new CommunityManualUpdateError(
    'response-too-large',
    `${label} exceeds the size limit`,
  );
}

async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      return await rejectResponse(
        response,
        responseInvalid(`${label} content-length is invalid`),
      );
    }
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      return await rejectResponse(response, responseTooLarge(label));
    }
  }
  if (!response.body) throw responseInvalid(`${label} body is missing`);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded-response error.
        }
        throw responseTooLarge(label);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the original stream error.
      }
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new CommunityManualUpdateError(
      'response-invalid',
      `${label} is not valid UTF-8`,
      { cause: error },
    );
  }
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  return decodeUtf8(
    await readBoundedResponseBytes(response, maxBytes, label),
    label,
  );
}

async function withRequestAbort<T>(
  options: {
    signal?: AbortSignal;
    timeoutMs: number;
  },
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('manual update request timed out'));
  }, options.timeoutMs);

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (error instanceof CommunityManualUpdateError) throw error;
    if (timedOut && !options.signal?.aborted) {
      throw new CommunityManualUpdateError(
        'request-timeout',
        `${label} timed out`,
        { cause: error },
      );
    }
    throw new CommunityManualUpdateError('request-failed', `${label} failed`, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

function requestHeaders(accept: string): Record<string, string> {
  return {
    Accept: accept,
    'User-Agent': REQUEST_USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function fetchReleasePayload(options: {
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  timeoutMs: number;
  maxResponseBytes: number;
}): Promise<unknown> {
  return await withRequestAbort(
    options,
    'GitHub releases request',
    async (signal) => {
      const response = await options.fetchImpl(COMMUNITY_RELEASES_API_URL, {
        method: 'GET',
        headers: requestHeaders('application/vnd.github+json'),
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal,
      });

      if (response.url !== COMMUNITY_RELEASES_API_URL) {
        return await rejectResponse(
          response,
          responseInvalid('GitHub releases response URL is not canonical'),
        );
      }
      if (!response.ok || response.status !== 200) {
        return await rejectResponse(
          response,
          new CommunityManualUpdateError(
            'request-failed',
            `GitHub releases request returned HTTP ${response.status}`,
          ),
        );
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (
        !/^application\/(?:json|vnd\.github\+json)(?:\s*;|$)/iu.test(
          contentType,
        )
      ) {
        return await rejectResponse(
          response,
          responseInvalid('GitHub releases response content-type is invalid'),
        );
      }

      const body = await readBoundedResponseBody(
        response,
        options.maxResponseBytes,
        'GitHub releases response',
      );
      try {
        return JSON.parse(body) as unknown;
      } catch (error) {
        throw new CommunityManualUpdateError(
          'response-invalid',
          'GitHub releases response is not valid JSON',
          { cause: error },
        );
      }
    },
  );
}

function validateChecksumRedirectUrl(value: unknown): string {
  const raw = requireBoundedString(
    value,
    'checksum redirect URL',
    MAX_REDIRECT_URL_CHARS,
  );
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw responseInvalid('checksum redirect URL is invalid');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash ||
    !CHECKSUM_REDIRECT_HOSTS.has(parsed.hostname.toLowerCase()) ||
    parsed.pathname === '/' ||
    parsed.toString() !== raw
  ) {
    throw responseInvalid('checksum redirect URL is not allowlisted');
  }
  return raw;
}

async function readChecksumResponse(
  response: Response,
  expectedUrl: string,
): Promise<Uint8Array> {
  if (response.url !== expectedUrl) {
    return await rejectResponse(
      response,
      responseInvalid('checksum response URL is not canonical'),
    );
  }
  if (!response.ok || response.status !== 200) {
    return await rejectResponse(
      response,
      new CommunityManualUpdateError(
        'request-failed',
        `checksum request returned HTTP ${response.status}`,
      ),
    );
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (
    !/^(?:application\/octet-stream|text\/plain)(?:\s*;|$)/iu.test(contentType)
  ) {
    return await rejectResponse(
      response,
      responseInvalid('checksum response content-type is invalid'),
    );
  }
  return await readBoundedResponseBytes(
    response,
    MAX_CHECKSUM_BYTES,
    'checksum response',
  );
}

async function fetchChecksumBytes(options: {
  asset: ValidatedAsset;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<Uint8Array> {
  const bytes = await withRequestAbort(
    options,
    'checksum request',
    async (signal) => {
      const requestOptions: RequestInit = {
        method: 'GET',
        headers: requestHeaders('application/octet-stream'),
        redirect: 'manual',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal,
      };
      const initial = await options.fetchImpl(
        options.asset.downloadUrl,
        requestOptions,
      );
      if (initial.url !== options.asset.downloadUrl) {
        return await rejectResponse(
          initial,
          responseInvalid('checksum response URL is not canonical'),
        );
      }
      if (initial.status === 200) {
        return await readChecksumResponse(initial, options.asset.downloadUrl);
      }
      if (![301, 302, 303, 307, 308].includes(initial.status)) {
        return await rejectResponse(
          initial,
          new CommunityManualUpdateError(
            'request-failed',
            `checksum request returned HTTP ${initial.status}`,
          ),
        );
      }

      const redirectUrl = validateChecksumRedirectUrl(
        initial.headers.get('location'),
      );
      await cancelResponseBody(initial);
      const redirected = await options.fetchImpl(redirectUrl, {
        ...requestOptions,
        redirect: 'error',
      });
      return await readChecksumResponse(redirected, redirectUrl);
    },
  );

  const actualDigest = createHash('sha256').update(bytes).digest('hex');
  if (actualDigest !== options.asset.digest) {
    throw responseInvalid('checksum asset digest does not match its bytes');
  }
  return bytes;
}

function verifyChecksumManifest(
  bytes: Uint8Array,
  release: ValidatedRelease,
): void {
  const source = decodeUtf8(bytes, 'checksum response');
  if (!source.endsWith('\n') || /[\0\r]/u.test(source)) {
    throw responseInvalid('checksum manifest is not canonical');
  }
  const lines = source.slice(0, -1).split('\n');
  const expectedNames = [...release.assets.keys()]
    .filter((name) => name !== CHECKSUM_ASSET_NAME)
    .sort((left, right) => left.localeCompare(right));
  if (lines.length !== expectedNames.length) {
    throw responseInvalid('checksum manifest coverage is invalid');
  }

  const records = lines.map((line) => {
    const match = CHECKSUM_LINE_PATTERN.exec(line);
    if (!match || !SHA256_PATTERN.test(match[1]!)) {
      throw responseInvalid('checksum manifest contains an invalid line');
    }
    return { digest: match[1]!, name: match[2]! };
  });
  if (
    JSON.stringify(records.map(({ name }) => name)) !==
    JSON.stringify(expectedNames)
  ) {
    throw responseInvalid('checksum manifest asset set is invalid');
  }
  for (const record of records) {
    if (release.assets.get(record.name)?.digest !== record.digest) {
      throw responseInvalid(`checksum mismatch for ${record.name}`);
    }
  }
}

export async function discoverCommunityManualUpdate(
  request: CommunityManualUpdateRequest,
): Promise<CommunityManualUpdateResult> {
  const current = parseCommunityBuildVersion(request.currentVersion);
  if (!current || current.distributionMode !== request.distributionMode) {
    throw new CommunityManualUpdateError(
      'unsupported-build',
      'Installed community build version is unsupported',
    );
  }
  if (
    !isSupportedPlatformArchitecture(request.platform, request.architecture)
  ) {
    throw new CommunityManualUpdateError(
      'unsupported-build',
      'Installed platform or architecture is unsupported',
    );
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = request.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 60_000
  ) {
    throw new CommunityManualUpdateError(
      'unsupported-build',
      'Manual update timeout is invalid',
    );
  }
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0 ||
    maxResponseBytes > MAX_RESPONSE_BYTES
  ) {
    throw new CommunityManualUpdateError(
      'unsupported-build',
      'Manual update response limit is invalid',
    );
  }

  const payload = await fetchReleasePayload({
    fetchImpl: request.fetchImpl ?? fetch,
    signal: request.signal,
    timeoutMs,
    maxResponseBytes,
  });
  if (!Array.isArray(payload) || payload.length > MAX_RELEASES) {
    throw responseInvalid('GitHub releases payload is invalid');
  }

  let selected:
    | {
        release: ValidatedRelease;
        version: ParsedCommunityVersion;
      }
    | undefined;
  for (const [index, rawRelease] of payload.entries()) {
    if (!isRecord(rawRelease)) continue;
    const rawTagName = rawRelease.tag_name;
    if (typeof rawTagName !== 'string') continue;
    const version =
      rawTagName.length <= MAX_TAG_CHARS &&
      SAFE_TAG_PATTERN.test(rawTagName) &&
      rawTagName.startsWith('v')
        ? parseCommunityBuildVersion(rawTagName.slice(1))
        : null;
    if (
      !version ||
      version.distributionMode !== request.distributionMode ||
      compareCommunityBuildVersions(version, current) <= 0
    ) {
      continue;
    }
    if (
      typeof rawRelease.draft !== 'boolean' ||
      typeof rawRelease.prerelease !== 'boolean'
    ) {
      throw responseInvalid(`release[${index}] publication state is invalid`);
    }
    if (rawRelease.draft || !rawRelease.prerelease) continue;

    const release = validateReleaseCandidate(
      rawRelease,
      index,
      rawTagName,
      version,
    );
    if (
      !selected ||
      compareCommunityBuildVersions(version, selected.version) > 0
    ) {
      selected = {
        release,
        version,
      };
    }
  }

  if (!selected) return { status: 'current' };
  const checksumAsset = selected.release.assets.get(CHECKSUM_ASSET_NAME);
  if (!checksumAsset) {
    throw responseInvalid('selected release has no checksum asset');
  }
  verifyChecksumManifest(
    await fetchChecksumBytes({
      asset: checksumAsset,
      fetchImpl: request.fetchImpl ?? fetch,
      signal: request.signal,
      timeoutMs,
    }),
    selected.release,
  );
  return {
    status: 'available',
    releaseName: selected.version.version,
    releasePageUrl: selected.release.releasePageUrl,
  };
}
