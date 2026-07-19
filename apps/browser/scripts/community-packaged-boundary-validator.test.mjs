import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  COMMUNITY_US_POSTHOG_ASSET_ORIGIN,
  COMMUNITY_US_POSTHOG_INGESTION_ORIGIN,
  attachCommunityPackagedBoundaryEvidence,
  inspectCommunityPackagedBoundary,
  resolveCommunityPackagedAsarPath,
} from './community-packaged-boundary-validator.mjs';

function fakeAsarApi(entries) {
  const records = new Map(
    Object.entries(entries).map(([entryPath, options]) => {
      const contents = Buffer.from(options.contents ?? '', 'utf8');
      return [entryPath, { ...options, contents }];
    }),
  );
  const resolveEntry = (lookupPath) => lookupPath.replaceAll('\\', '/');
  return {
    extractFile(_asarPath, lookupPath) {
      const entry = records.get(resolveEntry(lookupPath));
      if (!entry) throw new Error(`missing fake ASAR entry: ${lookupPath}`);
      return Buffer.from(entry.contents);
    },
    listPackage() {
      return [...records.keys()].map((entryPath) => `/${entryPath}`);
    },
    statFile(_asarPath, lookupPath) {
      const entry = records.get(resolveEntry(lookupPath));
      if (!entry) throw new Error(`missing fake ASAR entry: ${lookupPath}`);
      return {
        size: entry.contents.length,
        ...(entry.unpacked ? { unpacked: true } : {}),
      };
    },
  };
}

function makeFixture(entries, unpackedEntries = {}) {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'clodex-community-packaged-boundary-'),
  );
  const asarPath = path.join(root, 'app.asar');
  writeFileSync(asarPath, 'synthetic ASAR fixture\n');
  for (const [entryPath, contents] of Object.entries(unpackedEntries)) {
    const outputPath = path.join(`${asarPath}.unpacked`, entryPath);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, contents);
  }
  return {
    asarApi: fakeAsarApi(entries),
    asarPath,
    root,
  };
}

function validateFixture(fixture, distributionMode) {
  return inspectCommunityPackagedBoundary({
    asarApi: fixture.asarApi,
    asarPath: fixture.asarPath,
    distributionMode,
  });
}

function assertRejected(
  entries,
  ruleId,
  distributionMode = 'community-unsigned',
) {
  const fixture = makeFixture(entries);
  try {
    assert.throws(
      () => validateFixture(fixture, distributionMode),
      new RegExp(ruleId.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
}

test('resolves exact Forge app.asar paths for all Community platforms', () => {
  const browserDirectory = path.join(path.sep, 'repo', 'apps', 'browser');
  assert.equal(
    resolveCommunityPackagedAsarPath({
      arch: 'arm64',
      browserDirectory,
      distributionMode: 'community-observed',
      platform: 'macos',
    }),
    path.join(
      browserDirectory,
      'out/community-observed/clodex-community-observed-darwin-arm64/clodex-community-observed.app/Contents/Resources/app.asar',
    ),
  );
  assert.equal(
    resolveCommunityPackagedAsarPath({
      arch: 'x64',
      browserDirectory,
      distributionMode: 'community-unsigned',
      platform: 'windows',
    }),
    path.join(
      browserDirectory,
      'out/community-unsigned/clodex-community-unsigned-win32-x64/resources/app.asar',
    ),
  );
  assert.equal(
    resolveCommunityPackagedAsarPath({
      arch: 'x64',
      browserDirectory,
      distributionMode: 'community-unsigned',
      platform: 'linux',
    }),
    path.join(
      browserDirectory,
      'out/community-unsigned/clodex-community-unsigned-linux-x64/resources/app.asar',
    ),
  );
});

test('accepts a Free unsigned package with no configured managed service', () => {
  const fixture = makeFixture({
    '.vite/build/main.js': {
      contents:
        'const cloudTaskRoute = "/v1/cloud-tasks/executions"; const disabled = true;',
    },
    'node_modules/example/README.md': {
      contents: 'The words cloud tasks are documentation, not an endpoint.',
    },
  });
  try {
    const evidence = validateFixture(fixture, 'community-unsigned');
    assert.equal(evidence.status, 'validated');
    assert.equal(evidence.telemetry.requiredInBackend, false);
    assert.equal(evidence.scan.packedEntries, 2);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('requires the US ingestion origin in the observed backend bundle', () => {
  const fixture = makeFixture({
    '.vite/build/main.js': {
      contents:
        `const posthogHost = ${JSON.stringify(COMMUNITY_US_POSTHOG_INGESTION_ORIGIN)};` +
        ` const posthogAssets = ${JSON.stringify(COMMUNITY_US_POSTHOG_ASSET_ORIGIN)};`,
    },
    '.vite/renderer/main.js': {
      contents: 'export const rendererTelemetry = false;',
    },
  });
  try {
    const evidence = validateFixture(fixture, 'community-observed');
    assert.equal(evidence.telemetry.requiredInBackend, true);
    assert.equal(evidence.telemetry.backendUsPostHogOriginOccurrences, 1);
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }

  assertRejected(
    {
      '.vite/build/main.js': { contents: 'export const telemetry = true;' },
      '.vite/renderer/main.js': {
        contents: `const misleadingHost = ${JSON.stringify(COMMUNITY_US_POSTHOG_INGESTION_ORIGIN)};`,
      },
    },
    'observed-backend-missing-us-posthog-ingestion-origin',
    'community-observed',
  );
});

for (const [label, endpoint, ruleId] of [
  [
    'hosted MCP',
    'https://clodex.xyz/tools-gateway/mcp',
    'managed-mcp-endpoint',
  ],
  [
    'Cloud Tasks',
    'https://managed.example/v1/cloud-tasks',
    'managed-cloud-tasks-endpoint',
  ],
  [
    'session sharing',
    'https://managed.example/v1/session-shares',
    'managed-session-sharing-endpoint',
  ],
]) {
  test(`rejects a configured ${label} endpoint in app.asar`, () => {
    assertRejected(
      {
        '.vite/build/main.js': {
          contents: `const forbiddenEndpoint = ${JSON.stringify(endpoint)};`,
        },
      },
      ruleId,
    );
  });
}

test('rejects non-empty managed configuration values without logging them', () => {
  for (const key of [
    'CLODEX_CLOUD_TASKS_URL',
    'CLODEX_MCP_GATEWAY_URL',
    'CLODEX_SESSION_SHARING_URL',
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_URL',
  ]) {
    assertRejected(
      {
        '.vite/build/main.js': {
          contents: `const environment = { ${JSON.stringify(key)}: "private-value" };`,
        },
      },
      `embedded-managed-config:${key}`,
    );
  }
});

test('rejects Supabase project configuration and credentials in owned code', () => {
  const jwt = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
      'base64url',
    ),
    Buffer.from(
      JSON.stringify({ iss: 'supabase', ref: 'project', role: 'anon' }),
    ).toString('base64url'),
    'signature0000000000000000',
  ].join('.');
  for (const [value, ruleId] of [
    ['https://private-project.supabase.co', 'embedded-supabase-project-url'],
    ['sb_publishable_1234567890abcdefghij', 'embedded-supabase-api-key'],
    [jwt, 'embedded-supabase-jwt'],
    ['-----BEGIN PRIVATE KEY-----', 'embedded-private-key'],
  ]) {
    assertRejected(
      {
        '.vite/build/main.js': {
          contents: `const embeddedCredential = ${JSON.stringify(value)};`,
        },
      },
      ruleId,
    );
  }
});

test('rejects an EU PostHog ingestion host in app.asar.unpacked', () => {
  const entryPath = 'native/telemetry-config.txt';
  const fixture = makeFixture(
    {
      [entryPath]: { contents: '', unpacked: true },
      '.vite/build/main.js': { contents: 'export const telemetry = false;' },
    },
    { [entryPath]: 'https://eu.i.posthog.com' },
  );
  try {
    assert.throws(
      () => validateFixture(fixture, 'community-unsigned'),
      /non-us-posthog-ingestion-host/u,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('allows only the exact US PostHog ingestion and asset hosts', () => {
  for (const forbiddenHost of [
    'https://eu-assets.i.posthog.com',
    'https://ap.i.posthog.com',
    'https://preview-assets.i.posthog.com',
  ]) {
    assertRejected(
      {
        '.vite/build/main.js': {
          contents: `const posthogHost = ${JSON.stringify(forbiddenHost)};`,
        },
      },
      'non-us-posthog-ingestion-host',
    );
  }
});

test('fails closed on symlinks in app.asar.unpacked', () => {
  const entryPath = 'native/target.txt';
  const fixture = makeFixture(
    {
      [entryPath]: { contents: 'safe', unpacked: true },
    },
    { [entryPath]: 'safe' },
  );
  try {
    symlinkSync(
      'target.txt',
      path.join(`${fixture.asarPath}.unpacked`, 'native/link'),
    );
    assert.throws(
      () => validateFixture(fixture, 'community-unsigned'),
      /must not contain symlinks/u,
    );
  } finally {
    rmSync(fixture.root, { force: true, recursive: true });
  }
});

test('attaches evidence to the bounded validation manifest without overwriting', () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'clodex-community-boundary-manifest-'),
  );
  const manifestPath = path.join(root, 'validation.json');
  const evidence = {
    schemaVersion: 1,
    status: 'validated',
    distributionMode: 'community-unsigned',
  };
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      status: 'passed',
      build: {
        arch: 'x64',
        distributionMode: 'community-unsigned',
        platform: 'linux',
      },
      checks: { smoke: { status: 'passed' } },
    })}\n`,
  );
  try {
    attachCommunityPackagedBoundaryEvidence({
      architecture: 'x64',
      distributionMode: 'community-unsigned',
      evidence,
      manifestPath,
      platform: 'linux',
    });
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(manifest.checks.communityPackagedBoundary, evidence);
    assert.throws(
      () =>
        attachCommunityPackagedBoundaryEvidence({
          architecture: 'x64',
          distributionMode: 'community-unsigned',
          evidence,
          manifestPath,
          platform: 'linux',
        }),
      /already contains packaged-byte evidence/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
