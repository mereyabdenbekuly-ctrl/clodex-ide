#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  loadAndValidateReleasePlan,
  validateReleasePlan,
} from './release-plan.mjs';
import {
  ACCEPTANCE_ATTESTATION_WORKFLOW,
  CANONICAL_REPOSITORY,
  PUBLICATION_ATTESTATION_WORKFLOW,
  TRUSTED_SOURCE_REF,
  readJsonFile,
  sha256File,
  sha256Text,
  validateLiveReleasePublication,
  validatePublicationReport,
  validateTrustedAcceptanceEvidence,
} from './release-trust.mjs';

const repositoryDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

export const TRUSTED_CANARY_OBSERVATION_STATUS = 'NOT_READY';

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
        'expected-kind',
        'expected-tag',
        'expected-version',
        'github-output',
        'manifest',
        'repository',
        'require-new-tag',
      ].includes(name)
    ) {
      fail(`Unknown argument: ${value}`);
    }
    options[name] = parts.join('=');
  }
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryDirectory,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} failed: ${
        result.error?.message ?? result.stderr ?? result.status
      }`,
    );
  }
  return result.stdout ?? '';
}

function verifyAttestation(filePath, { signerDigest, sourceDigest, workflow }) {
  if (
    !/^[a-f0-9]{40}$/u.test(String(sourceDigest ?? '')) ||
    !/^[a-f0-9]{40}$/u.test(String(signerDigest ?? ''))
  ) {
    fail('attestation verification requires exact source and signer digests');
  }
  run('gh', [
    'attestation',
    'verify',
    filePath,
    '--repo',
    CANONICAL_REPOSITORY,
    '--signer-workflow',
    workflow,
    '--source-ref',
    TRUSTED_SOURCE_REF,
    '--source-digest',
    sourceDigest,
    '--signer-digest',
    signerDigest,
    '--deny-self-hosted-runners',
  ]);
}

function readHistoricalFile(commit, relativePath) {
  return execFileSync('/usr/bin/git', ['show', `${commit}:${relativePath}`], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolveRemoteTag(tag, expectedCommit) {
  const tagRef = `refs/tags/${tag}`;
  run('/usr/bin/git', [
    'fetch',
    '--force',
    '--no-tags',
    'origin',
    `${tagRef}:${tagRef}`,
  ]);
  const tagCommit = execFileSync(
    '/usr/bin/git',
    ['rev-parse', '--verify', `${tagRef}^{commit}`],
    { cwd: repositoryDirectory, encoding: 'utf8' },
  ).trim();
  if (tagCommit !== expectedCommit) {
    fail(`remote prerequisite tag ${tag} does not resolve to accepted source`);
  }
}

function normalizeEvidencePath(value) {
  if (
    typeof value !== 'string' ||
    path.posix.normalize(value) !== value ||
    !value.startsWith('.release-evidence/') ||
    !value.endsWith('.json')
  ) {
    fail('historical promotion evidence path is invalid');
  }
  return value;
}

export function requireTrustedCanaryObservation(evidence) {
  if (evidence?.status === 'ready-for-stable') {
    fail(
      'stable promotion is NOT_READY: no trusted, manifest-bound canary observation attestation verifier is configured',
    );
  }
}

async function verifyAcceptedRelease({
  evidenceFilePath,
  evidenceRelativePath,
  now,
  visited,
}) {
  const evidence = validateTrustedAcceptanceEvidence(
    readJsonFile(evidenceFilePath, 'promotion evidence'),
    { now },
  );
  requireTrustedCanaryObservation(evidence);
  const visitKey = `${evidence.manifest.sourceCommit}:${evidenceRelativePath}`;
  if (visited.has(visitKey)) fail('promotion evidence chain contains a cycle');
  visited.add(visitKey);

  verifyAttestation(evidenceFilePath, {
    signerDigest: evidence.collector.workflowCommit,
    sourceDigest: evidence.collector.sourceCommit,
    workflow: ACCEPTANCE_ATTESTATION_WORKFLOW,
  });

  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), 'clodex-accepted-release.'),
  );
  try {
    const releaseOutput = run('gh', [
      'api',
      '--method',
      'GET',
      `repos/${CANONICAL_REPOSITORY}/releases/${evidence.publication.releaseId}`,
    ]);
    const release = JSON.parse(releaseOutput);
    const assetsDirectory = path.join(temporaryDirectory, 'assets');
    mkdirSync(assetsDirectory, { recursive: true });
    run(
      'gh',
      [
        'release',
        'download',
        evidence.publication.tag,
        '--repo',
        CANONICAL_REPOSITORY,
        '--dir',
        assetsDirectory,
        '--clobber',
      ],
      { inherit: true },
    );
    const reportPath = path.join(
      assetsDirectory,
      evidence.publication.reportFileName,
    );
    const report = validatePublicationReport(
      readJsonFile(reportPath, 'publication report'),
      {
        releasePlanPath: evidence.manifest.path,
        releasePlanSha256: evidence.manifest.sha256,
        sourceCommit: evidence.manifest.sourceCommit,
        tag: evidence.release.tag,
      },
    );
    verifyAttestation(reportPath, {
      signerDigest: report.workflow.commit,
      sourceDigest: report.sourceCommit,
      workflow: PUBLICATION_ATTESTATION_WORKFLOW,
    });
    const snapshot = await validateLiveReleasePublication({
      assetsDirectory,
      expectedReleaseId: evidence.publication.releaseId,
      now,
      release,
      report,
      reportFileName: evidence.publication.reportFileName,
    });
    const reportAsset = snapshot.assets.find(
      (asset) => asset.fileName === evidence.publication.reportFileName,
    );
    if (
      JSON.stringify(snapshot.assets) !==
        JSON.stringify(evidence.publication.assets) ||
      snapshot.createdAt !== evidence.publication.createdAt ||
      reportAsset?.releaseAssetId !== evidence.publication.reportAssetId ||
      (await sha256File(reportPath)) !== evidence.publication.reportSha256
    ) {
      fail(
        'live GitHub Release differs from the attested acceptance publication snapshot',
      );
    }
    resolveRemoteTag(evidence.release.tag, evidence.manifest.sourceCommit);

    const historicalManifestText = readHistoricalFile(
      evidence.manifest.sourceCommit,
      evidence.manifest.path,
    );
    if (sha256Text(historicalManifestText) !== evidence.manifest.sha256) {
      fail('accepted historical release manifest digest changed');
    }
    const historicalPlan = JSON.parse(historicalManifestText);
    validateReleasePlan(historicalPlan, { skipPromotionEvidence: true });
    if (
      historicalPlan.releaseKind !== 'technical-preview' ||
      historicalPlan.version !== evidence.release.version ||
      historicalPlan.tag !== evidence.release.tag ||
      historicalPlan.promotionRole !== evidence.release.promotionRole
    ) {
      fail('accepted release identity differs from its historical plan');
    }
    const chain = [
      {
        releaseId: evidence.publication.releaseId,
        sourceCommit: evidence.manifest.sourceCommit,
        tag: evidence.release.tag,
      },
    ];
    if (historicalPlan.promotionEvidence) {
      const prerequisitePath = normalizeEvidencePath(
        historicalPlan.promotionEvidence,
      );
      const prerequisiteText = readHistoricalFile(
        evidence.manifest.sourceCommit,
        prerequisitePath,
      );
      const prerequisiteFilePath = path.join(
        temporaryDirectory,
        'prerequisite-evidence.json',
      );
      writeFileSync(prerequisiteFilePath, prerequisiteText);
      chain.push(
        ...(await verifyAcceptedRelease({
          evidenceFilePath: prerequisiteFilePath,
          evidenceRelativePath: prerequisitePath,
          now,
          visited,
        })),
      );
    }
    return chain;
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

export function expectedPromotionChain(plan) {
  if (!plan.promotionEvidence) return [];
  if (plan.releaseKind === 'stable') {
    return [`v${plan.version}-preview.3`, `v${plan.version}-preview.2`];
  }
  if (
    plan.releaseKind === 'technical-preview' &&
    plan.promotionRole === 'canary'
  ) {
    return [plan.rollback.targetTag];
  }
  fail('release plan promotion chain is invalid');
}

function emitResult({ githubOutput, loaded, prerequisiteChain }) {
  const result = {
    manifest: loaded.manifestPath,
    manifestSha256: loaded.manifestSha256,
    prerequisiteChain,
    promotionRole: loaded.plan.promotionRole ?? null,
    releaseDraft: loaded.plan.distribution?.githubReleaseState === 'draft',
    releaseRef: loaded.releaseRef,
    rollbackTag: loaded.plan.rollback?.targetTag ?? null,
    status: 'passed',
    tag: loaded.plan.tag,
    version: loaded.plan.version,
  };
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      [
        `manifest_path=${loaded.manifestPath}`,
        `manifest_sha256=${loaded.manifestSha256}`,
        `promotion_role=${loaded.plan.promotionRole ?? ''}`,
        `release_draft=${String(result.releaseDraft)}`,
        `release_ref=${loaded.releaseRef}`,
        `rollback_tag=${loaded.plan.rollback?.targetTag ?? ''}`,
        `tag=${loaded.plan.tag}`,
        `version=${loaded.plan.version}`,
        '',
      ].join('\n'),
    );
  }
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  for (const name of [
    'expected-kind',
    'expected-tag',
    'expected-version',
    'manifest',
    'repository',
  ]) {
    if (!options[name]) fail(`--${name} is required`);
  }
  if (options.repository !== CANONICAL_REPOSITORY) {
    fail('repository is not canonical');
  }

  const plan = JSON.parse(
    readFileSync(path.resolve(repositoryDirectory, options.manifest), 'utf8'),
  );
  const expectedChain = expectedPromotionChain(plan);
  if (expectedChain.length === 0) {
    const loaded = loadAndValidateReleasePlan({
      expectedKind: options['expected-kind'],
      expectedTag: options['expected-tag'],
      expectedVersion: options['expected-version'],
      manifest: options.manifest,
      repositoryDirectory,
      requireNewTag: options['require-new-tag'] === 'true',
      sourceRef: 'main',
    });
    emitResult({
      githubOutput: options['github-output'],
      loaded,
      prerequisiteChain: [],
    });
    return;
  }

  const evidenceRelativePath = normalizeEvidencePath(plan.promotionEvidence);
  const evidencePath = path.resolve(repositoryDirectory, evidenceRelativePath);
  const evidenceSha256 = await sha256File(evidencePath);
  const chain = await verifyAcceptedRelease({
    evidenceFilePath: evidencePath,
    evidenceRelativePath,
    now: new Date(),
    visited: new Set(),
  });
  const observedTags = chain.map((entry) => entry.tag);
  if (JSON.stringify(observedTags) !== JSON.stringify(expectedChain)) {
    fail(
      `promotion chain is incomplete: expected ${expectedChain.join(' -> ')}, got ${observedTags.join(' -> ')}`,
    );
  }

  const loaded = loadAndValidateReleasePlan({
    expectedKind: options['expected-kind'],
    expectedTag: options['expected-tag'],
    expectedVersion: options['expected-version'],
    manifest: options.manifest,
    repositoryDirectory,
    requireNewTag: options['require-new-tag'] === 'true',
    requirePrerequisiteTag: true,
    sourceRef: 'main',
    verifyEvidenceTrust: (_evidence, trust) =>
      trust.path === evidenceRelativePath && trust.sha256 === evidenceSha256,
  });
  emitResult({
    githubOutput: options['github-output'],
    loaded,
    prerequisiteChain: chain,
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(
      `[release-promotion-verify] ${
        error instanceof Error ? error.message : error
      }`,
    );
    process.exitCode = 1;
  });
}
