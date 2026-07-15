#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_REPOSITORY,
  readJsonFile,
  sha256File,
  sha256Text,
  validateLiveReleasePublication,
  validatePublicationReport,
} from './release-trust.mjs';

function fail(message) {
  throw new Error(message);
}

function parseArguments(values) {
  const options = {};
  for (const value of values) {
    if (!value.startsWith('--') || !value.includes('=')) {
      fail(`Invalid argument: ${value}`);
    }
    const [name, ...parts] = value.slice(2).split('=');
    if (
      ![
        'assets',
        'expected-run-attempt',
        'expected-release-state',
        'expected-source-commit',
        'expected-tag',
        'expected-workflow-run-id',
        'release-id',
        'release-json',
        'report',
        'report-name',
        'repository',
        'snapshot',
      ].includes(name)
    ) {
      fail(`Unknown argument: ${value}`);
    }
    options[name] = parts.join('=');
  }
  return options;
}

function git(args, repositoryDirectory) {
  return execFileSync('/usr/bin/git', args, {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  for (const name of [
    'assets',
    'release-id',
    'release-json',
    'report',
    'report-name',
    'repository',
  ]) {
    if (!options[name]) fail(`--${name} is required`);
  }
  if (options.repository !== CANONICAL_REPOSITORY) {
    fail('release repository is not canonical');
  }
  const releaseId = Number.parseInt(options['release-id'], 10);
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0) {
    fail('release ID is invalid');
  }
  const expectedReleaseState = options['expected-release-state'];
  if (
    expectedReleaseState &&
    !['draft', 'published'].includes(expectedReleaseState)
  ) {
    fail('expected release state is invalid');
  }
  const repositoryDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  const reportPath = path.resolve(options.report);
  if (path.basename(reportPath) !== options['report-name']) {
    fail(
      'publication report path does not match the expected release asset name',
    );
  }
  const report = validatePublicationReport(
    readJsonFile(reportPath, 'publication report'),
  );
  if (
    (options['expected-source-commit'] &&
      report.sourceCommit !== options['expected-source-commit']) ||
    (options['expected-tag'] && report.tag !== options['expected-tag']) ||
    (options['expected-workflow-run-id'] &&
      report.workflow.runId !==
        Number.parseInt(options['expected-workflow-run-id'], 10)) ||
    (options['expected-run-attempt'] &&
      report.workflow.runAttempt !==
        Number.parseInt(options['expected-run-attempt'], 10))
  ) {
    fail('publication report does not match the invoking release workflow');
  }
  const release = readJsonFile(
    path.resolve(options['release-json']),
    'GitHub Release response',
  );

  git(
    [
      'fetch',
      '--force',
      '--no-tags',
      'origin',
      `refs/tags/${report.tag}:refs/tags/${report.tag}`,
    ],
    repositoryDirectory,
  );
  const tagCommit = git(
    ['rev-parse', '--verify', `refs/tags/${report.tag}^{commit}`],
    repositoryDirectory,
  );
  if (tagCommit !== report.sourceCommit) {
    fail(
      'remote release tag does not resolve to the publication source commit',
    );
  }
  const historicalManifest = execFileSync(
    '/usr/bin/git',
    ['show', `${report.sourceCommit}:${report.releasePlan.path}`],
    {
      cwd: repositoryDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (sha256Text(historicalManifest) !== report.releasePlan.sha256) {
    fail('publication report release-plan digest is not committed at source');
  }

  const snapshot = await validateLiveReleasePublication({
    assetsDirectory: path.resolve(options.assets),
    expectedReleaseState,
    expectedReleaseId: releaseId,
    release,
    report,
    reportFileName: options['report-name'],
  });
  const reportAsset = snapshot.assets.find(
    (asset) => asset.fileName === options['report-name'],
  );
  if (!reportAsset)
    fail('live publication snapshot is missing the report asset');
  const output = {
    ...snapshot,
    releaseId,
    reportAsset,
    reportSha256: await sha256File(reportPath),
    repository: CANONICAL_REPOSITORY,
    sourceCommit: report.sourceCommit,
    tag: report.tag,
  };
  if (options.snapshot) {
    writeFileSync(
      path.resolve(options.snapshot),
      `${JSON.stringify(output, null, 2)}\n`,
    );
  }
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(
    `[release-publication-verify] ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
});
