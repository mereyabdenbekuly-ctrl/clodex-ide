import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workflow = readFileSync(
  path.join(root, '.github/workflows/community-observed-publish.yml'),
  'utf8',
);
const assembler = readFileSync(
  path.join(root, 'scripts/release/community-observed-publication.mjs'),
  'utf8',
);
const publisher = readFileSync(
  path.join(root, 'scripts/release/publish-community-observed-prerelease.mjs'),
  'utf8',
);

test('publisher workflow is manual and separates read-only verification from Release writes', () => {
  assert.match(workflow, /^on:\n {2}workflow_dispatch:/mu);
  for (const input of [
    'run_id',
    'source_commit',
    'tag',
    'confirm',
    'immutability_confirm',
    'redistribution_confirm',
  ]) {
    assert.match(workflow, new RegExp(`^      ${input}:`, 'mu'));
  }
  assert.match(
    workflow,
    /^permissions:\n {2}actions: read\n {2}contents: read$/mu,
  );
  const [verifySection, publishSection] = workflow.split('\n  publish:\n');
  assert.ok(verifySection);
  assert.ok(publishSection);
  assert.doesNotMatch(verifySection, /contents:\s*write/u);
  assert.match(publishSection, /environment: Release/u);
  assert.match(
    publishSection,
    /permissions:\n {6}actions: read\n {6}contents: write/u,
  );
});

test('workflow binds current publisher main to an exact successful observed ancestor', () => {
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(workflow, /test "\$GITHUB_SHA" = "\$remote_main"/u);
  assert.match(workflow, /test "\$GITHUB_WORKFLOW_SHA" = "\$remote_main"/u);
  assert.match(
    workflow,
    /git merge-base --is-ancestor "\$COMMUNITY_SOURCE_SHA" "\$remote_main"/u,
  );
  assert.match(workflow, /community-observed-publication\.mjs prepare/u);
  assert.match(assembler, /conclusion === 'success'/u);
  assert.match(assembler, /head_sha === sourceCommit/u);
  assert.match(assembler, /communityobserved\$\{run\.run_number\}/u);
  assert.match(assembler, /git[\s\S]*show[\s\S]*apps\/browser\/package\.json/u);
});

test('candidate and effect are bound to exact artifact IDs and digests', () => {
  assert.match(
    workflow,
    /candidate_artifact_digest: \$\{\{ steps\.upload\.outputs\.artifact-digest \}\}/u,
  );
  assert.match(
    workflow,
    /candidate_artifact_id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/u,
  );
  assert.match(workflow, /\.digest'[\s\S]*sha256:\$CANDIDATE_DIGEST/u);
  assert.match(
    workflow,
    /artifact-ids: \$\{\{ needs\.verify-stage\.outputs\.candidate_artifact_id \}\}/u,
  );
  assert.match(workflow, /merge-multiple: true/u);
  assert.match(workflow, /--publisher-commit="\$GITHUB_SHA"/u);
  assert.match(
    workflow,
    /--immutability-enabled="\$\{\{ vars\.CLODEX_IMMUTABLE_RELEASES_ENABLED \}\}"/u,
  );
  assert.match(
    workflow,
    /--redistribution-confirm="\$\{\{ inputs\.redistribution_confirm \}\}"/u,
  );
});

test('release contract is exactly five unchanged installers, evidence, and self-excluded checksums', () => {
  assert.match(assembler, /installers\.length === 5/u);
  assert.match(assembler, /assetNames\.length === 7/u);
  assert.match(assembler, /five-installers-evidence-checksums-v1/u);
  assert.match(assembler, /-evidence\.zip/u);
  assert.match(assembler, /SHA256SUMS\.txt/u);
  assert.match(assembler, /COPYFILE_EXCL/u);
  assert.match(assembler, /communityPackagedBoundary/u);
  assert.match(assembler, /bomFormat === 'CycloneDX'/u);
  assert.doesNotMatch(assembler, /publicBundleFileName/u);
});

test('publication is draft-first, immutable-gated, digest-verified and single-PATCH', () => {
  assert.match(workflow, /vars\.CLODEX_IMMUTABLE_RELEASES_ENABLED/u);
  assert.match(workflow, /test "\$REPOSITORY_IMMUTABILITY_ENABLED" = "true"/u);
  assert.match(
    publisher,
    /repository immutable-release attestation is not enabled/u,
  );
  assert.match(publisher, /2026-03-10/u);
  assert.doesNotMatch(publisher, /\/immutable-releases/u);
  assert.match(publisher, /stageProtectedReleaseDraft/u);
  assert.match(publisher, /release\.assets\.length === 7/u);
  assert.match(publisher, /asset\.digest === `sha256:\$\{record\.sha256\}`/u);
  assert.match(publisher, /'If-Match': assertConditionalEtag\(etag\)/u);
  assert.match(
    publisher,
    /body: JSON\.stringify\(\{ draft: false, make_latest: 'false' \}\)/u,
  );
  assert.match(publisher, /release\.immutable === true/u);
  assert.equal((publisher.match(/method: 'PATCH'/gu) ?? []).length, 1);
  for (const forbidden of [
    /\bgh\s+release\b/u,
    /\bdeleteRelease\b/u,
    /\bdeleteAsset\b/u,
    /\bclobber\b/u,
    /softprops\/action-gh-release/u,
    /latest\.ya?ml/u,
    /\.nupkg/u,
    /\.blockmap/u,
  ]) {
    assert.doesNotMatch(workflow, forbidden);
    assert.doesNotMatch(publisher, forbidden);
  }
});

test('all third-party Actions are pinned by full commit SHA', () => {
  const actions = [...workflow.matchAll(/uses:\s*([^\s]+@[^\s]+)/gu)].map(
    (match) => match[1],
  );
  assert.ok(actions.length >= 4);
  for (const action of actions) assert.match(action, /^[^@]+@[a-f0-9]{40}$/u);
});
