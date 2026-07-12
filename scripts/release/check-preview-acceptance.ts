#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process';
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

interface CliOptions {
  allowHold: boolean;
  artifactValidationPath?: string;
  inputPath?: string;
  outputPath?: string;
  packagedAppPath?: string;
  printMatrix: boolean;
  printTemplate: boolean;
  repositoryDirectory: string;
  runSourceChecks: boolean;
}

function usage(): string {
  return `
Validate preview.2 acceptance, canary-5, and rollback evidence.

Usage:
  node --import tsx scripts/release/check-preview-acceptance.ts --print-template [--output=<path>]
  node --import tsx scripts/release/check-preview-acceptance.ts --print-matrix [--output=<path>]
  node --import tsx scripts/release/check-preview-acceptance.ts --input=<path> [options]

Options:
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

function readInput(filePath: string): PreviewAcceptanceInput {
  const value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  validatePreviewAcceptanceInput(value);
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
  if (options.printTemplate) {
    const result = spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
      cwd: repositoryDirectory,
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error('Unable to resolve HEAD');
    emit(
      createPreviewAcceptanceTemplate(result.stdout.trim()),
      options.outputPath,
    );
    return;
  }

  if (!options.inputPath) {
    throw new Error(`--input is required\n\n${usage()}`);
  }
  const input = readInput(path.resolve(options.inputPath));
  const automatedChecks = collectAutomatedAcceptance({
    artifactValidationPath: options.artifactValidationPath
      ? path.resolve(options.artifactValidationPath)
      : undefined,
    packagedAppPath: options.packagedAppPath
      ? path.resolve(options.packagedAppPath)
      : undefined,
    release: input.release,
    repositoryDirectory,
    runSourceChecks: options.runSourceChecks,
  });
  const report = evaluatePreviewAcceptance(input, automatedChecks);
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
