#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assembleCommunityBundle,
  COMMUNITY_OBSERVED_DISTRIBUTION_MODE,
} from './assemble-community-unsigned-bundle.mjs';

function parseArguments(values) {
  const options = {
    distributionMode: COMMUNITY_OBSERVED_DISTRIBUTION_MODE,
  };
  for (const value of values) {
    if (value === '--') continue;
    const match = /^--([a-z-]+)=(.*)$/u.exec(value);
    if (!match?.[2]) throw new Error(`Invalid argument: ${value}`);
    const [, name, optionValue] = match;
    if (name === 'manifest') options.manifestPath = optionValue;
    else if (name === 'output') options.outputDirectory = optionValue;
    else if (name === 'source-commit') options.sourceCommit = optionValue;
    else if (name === 'version') options.version = optionValue;
    else if (name === 'platform') options.platform = optionValue;
    else if (name === 'arch') options.architecture = optionValue;
    else throw new Error(`Unknown argument: --${name}`);
  }
  for (const [name, value] of Object.entries({
    manifest: options.manifestPath,
    output: options.outputDirectory,
    'source-commit': options.sourceCommit,
    version: options.version,
    platform: options.platform,
    arch: options.architecture,
  })) {
    if (!value) throw new Error(`Missing required --${name} option`);
  }
  return options;
}

const isEntryPoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  try {
    const result = assembleCommunityBundle(
      parseArguments(process.argv.slice(2)),
    );
    console.log(
      `[community-observed] assembled ${result.checksummedFiles.length} checksummed files at ${result.outputDirectory}`,
    );
  } catch (error) {
    console.error(
      `[community-observed] FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
