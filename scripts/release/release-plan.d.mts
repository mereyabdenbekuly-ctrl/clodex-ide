export type TechnicalPreviewPromotionRole = 'canary' | 'rollback-baseline';

export const REQUIRED_ACCEPTANCE_CHECK_IDS: readonly string[];

export interface TechnicalPreviewReleasePlan {
  acceptance: {
    binding: 'manifest-sha256+source-commit';
    entryStatus?: 'ready-for-canary';
    requiredStatus: 'ready-as-rollback-baseline' | 'ready-for-stable';
  };
  authentication: {
    oauthWebAuthReady: false;
    releaseClaim: string;
  };
  buildChannel: 'prerelease';
  channel: 'preview';
  distribution: {
    access: 'controlled-canary' | 'release-operators-only';
    githubReleaseState: 'draft';
    canaryInstallations: 0 | 5;
    protectedEnvironment: 'Release';
    publicDownloadLinks: false;
  };
  githubArtifactBundles: string[];
  promotionEvidence?: string;
  promotionRole: TechnicalPreviewPromotionRole;
  releaseKind: 'technical-preview';
  rollback: {
    mode: 'distribution-stop-only';
    targetTag?: string;
  };
  schemaVersion: 2;
  sourceRef: 'main';
  tag: string;
  validationArtifacts: string[];
  version: string;
}

export interface LoadedTechnicalPreviewReleasePlan {
  manifestPath: string;
  manifestSha256: string;
  plan: TechnicalPreviewReleasePlan;
  releaseRef: string;
}

export interface PromotionEvidenceTrust {
  path: string;
  sha256: string;
}

export function assertReleaseTagReusable(options: {
  existingTagCommit: null | string;
  releaseRef: string;
  tag: string;
}): void;

export function loadAndValidateReleasePlan(options: {
  changelogPath?: string;
  expectedKind?: 'stable' | 'technical-preview';
  expectedTag?: string;
  expectedVersion?: string;
  manifest: string;
  packageJsonPath?: string;
  repositoryDirectory: string;
  requireNewTag?: boolean;
  requirePrerequisiteTag?: boolean;
  sourceRef?: string;
  verifyEvidenceTrust?: (
    evidence: unknown,
    trust: PromotionEvidenceTrust,
  ) => boolean;
}): LoadedTechnicalPreviewReleasePlan;

export function sha256Text(value: string): string;

export function validateReleasePlan(
  plan: unknown,
  context?: Record<string, unknown>,
): unknown;
