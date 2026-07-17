import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPackage, listPackage } from '@electron/asar';
import {
  COMMUNITY_OBSERVED_RENDERER_POSTHOG_NOOP,
  COMMUNITY_OBSERVED_TELEMETRY_ARTIFACT_ASSERTION,
  COMMUNITY_OBSERVED_TELEMETRY_CONTRACT,
  inspectCommunityObservedTelemetryAsar,
  normalizeCommunityObservedArchivePath,
} from './community-observed-telemetry-validator.mjs';

const TEST_PROJECT_KEY = [
  'phc',
  'community_observed_artifact_test_only_000000',
].join('_');

async function makeFixture(options = {}) {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'clodex-community-observed-asar-'),
  );
  const source = path.join(root, 'source');
  const backend = path.join(source, '.vite', 'build');
  const renderer = path.join(
    source,
    '.vite',
    'renderer',
    'main_window',
    'assets',
  );
  mkdirSync(backend, { recursive: true });
  mkdirSync(renderer, { recursive: true });
  const semverTarget = path.join(
    source,
    'node_modules',
    'semver',
    'bin',
    'semver.js',
  );
  const sharpBinDirectory = path.join(
    source,
    'node_modules',
    'sharp',
    'node_modules',
    '.bin',
  );
  mkdirSync(path.dirname(semverTarget), { recursive: true });
  mkdirSync(sharpBinDirectory, { recursive: true });
  writeFileSync(semverTarget, 'export const semver = true;\n');
  symlinkSync(
    path.relative(sharpBinDirectory, semverTarget),
    path.join(sharpBinDirectory, 'semver.js'),
  );
  writeFileSync(path.join(backend, 'main.js'), 'import "./telemetry.js";\n');
  writeFileSync(
    path.join(backend, 'telemetry.js'),
    [
      `const key = ${JSON.stringify(TEST_PROJECT_KEY)};`,
      `const contract = ${JSON.stringify(COMMUNITY_OBSERVED_TELEMETRY_CONTRACT)};`,
      `const assertion = ${JSON.stringify(
        options.invalidContract
          ? COMMUNITY_OBSERVED_TELEMETRY_ARTIFACT_ASSERTION.replace(
              '"privacyMode":true',
              '"privacyMode":false',
            )
          : COMMUNITY_OBSERVED_TELEMETRY_ARTIFACT_ASSERTION,
      )};`,
      options.omitPrivacyMarkers
        ? 'const options = {};'
        : 'const options = { privacyMode: true, disableGeoip: true, disableRemoteConfig: true, enableExceptionAutocapture: false };',
      'export { key, contract, assertion, options };',
    ].join('\n'),
  );
  writeFileSync(
    path.join(renderer, 'app.js'),
    options.rendererProjectKey
      ? `const forbidden = ${JSON.stringify(TEST_PROJECT_KEY)};\n`
      : options.activeRendererPostHog
        ? `${JSON.stringify(COMMUNITY_OBSERVED_RENDERER_POSTHOG_NOOP)}; posthog.init('', { autocapture: true });\n`
        : `const rendererTelemetry = ${JSON.stringify(
            COMMUNITY_OBSERVED_RENDERER_POSTHOG_NOOP,
          )};\n`,
  );
  if (options.nonJavascriptProjectKey) {
    writeFileSync(
      path.join(renderer, 'telemetry-config.json'),
      JSON.stringify({ key: TEST_PROJECT_KEY }),
    );
  }
  const asarPath = path.join(root, 'app.asar');
  await createPackage(source, asarPath);
  if (options.unpackedProjectKey) {
    const unpacked = path.join(`${asarPath}.unpacked`, 'native');
    mkdirSync(unpacked, { recursive: true });
    writeFileSync(path.join(unpacked, 'telemetry.bin'), TEST_PROJECT_KEY);
  }
  return { asarPath, root };
}

test('validates a single backend-only observed PostHog project key', async () => {
  const fixture = await makeFixture();
  try {
    const evidence = inspectCommunityObservedTelemetryAsar(fixture.asarPath);
    assert.equal(evidence.status, 'validated');
    assert.equal(evidence.transport, 'posthog-node-backend');
    assert.equal(evidence.allowedTelemetryLevel, 'anonymous');
    assert.equal(evidence.renderer.projectKeyEmbedded, false);
    assert.equal(evidence.exceptions, 'disabled');
    assert.equal(evidence.modelTracing, 'disabled');
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('normalizes Windows ASAR paths and ignores node_modules .bin links', async () => {
  assert.equal(
    normalizeCommunityObservedArchivePath('\\.vite\\build\\main.js'),
    '.vite/build/main.js',
  );
  const fixture = await makeFixture();
  try {
    assert.ok(
      listPackage(fixture.asarPath).some((entry) =>
        normalizeCommunityObservedArchivePath(entry).endsWith(
          'node_modules/sharp/node_modules/.bin/semver.js',
        ),
      ),
    );
    assert.equal(
      inspectCommunityObservedTelemetryAsar(fixture.asarPath).status,
      'validated',
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects a project key embedded in renderer assets', async () => {
  const fixture = await makeFixture({ rendererProjectKey: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /escaped the backend entry graph/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects a project key embedded in non-JavaScript ASAR assets', async () => {
  const fixture = await makeFixture({ nonJavascriptProjectKey: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /escaped the backend entry graph/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects a project key embedded in app.asar.unpacked', async () => {
  const fixture = await makeFixture({ unpackedProjectKey: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /escaped into app\.asar\.unpacked/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects a backend with a non-canonical privacy contract', async () => {
  const fixture = await makeFixture({ invalidContract: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /missing the canonical telemetry contract assertion/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('rejects active renderer PostHog init/autocapture even without a key', async () => {
  const fixture = await makeFixture({ activeRendererPostHog: true });
  try {
    assert.throws(
      () => inspectCommunityObservedTelemetryAsar(fixture.asarPath),
      /contains active posthog\.init code|contains active autocapture enabled code/,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});
