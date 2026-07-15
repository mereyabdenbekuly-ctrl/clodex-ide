#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAndValidateReleasePlan } from './release-plan.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(scriptDirectory, '../..');

function parseArguments(values) {
  const options = {};
  for (const value of values) {
    if (value.startsWith('--manifest=')) {
      options.manifest = value.slice('--manifest='.length);
    } else if (value.startsWith('--expected-tag=')) {
      options.expectedTag = value.slice('--expected-tag='.length);
    } else if (value.startsWith('--expected-version=')) {
      options.expectedVersion = value.slice('--expected-version='.length);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (!options.manifest || !options.expectedTag || !options.expectedVersion) {
    throw new Error(
      '--manifest, --expected-tag, and --expected-version are required',
    );
  }
  const result = loadAndValidateReleasePlan({
    expectedKind: 'stable',
    expectedTag: options.expectedTag,
    expectedVersion: options.expectedVersion,
    manifest: options.manifest,
    repositoryDirectory,
    requireNewTag: true,
    sourceRef: 'main',
  });
  console.log(
    JSON.stringify(
      {
        manifest: result.manifestPath,
        manifestSha256: result.manifestSha256,
        releaseRef: result.releaseRef,
        status: 'passed',
        tag: result.plan.tag,
        version: result.plan.version,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    `[stable-release-plan] ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
}
