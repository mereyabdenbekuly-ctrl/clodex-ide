import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  REQUIRED_ACCEPTANCE_CHECK_IDS as TRUSTED_REQUIRED_ACCEPTANCE_CHECK_IDS,
  validateTrustedAcceptanceEvidence,
} from './release-trust.mjs';

export const RELEASE_PLAN_SCHEMA_VERSION = 2;
export const RELEASE_ACCEPTANCE_SCHEMA_VERSION = 4;

const TECHNICAL_PREVIEW_VERSION = /^(\d+\.\d+\.\d+)-preview\.([1-9]\d*)$/u;
const STABLE_VERSION = /^\d+\.\d+\.\d+$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;

export const REQUIRED_ACCEPTANCE_CHECK_IDS =
  TRUSTED_REQUIRED_ACCEPTANCE_CHECK_IDS;

const EXPECTED_BUNDLES = [
  'clodex-linux-x64',
  'clodex-macos-arm64',
  'clodex-macos-x64',
  'clodex-windows-x64',
];

const PROMOTION_ONLY_PATHS = [
  '.release-evidence/',
  '.release-notes/',
  'apps/browser/CHANGELOG.md',
  'docs/preview-release-acceptance.md',
  'docs/releases/',
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

function isSha256(value) {
  return typeof value === 'string' && SHA_256.test(value);
}

function isCommitSha(value) {
  return typeof value === 'string' && COMMIT_SHA.test(value);
}

function isNormalizedSubpath(value, directory) {
  return (
    typeof value === 'string' &&
    !value.includes('\\') &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value.startsWith(`${directory}/`)
  );
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function deepStrings(value, result = []) {
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) deepStrings(item, result);
  } else if (isObject(value)) {
    for (const item of Object.values(value)) deepStrings(item, result);
  }
  return result;
}

function assertNoPlaceholderEvidence(value) {
  const placeholder =
    /(^|[\s._-])(placeholder|replace[\s._-]*me|todo|tbd)([\s._-]|$)/iu;
  for (const text of deepStrings(value)) {
    assert(
      !placeholder.test(text),
      'promotion evidence contains placeholder text',
    );
    assert(
      !/^0{40}$/u.test(text),
      'promotion evidence contains an all-zero commit',
    );
    assert(
      !/^0{64}$/u.test(text),
      'promotion evidence contains an all-zero digest',
    );
  }
}

function assertExactArray(actual, expected, message) {
  assert(Array.isArray(actual), `${message} must be an array`);
  assert(
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()),
    message,
  );
}

function expectedValidationArtifacts(version) {
  return [
    `linux-x64-${version}.json`,
    `linux-x64-${version}.sha256`,
    `macos-arm64-${version}.json`,
    `macos-arm64-${version}.sha256`,
    `macos-x64-${version}.json`,
    `macos-x64-${version}.sha256`,
    `windows-x64-${version}.json`,
    `windows-x64-${version}.sha256`,
  ];
}

function assertCommonPlan(plan, context) {
  assert(isObject(plan), 'release plan must be an object');
  assert(
    plan.schemaVersion === RELEASE_PLAN_SCHEMA_VERSION,
    `schemaVersion must be ${RELEASE_PLAN_SCHEMA_VERSION}`,
  );
  assert(plan.sourceRef === 'main', 'committed release sourceRef must be main');
  if (context.sourceRef) {
    assert(
      context.sourceRef === plan.sourceRef,
      'dispatch ref must match manifest sourceRef',
    );
  }
  assert(
    plan.acceptance?.binding === 'manifest-sha256+source-commit',
    'acceptance.binding must be manifest-sha256+source-commit',
  );
  assert(
    plan.authentication?.oauthWebAuthReady === false,
    'OAuth/WebAuth must remain explicitly not ready for this release',
  );
  assert(
    typeof plan.authentication?.releaseClaim === 'string' &&
      /not included/iu.test(plan.authentication.releaseClaim),
    'authentication.releaseClaim must explicitly say OAuth/WebAuth is not included',
  );
  assertExactArray(
    plan.githubArtifactBundles,
    EXPECTED_BUNDLES,
    'githubArtifactBundles do not match the release matrix',
  );
  assertExactArray(
    plan.validationArtifacts,
    expectedValidationArtifacts(plan.version),
    'validationArtifacts do not match validator output names',
  );
  if (context.expectedVersion) {
    assert(
      plan.version === context.expectedVersion,
      'release version mismatch',
    );
  }
  if (context.expectedTag) {
    assert(plan.tag === context.expectedTag, 'release tag mismatch');
  }
  if (context.packageVersion) {
    const packageVersion =
      plan.releaseKind === 'technical-preview'
        ? plan.version.split('-preview.')[0]
        : plan.version;
    assert(
      context.packageVersion === packageVersion,
      `apps/browser package version ${context.packageVersion} must equal release base ${packageVersion}`,
    );
  }
  if (context.changelog) {
    assert(
      new RegExp(
        `^## ${escapeRegex(plan.version)} \\(\\d{4}-\\d{2}-\\d{2}\\)$`,
        'mu',
      ).test(context.changelog),
      `CHANGELOG.md is missing an exact ${plan.version} heading`,
    );
  }
}

function assertDraftDistribution(plan, { access, canaryInstallations }) {
  assert(
    plan.distribution?.githubReleaseState === 'draft',
    'technical previews must be staged as draft GitHub Releases',
  );
  assert(
    plan.distribution?.protectedEnvironment === 'Release',
    'technical-preview distribution must use the protected Release environment',
  );
  assert(
    plan.distribution?.publicDownloadLinks === false,
    'technical previews must not expose public download links',
  );
  assert(
    plan.distribution?.access === access,
    `distribution.access must be ${access}`,
  );
  assert(
    plan.distribution?.canaryInstallations === canaryInstallations,
    `distribution.canaryInstallations must be ${canaryInstallations}`,
  );
}

function assertHistoricalManifestBinding(evidence, context) {
  assert(
    isObject(evidence.manifest),
    'promotion evidence manifest binding is missing',
  );
  assert(
    isNormalizedSubpath(evidence.manifest.path, '.release-notes'),
    'promotion evidence manifest path is invalid',
  );
  assert(
    isSha256(evidence.manifest.sha256),
    'promotion evidence manifest digest is invalid',
  );
  assert(
    isCommitSha(evidence.manifest.sourceCommit),
    'promotion evidence source commit is invalid',
  );
  assert(
    typeof context.loadManifestAtCommit === 'function',
    'historical manifest loader is required for promotion evidence',
  );
  const historicalManifestText = context.loadManifestAtCommit(
    evidence.manifest.sourceCommit,
    evidence.manifest.path,
  );
  assert(
    typeof historicalManifestText === 'string',
    'promotion evidence source manifest is unavailable',
  );
  assert(
    sha256Text(historicalManifestText) === evidence.manifest.sha256,
    'promotion evidence manifest digest does not match the committed source manifest',
  );
  let historicalPlan;
  try {
    historicalPlan = JSON.parse(historicalManifestText);
  } catch {
    fail('promotion evidence source manifest is invalid JSON');
  }
  assert(
    historicalPlan.schemaVersion === RELEASE_PLAN_SCHEMA_VERSION &&
      historicalPlan.releaseKind === 'technical-preview',
    'promotion evidence source manifest is not a schema-v2 technical preview',
  );
  validateReleasePlan(historicalPlan, { skipPromotionEvidence: true });
  assert(
    historicalPlan.version === evidence.release?.version &&
      historicalPlan.tag === evidence.release?.tag &&
      historicalPlan.promotionRole === evidence.release?.promotionRole,
    'promotion evidence release identity does not match its source manifest',
  );
  if (typeof context.isAncestorCommit === 'function') {
    assert(
      context.isAncestorCommit(evidence.manifest.sourceCommit),
      'promotion evidence source commit is not an ancestor of the candidate',
    );
  }
  if (typeof context.changedPathsSince === 'function') {
    const changedPaths = context.changedPathsSince(
      evidence.manifest.sourceCommit,
    );
    assert(
      Array.isArray(changedPaths),
      'unable to inspect candidate changes after accepted source commit',
    );
    const disallowed = changedPaths.filter(
      (changedPath) =>
        !PROMOTION_ONLY_PATHS.some(
          (allowedPath) =>
            (allowedPath.endsWith('/') &&
              changedPath.startsWith(allowedPath)) ||
            changedPath === allowedPath,
        ),
    );
    assert(
      disallowed.length === 0,
      `candidate changed product code after accepted source commit: ${disallowed.join(', ')}`,
    );
  }
}

function validatePromotionEvidence(evidence, expected, context, evidenceTrust) {
  assert(isObject(evidence), 'promotion evidence must be an object');
  assertNoPlaceholderEvidence(evidence);
  validateTrustedAcceptanceEvidence(evidence, {
    now: context.now instanceof Date ? context.now : new Date(),
  });
  assert(
    typeof context.verifyEvidenceTrust === 'function' &&
      context.verifyEvidenceTrust(evidence, evidenceTrust) === true,
    'promotion evidence lacks a verified protected-workflow attestation',
  );
  assert(
    evidence.schemaVersion === RELEASE_ACCEPTANCE_SCHEMA_VERSION,
    `promotion evidence schemaVersion must be ${RELEASE_ACCEPTANCE_SCHEMA_VERSION}`,
  );
  assert(
    evidence.evidenceKind === 'release-acceptance',
    'promotion evidence kind must be release-acceptance',
  );
  assert(
    typeof evidence.generatedAt === 'string' &&
      !Number.isNaN(new Date(evidence.generatedAt).getTime()),
    'promotion evidence generatedAt is invalid',
  );
  assert(
    evidence.status === expected.status,
    `promotion evidence status must be ${expected.status}`,
  );
  assert(
    Array.isArray(evidence.blockers) && evidence.blockers.length === 0,
    'promotion evidence must contain zero blockers',
  );
  assert(
    Array.isArray(evidence.checks) &&
      evidence.checks.every(
        (check) => isObject(check) && check.status === 'pass',
      ),
    'promotion evidence must contain only passing acceptance checks',
  );
  assertExactArray(
    evidence.checks.map((check) => check.id),
    REQUIRED_ACCEPTANCE_CHECK_IDS,
    'promotion evidence acceptance checks are incomplete or duplicated',
  );
  assert(
    evidence.release?.promotionRole === expected.promotionRole,
    `promotion evidence role must be ${expected.promotionRole}`,
  );
  assert(
    evidence.release?.channel === 'preview',
    'promotion evidence release channel must be preview',
  );
  assert(
    evidence.release?.version === expected.version &&
      evidence.release?.tag === expected.tag,
    'promotion evidence release version or tag is invalid',
  );
  assert(
    Number.isInteger(evidence.publication?.releaseId) &&
      evidence.publication.releaseId > 0,
    'promotion evidence must identify a real attested GitHub Release',
  );
  assert(
    evidence.publication.tag === evidence.release.tag &&
      evidence.publication.sourceCommit === evidence.manifest?.sourceCommit,
    'promotion evidence publication is not bound to the release source',
  );
  assertHistoricalManifestBinding(evidence, context);
  assert(
    evidence.rollback?.mode === 'distribution-stop-only',
    'promotion evidence rollback mode is invalid',
  );
  assert(
    evidence.canary?.targetObservationHours === 24,
    'promotion evidence canary observation target must be 24 hours',
  );

  if (expected.promotionRole === 'rollback-baseline') {
    assert(
      evidence.canary?.observedHours === null &&
        evidence.canary?.observedInstallations === null &&
        evidence.canary?.targetInstallations === 0 &&
        evidence.canary?.observationEvidence === null &&
        !Object.hasOwn(evidence.rollback, 'targetTag'),
      'rollback-baseline evidence must not claim a canary',
    );
  } else {
    assert(
      evidence.canary?.targetInstallations === 5 &&
        evidence.canary?.observedInstallations === 5 &&
        evidence.canary?.observedHours >= 24 &&
        typeof evidence.canary?.observationEvidence === 'object' &&
        evidence.canary.observationEvidence !== null &&
        Array.isArray(evidence.canary?.stopReasons) &&
        evidence.canary.stopReasons.length === 0 &&
        evidence.rollback?.targetTag ===
          `v${expected.version.split('-preview.')[0]}-preview.2`,
      'canary evidence must prove exactly-five scope and a complete observation window',
    );
  }
}

function loadRequiredPromotionEvidence(plan, expected, context) {
  const evidencePath = plan.promotionEvidence;
  assert(
    isNormalizedSubpath(evidencePath, '.release-evidence') &&
      evidencePath.endsWith('.json'),
    'promotionEvidence must reference a JSON file under .release-evidence/',
  );
  assert(
    typeof context.loadEvidence === 'function',
    'promotion evidence loader is required',
  );
  const loaded = context.loadEvidence(evidencePath);
  assert(
    isObject(loaded),
    `promotion evidence is unavailable: ${evidencePath}`,
  );
  assert(
    loaded.committed === true,
    `promotion evidence must be committed without worktree changes: ${evidencePath}`,
  );
  validatePromotionEvidence(loaded.value, expected, context, {
    path: evidencePath,
    sha256: loaded.sha256,
  });
  return loaded.value;
}

function validateTechnicalPreviewPlan(plan, context) {
  assert(
    plan.releaseKind === 'technical-preview',
    'releaseKind must be technical-preview',
  );
  assert(
    plan.channel === 'preview',
    'technical-preview channel must be preview',
  );
  assert(
    plan.buildChannel === 'prerelease',
    'technical-preview buildChannel must be prerelease',
  );
  const versionMatch =
    typeof plan.version === 'string'
      ? plan.version.match(TECHNICAL_PREVIEW_VERSION)
      : null;
  assert(versionMatch, 'version must match X.Y.Z-preview.N');
  assert(plan.tag === `v${plan.version}`, 'tag must equal v<version>');
  assert(
    plan.rollback?.mode === 'distribution-stop-only',
    'technical-preview rollback mode must be distribution-stop-only',
  );

  if (plan.promotionRole === 'rollback-baseline') {
    const previewNumber = Number.parseInt(versionMatch[2], 10);
    assert(
      previewNumber === 2,
      'the v1.16.0 release chain requires preview.2 as rollback baseline',
    );
    assertDraftDistribution(plan, {
      access: 'release-operators-only',
      canaryInstallations: 0,
    });
    assert(
      plan.acceptance?.requiredStatus === 'ready-as-rollback-baseline',
      'rollback-baseline acceptance status must be ready-as-rollback-baseline',
    );
    assert(
      !Object.hasOwn(plan.rollback, 'targetTag'),
      'rollback-baseline must not declare a rollback target tag',
    );
    assert(
      !Object.hasOwn(plan, 'promotionEvidence'),
      'rollback-baseline must not claim prerequisite promotion evidence',
    );
  } else if (plan.promotionRole === 'canary') {
    assertDraftDistribution(plan, {
      access: 'controlled-canary',
      canaryInstallations: 5,
    });
    assert(
      plan.acceptance?.entryStatus === 'ready-for-canary' &&
        plan.acceptance?.requiredStatus === 'ready-for-stable',
      'canary acceptance statuses must be ready-for-canary and ready-for-stable',
    );
    const previewNumber = Number.parseInt(versionMatch[2], 10);
    assert(
      previewNumber === 3,
      'the v1.16.0 release chain requires preview.3 as canary',
    );
    const expectedRollbackTag = `v${versionMatch[1]}-preview.2`;
    assert(
      plan.rollback?.targetTag === expectedRollbackTag,
      `canary rollback target must be ${expectedRollbackTag}`,
    );
    if (!context.skipPromotionEvidence) {
      const evidence = loadRequiredPromotionEvidence(
        plan,
        {
          promotionRole: 'rollback-baseline',
          status: 'ready-as-rollback-baseline',
          tag: expectedRollbackTag,
          version: `${versionMatch[1]}-preview.2`,
        },
        context,
      );
      if (context.requirePrerequisiteTag) {
        assert(
          typeof context.resolveTagCommit === 'function' &&
            context.resolveTagCommit(expectedRollbackTag) ===
              evidence.manifest.sourceCommit,
          `prerequisite tag ${expectedRollbackTag} must resolve to the accepted baseline commit`,
        );
      }
    }
  } else {
    fail('promotionRole must be rollback-baseline or canary');
  }
}

function validateStablePlan(plan, context) {
  assert(plan.releaseKind === 'stable', 'releaseKind must be stable');
  assert(plan.channel === 'release', 'stable channel must be release');
  assert(
    plan.buildChannel === 'release',
    'stable buildChannel must be release',
  );
  assert(
    typeof plan.version === 'string' && STABLE_VERSION.test(plan.version),
    'stable version must match X.Y.Z',
  );
  assert(
    plan.tag === `clodex@${plan.version}`,
    'stable tag must equal clodex@<version>',
  );
  assert(
    !Object.hasOwn(plan, 'promotionRole'),
    'stable plans must not claim a technical-preview promotionRole',
  );
  assert(
    plan.distribution?.githubReleaseState === 'draft' &&
      plan.distribution?.protectedEnvironment === 'Release' &&
      plan.distribution?.publicDownloadLinks === false,
    'stable distribution must remain a protected draft without public links until attested publication',
  );
  assert(
    plan.acceptance?.requiredStatus === 'ready-for-stable',
    'stable plans must require ready-for-stable canary evidence',
  );
  if (!context.skipPromotionEvidence) {
    const expectedCanaryTag = `v${plan.version}-preview.3`;
    const evidence = loadRequiredPromotionEvidence(
      plan,
      {
        promotionRole: 'canary',
        status: 'ready-for-stable',
        tag: expectedCanaryTag,
        version: `${plan.version}-preview.3`,
      },
      context,
    );
    if (context.requirePrerequisiteTag) {
      assert(
        typeof context.resolveTagCommit === 'function' &&
          context.resolveTagCommit(expectedCanaryTag) ===
            evidence.manifest.sourceCommit,
        `prerequisite tag ${expectedCanaryTag} must resolve to the accepted canary commit`,
      );
    }
  }
}

export function validateReleasePlan(plan, context = {}) {
  assertCommonPlan(plan, context);
  if (context.expectedKind) {
    assert(plan.releaseKind === context.expectedKind, 'release kind mismatch');
  }
  if (plan.releaseKind === 'technical-preview') {
    validateTechnicalPreviewPlan(plan, context);
  } else if (plan.releaseKind === 'stable') {
    validateStablePlan(plan, context);
  } else {
    fail('releaseKind must be technical-preview or stable');
  }
  return plan;
}

export function assertReleaseTagReusable({
  existingTagCommit,
  releaseRef,
  tag,
}) {
  assert(
    existingTagCommit === null || existingTagCommit === releaseRef,
    `target tag ${tag} points to ${existingTagCommit}, expected ${releaseRef}`,
  );
}

export function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function git(
  repositoryDirectory,
  args,
  { allowFailure = false, trim = true } = {},
) {
  try {
    const result = execFileSync('/usr/bin/git', args, {
      cwd: repositoryDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', allowFailure ? 'ignore' : 'pipe'],
    });
    return trim ? result.trim() : result;
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function resolveContainedPath(repositoryDirectory, relativePath, directory) {
  assert(typeof relativePath === 'string', 'release path must be a string');
  const root = path.join(repositoryDirectory, directory);
  const resolved = path.resolve(repositoryDirectory, relativePath);
  assert(
    resolved.startsWith(`${root}${path.sep}`),
    `release path must be stored under ${directory}/`,
  );
  return resolved;
}

function loadCommittedEvidence(repositoryDirectory, evidencePath) {
  const resolved = resolveContainedPath(
    repositoryDirectory,
    evidencePath,
    '.release-evidence',
  );
  if (!existsSync(resolved)) return null;
  const raw = readFileSync(resolved, 'utf8');
  const committedRaw = git(
    repositoryDirectory,
    ['show', `HEAD:${evidencePath}`],
    { allowFailure: true, trim: false },
  );
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(`promotion evidence is invalid JSON: ${evidencePath}`);
  }
  return {
    committed: committedRaw !== null && committedRaw === raw,
    sha256: sha256Text(raw),
    value,
  };
}

export function loadAndValidateReleasePlan({
  changelogPath = 'apps/browser/CHANGELOG.md',
  expectedKind,
  expectedTag,
  expectedVersion,
  manifest,
  packageJsonPath = 'apps/browser/package.json',
  repositoryDirectory,
  requireNewTag = false,
  requirePrerequisiteTag = false,
  sourceRef,
  verifyEvidenceTrust,
}) {
  const manifestPath = resolveContainedPath(
    repositoryDirectory,
    manifest,
    '.release-notes',
  );
  assert(existsSync(manifestPath), `manifest not found: ${manifest}`);
  const manifestText = readFileSync(manifestPath, 'utf8');
  let plan;
  try {
    plan = JSON.parse(manifestText);
  } catch {
    fail(`manifest is invalid JSON: ${manifest}`);
  }

  const packageJson = JSON.parse(
    readFileSync(path.join(repositoryDirectory, packageJsonPath), 'utf8'),
  );
  const changelog = readFileSync(
    path.join(repositoryDirectory, changelogPath),
    'utf8',
  );
  const releaseRef = git(repositoryDirectory, ['rev-parse', 'HEAD']);
  const resolveTagCommit = (tag) =>
    git(
      repositoryDirectory,
      ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`],
      {
        allowFailure: true,
      },
    );

  validateReleasePlan(plan, {
    changelog,
    changedPathsSince: (commit) => {
      const output = git(
        repositoryDirectory,
        ['diff', '--name-only', `${commit}..HEAD`],
        { allowFailure: true },
      );
      return output === null ? null : output.split('\n').filter(Boolean);
    },
    expectedKind,
    expectedTag,
    expectedVersion,
    isAncestorCommit: (commit) =>
      git(
        repositoryDirectory,
        ['merge-base', '--is-ancestor', commit, 'HEAD'],
        {
          allowFailure: true,
        },
      ) !== null,
    loadEvidence: (evidencePath) =>
      loadCommittedEvidence(repositoryDirectory, evidencePath),
    loadManifestAtCommit: (commit, historicalManifestPath) =>
      git(
        repositoryDirectory,
        ['show', `${commit}:${historicalManifestPath}`],
        { allowFailure: true, trim: false },
      ),
    packageVersion: packageJson.version,
    requirePrerequisiteTag,
    resolveTagCommit,
    sourceRef,
    verifyEvidenceTrust,
  });

  if (requireNewTag) {
    assertReleaseTagReusable({
      existingTagCommit: resolveTagCommit(plan.tag),
      releaseRef,
      tag: plan.tag,
    });
  }

  return {
    manifestPath: path.relative(repositoryDirectory, manifestPath),
    manifestSha256: sha256Text(manifestText),
    plan,
    releaseRef,
  };
}
