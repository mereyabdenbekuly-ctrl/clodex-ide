export interface AttributionBlocker {
  code: string;
  message: string;
}

export interface BundledArtifactRecord {
  archivePath?: string;
  bytes: number;
  location: 'application' | 'resources';
  path: string;
  role: string;
  sha256: string;
}

export interface BundledComponentSource {
  type: 'git-archive' | 'nuget-package';
  url: string;
  sha256: string;
  sourceReferences: string[];
  versionRef?: string;
  immutableRevision?: string;
  packageId?: string;
  version?: string;
  nugetSha512?: string;
  sourceRevision?: string;
  signatureEntrySha256?: string;
  materializedSymlinks?: Array<{ path: string; target: string }>;
}

export interface BundledComponentEvidenceFile {
  path: string;
  sha256: string;
  sourceReferences: string[];
}

export interface BundledEmbeddedDependency {
  name: string;
  version: string;
  license: string;
  publisher: string;
  repository: string;
  purl: string;
  packageSource: {
    registry: 'npm';
    tarball: string;
    integrity: string;
    sha256: string;
  };
  licenseEvidence: BundledComponentEvidenceFile & { packagePath: string };
  licenseText: string;
  bundleScope: 'embedded' | 'production-lock-only';
}

export interface BundledComponentEvidence {
  registryId: string;
  reviewStatus: string;
  source: BundledComponentSource;
  licenseEvidence: BundledComponentEvidenceFile;
  metadataEvidence?: BundledComponentEvidenceFile;
  noticeEvidence: {
    status: string;
    sourceArchiveInspectedSha256: string;
    sourceReferences: string[];
  };
  packagedArtifacts:
    | {
        mode: 'fixed-files';
        files: BundledArtifactRecord[];
        exclusiveFileMatch: {
          location: 'application' | 'resources';
          path: string;
          fileNamePattern: string;
        };
      }
    | {
        mode: 'generated-manifest';
        manifest: { location: 'resources'; path: string };
        artifactDirectory: { location: 'resources'; path: string };
        requiredFiles: Array<{ path: string; role: string }>;
        fixedFiles: BundledArtifactRecord[];
      };
  buildTransforms?: Array<{
    id: string;
    targetPath: string;
    beforeSha256: string;
    afterSha256: string;
    description: string;
  }>;
  embeddedDependencyLock?: BundledComponentEvidenceFile;
  embeddedDependencies?: BundledEmbeddedDependency[];
  redistributionReview: {
    status: string;
    legalConclusion: false;
    sourceReferences: string[];
    notes: string;
  };
  platforms: Array<'linux' | 'macos' | 'windows'>;
  architectures: Array<'arm64' | 'x64'>;
}

export interface BundledComponent {
  id: string;
  name: string;
  version: string;
  kind: 'bundled-source-build' | 'bundled-binary-archive';
  platforms: Array<'linux' | 'macos' | 'windows'>;
  architectures: Array<'arm64' | 'x64'>;
  publisher: string;
  repository: string;
  purl: string;
  license: string;
  reviewStatus: string;
  buildTransforms?: BundledComponentEvidence['buildTransforms'];
  embeddedDependencyLock?: BundledComponentEvidenceFile;
  embeddedDependencies?: BundledEmbeddedDependency[];
  embeddedDependencyLockText: string;
  source: BundledComponentSource;
  licenseEvidence: BundledComponentEvidenceFile;
  metadataEvidence?: BundledComponentEvidenceFile;
  noticeEvidence: BundledComponentEvidence['noticeEvidence'];
  packagedArtifacts: BundledComponentEvidence['packagedArtifacts'];
  redistributionReview: BundledComponentEvidence['redistributionReview'];
  licenseText: string;
  metadataText: string;
}

export interface AttributionEntry {
  kind:
    | 'open_source'
    | 'custom_license'
    | 'commercial_asset'
    | 'bundled_component';
  name: string;
  version: string;
  license: string;
  repository: string;
  publisher: string;
  purl?: string;
  licenseText: string;
  licenseEvidence?: {
    basis: string;
    licenseTextSha256: string;
    packageSource: {
      integrity: string;
      tarball: string;
    };
    registryIdentity: string;
    reviewStatus: string;
    sourceReferences: string[];
    sourceType: string;
  };
  bundledComponentEvidence?: BundledComponentEvidence;
  evidenceReferences?: string[];
}

export interface DependencyInventory {
  blockers: AttributionBlocker[];
  entries: AttributionEntry[];
  bundledComponents: {
    applicableCount: number;
    applicableEmbeddedDependencyCount: number;
    applicableProductionLockDependencyCount: number;
    embeddedDependencyCount: number;
    productionLockDependencyCount: number;
    entryCount: number;
    registryPath: string;
    status: string;
  };
  licenseOverrides: {
    appliedCount: number;
    entryCount: number;
    registryPath: string;
    status: string;
  };
  nucleo: {
    evidencePath: string;
    packageNames: string[];
    status: string;
  };
}

export class AttributionGateError extends Error {
  blockers: AttributionBlocker[];
}

export const ATTRIBUTION_DIRECTORY_NAME: string;
export const BUNDLED_COMPONENT_REGISTRY_RELATIVE_PATH: string;
export const LICENSE_OVERRIDE_REGISTRY_RELATIVE_PATH: string;
export const NUCLEO_EVIDENCE_RELATIVE_PATH: string;
export const PNPM_LOCK_RELATIVE_PATH: string;
export const REQUIRED_ATTRIBUTION_PATHS: string[];

export function collectReleaseDependencyInventory(options: {
  arch?: string;
  appDirectory: string;
  platform?: string;
  repositoryDirectory: string;
  now?: Date;
  strict?: boolean;
}): DependencyInventory;

export function prepareReleaseAttributionBundle(options: {
  arch?: string;
  appDirectory: string;
  outputDirectory: string;
  platform?: string;
  releaseChannel?: string;
  repositoryDirectory: string;
  now?: Date;
}): {
  inventory: DependencyInventory;
  manifest: {
    blockerCount: number;
    bundledComponentApplicableCount: number;
    bundledComponentApplicableEmbeddedDependencyCount: number;
    bundledComponentApplicableProductionLockDependencyCount: number;
    bundledComponentEmbeddedDependencyCount: number;
    bundledComponentProductionLockDependencyCount: number;
    bundledComponentEntryCount: number;
    bundledComponentStatus: string;
    dependencyCount: number;
    licenseOverrideAppliedCount: number;
    licenseOverrideEntryCount: number;
    licenseOverrideStatus: string;
    status: string;
  };
  outputDirectory: string;
};

export function loadBundledComponentRegistry(options: {
  arch?: string;
  platform?: string;
  registryPath: string;
  strict?: boolean;
}): {
  applicableComponents: BundledComponent[];
  applicableEmbeddedDependencyCount: number;
  applicableProductionLockDependencyCount: number;
  blockers: AttributionBlocker[];
  components: BundledComponent[];
  embeddedDependencyCount: number;
  productionLockDependencyCount: number;
  entryCount: number;
  registryPath: string;
  status: string;
};

export function inspectBundledComponentArtifacts(options: {
  applicationDirectory: string;
  component: BundledComponent;
  resourcesDirectory: string;
}): {
  componentId: string;
  files: Array<{
    bytes: number;
    location: string;
    path: string;
    role: string;
    sha256: string;
  }>;
  mode: string;
};

export function verifyBundledComponentSourceBytes(options: {
  bytes: Uint8Array;
  component: BundledComponent;
}): {
  bytes: number;
  sha256: string;
  sha512: string | null;
};

export function verifyBundledComponentFixedArtifactBytes(options: {
  artifact: BundledArtifactRecord;
  bytes: Uint8Array;
  component: BundledComponent;
}): {
  bytes: number;
  sha256: string;
};

export function verifyBundledEmbeddedDependencySourceBytes(options: {
  bytes: Uint8Array;
  componentId: string;
  dependency: BundledEmbeddedDependency;
}): {
  bytes: number;
  integrity: string;
  sha256: string;
};

export function writeLicenseUiJson(options: {
  appDirectory: string;
  outputPath: string;
  releaseChannel?: string;
  repositoryDirectory: string;
}): {
  blockers: AttributionBlocker[];
  entries: AttributionEntry[];
};

export function inspectPackagedAttribution(options: {
  attributionDirectory: string;
  requireReady?: boolean;
}): {
  attributionDirectory: string;
  dependencyCount: number;
  inventory: DependencyInventory & { status: string };
  manifest: Record<string, unknown>;
  manifestSha256: string;
  noticePaths: string[];
};

export function inspectElectronRuntimeNotices(applicationDirectory: string): {
  chromium: { path: string; sha256: string };
  electron: { path: string; sha256: string };
};

export function resolveElectronRuntimeNoticePaths(options: {
  appDirectory: string;
}): {
  chromium: string;
  electron: string;
  license: string;
  version: string;
};

export function writeFinalArtifactSbom(options: {
  applicationDirectory: string;
  appName: string;
  appVersion: string;
  arch: string;
  attribution: ReturnType<typeof inspectPackagedAttribution>;
  electronRuntime: {
    license: string;
    name: 'electron';
    version: string;
  };
  outputPath: string;
  platform: string;
  resourcesDirectory: string;
  timestamp?: Date;
}): Promise<{
  bytes: number;
  bundledArtifactCount: number;
  bundledComponentCount: number;
  bundledEmbeddedDependencyCount: number;
  componentCount: number;
  electronNotices: Record<string, { path: string; sha256: string }>;
  electronRuntime: {
    license: string;
    name: string;
    version: string;
  };
  nativePackageCount: number;
  path: string;
  sha256: string;
}>;

export function sha256FileSync(filePath: string): string;
