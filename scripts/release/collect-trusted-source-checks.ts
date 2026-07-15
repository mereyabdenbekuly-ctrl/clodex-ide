#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  collectAutomatedAcceptance,
  writeJsonFile,
} from './preview-acceptance.js';
import type { TechnicalPreviewReleasePlan } from './release-plan.mjs';
import { validateReleasePlan } from './release-plan.mjs';

const CANONICAL_REPOSITORY = 'mereyabdenbekuly-ctrl/clodex-ide';

const REQUIRED_SOURCE_CHECK_IDS = [
  'source.commit-bound',
  'source.clean-tree',
  'publication.github-release',
  'toolchain.node',
  'toolchain.pnpm',
  'product.quick-task-green',
  'product.task-creation-contract',
  'product.browser-contract',
  'product.mcp-contract',
  'product.guardian-egress-contract',
  'product.session-recovery-contract',
] as const;

function parseArguments(values: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (const value of values) {
    if (!value.startsWith('--') || !value.includes('=')) {
      throw new Error(`Invalid argument: ${value}`);
    }
    const [name, ...parts] = value.slice(2).split('=');
    if (
      !name ||
      ![
        'manifest',
        'output',
        'release-id',
        'repository',
        'source-commit',
      ].includes(name)
    ) {
      throw new Error(`Unknown argument: ${value}`);
    }
    options[name] = parts.join('=');
  }
  return options;
}

function requireOption(options: Record<string, string>, name: string): string {
  const value = options[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function main(): void {
  const options = parseArguments(process.argv.slice(2));
  const manifest = requireOption(options, 'manifest');
  const output = requireOption(options, 'output');
  const releaseIdInput = requireOption(options, 'release-id');
  const repository = requireOption(options, 'repository');
  const sourceCommit = requireOption(options, 'source-commit');
  const repositoryDirectory = process.cwd();
  if (repository !== CANONICAL_REPOSITORY) {
    throw new Error('source checks require the canonical release repository');
  }
  const head = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
  }).trim();
  if (head !== sourceCommit) {
    throw new Error('source-check worktree is not the exact release commit');
  }
  const manifestPath = path.resolve(repositoryDirectory, manifest);
  const manifestText = readFileSync(manifestPath, 'utf8');
  const plan = JSON.parse(manifestText) as TechnicalPreviewReleasePlan;
  validateReleasePlan(plan, { skipPromotionEvidence: true });
  const releaseId = Number.parseInt(releaseIdInput, 10);
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0) {
    throw new Error('release ID is invalid');
  }
  const receipts = collectAutomatedAcceptance({
    context: {
      manifestPath: manifest,
      manifestSha256: createHash('sha256').update(manifestText).digest('hex'),
      plan,
      releaseRef: head,
    },
    githubRepository: repository,
    publication: {
      githubReleaseId: releaseId,
      githubReleaseState: 'draft',
      tag: plan.tag,
      targetCommit: head,
    },
    repositoryDirectory,
    runSourceChecks: true,
  }).filter((receipt) =>
    REQUIRED_SOURCE_CHECK_IDS.includes(
      receipt.id as (typeof REQUIRED_SOURCE_CHECK_IDS)[number],
    ),
  );
  const expected = [...REQUIRED_SOURCE_CHECK_IDS].sort();
  const observed = receipts.map((receipt) => receipt.id).sort();
  if (
    JSON.stringify(expected) !== JSON.stringify(observed) ||
    receipts.some((receipt) => receipt.status !== 'pass')
  ) {
    throw new Error(
      `trusted source checks failed: ${receipts
        .filter((receipt) => receipt.status !== 'pass')
        .map((receipt) => `${receipt.id}:${receipt.reasonCode}`)
        .join(', ')}`,
    );
  }
  writeJsonFile(path.resolve(output), {
    schemaVersion: 1,
    receiptKind: 'trusted-release-source-checks',
    sourceCommit: head,
    manifestPath: manifest,
    receipts,
  });
}

try {
  main();
} catch (error) {
  console.error(
    `[trusted-source-checks] ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
}
