import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { queryGitHubReleaseState } from './github-release-state.mjs';
import { assertTechnicalPreviewTagReusable } from './validate-technical-preview-plan.mjs';

const repositoryRoot = new URL('../../', import.meta.url);

test('technical preview retry accepts only an absent or exact-SHA tag', () => {
  const releaseRef = 'a'.repeat(40);
  assert.doesNotThrow(() =>
    assertTechnicalPreviewTagReusable({
      existingTagCommit: null,
      releaseRef,
      tag: 'v1.16.0-preview.2',
    }),
  );
  assert.doesNotThrow(() =>
    assertTechnicalPreviewTagReusable({
      existingTagCommit: releaseRef,
      releaseRef,
      tag: 'v1.16.0-preview.2',
    }),
  );
  assert.throws(
    () =>
      assertTechnicalPreviewTagReusable({
        existingTagCommit: 'b'.repeat(40),
        releaseRef,
        tag: 'v1.16.0-preview.2',
      }),
    /points to b+.*expected a+/,
  );
});

function mockedGhResult({ error, httpStatus, status }) {
  return {
    error,
    status,
    stderr:
      httpStatus === undefined ? '' : `gh: mocked failure (HTTP ${httpStatus})`,
    stdout:
      httpStatus === undefined
        ? ''
        : `HTTP/2.0 ${httpStatus} Mocked\nContent-Type: application/json\n\n{}`,
  };
}

test('GitHub release lookup treats only a real HTTP 404 as absent', () => {
  const runGh = () => mockedGhResult({ httpStatus: 404, status: 1 });
  assert.equal(
    queryGitHubReleaseState({
      repository: 'owner/repository',
      runGh,
      tag: 'v1.16.0-preview.2',
    }),
    'absent',
  );
});

test('GitHub release lookup accepts an HTTP 200 as existing', () => {
  const runGh = () => mockedGhResult({ httpStatus: 200, status: 0 });
  assert.equal(
    queryGitHubReleaseState({
      repository: 'owner/repository',
      runGh,
      tag: 'v1.16.0-preview.2',
    }),
    'exists',
  );
});

test('GitHub release lookup aborts on auth, rate-limit, and server failures', () => {
  for (const httpStatus of [401, 403, 429, 500, 503]) {
    const runGh = () => mockedGhResult({ httpStatus, status: 1 });
    assert.throws(
      () =>
        queryGitHubReleaseState({
          repository: 'owner/repository',
          runGh,
          tag: 'v1.16.0-preview.2',
        }),
      new RegExp(`HTTP ${httpStatus}`),
    );
  }
});

test('GitHub release lookup aborts on network and status-less failures', () => {
  assert.throws(
    () =>
      queryGitHubReleaseState({
        repository: 'owner/repository',
        runGh: () =>
          mockedGhResult({
            error: new Error('spawn gh ENETUNREACH'),
            status: null,
          }),
        tag: 'v1.16.0-preview.2',
      }),
    /before receiving an HTTP response.*ENETUNREACH/,
  );
  assert.throws(
    () =>
      queryGitHubReleaseState({
        repository: 'owner/repository',
        runGh: () => mockedGhResult({ status: 1 }),
        tag: 'v1.16.0-preview.2',
      }),
    /before receiving an HTTP status/,
  );
});

test('release workflows fail closed when checking completed releases', () => {
  const previewWorkflow = readFileSync(
    new URL('.github/workflows/technical-preview-release.yml', repositoryRoot),
    'utf8',
  );
  assert.match(previewWorkflow, /Refuse a completed preview release retry/);
  assert.match(previewWorkflow, /github-release-state\.mjs/);
  assert.match(previewWorkflow, /if ! release_state=/);
  assert.match(previewWorkflow, /exact-SHA tag retry is allowed/);
  assert.doesNotMatch(previewWorkflow, /gh release view/);

  const autoReleaseWorkflow = readFileSync(
    new URL('.github/workflows/auto-release.yml', repositoryRoot),
    'utf8',
  );
  assert.match(autoReleaseWorkflow, /Tag exists without a GitHub Release/);
  assert.match(autoReleaseWorkflow, /github-release-state\.mjs/);
  assert.match(autoReleaseWorkflow, /if ! release_state=/);
  assert.doesNotMatch(autoReleaseWorkflow, /gh release view/);
});

test('browser release builds and publishes only the immutable input SHA', () => {
  const workflow = readFileSync(
    new URL('.github/workflows/_release-browser.yml', repositoryRoot),
    'utf8',
  );
  const buildSection = workflow.split('\n  build:')[1].split('\n  release:')[0];
  const releaseSection = workflow
    .split('\n  release:')[1]
    .split('\n  trigger-nightly-after-stable:')[0];

  assert.match(workflow, /Immutable 40-character commit SHA/);
  assert.match(workflow, /Validate immutable release ref input/);
  assert.match(buildSection, /permissions:\n\s+contents: read/);
  assert.match(buildSection, /ref: \$\{\{ inputs\.ref \}\}/);
  assert.match(buildSection, /persist-credentials: false/);
  assert.doesNotMatch(buildSection, /ref: \$\{\{ inputs\.tag \}\}/);
  assert.match(buildSection, /Assert immutable release candidate checkout/);
  assert.match(
    releaseSection,
    /Re-assert immutable tag target before publication/,
  );
  assert.match(releaseSection, /actual_ref.*RELEASE_REF/s);

  const nightlyWorkflow = readFileSync(
    new URL('.github/workflows/nightly-release.yml', repositoryRoot),
    'utf8',
  );
  assert.match(nightlyWorkflow, /release_ref=\$\(git rev-parse HEAD\)/);
  assert.match(
    nightlyWorkflow,
    /ref: \$\{\{ needs\.version\.outputs\.release_ref \}\}/,
  );
});

test('technical preview rollback is documented as manual-only', () => {
  const plan = readFileSync(
    new URL('docs/releases/v1.16.0-preview.2.md', repositoryRoot),
    'utf8',
  );
  assert.doesNotMatch(plan, /pin the prerelease feed back/i);
  assert.match(plan, /manual.*reinstall/is);
  assert.match(plan, /forward-fix/i);
});

test('Squirrel packaging binds public and internal preview versions explicitly', () => {
  const plugin = readFileSync(
    new URL(
      'apps/browser/etc/forge-plugins/squirrel-installer-name-fix.ts',
      repositoryRoot,
    ),
    'utf8',
  );
  assert.match(plugin, /toSquirrelInternalVersion/);
  assert.match(plugin, /Unexpected internal nupkg version/);

  const validator = readFileSync(
    new URL(
      'apps/browser/scripts/validate-release-artifacts.mjs',
      repositoryRoot,
    ),
    'utf8',
  );
  assert.match(validator, /toSquirrelInternalVersion\(version\)/);
  assert.match(validator, /squirrelInternalVersion: internalVersion/);
});
