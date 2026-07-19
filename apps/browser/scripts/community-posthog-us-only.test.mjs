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
  enforceCommunityPostHogUsOnlyInBackend,
  findDisallowedCommunityPostHogHosts,
  rewriteKnownCommunityPostHogOrigins,
} from './community-posthog-us-only.mjs';

test('rewrites known EU origins without changing byte length', () => {
  const source = [
    'https://eu.i.posthog.com/capture',
    'https://eu-assets.i.posthog.com/static/app.js',
    `${COMMUNITY_US_POSTHOG_INGESTION_ORIGIN}/batch`,
    `${COMMUNITY_US_POSTHOG_ASSET_ORIGIN}/static/array.js`,
  ].join('\n');

  const result = rewriteKnownCommunityPostHogOrigins(source);

  assert.equal(result.source.length, source.length);
  assert.equal(result.replacements.length, 2);
  assert.equal(
    result.source,
    [
      `${COMMUNITY_US_POSTHOG_INGESTION_ORIGIN}/capture`,
      `${COMMUNITY_US_POSTHOG_ASSET_ORIGIN}/static/app.js`,
      `${COMMUNITY_US_POSTHOG_INGESTION_ORIGIN}/batch`,
      `${COMMUNITY_US_POSTHOG_ASSET_ORIGIN}/static/array.js`,
    ].join('\n'),
  );
  assert.deepEqual(findDisallowedCommunityPostHogHosts(result.source), []);
});

test('fails closed on an unknown regional host', () => {
  assert.throws(
    () =>
      rewriteKnownCommunityPostHogOrigins(
        'const host = "https://ap.i.posthog.com";',
      ),
    /unsupported PostHog regional host\(s\): ap\.i\.posthog\.com/u,
  );
  assert.throws(
    () =>
      rewriteKnownCommunityPostHogOrigins(
        'const host = "https://preview-assets.i.posthog.com";',
      ),
    /preview-assets\.i\.posthog\.com/u,
  );
});

test('rewrites and re-reads the exact Community backend build bytes', () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'clodex-community-posthog-us-only-'),
  );
  const backendDirectory = path.join(root, '.vite', 'build');
  const mainPath = path.join(backendDirectory, 'main.js');
  const mapPath = path.join(backendDirectory, 'chunks', 'main.js.map');
  mkdirSync(path.dirname(mapPath), { recursive: true });
  writeFileSync(
    mainPath,
    [
      'const ingestion="https://eu.i.posthog.com";',
      'const assets="https://us-assets.i.posthog.com";',
    ].join(' '),
  );
  writeFileSync(mapPath, '{"source":"https://eu-assets.i.posthog.com"}');

  try {
    const evidence = enforceCommunityPostHogUsOnlyInBackend(root);
    assert.equal(evidence.filesScanned, 2);
    assert.equal(evidence.replacements.length, 2);
    assert.match(
      readFileSync(mainPath, 'utf8'),
      /https:\/\/us\.i\.posthog\.com/u,
    );
    assert.match(
      readFileSync(mainPath, 'utf8'),
      /https:\/\/us-assets\.i\.posthog\.com/u,
    );
    assert.equal(
      readFileSync(mapPath, 'utf8'),
      '{"source":"https://us-assets.i.posthog.com"}',
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('rejects unknown hosts and symlinks in backend output', () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), 'clodex-community-posthog-us-only-'),
  );
  const backendDirectory = path.join(root, '.vite', 'build');
  mkdirSync(backendDirectory, { recursive: true });
  const mainPath = path.join(backendDirectory, 'main.js');
  writeFileSync(mainPath, 'https://ca.i.posthog.com');

  try {
    assert.throws(
      () => enforceCommunityPostHogUsOnlyInBackend(root),
      /unsupported PostHog regional host\(s\): ca\.i\.posthog\.com/u,
    );

    writeFileSync(mainPath, COMMUNITY_US_POSTHOG_INGESTION_ORIGIN);
    symlinkSync('main.js', path.join(backendDirectory, 'linked-main.js'));
    assert.throws(
      () => enforceCommunityPostHogUsOnlyInBackend(root),
      /must not contain symlinks/u,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
