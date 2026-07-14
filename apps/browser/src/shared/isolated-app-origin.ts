import { sha256 } from '@noble/hashes/sha2.js';

export const ISOLATED_APP_IDENTITY_TUPLE_VERSION = 1;
export const ISOLATED_APP_DIGEST_LENGTH = 52;

const SHA256_BYTE_LENGTH = 32;
const RFC4648_BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const MAX_UINT32 = 0xffff_ffff;
const ISOLATED_HOST_PATTERN = /^(agents|plugins)-([a-z2-7]{52})$/;

export type AppUrlNamespace = 'agents' | 'plugins';

export interface AppUrlIdentity {
  namespace: AppUrlNamespace;
  /** The already-decoded agent or plugin identifier. */
  entityId: string;
  /** The already-decoded app identifier. */
  appId: string;
}

export interface ParsedIsolatedAppHost {
  namespace: AppUrlNamespace;
  digest: string;
  host: string;
}

export interface ParsedIsolatedAppOrigin extends ParsedIsolatedAppHost {
  origin: string;
}

export interface ParsedAppUrlIdentity {
  /** Legacy URLs are accepted only so the backend can continue serving them. */
  classification: 'isolated' | 'legacy';
  identity: AppUrlIdentity;
  host: string;
  origin: string;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isValidDecodedIdentityPart(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !hasUnpairedSurrogate(value)
  );
}

function assertValidIdentity(identity: Readonly<AppUrlIdentity>): void {
  if (identity.namespace !== 'agents' && identity.namespace !== 'plugins') {
    throw new TypeError('Invalid app namespace');
  }
  if (!isValidDecodedIdentityPart(identity.entityId)) {
    throw new TypeError('Invalid decoded app entity identifier');
  }
  if (!isValidDecodedIdentityPart(identity.appId)) {
    throw new TypeError('Invalid decoded app identifier');
  }
}

/**
 * Serialize the identity as:
 *
 *   u8 version || u32be namespaceByteLength || namespaceUtf8
 *              || u32be entityIdByteLength  || entityIdUtf8
 *              || u32be appIdByteLength     || appIdUtf8
 *
 * Lengths are byte lengths, not JavaScript UTF-16 code-unit counts. The
 * explicit version and lengths make tuple boundaries unambiguous.
 */
function encodeCanonicalIdentityTuple(
  identity: Readonly<AppUrlIdentity>,
): Uint8Array {
  assertValidIdentity(identity);
  const encoder = new TextEncoder();
  const fields = [
    encoder.encode(identity.namespace),
    encoder.encode(identity.entityId),
    encoder.encode(identity.appId),
  ];

  let byteLength = 1;
  for (const field of fields) {
    if (field.length > MAX_UINT32) {
      throw new RangeError('App identity field is too large');
    }
    byteLength += 4 + field.length;
  }

  const encoded = new Uint8Array(byteLength);
  const view = new DataView(encoded.buffer);
  encoded[0] = ISOLATED_APP_IDENTITY_TUPLE_VERSION;

  let offset = 1;
  for (const field of fields) {
    view.setUint32(offset, field.length, false);
    offset += 4;
    encoded.set(field, offset);
    offset += field.length;
  }
  return encoded;
}

function encodeRfc4648Base32(bytes: Uint8Array): string {
  let result = '';
  let buffer = 0;
  let bufferedBits = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    buffer = (buffer << 8) | byte;
    bufferedBits += 8;

    while (bufferedBits >= 5) {
      bufferedBits -= 5;
      result += RFC4648_BASE32_ALPHABET[(buffer >>> bufferedBits) & 0x1f];
    }

    if (bufferedBits > 0) {
      buffer &= (1 << bufferedBits) - 1;
    } else {
      buffer = 0;
    }
  }

  if (bufferedBits > 0) {
    result += RFC4648_BASE32_ALPHABET[(buffer << (5 - bufferedBits)) & 0x1f];
  }
  return result;
}

function buildIsolatedAppDigest(identity: Readonly<AppUrlIdentity>): string {
  const digestBytes = sha256(encodeCanonicalIdentityTuple(identity));
  if (digestBytes.length !== SHA256_BYTE_LENGTH) {
    throw new Error('Unexpected SHA-256 digest length');
  }
  const digest = encodeRfc4648Base32(digestBytes);
  if (digest.length !== ISOLATED_APP_DIGEST_LENGTH) {
    throw new Error('Unexpected SHA-256 base32 digest length');
  }
  return digest;
}

function isCanonicalSha256Base32(value: string): boolean {
  if (value.length !== ISOLATED_APP_DIGEST_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? '';
    if (!RFC4648_BASE32_ALPHABET.includes(character)) return false;
  }

  // SHA-256 needs 52 base32 characters. Only one bit is meaningful in the
  // final character, so RFC 4648's four pad bits must be zero.
  return value.endsWith('a') || value.endsWith('q');
}

export function buildIsolatedAppHost(
  identity: Readonly<AppUrlIdentity>,
): string {
  const host = `${identity.namespace}-${buildIsolatedAppDigest(identity)}`;
  if (host.length >= 63 || host.includes('.')) {
    throw new Error('Isolated app host must be one DNS label below 63 bytes');
  }
  return host;
}

export function parseIsolatedAppHost(
  host: string,
): ParsedIsolatedAppHost | null {
  const match = ISOLATED_HOST_PATTERN.exec(host);
  if (!match) return null;

  const namespace = match[1] as AppUrlNamespace;
  const digest = match[2];
  if (!digest || !isCanonicalSha256Base32(digest)) return null;
  return { namespace, digest, host };
}

export function validateIsolatedAppHost(
  host: string,
  identity: Readonly<AppUrlIdentity>,
): boolean {
  const parsed = parseIsolatedAppHost(host);
  if (!parsed || parsed.namespace !== identity.namespace) return false;

  try {
    return host === buildIsolatedAppHost(identity);
  } catch {
    return false;
  }
}

export function buildIsolatedAppOrigin(
  identity: Readonly<AppUrlIdentity>,
): string {
  return `app://${buildIsolatedAppHost(identity)}`;
}

export function parseIsolatedAppOrigin(
  origin: string,
): ParsedIsolatedAppOrigin | null {
  if (!origin.startsWith('app://')) return null;
  const host = origin.slice('app://'.length);
  if (!host || host.includes('/') || host.includes('?') || host.includes('#')) {
    return null;
  }

  const parsedHost = parseIsolatedAppHost(host);
  if (!parsedHost) return null;
  return { ...parsedHost, origin };
}

export function validateIsolatedAppOrigin(
  origin: string,
  identity: Readonly<AppUrlIdentity>,
): boolean {
  const parsed = parseIsolatedAppOrigin(origin);
  return parsed !== null && validateIsolatedAppHost(parsed.host, identity);
}

export function buildIsolatedAppUrl(
  identity: Readonly<AppUrlIdentity>,
  relativePathParts: readonly string[] = [],
): string {
  assertValidIdentity(identity);
  for (const part of relativePathParts) {
    if (!isValidDecodedIdentityPart(part)) {
      throw new TypeError('Invalid decoded app URL path part');
    }
  }

  const pathParts = [
    identity.entityId,
    identity.appId,
    ...relativePathParts,
  ].map((part) => encodeURIComponent(part));
  return `${buildIsolatedAppOrigin(identity)}/${pathParts.join('/')}`;
}

function getCanonicalAppAuthority(value: string, url: URL): string | null {
  if (!value.startsWith('app://')) return null;
  const authorityEnd = value.slice('app://'.length).search(/[/?#]/);
  const authority =
    authorityEnd === -1
      ? value.slice('app://'.length)
      : value.slice('app://'.length, 'app://'.length + authorityEnd);

  if (
    !authority ||
    url.protocol !== 'app:' ||
    url.username ||
    url.password ||
    url.port ||
    url.host !== authority ||
    url.hostname !== authority ||
    authority.endsWith('.')
  ) {
    return null;
  }
  return authority;
}

function decodeIdentityPath(pathname: string): {
  entityId: string;
  appId: string;
} | null {
  const encodedParts = pathname.replace(/^\//, '').split('/');
  if (encodedParts.length < 2) return null;

  try {
    const entityId = decodeURIComponent(encodedParts[0] ?? '');
    const appId = decodeURIComponent(encodedParts[1] ?? '');
    if (
      !isValidDecodedIdentityPart(entityId) ||
      !isValidDecodedIdentityPart(appId)
    ) {
      return null;
    }
    return { entityId, appId };
  } catch {
    return null;
  }
}

/**
 * Parse a canonical app URL and bind an isolated host digest to the decoded
 * identity in its first two path segments. Legacy namespace hosts are parsed
 * only for backend serve compatibility; new URLs must use the isolated builder.
 */
export function parseAppUrlIdentity(
  value: string,
): ParsedAppUrlIdentity | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const host = getCanonicalAppAuthority(value, url);
  if (!host) return null;

  const pathIdentity = decodeIdentityPath(url.pathname);
  if (!pathIdentity) return null;

  if (host === 'agents' || host === 'plugins') {
    const identity: AppUrlIdentity = {
      namespace: host,
      ...pathIdentity,
    };
    return {
      classification: 'legacy',
      identity,
      host,
      origin: `app://${host}`,
    };
  }

  const isolatedHost = parseIsolatedAppHost(host);
  if (!isolatedHost) return null;
  const identity: AppUrlIdentity = {
    namespace: isolatedHost.namespace,
    ...pathIdentity,
  };
  if (!validateIsolatedAppHost(host, identity)) return null;

  return {
    classification: 'isolated',
    identity,
    host,
    origin: `app://${host}`,
  };
}

export function parseIsolatedAppUrlIdentity(
  value: string,
): AppUrlIdentity | null {
  const parsed = parseAppUrlIdentity(value);
  return parsed?.classification === 'isolated' ? parsed.identity : null;
}

export function validateIsolatedAppUrlIdentity(
  value: string,
  identity: Readonly<AppUrlIdentity>,
): boolean {
  const parsed = parseIsolatedAppUrlIdentity(value);
  return (
    parsed?.namespace === identity.namespace &&
    parsed.entityId === identity.entityId &&
    parsed.appId === identity.appId
  );
}
