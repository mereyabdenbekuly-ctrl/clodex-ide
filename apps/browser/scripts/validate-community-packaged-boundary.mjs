import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachCommunityPackagedBoundaryEvidence,
  inspectCommunityPackagedBoundary,
  resolveCommunityPackagedAsarPath,
  writeCommunityPackagedBoundaryEvidence,
} from './community-packaged-boundary-validator.mjs';

const browserDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const help = `
Validate the packaged bytes of a Community desktop application.

Usage:
  node scripts/validate-community-packaged-boundary.mjs \\
    --distribution-mode=<community-unsigned|community-observed> \\
    --platform=<macos|windows|linux> \\
    --arch=<arm64|x64> [--asar=<path>] [--output=<path>] \\
    [--validation-manifest=<path>]
`;

function parseArguments(values) {
  const options = {};
  for (const value of values) {
    if (value === '--') continue;
    if (value === '--help') {
      process.stdout.write(`${help.trim()}\n`);
      process.exit(0);
    }
    const separator = value.indexOf('=');
    if (!value.startsWith('--') || separator < 3) {
      throw new Error(`Unknown argument: ${value}`);
    }
    const name = value.slice(2, separator);
    const argument = value.slice(separator + 1);
    if (!argument) throw new Error(`Argument --${name} must not be empty`);
    if (name === 'distribution-mode') options.distributionMode = argument;
    else if (name === 'platform') options.platform = argument;
    else if (name === 'arch') options.arch = argument;
    else if (name === 'asar') options.asarPath = argument;
    else if (name === 'output') options.output = argument;
    else if (name === 'validation-manifest')
      options.validationManifest = argument;
    else throw new Error(`Unknown argument: --${name}`);
  }
  for (const name of ['arch', 'distributionMode', 'platform']) {
    if (!options[name]) {
      const argumentName = name.replace(
        /[A-Z]/g,
        (character) => `-${character.toLowerCase()}`,
      );
      throw new Error(`Missing required argument: --${argumentName}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const asarPath = path.resolve(
    options.asarPath ??
      resolveCommunityPackagedAsarPath({
        arch: options.arch,
        browserDirectory,
        distributionMode: options.distributionMode,
        platform: options.platform,
      }),
  );
  const { extractFile, listPackage, statFile } = await import('@electron/asar');
  const evidence = inspectCommunityPackagedBoundary({
    asarApi: { extractFile, listPackage, statFile },
    asarPath,
    distributionMode: options.distributionMode,
  });
  const outputPath = options.output
    ? writeCommunityPackagedBoundaryEvidence(options.output, evidence)
    : undefined;
  const validationManifest = options.validationManifest
    ? attachCommunityPackagedBoundaryEvidence({
        architecture: options.arch,
        distributionMode: options.distributionMode,
        evidence,
        manifestPath: options.validationManifest,
        platform: options.platform,
      })
    : undefined;
  const destinations = [
    outputPath ? `evidence: ${outputPath}` : undefined,
    validationManifest ? `attached: ${validationManifest}` : undefined,
  ].filter(Boolean);
  process.stdout.write(
    `[community-packaged-boundary] validated ${evidence.scan.files} files (${evidence.scan.bytes} bytes)${destinations.length > 0 ? `; ${destinations.join('; ')}` : ''}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `[community-packaged-boundary] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
