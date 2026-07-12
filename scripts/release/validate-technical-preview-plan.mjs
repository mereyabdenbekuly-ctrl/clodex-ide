#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, '../..');

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function parseArguments(values) {
  const options = {
    githubOutput: undefined,
    manifest: '.release-notes/clodex-technical-preview.json',
    requireNewTag: false,
    requireRollbackTag: false,
    sourceRef: undefined,
  };

  for (const value of values) {
    if (value === '--require-new-tag') {
      options.requireNewTag = true;
    } else if (value === '--require-rollback-tag') {
      options.requireRollbackTag = true;
    } else if (value.startsWith('--github-output=')) {
      options.githubOutput = value.slice('--github-output='.length);
    } else if (value.startsWith('--manifest=')) {
      options.manifest = value.slice('--manifest='.length);
    } else if (value.startsWith('--source-ref=')) {
      options.sourceRef = value.slice('--source-ref='.length);
    } else {
      fail(`Unknown argument: ${value}`);
    }
  }

  return options;
}

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('/usr/bin/git', args, {
      cwd: repositoryDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', allowFailure ? 'ignore' : 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validatePlan(plan, options) {
  assert(plan.schemaVersion === 1, 'schemaVersion must be 1');
  assert(
    plan.releaseKind === 'technical-preview',
    'releaseKind must be technical-preview',
  );
  assert(plan.channel === 'preview', 'channel must be preview');
  assert(plan.buildChannel === 'prerelease', 'buildChannel must be prerelease');
  assert(
    typeof plan.version === 'string' &&
      /^\d+\.\d+\.\d+-preview\.[1-9]\d*$/.test(plan.version),
    'version must match X.Y.Z-preview.N',
  );
  assert(plan.tag === `v${plan.version}`, 'tag must equal v<version>');
  assert(
    typeof plan.rollbackTag === 'string' &&
      /^v\d+\.\d+\.\d+-preview\.[1-9]\d*$/.test(plan.rollbackTag),
    'rollbackTag must be a technical-preview tag',
  );
  assert(
    plan.rollbackTag !== plan.tag,
    'rollbackTag must differ from target tag',
  );
  const targetMatch = plan.version.match(
    /^(\d+\.\d+\.\d+)-preview\.([1-9]\d*)$/,
  );
  const rollbackMatch = plan.rollbackTag.match(
    /^v(\d+\.\d+\.\d+)-preview\.([1-9]\d*)$/,
  );
  assert(targetMatch && rollbackMatch, 'preview tag parsing failed');
  assert(
    rollbackMatch[1] === targetMatch[1],
    'rollbackTag must use the same base version as the target',
  );
  assert(
    Number.parseInt(rollbackMatch[2], 10) < Number.parseInt(targetMatch[2], 10),
    'rollbackTag must precede the target preview number',
  );
  assert(plan.sourceRef === 'main', 'committed preview sourceRef must be main');
  if (options.sourceRef) {
    assert(
      options.sourceRef === plan.sourceRef,
      'dispatch ref must match manifest sourceRef',
    );
  }

  const packageJson = JSON.parse(
    readFileSync(
      path.join(repositoryDirectory, 'apps/browser/package.json'),
      'utf8',
    ),
  );
  const baseVersion = plan.version.split('-preview.')[0];
  assert(
    packageJson.version === baseVersion,
    `apps/browser package version ${packageJson.version} must equal preview base ${baseVersion}`,
  );

  assert(
    plan.authentication?.oauthWebAuthReady === false,
    'OAuth/WebAuth must remain explicitly not ready for this preview',
  );
  assert(
    typeof plan.authentication?.releaseClaim === 'string' &&
      /not included/i.test(plan.authentication.releaseClaim),
    'authentication.releaseClaim must explicitly say OAuth/WebAuth is not included',
  );

  const expectedBundles = [
    'clodex-linux-x64',
    'clodex-macos-arm64',
    'clodex-macos-x64',
    'clodex-windows-x64',
  ];
  assert(
    Array.isArray(plan.githubArtifactBundles),
    'githubArtifactBundles must be an array',
  );
  assert(
    JSON.stringify([...plan.githubArtifactBundles].sort()) ===
      JSON.stringify(expectedBundles),
    'githubArtifactBundles do not match the release matrix',
  );

  const expectedValidation = [
    `linux-x64-${plan.version}.json`,
    `linux-x64-${plan.version}.sha256`,
    `macos-arm64-${plan.version}.json`,
    `macos-arm64-${plan.version}.sha256`,
    `macos-x64-${plan.version}.json`,
    `macos-x64-${plan.version}.sha256`,
    `windows-x64-${plan.version}.json`,
    `windows-x64-${plan.version}.sha256`,
  ];
  assert(
    Array.isArray(plan.validationArtifacts),
    'validationArtifacts must be an array',
  );
  assert(
    JSON.stringify([...plan.validationArtifacts].sort()) ===
      JSON.stringify(expectedValidation.sort()),
    'validationArtifacts do not match validator output names',
  );

  const changelog = readFileSync(
    path.join(repositoryDirectory, 'apps/browser/CHANGELOG.md'),
    'utf8',
  );
  assert(
    new RegExp(
      `^## ${escapeRegex(plan.version)} \\(\\d{4}-\\d{2}-\\d{2}\\)$`,
      'm',
    ).test(changelog),
    `CHANGELOG.md is missing an exact ${plan.version} heading`,
  );

  const releaseRef = git(['rev-parse', 'HEAD']);
  if (options.requireNewTag) {
    assert(
      git(['rev-parse', '--verify', `refs/tags/${plan.tag}`], {
        allowFailure: true,
      }) === null,
      `target tag already exists: ${plan.tag}`,
    );
  }
  if (options.requireRollbackTag) {
    assert(
      git(['rev-parse', '--verify', `refs/tags/${plan.rollbackTag}`], {
        allowFailure: true,
      }) !== null,
      `rollback tag is unavailable: ${plan.rollbackTag}`,
    );
  }

  return { releaseRef };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifestPath = path.resolve(repositoryDirectory, options.manifest);
  const notesDirectory = path.join(repositoryDirectory, '.release-notes');
  assert(
    manifestPath.startsWith(`${notesDirectory}${path.sep}`),
    'manifest must be stored under .release-notes/',
  );
  assert(existsSync(manifestPath), `manifest not found: ${options.manifest}`);

  const plan = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const { releaseRef } = validatePlan(plan, options);
  const result = {
    status: 'passed',
    manifest: path.relative(repositoryDirectory, manifestPath),
    releaseRef,
    tag: plan.tag,
    version: plan.version,
    rollbackTag: plan.rollbackTag,
  };

  if (options.githubOutput) {
    appendFileSync(
      options.githubOutput,
      [
        `release_ref=${releaseRef}`,
        `rollback_tag=${plan.rollbackTag}`,
        `tag=${plan.tag}`,
        `version=${plan.version}`,
        '',
      ].join('\n'),
    );
  }

  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (error) {
  console.error(
    `[technical-preview-plan] ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
}
