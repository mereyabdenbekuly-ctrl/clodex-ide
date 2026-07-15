#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER_NUMBER = '(?:0|[1-9][0-9]*)';
const SEMVER_CORE = `${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}`;
const PRERELEASE_COUNTER = '(?:00[1-9]|0[1-9][0-9]|[1-9][0-9]{2})';
const NPM_MAX_SAFE_SEMVER_COMPONENT = 9_007_199_254_740_991n;
const SEMVER_CORE_COMPONENTS =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

const STABLE_VERSION = new RegExp(`^${SEMVER_CORE}$`, 'u');
const PREVIEW_VERSION = new RegExp(
  `^${SEMVER_CORE}-preview\\.([1-9][0-9]*)$`,
  'u',
);
const ALPHA_VERSION = new RegExp(
  `^${SEMVER_CORE}-alpha${PRERELEASE_COUNTER}$`,
  'u',
);
const BETA_VERSION = new RegExp(
  `^${SEMVER_CORE}-beta${PRERELEASE_COUNTER}$`,
  'u',
);
const NIGHTLY_VERSION = new RegExp(
  `^${SEMVER_CORE}-nightly([0-9]{8})c${PRERELEASE_COUNTER}$`,
  'u',
);

export const RELEASE_IDENTITY_CHANNELS = Object.freeze([
  'preview',
  'alpha',
  'beta',
  'nightly',
  'release',
]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertPlainString(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label} is required`);
  assert(value.length <= 128, `${label} is too long`);
  const containsAsciiWhitespaceOrControl = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 32 || codePoint === 127;
  });
  assert(
    !containsAsciiWhitespaceOrControl,
    `${label} contains whitespace or control characters`,
  );
}

function isValidCalendarDate(value) {
  const year = Number.parseInt(value.slice(0, 4), 10);
  const month = Number.parseInt(value.slice(4, 6), 10);
  const day = Number.parseInt(value.slice(6, 8), 10);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

function assertNpmSafeNumericIdentifier(value) {
  assert(
    BigInt(value) <= NPM_MAX_SAFE_SEMVER_COMPONENT,
    'release version is outside npm SemVer numeric range',
  );
}

function assertNpmCompatibleVersionRange(version, channel) {
  const [core] = version.split('-', 1);
  const match = SEMVER_CORE_COMPONENTS.exec(core);
  assert(match !== null, 'release version is not npm-compatible SemVer');
  for (const component of match.slice(1)) {
    assertNpmSafeNumericIdentifier(component);
  }

  // preview.N is the only channel whose prerelease suffix is itself a purely
  // numeric SemVer identifier. node-semver/npm reject it above MAX_SAFE_INTEGER
  // even though the SemVer grammar alone permits arbitrarily large integers.
  if (channel === 'preview') {
    const preview = PREVIEW_VERSION.exec(version);
    assert(preview !== null, 'release version is not npm-compatible SemVer');
    assertNpmSafeNumericIdentifier(preview[1]);
  }
}

function expectedClodexTag(channel, version) {
  return channel === 'preview' ? `v${version}` : `clodex@${version}`;
}

/**
 * Validate an exact, canonical release identity before any caller grants write,
 * signing, attestation, or Release-environment privileges.
 */
export function validateReleaseIdentity({
  channel,
  product = 'clodex',
  tag,
  version,
}) {
  assertPlainString(product, 'release product');
  assertPlainString(channel, 'release channel');
  assertPlainString(version, 'release version');
  assertPlainString(tag, 'release tag');

  assert(
    product === 'clodex' || product === 'karton',
    'unsupported release product',
  );

  if (product === 'karton') {
    assert(channel === 'release', 'Karton supports only the release channel');
    assert(
      STABLE_VERSION.test(version),
      'Karton release version is not canonical SemVer',
    );
    assertNpmCompatibleVersionRange(version, channel);
    assert(
      tag === `@clodex/karton@${version}`,
      'Karton release tag does not match its version',
    );
    return Object.freeze({ channel, product, tag, version });
  }

  assert(
    RELEASE_IDENTITY_CHANNELS.includes(channel),
    'unsupported Clodex release channel',
  );

  let validVersion = false;
  switch (channel) {
    case 'release':
      validVersion = STABLE_VERSION.test(version);
      break;
    case 'preview':
      validVersion = PREVIEW_VERSION.test(version);
      break;
    case 'alpha':
      validVersion = ALPHA_VERSION.test(version);
      break;
    case 'beta':
      validVersion = BETA_VERSION.test(version);
      break;
    case 'nightly': {
      const match = NIGHTLY_VERSION.exec(version);
      validVersion = match !== null && isValidCalendarDate(match[1]);
      break;
    }
  }

  assert(validVersion, `Clodex ${channel} version is not canonical`);
  assertNpmCompatibleVersionRange(version, channel);
  assert(
    tag === expectedClodexTag(channel, version),
    'Clodex release tag does not match its channel and version',
  );
  return Object.freeze({ channel, product, tag, version });
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: false,
    options: {
      channel: { type: 'string' },
      product: { default: 'clodex', type: 'string' },
      tag: { type: 'string' },
      version: { type: 'string' },
    },
    strict: true,
  });
  assert(positionals.length === 0, 'positional arguments are not allowed');
  validateReleaseIdentity({
    channel: values.channel,
    product: values.product,
    tag: values.tag,
    version: values.version,
  });
}

const entrypoint = process.argv[1]
  ? realpathSync(path.resolve(process.argv[1]))
  : null;
const modulePath = realpathSync(fileURLToPath(import.meta.url));
if (entrypoint === modulePath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
