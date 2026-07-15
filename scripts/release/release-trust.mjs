import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { validateCanaryObservationEvidenceBundle } from './assemble-canary-observation-receipt.mjs';
import {
  ACCEPTANCE_ATTESTATION_WORKFLOW,
  CANARY_OBSERVATION_ATTESTATION_WORKFLOW,
  CANONICAL_REPOSITORY,
  EVIDENCE_MAX_AGE_MS,
  PUBLICATION_REPORT_FILE_NAME,
  TRUSTED_SOURCE_REF,
} from './release-trust-constants.mjs';

export {
  ACCEPTANCE_ATTESTATION_WORKFLOW,
  CANARY_OBSERVATION_ATTESTATION_WORKFLOW,
  CANONICAL_REPOSITORY,
  EVIDENCE_MAX_AGE_MS,
  PUBLICATION_ATTESTATION_WORKFLOW,
  PUBLICATION_REPORT_FILE_NAME,
  TRUSTED_SOURCE_REF,
} from './release-trust-constants.mjs';
export const REQUIRED_ACCEPTANCE_CHECK_IDS = [
  'source.commit-bound',
  'source.clean-tree',
  'publication.github-release',
  'toolchain.node',
  'toolchain.pnpm',
  'artifact.validation-manifest',
  'artifact.packaged-smoke',
  'artifact.clean-profile-launch',
  'artifact.app-icon',
  'security.distribution-trust',
  'product.quick-task-green',
  'product.task-creation-contract',
  'product.browser-contract',
  'product.mcp-contract',
  'product.guardian-egress-contract',
  'product.session-recovery-contract',
  'manual.dock-or-tray-icon',
  'manual.task-creation',
  'manual.terminal',
  'manual.browser',
  'manual.mcp',
  'manual.guardian-egress-prompt',
  'manual.restart-session-recovery',
];

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const EXPECTED_BUILDS = [
  'linux:x64',
  'macos:arm64',
  'macos:x64',
  'windows:x64',
];
const EXPECTED_ARTIFACT_CHECKS = [
  'artifact.app-icon',
  'artifact.clean-profile-launch',
  'artifact.packaged-smoke',
  'artifact.validation-manifest',
  'security.distribution-trust',
];

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNormalizedRepositorySubpath(value, directory) {
  return (
    typeof value === 'string' &&
    !value.includes('\\') &&
    path.posix.normalize(value) === value &&
    value.startsWith(`${directory}/`)
  );
}

function parseDate(value, label) {
  const time =
    typeof value === 'string' ? new Date(value).getTime() : Number.NaN;
  assert(!Number.isNaN(time), `${label} is invalid`);
  return time;
}

function assertExactStrings(actual, expected, message) {
  assert(Array.isArray(actual), message);
  assert(
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()),
    message,
  );
}

function assertExactKeys(value, expected, label) {
  assert(isObject(value), `${label} must be an object`);
  assert(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort()),
    `${label} contains missing or unsupported fields`,
  );
}

export function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export function readJsonFile(filePath, label = 'JSON file') {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateAssetRecord(asset, label, { requireId = false } = {}) {
  assert(isObject(asset), `${label} is invalid`);
  assert(
    typeof asset.fileName === 'string' &&
      asset.fileName === path.basename(asset.fileName) &&
      asset.fileName.length > 0,
    `${label} filename is invalid`,
  );
  assert(
    Number.isSafeInteger(asset.bytes) && asset.bytes > 0,
    `${label} size is invalid`,
  );
  assert(SHA256.test(String(asset.sha256 ?? '')), `${label} digest is invalid`);
  if (requireId) {
    assert(
      Number.isSafeInteger(asset.releaseAssetId) && asset.releaseAssetId > 0,
      `${label} release asset ID is invalid`,
    );
  }
}

export function validatePublicationReport(report, expected = {}) {
  assert(isObject(report), 'publication report must be an object');
  assert(
    report.schemaVersion === 2 &&
      report.reportKind === 'release-publication' &&
      report.status === 'validated',
    'publication report schema/status is invalid',
  );
  parseDate(report.generatedAt, 'publication report generatedAt');
  assert(
    report.repository === CANONICAL_REPOSITORY,
    'publication report repository is not canonical',
  );
  assert(
    COMMIT.test(String(report.sourceCommit ?? '')),
    'publication source commit is invalid',
  );
  assert(
    typeof report.tag === 'string' && report.tag.length > 0,
    'publication tag is invalid',
  );
  assert(
    (report.channel === 'prerelease' &&
      /^\d+\.\d+\.\d+-preview\.\d+$/u.test(String(report.version ?? '')) &&
      report.tag === `v${report.version}`) ||
      (report.channel === 'release' &&
        /^\d+\.\d+\.\d+$/u.test(String(report.version ?? '')) &&
        report.tag === `clodex@${report.version}`),
    'publication version/channel/tag binding is invalid',
  );
  assert(
    isObject(report.releasePlan) &&
      isNormalizedRepositorySubpath(
        report.releasePlan.path,
        '.release-notes',
      ) &&
      report.releasePlan.path.endsWith('.json') &&
      SHA256.test(String(report.releasePlan.sha256 ?? '')),
    'publication release-plan binding is invalid',
  );
  assert(
    isObject(report.workflow) &&
      Number.isSafeInteger(report.workflow.runId) &&
      report.workflow.runId > 0 &&
      Number.isSafeInteger(report.workflow.runAttempt) &&
      report.workflow.runAttempt > 0 &&
      COMMIT.test(String(report.workflow.commit ?? '')) &&
      report.workflow.commit === report.sourceCommit &&
      report.workflow.sourceRef === TRUSTED_SOURCE_REF,
    'publication workflow binding is invalid',
  );
  if (expected.sourceCommit) {
    assert(
      report.sourceCommit === expected.sourceCommit,
      'publication source mismatch',
    );
  }
  if (expected.tag)
    assert(report.tag === expected.tag, 'publication tag mismatch');
  if (expected.releasePlanPath) {
    assert(
      report.releasePlan.path === expected.releasePlanPath,
      'publication plan path mismatch',
    );
  }
  if (expected.releasePlanSha256) {
    assert(
      report.releasePlan.sha256 === expected.releasePlanSha256,
      'publication plan digest mismatch',
    );
  }
  assert(
    Array.isArray(report.assets) && report.assets.length > 0,
    'publication assets are missing',
  );
  const names = new Set();
  for (const asset of report.assets) {
    validateAssetRecord(asset, 'publication asset');
    assert(
      !names.has(asset.fileName),
      `duplicate publication asset: ${asset.fileName}`,
    );
    names.add(asset.fileName);
  }
  assertExactStrings(
    report.builds,
    EXPECTED_BUILDS,
    'publication report must bind the exact release build matrix',
  );
  assert(
    Array.isArray(report.validations) && report.validations.length === 4,
    'publication report must bind all four platform validation manifests',
  );
  const validationIdentities = [];
  const validationManifestNames = new Set();
  for (const validation of report.validations) {
    assert(
      isObject(validation) &&
        ['macos', 'windows', 'linux'].includes(validation.platform) &&
        ['arm64', 'x64'].includes(validation.arch) &&
        validation.status === 'passed' &&
        typeof validation.manifestFileName === 'string' &&
        validation.manifestFileName.length > 0 &&
        validation.manifestFileName ===
          path.basename(validation.manifestFileName) &&
        SHA256.test(String(validation.manifestSha256 ?? '')) &&
        SHA256.test(String(validation.checksSha256 ?? '')) &&
        (validation.signatureSha256 === null ||
          SHA256.test(String(validation.signatureSha256 ?? ''))) &&
        (validation.trustSha256 === null ||
          SHA256.test(String(validation.trustSha256 ?? ''))),
      'publication validation receipt is invalid',
    );
    assert(
      !validationManifestNames.has(validation.manifestFileName),
      'publication validation manifests are duplicated',
    );
    validationManifestNames.add(validation.manifestFileName);
    validationIdentities.push(`${validation.platform}:${validation.arch}`);
  }
  assertExactStrings(
    validationIdentities,
    EXPECTED_BUILDS,
    'publication validation receipts do not match the build matrix',
  );
  assert(
    Array.isArray(report.acceptanceChecks) &&
      JSON.stringify(
        report.acceptanceChecks.map((check) => check?.id).sort(),
      ) === JSON.stringify(EXPECTED_ARTIFACT_CHECKS) &&
      report.acceptanceChecks.every(
        (check) =>
          check.status === 'pass' &&
          check.reasonCode === 'attested-publication-validation',
      ),
    'publication artifact acceptance receipts are incomplete',
  );
  const assetBuilds = new Set();
  for (const asset of report.assets) {
    assert(
      typeof asset.identity === 'string' &&
        EXPECTED_BUILDS.includes(asset.identity),
      'publication asset build identity is invalid',
    );
    assetBuilds.add(asset.identity);
  }
  assertExactStrings(
    [...assetBuilds],
    EXPECTED_BUILDS,
    'publication assets do not cover the exact release build matrix',
  );
  return report;
}

export async function validateLiveReleasePublication({
  assetsDirectory,
  expectedReleaseState,
  expectedReleaseId,
  release,
  report,
  reportFileName,
  now = new Date(),
}) {
  validatePublicationReport(report);
  const nowMs = now.getTime();
  const reportGeneratedAt = parseDate(
    report.generatedAt,
    'publication report generatedAt',
  );
  assert(
    reportGeneratedAt <= nowMs + 5 * 60_000,
    'publication report generatedAt is in the future',
  );
  assert(isObject(release), 'GitHub Release response is invalid');
  const stablePublication = report.channel === 'release';
  const releaseState =
    expectedReleaseState ?? (stablePublication ? 'published' : 'draft');
  assert(
    releaseState === 'draft' || releaseState === 'published',
    'expected GitHub Release state is invalid',
  );
  const stateMatches =
    releaseState === 'draft'
      ? release.draft === true &&
        release.prerelease === !stablePublication &&
        release.published_at === null
      : stablePublication &&
        release.draft === false &&
        release.prerelease === false &&
        typeof release.published_at === 'string';
  assert(
    release.id === expectedReleaseId &&
      release.tag_name === report.tag &&
      stateMatches,
    'GitHub Release identity/state is invalid',
  );
  const createdAt = parseDate(release.created_at, 'GitHub Release created_at');
  assert(
    createdAt <= nowMs + 5 * 60_000,
    'GitHub Release creation time is in the future',
  );
  if (releaseState === 'published') {
    const publishedAt = parseDate(
      release.published_at,
      'GitHub Release published_at',
    );
    assert(
      publishedAt >= createdAt && publishedAt <= nowMs + 5 * 60_000,
      'GitHub Release publication time is invalid',
    );
  }
  assert(Array.isArray(release.assets), 'GitHub Release assets are missing');

  const expectedByName = new Map(
    report.assets.map((asset) => [asset.fileName, asset]),
  );
  const expectedNames = new Set([...expectedByName.keys(), reportFileName]);
  const liveNames = release.assets.map((asset) => asset?.name).sort();
  assert(
    JSON.stringify(liveNames) === JSON.stringify([...expectedNames].sort()),
    'GitHub Release asset set differs from the attested publication report',
  );

  const snapshot = [];
  for (const asset of release.assets) {
    assert(
      isObject(asset) &&
        Number.isSafeInteger(asset.id) &&
        asset.id > 0 &&
        typeof asset.name === 'string' &&
        asset.state === 'uploaded' &&
        Number.isSafeInteger(asset.size) &&
        asset.size > 0 &&
        typeof asset.digest === 'string' &&
        asset.digest.startsWith('sha256:'),
      'GitHub Release asset metadata is incomplete',
    );
    const filePath = path.join(assetsDirectory, asset.name);
    assert(
      existsSync(filePath),
      `downloaded release asset is missing: ${asset.name}`,
    );
    const stats = lstatSync(filePath);
    assert(
      stats.isFile() && stats.size === asset.size && stats.size > 0,
      `release asset size mismatch: ${asset.name}`,
    );
    const digest = await sha256File(filePath);
    assert(
      asset.digest === `sha256:${digest}`,
      `release asset API digest mismatch: ${asset.name}`,
    );
    const expected = expectedByName.get(asset.name);
    if (expected) {
      assert(
        expected.bytes === asset.size && expected.sha256 === digest,
        `release asset differs from publication report: ${asset.name}`,
      );
    }
    snapshot.push({
      bytes: asset.size,
      fileName: asset.name,
      releaseAssetId: asset.id,
      sha256: digest,
    });
  }
  return {
    assets: snapshot.sort((left, right) =>
      left.fileName.localeCompare(right.fileName),
    ),
    createdAt: new Date(createdAt).toISOString(),
  };
}

export function validateTrustedAcceptanceEvidence(
  evidence,
  { now = new Date() } = {},
) {
  assert(isObject(evidence), 'trusted acceptance evidence must be an object');
  assertExactKeys(
    evidence,
    [
      'blockers',
      'canary',
      'checks',
      'collector',
      'evidenceKind',
      'generatedAt',
      'inputs',
      'manifest',
      'publication',
      'release',
      'rollback',
      'schemaVersion',
      'status',
    ],
    'trusted acceptance evidence',
  );
  assert(
    evidence.schemaVersion === 4 &&
      evidence.evidenceKind === 'release-acceptance' &&
      ['ready-as-rollback-baseline', 'ready-for-stable'].includes(
        evidence.status,
      ),
    'trusted acceptance evidence schema/status is invalid',
  );
  const nowMs = now.getTime();
  const generatedAt = parseDate(evidence.generatedAt, 'evidence generatedAt');
  assert(
    generatedAt <= nowMs + 5 * 60_000,
    'evidence generatedAt is in the future',
  );
  assert(
    nowMs - generatedAt <= EVIDENCE_MAX_AGE_MS,
    'trusted acceptance evidence is stale',
  );
  assertExactKeys(
    evidence.collector,
    [
      'repository',
      'runAttempt',
      'runId',
      'sourceCommit',
      'sourceRef',
      'workflow',
      'workflowCommit',
    ],
    'trusted collector',
  );
  assert(
    evidence.collector?.repository === CANONICAL_REPOSITORY &&
      evidence.collector?.workflow === ACCEPTANCE_ATTESTATION_WORKFLOW &&
      evidence.collector?.sourceRef === TRUSTED_SOURCE_REF &&
      COMMIT.test(String(evidence.collector?.sourceCommit ?? '')) &&
      COMMIT.test(String(evidence.collector?.workflowCommit ?? '')) &&
      evidence.collector.workflowCommit === evidence.collector.sourceCommit &&
      Number.isSafeInteger(evidence.collector?.runId) &&
      evidence.collector.runId > 0 &&
      Number.isSafeInteger(evidence.collector?.runAttempt) &&
      evidence.collector.runAttempt > 0,
    'trusted collector identity is invalid',
  );
  assertExactKeys(
    evidence.manifest,
    ['path', 'sha256', 'sourceCommit'],
    'trusted manifest',
  );
  assert(
    isObject(evidence.manifest) &&
      isNormalizedRepositorySubpath(evidence.manifest.path, '.release-notes') &&
      evidence.manifest.path.endsWith('.json') &&
      SHA256.test(String(evidence.manifest.sha256 ?? '')) &&
      COMMIT.test(String(evidence.manifest.sourceCommit ?? '')),
    'trusted manifest binding is invalid',
  );
  assertExactKeys(
    evidence.publication,
    [
      'assets',
      'createdAt',
      'releaseId',
      'reportAssetId',
      'reportFileName',
      'reportSha256',
      'repository',
      'sourceCommit',
      'tag',
    ],
    'trusted publication',
  );
  assert(
    evidence.publication?.repository === CANONICAL_REPOSITORY &&
      Number.isSafeInteger(evidence.publication?.releaseId) &&
      evidence.publication.releaseId > 0 &&
      Array.isArray(evidence.publication.assets) &&
      evidence.publication.assets.length > 1 &&
      SHA256.test(String(evidence.publication?.reportSha256 ?? '')) &&
      Number.isSafeInteger(evidence.publication?.reportAssetId) &&
      evidence.publication.reportAssetId > 0 &&
      evidence.publication?.reportFileName === PUBLICATION_REPORT_FILE_NAME &&
      evidence.publication.sourceCommit === evidence.manifest.sourceCommit &&
      typeof evidence.publication.tag === 'string' &&
      evidence.publication.tag.length > 0,
    'trusted publication snapshot is invalid',
  );
  const publicationNames = new Set();
  const publicationIds = new Set();
  for (const asset of evidence.publication.assets) {
    assertExactKeys(
      asset,
      ['bytes', 'fileName', 'releaseAssetId', 'sha256'],
      'trusted publication asset',
    );
    validateAssetRecord(asset, 'trusted publication asset', {
      requireId: true,
    });
    assert(
      !publicationNames.has(asset.fileName) &&
        !publicationIds.has(asset.releaseAssetId),
      'trusted publication assets contain duplicate names or IDs',
    );
    publicationNames.add(asset.fileName);
    publicationIds.add(asset.releaseAssetId);
  }
  const reportAsset = evidence.publication.assets.find(
    (asset) => asset.fileName === evidence.publication.reportFileName,
  );
  assert(
    reportAsset?.releaseAssetId === evidence.publication.reportAssetId &&
      reportAsset.sha256 === evidence.publication.reportSha256,
    'trusted publication report asset binding is invalid',
  );
  assertExactKeys(
    evidence.release,
    ['channel', 'promotionRole', 'tag', 'version'],
    'trusted release',
  );
  assert(
    isObject(evidence.release) &&
      evidence.release.channel === 'preview' &&
      evidence.release.tag === evidence.publication.tag &&
      typeof evidence.release.version === 'string' &&
      /^\d+\.\d+\.\d+-preview\.[1-9]\d*$/u.test(evidence.release.version) &&
      evidence.release.tag === `v${evidence.release.version}` &&
      ['canary', 'rollback-baseline'].includes(evidence.release.promotionRole),
    'trusted release identity is invalid',
  );
  assert(
    Array.isArray(evidence.blockers) && evidence.blockers.length === 0,
    'trusted acceptance evidence contains blockers',
  );
  assert(
    Array.isArray(evidence.checks) &&
      evidence.checks.length > 0 &&
      evidence.checks.every(
        (check) =>
          isObject(check) &&
          typeof check.id === 'string' &&
          check.id.length > 0 &&
          check.status === 'pass' &&
          typeof check.reasonCode === 'string' &&
          check.reasonCode.length > 0,
      ) &&
      new Set(evidence.checks.map((check) => check.id)).size ===
        evidence.checks.length,
    'trusted acceptance checks are invalid or duplicated',
  );
  for (const check of evidence.checks) {
    assertExactKeys(
      check,
      ['id', 'reasonCode', 'status'],
      'trusted acceptance check',
    );
  }
  assertExactStrings(
    evidence.checks.map((check) => check.id),
    REQUIRED_ACCEPTANCE_CHECK_IDS,
    'trusted acceptance checks are incomplete',
  );
  const releaseCreatedAt = parseDate(
    evidence.publication.createdAt,
    'publication createdAt',
  );
  assert(
    generatedAt >= releaseCreatedAt,
    'evidence predates the GitHub Release',
  );

  const canary = evidence.canary;
  assert(isObject(canary), 'trusted canary receipt is missing');
  assertExactKeys(
    canary,
    [
      'authFailures',
      'distributionClosedAt',
      'endedAt',
      'observationEvidence',
      'observedHours',
      'observedInstallations',
      'startedAt',
      'stopReasons',
      'targetInstallations',
      'targetObservationHours',
    ],
    'trusted canary receipt',
  );
  assertExactKeys(
    evidence.inputs,
    ['automatedChecks', 'manualChecks'],
    'trusted acceptance inputs',
  );
  assertExactKeys(
    evidence.inputs.automatedChecks,
    ['path', 'sha256', 'sourceCommit'],
    'trusted automated-check input',
  );
  assertExactKeys(
    evidence.inputs.manualChecks,
    ['path', 'sha256', 'sourceCommit'],
    'trusted manual-check input',
  );
  assert(
    typeof evidence.inputs.automatedChecks.path === 'string' &&
      evidence.inputs.automatedChecks.path ===
        path.basename(evidence.inputs.automatedChecks.path) &&
      SHA256.test(String(evidence.inputs.automatedChecks.sha256 ?? '')) &&
      evidence.inputs.automatedChecks.sourceCommit ===
        evidence.manifest.sourceCommit &&
      typeof evidence.inputs.manualChecks.path === 'string' &&
      evidence.inputs.manualChecks.path ===
        path.basename(evidence.inputs.manualChecks.path) &&
      SHA256.test(String(evidence.inputs.manualChecks.sha256 ?? '')) &&
      evidence.inputs.manualChecks.sourceCommit ===
        evidence.collector.sourceCommit,
    'trusted acceptance input bindings are invalid',
  );
  assert(
    isObject(evidence.rollback) &&
      evidence.rollback.mode === 'distribution-stop-only',
    'trusted rollback policy is invalid',
  );
  if (evidence.status === 'ready-as-rollback-baseline') {
    assertExactKeys(evidence.rollback, ['mode'], 'trusted rollback policy');
    assert(
      evidence.release.promotionRole === 'rollback-baseline' &&
        !Object.hasOwn(evidence.rollback, 'targetTag') &&
        canary.startedAt === null &&
        canary.endedAt === null &&
        canary.distributionClosedAt === null &&
        canary.observedHours === null &&
        canary.observedInstallations === null &&
        canary.targetInstallations === 0 &&
        canary.targetObservationHours === 24 &&
        canary.authFailures === 0 &&
        canary.observationEvidence === null &&
        Array.isArray(canary.stopReasons) &&
        canary.stopReasons.length === 0,
      'rollback baseline must not claim a canary window',
    );
  } else {
    assertExactKeys(
      evidence.rollback,
      ['mode', 'targetTag'],
      'trusted rollback policy',
    );
    const observationEvidence = validateCanaryObservationEvidenceBundle(
      canary.observationEvidence,
      { now },
    );
    const observationReceipt = observationEvidence.bundle.receipt.value;
    const startedAt = parseDate(canary.startedAt, 'canary startedAt');
    const endedAt = parseDate(canary.endedAt, 'canary endedAt');
    const distributionClosedAt = parseDate(
      canary.distributionClosedAt,
      'canary distributionClosedAt',
    );
    assert(
      startedAt >= releaseCreatedAt,
      'canary started before the real release existed',
    );
    assert(
      endedAt >= startedAt && endedAt <= nowMs,
      'canary end is invalid or open',
    );
    assert(
      distributionClosedAt >= endedAt && distributionClosedAt <= nowMs,
      'canary distribution closure timestamp is invalid',
    );
    assert(
      generatedAt >= distributionClosedAt,
      'evidence predates distribution closure',
    );
    assert(
      parseDate(
        observationReceipt.generatedAt,
        'canary observation receipt generatedAt',
      ) <= generatedAt,
      'acceptance evidence predates the canary observation receipt',
    );
    assert(
      endedAt - startedAt >= 24 * 60 * 60 * 1000,
      'canary window is shorter than 24 hours',
    );
    const observedHours = (endedAt - startedAt) / (60 * 60 * 1000);
    assert(
      evidence.release.promotionRole === 'canary' &&
        evidence.rollback.targetTag ===
          `v${evidence.release.version.split('-preview.')[0]}-preview.2` &&
        canary.observedInstallations === 5 &&
        canary.targetInstallations === 5 &&
        canary.targetObservationHours === 24 &&
        typeof canary.observedHours === 'number' &&
        Math.abs(canary.observedHours - observedHours) < 0.001 &&
        canary.authFailures === 0 &&
        Array.isArray(canary.stopReasons) &&
        canary.stopReasons.length === 0,
      'canary receipt violates exactly-five or zero-failure policy',
    );
    assert(
      observationEvidence.policy.policySatisfied === true &&
        observationReceipt.source.commit === evidence.manifest.sourceCommit &&
        observationReceipt.manifest.path === evidence.manifest.path &&
        observationReceipt.manifest.sha256 === evidence.manifest.sha256 &&
        observationReceipt.manifest.sourceCommit ===
          evidence.manifest.sourceCommit &&
        observationReceipt.release.sourceCommit ===
          evidence.manifest.sourceCommit &&
        observationReceipt.release.version === evidence.release.version &&
        observationReceipt.release.tag === evidence.release.tag &&
        observationReceipt.release.promotionRole ===
          evidence.release.promotionRole &&
        observationReceipt.publication.repository ===
          evidence.publication.repository &&
        observationReceipt.publication.releaseId ===
          evidence.publication.releaseId &&
        observationReceipt.publication.reportAssetId ===
          evidence.publication.reportAssetId &&
        observationReceipt.publication.reportFileName ===
          evidence.publication.reportFileName &&
        observationReceipt.publication.reportSha256 ===
          evidence.publication.reportSha256 &&
        observationReceipt.publication.sourceCommit ===
          evidence.publication.sourceCommit &&
        observationReceipt.publication.tag === evidence.publication.tag &&
        observationReceipt.observation.startedAt === canary.startedAt &&
        observationReceipt.observation.endedAt === canary.endedAt &&
        observationReceipt.observation.distributionClosedAt ===
          canary.distributionClosedAt &&
        observationReceipt.observation.observedHours === canary.observedHours &&
        observationReceipt.observation.counters.uniqueInstallations ===
          canary.observedInstallations &&
        observationReceipt.observation.counters.authFailures ===
          canary.authFailures &&
        JSON.stringify(observationReceipt.observation.stopReasons) ===
          JSON.stringify(canary.stopReasons) &&
        observationReceipt.producer.repository === CANONICAL_REPOSITORY &&
        observationReceipt.producer.workflow ===
          CANARY_OBSERVATION_ATTESTATION_WORKFLOW,
      'trusted acceptance evidence is not bound to the exact canary observation subjects',
    );
  }
  return evidence;
}
