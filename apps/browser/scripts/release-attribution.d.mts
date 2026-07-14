export interface AttributionBlocker {
  code: string;
  message: string;
}

export interface AttributionEntry {
  kind: 'open_source' | 'commercial_asset';
  name: string;
  version: string;
  license: string;
  repository: string;
  publisher: string;
  licenseText: string;
  evidenceReferences?: string[];
}

export interface DependencyInventory {
  blockers: AttributionBlocker[];
  entries: AttributionEntry[];
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
export const NUCLEO_EVIDENCE_RELATIVE_PATH: string;
export const REQUIRED_ATTRIBUTION_PATHS: string[];

export function collectReleaseDependencyInventory(options: {
  appDirectory: string;
  repositoryDirectory: string;
  now?: Date;
  strict?: boolean;
}): DependencyInventory;

export function prepareReleaseAttributionBundle(options: {
  appDirectory: string;
  outputDirectory: string;
  releaseChannel?: string;
  repositoryDirectory: string;
  now?: Date;
}): {
  inventory: DependencyInventory;
  manifest: {
    blockerCount: number;
    dependencyCount: number;
    status: string;
  };
  outputDirectory: string;
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
  inventory: {
    entries: AttributionEntry[];
    status: string;
  };
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
};

export function writeFinalArtifactSbom(options: {
  applicationDirectory: string;
  appName: string;
  appVersion: string;
  arch: string;
  attribution: ReturnType<typeof inspectPackagedAttribution>;
  outputPath: string;
  platform: string;
  resourcesDirectory: string;
  timestamp?: Date;
}): Promise<{
  bytes: number;
  componentCount: number;
  electronNotices: Record<string, { path: string; sha256: string }>;
  nativePackageCount: number;
  path: string;
  sha256: string;
}>;

export function sha256FileSync(filePath: string): string;
