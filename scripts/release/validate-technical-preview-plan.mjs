#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertReleaseTagReusable,
  loadAndValidateReleasePlan,
} from './release-plan.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, '../..');

function fail(message) {
  throw new Error(message);
}

function parseArguments(values) {
  const options = {
    expectedTag: undefined,
    expectedVersion: undefined,
    githubOutput: undefined,
    manifest: '.release-notes/clodex-technical-preview.json',
    requireNewTag: false,
    requirePrerequisiteTag: false,
    sourceRef: undefined,
  };

  for (const value of values) {
    if (value === '--require-new-tag') {
      options.requireNewTag = true;
    } else if (
      value === '--require-prerequisite-tag' ||
      value === '--require-rollback-tag'
    ) {
      // Keep the old spelling as a fail-closed compatibility alias while
      // schema v2 models preview.2 as a baseline with no rollback target.
      options.requirePrerequisiteTag = true;
    } else if (value.startsWith('--expected-tag=')) {
      options.expectedTag = value.slice('--expected-tag='.length);
    } else if (value.startsWith('--expected-version=')) {
      options.expectedVersion = value.slice('--expected-version='.length);
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

export const assertTechnicalPreviewTagReusable = assertReleaseTagReusable;

function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = loadAndValidateReleasePlan({
    expectedKind: 'technical-preview',
    expectedTag: options.expectedTag,
    expectedVersion: options.expectedVersion,
    manifest: options.manifest,
    repositoryDirectory,
    requireNewTag: options.requireNewTag,
    requirePrerequisiteTag: options.requirePrerequisiteTag,
    sourceRef: options.sourceRef,
  });
  const rollbackTag = result.plan.rollback.targetTag ?? '';
  const output = {
    manifest: result.manifestPath,
    manifestSha256: result.manifestSha256,
    promotionRole: result.plan.promotionRole,
    releaseDraft: true,
    releaseRef: result.releaseRef,
    rollbackTag: rollbackTag || null,
    status: 'passed',
    tag: result.plan.tag,
    version: result.plan.version,
  };

  if (options.githubOutput) {
    appendFileSync(
      options.githubOutput,
      [
        `manifest_path=${result.manifestPath}`,
        `manifest_sha256=${result.manifestSha256}`,
        `promotion_role=${result.plan.promotionRole}`,
        'release_draft=true',
        `release_ref=${result.releaseRef}`,
        `rollback_tag=${rollbackTag}`,
        `tag=${result.plan.tag}`,
        `version=${result.plan.version}`,
        '',
      ].join('\n'),
    );
  }

  console.log(JSON.stringify(output, null, 2));
}

const isEntryPoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  try {
    main();
  } catch (error) {
    console.error(
      `[technical-preview-plan] ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  }
}
