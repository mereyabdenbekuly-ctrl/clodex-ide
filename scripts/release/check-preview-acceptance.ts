#!/usr/bin/env tsx

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  collectAutomatedAcceptance,
  createPreviewAcceptanceTemplate,
  evaluatePreviewAcceptance,
  PREVIEW_ACCEPTANCE_MATRIX,
  type PreviewAcceptanceInput,
  validatePreviewAcceptanceInput,
  writeJsonFile,
} from './preview-acceptance.js';
import { loadAndValidateReleasePlan } from './release-plan.mjs';

interface CliOptions {
  allowHold: boolean;
  artifactValidationPath?: string;
  githubRepository?: string;
  inputPath?: string;
  manifestPath: string;
  outputPath?: string;
  packagedAppPath?: string;
  printMatrix: boolean;
  printTemplate: boolean;
  repositoryDirectory: string;
  runSourceChecks: boolean;
}

function usage(): string {
  return `
Validate manifest-bound rollback-baseline or canary acceptance evidence.

Usage:
  node --import tsx scripts/release/check-preview-acceptance.ts --print-template [--manifest=<path>] [--output=<path>]
  node --import tsx scripts/release/check-preview-acceptance.ts --print-matrix [--output=<path>]
  node --import tsx scripts/release/check-preview-acceptance.ts --input=<path> [--manifest=<path>] [options]

Options:
  --manifest=<path>             committed schema-v2 release plan
  --github-repository=<owner/repo> verify the real draft release with gh api
  --artifact-validation=<path>  macOS validation JSON from release:validate:macos
  --packaged-app=<path>          run isolated smoke and icon checks on a .app
  --run-source-checks           run focused Vitest and Quick Task visual checks
  --repository=<path>           release worktree (default: current directory)
  --output=<path>               write the content-free JSON report
  --allow-hold                  return success while the report is hold/canary-running
  --help                        show this help

The report never includes command output, credentials, raw telemetry, user IDs,
installation IDs, workspace data, prompts, or absolute artifact paths.
`.trim();
}

function parseArguments(values: string[]): CliOptions {
  const options: CliOptions = {
    allowHold: false,
    githubRepository: process.env.GITHUB_REPOSITORY,
    manifestPath: '.release-notes/clodex-technical-preview.json',
    printMatrix: false,
    printTemplate: false,
    repositoryDirectory: process.cwd(),
    runSourceChecks: false,
  };
  for (const value of values) {
    if (value === '--allow-hold') options.allowHold = true;
    else if (value === '--print-matrix') options.printMatrix = true;
    else if (value === '--print-template') options.printTemplate = true;
    else if (value === '--run-source-checks') options.runSourceChecks = true;
    else if (value === '--help') {
      console.log(usage());
      process.exit(0);
    } else if (value.startsWith('--artifact-validation=')) {
      options.artifactValidationPath = value.slice(
        '--artifact-validation='.length,
      );
    } else if (value.startsWith('--input=')) {
      options.inputPath = value.slice('--input='.length);
    } else if (value.startsWith('--github-repository=')) {
      options.githubRepository = value.slice('--github-repository='.length);
    } else if (value.startsWith('--manifest=')) {
      options.manifestPath = value.slice('--manifest='.length);
    } else if (value.startsWith('--packaged-app=')) {
      options.packagedAppPath = value.slice('--packaged-app='.length);
    } else if (value.startsWith('--output=')) {
      options.outputPath = value.slice('--output='.length);
    } else if (value.startsWith('--repository=')) {
      options.repositoryDirectory = value.slice('--repository='.length);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return options;
}

function readInput(
  filePath: string,
  context: ReturnType<typeof loadAndValidateReleasePlan>,
): PreviewAcceptanceInput {
  const value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  validatePreviewAcceptanceInput(value, context);
  return value;
}

function emit(value: unknown, outputPath: string | undefined): void {
  if (outputPath) {
    writeJsonFile(path.resolve(outputPath), value);
    console.log(`Output: ${path.resolve(outputPath)}`);
  } else {
    console.log(JSON.stringify(value, null, 2));
  }
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));
  if (options.printMatrix) {
    emit(PREVIEW_ACCEPTANCE_MATRIX, options.outputPath);
    return;
  }

  const repositoryDirectory = path.resolve(options.repositoryDirectory);
  const context = loadAndValidateReleasePlan({
    expectedKind: 'technical-preview',
    manifest: options.manifestPath,
    repositoryDirectory,
  });
  if (options.printTemplate) {
    emit(createPreviewAcceptanceTemplate(context), options.outputPath);
    return;
  }

  if (!options.inputPath) {
    throw new Error(`--input is required\n\n${usage()}`);
  }
  const input = readInput(path.resolve(options.inputPath), context);
  const automatedChecks = collectAutomatedAcceptance({
    artifactValidationPath: options.artifactValidationPath
      ? path.resolve(options.artifactValidationPath)
      : undefined,
    context,
    githubRepository: options.githubRepository,
    packagedAppPath: options.packagedAppPath
      ? path.resolve(options.packagedAppPath)
      : undefined,
    publication: input.publication,
    repositoryDirectory,
    runSourceChecks: options.runSourceChecks,
  });
  const report = evaluatePreviewAcceptance(context, input, automatedChecks);
  emit(report, options.outputPath);
  console.log(`Acceptance status: ${report.status}`);

  if (report.status === 'rollback-required') process.exitCode = 2;
  else if (
    !options.allowHold &&
    (report.status === 'hold' || report.status === 'canary-running')
  ) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(
    `[preview-acceptance] ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
