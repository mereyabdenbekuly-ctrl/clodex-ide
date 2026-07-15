#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ACCEPTANCE_ATTESTATION_WORKFLOW,
  CANONICAL_REPOSITORY,
  TRUSTED_SOURCE_REF,
  readJsonFile,
  sha256File,
  sha256Text,
  validatePublicationReport,
  validateTrustedAcceptanceEvidence,
} from './release-trust.mjs';
import {
  REQUIRED_ACCEPTANCE_CHECK_IDS,
  validateReleasePlan,
} from './release-plan.mjs';

const MANUAL_CHECK_IDS = [
  'manual.dock-or-tray-icon',
  'manual.task-creation',
  'manual.terminal',
  'manual.browser',
  'manual.mcp',
  'manual.guardian-egress-prompt',
  'manual.restart-session-recovery',
];

function fail(message) {
  throw new Error(message);
}

function assertExactKeys(value, expected, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...expected].sort())
  ) {
    fail(`${label} contains missing or unknown fields`);
  }
}

function parseArguments(values) {
  const options = {};
  for (const value of values) {
    if (!value.startsWith('--') || !value.includes('='))
      fail(`Invalid argument: ${value}`);
    const [name, ...parts] = value.slice(2).split('=');
    if (
      ![
        'automated-checks',
        'manual-checks',
        'output',
        'plan',
        'publication-report',
        'publication-snapshot',
      ].includes(name)
    ) {
      fail(`Unknown argument: ${value}`);
    }
    options[name] = parts.join('=');
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  for (const name of [
    'automated-checks',
    'manual-checks',
    'output',
    'plan',
    'publication-report',
    'publication-snapshot',
  ]) {
    if (!options[name]) fail(`--${name} is required`);
  }
  const planPath = path.resolve(options.plan);
  const planText = readFileSync(planPath, 'utf8');
  const plan = JSON.parse(planText);
  validateReleasePlan(plan, { skipPromotionEvidence: true });
  const reportPath = path.resolve(options['publication-report']);
  const reportText = readFileSync(reportPath, 'utf8');
  const report = validatePublicationReport(JSON.parse(reportText));
  const snapshot = readJsonFile(
    path.resolve(options['publication-snapshot']),
    'publication snapshot',
  );
  if (
    report.sourceCommit !== snapshot.sourceCommit ||
    report.tag !== snapshot.tag ||
    report.releasePlan.sha256 !== sha256Text(planText) ||
    report.releasePlan.path !== options.plan ||
    report.version !== plan.version ||
    report.tag !== plan.tag ||
    snapshot.repository !== CANONICAL_REPOSITORY ||
    !Number.isSafeInteger(snapshot.releaseId) ||
    snapshot.releaseId <= 0 ||
    !Array.isArray(snapshot.assets) ||
    !snapshot.reportAsset ||
    snapshot.reportAsset.fileName !== 'clodex-release-publication.json' ||
    snapshot.reportAsset.releaseAssetId <= 0 ||
    snapshot.reportSha256 !== (await sha256File(reportPath))
  ) {
    fail('release plan, publication report, and live snapshot are not bound');
  }
  const manualChecks = readJsonFile(
    path.resolve(options['manual-checks']),
    'manual checks',
  );
  assertExactKeys(manualChecks, MANUAL_CHECK_IDS, 'manual checks');
  for (const id of MANUAL_CHECK_IDS) {
    if (manualChecks?.[id] !== true)
      fail(`Manual acceptance is not approved: ${id}`);
  }
  const automatedChecksPath = path.resolve(options['automated-checks']);
  const automatedChecksText = readFileSync(automatedChecksPath, 'utf8');
  const automatedChecks = JSON.parse(automatedChecksText);
  if (
    automatedChecks?.receiptKind !== 'trusted-release-source-checks' ||
    automatedChecks?.sourceCommit !== report.sourceCommit ||
    !Array.isArray(automatedChecks.receipts) ||
    automatedChecks.receipts.some((receipt) => receipt.status !== 'pass')
  ) {
    fail('trusted automated source-check receipt is invalid');
  }
  const combinedAutomatedChecks = [
    ...automatedChecks.receipts,
    ...report.acceptanceChecks,
  ];
  const expectedAutomatedIds = REQUIRED_ACCEPTANCE_CHECK_IDS.filter(
    (id) => !MANUAL_CHECK_IDS.includes(id),
  ).sort();
  if (
    JSON.stringify(combinedAutomatedChecks.map((check) => check.id).sort()) !==
    JSON.stringify(expectedAutomatedIds)
  ) {
    fail('trusted automated acceptance check IDs are incomplete');
  }

  const generatedAt = new Date().toISOString();
  let canary;
  let status;
  if (plan.promotionRole === 'rollback-baseline') {
    status = 'ready-as-rollback-baseline';
    canary = {
      authFailures: 0,
      distributionClosedAt: null,
      endedAt: null,
      observationEvidence: null,
      observedHours: null,
      observedInstallations: null,
      startedAt: null,
      stopReasons: [],
      targetInstallations: 0,
      targetObservationHours: 24,
    };
  } else if (plan.promotionRole === 'canary') {
    fail(
      'stable promotion is NOT_READY: no trusted, manifest-bound canary observation attestation source is configured',
    );
  } else {
    fail('release plan promotion role is invalid');
  }

  const sourceCommit = process.env.GITHUB_SHA;
  const workflowCommit = process.env.GITHUB_WORKFLOW_SHA ?? sourceCommit;
  const runId = Number.parseInt(process.env.GITHUB_RUN_ID ?? '', 10);
  const runAttempt = Number.parseInt(process.env.GITHUB_RUN_ATTEMPT ?? '', 10);
  if (
    !/^[a-f0-9]{40}$/.test(String(sourceCommit ?? '')) ||
    !/^[a-f0-9]{40}$/.test(String(workflowCommit ?? '')) ||
    workflowCommit !== sourceCommit ||
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt <= 0
  ) {
    fail('trusted GitHub collector identity is unavailable');
  }

  const evidence = {
    schemaVersion: 4,
    evidenceKind: 'release-acceptance',
    status,
    generatedAt,
    blockers: [],
    checks: [
      ...combinedAutomatedChecks,
      ...MANUAL_CHECK_IDS.map((id) => ({
        id,
        reasonCode: 'protected-operator-approval',
        status: 'pass',
      })),
    ].sort((left, right) => left.id.localeCompare(right.id)),
    collector: {
      repository: CANONICAL_REPOSITORY,
      runAttempt,
      runId,
      sourceCommit,
      sourceRef: TRUSTED_SOURCE_REF,
      workflow: ACCEPTANCE_ATTESTATION_WORKFLOW,
      workflowCommit,
    },
    manifest: {
      path: report.releasePlan.path,
      sha256: report.releasePlan.sha256,
      sourceCommit: report.sourceCommit,
    },
    publication: {
      assets: snapshot.assets,
      createdAt: snapshot.createdAt,
      releaseId: snapshot.releaseId,
      reportAssetId: snapshot.reportAsset.releaseAssetId,
      reportFileName: snapshot.reportAsset.fileName,
      reportSha256: snapshot.reportSha256,
      repository: CANONICAL_REPOSITORY,
      sourceCommit: snapshot.sourceCommit,
      tag: snapshot.tag,
    },
    inputs: {
      automatedChecks: {
        path: path.basename(options['automated-checks']),
        sha256: sha256Text(automatedChecksText),
        sourceCommit: report.sourceCommit,
      },
      manualChecks: {
        path: path.basename(options['manual-checks']),
        sha256: sha256Text(
          readFileSync(path.resolve(options['manual-checks']), 'utf8'),
        ),
        sourceCommit,
      },
    },
    release: {
      channel: 'preview',
      promotionRole: plan.promotionRole,
      tag: plan.tag,
      version: plan.version,
    },
    rollback: {
      mode: 'distribution-stop-only',
      ...(plan.rollback.targetTag
        ? { targetTag: plan.rollback.targetTag }
        : {}),
    },
    canary,
  };
  validateTrustedAcceptanceEvidence(evidence, { now: new Date(generatedAt) });
  writeFileSync(
    path.resolve(options.output),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({ output: path.resolve(options.output), status }, null, 2),
  );
}

try {
  await main();
} catch (error) {
  console.error(
    `[trusted-release-evidence] ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
}
