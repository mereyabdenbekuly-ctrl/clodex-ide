import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const ATTRIBUTION_DIRECTORY_NAME = 'release-attribution';
export const NUCLEO_EVIDENCE_RELATIVE_PATH =
  'docs/provenance/NUCLEO_REDISTRIBUTION_EVIDENCE.json';
export const LICENSE_OVERRIDE_REGISTRY_RELATIVE_PATH =
  'docs/provenance/DEPENDENCY_LICENSE_OVERRIDES.json';
export const BUNDLED_COMPONENT_REGISTRY_RELATIVE_PATH =
  'docs/provenance/BUNDLED_COMPONENTS.json';
export const PNPM_LOCK_RELATIVE_PATH = 'pnpm-lock.yaml';

const REQUIRED_NOTICE_SOURCES = [
  { source: 'LICENSE', target: 'LICENSE' },
  { source: 'THIRD-PARTY-NOTICES.md', target: 'THIRD-PARTY-NOTICES.md' },
  { source: 'CLODEX_VS_UPSTREAM.md', target: 'CLODEX_VS_UPSTREAM.md' },
  { source: 'CONTRIBUTORS.md', target: 'CONTRIBUTORS.md' },
  {
    source: 'packages/karton/LICENSE.md',
    target: 'packages/karton/LICENSE.md',
  },
  {
    source: NUCLEO_EVIDENCE_RELATIVE_PATH,
    target: 'provenance/NUCLEO_REDISTRIBUTION_EVIDENCE.json',
  },
  {
    source: LICENSE_OVERRIDE_REGISTRY_RELATIVE_PATH,
    target: 'provenance/DEPENDENCY_LICENSE_OVERRIDES.json',
  },
  {
    source: BUNDLED_COMPONENT_REGISTRY_RELATIVE_PATH,
    target: 'provenance/BUNDLED_COMPONENTS.json',
  },
  {
    source:
      'docs/provenance/bundled-component-license-texts/vscode-eslint-3.0.10-MIT.txt',
    target:
      'provenance/bundled-component-license-texts/vscode-eslint-3.0.10-MIT.txt',
  },
  {
    source:
      'docs/provenance/bundled-component-license-texts/vcruntime-cefsharp-140-1.0.5-MIT.txt',
    target:
      'provenance/bundled-component-license-texts/vcruntime-cefsharp-140-1.0.5-MIT.txt',
  },
  {
    source:
      'docs/provenance/bundled-component-license-texts/eslint-bundle-ISC.txt',
    target: 'provenance/bundled-component-license-texts/eslint-bundle-ISC.txt',
  },
  {
    source:
      'docs/provenance/bundled-component-license-texts/vscode-languageserver-node-MIT.txt',
    target:
      'provenance/bundled-component-license-texts/vscode-languageserver-node-MIT.txt',
  },
  {
    source:
      'docs/provenance/bundled-component-license-texts/vscode-uri-3.0.8-MIT.txt',
    target:
      'provenance/bundled-component-license-texts/vscode-uri-3.0.8-MIT.txt',
  },
  {
    source:
      'docs/provenance/bundled-component-evidence/VCRuntime.CefSharp.140-1.0.5.nuspec',
    target:
      'provenance/bundled-component-evidence/VCRuntime.CefSharp.140-1.0.5.nuspec',
  },
  {
    source:
      'docs/provenance/bundled-component-evidence/vscode-eslint-3.0.10-server-package-lock.json',
    target:
      'provenance/bundled-component-evidence/vscode-eslint-3.0.10-server-package-lock.json',
  },
];

export const REQUIRED_ATTRIBUTION_PATHS = [
  ...REQUIRED_NOTICE_SOURCES.map(({ target }) => target),
  'dependency-licenses.json',
  'manifest.json',
];

const LICENSE_FILE_PATTERNS = [
  /^licen[cs]e(?:[-_.].*)?$/i,
  /^copying(?:\.[^.]+)?$/i,
  /^unlicense(?:\.[^.]+)?$/i,
];

const LICENSE_OVERRIDE_REVIEW_STATUS = 'ENGINEERING_REVIEWED';
const BUNDLED_COMPONENT_REVIEW_STATUS = 'ENGINEERING_REVIEWED';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_REVISION_PATTERN = /^[a-f0-9]{40}$/;

const BUILD_ONLY_PATTERNS = [
  /^@types\//,
  /^@electron-forge\//,
  /^@electron\//,
  /^@electron-internal\//,
  /^@esbuild\//,
  /^@storybook\//,
  /^@vueless\//,
  /^@typescript-eslint\//,
  /^@tanstack\/router-plugin$/,
  /^@tanstack\/react-router-devtools$/,
  /^@vitejs\//,
  /^@tailwindcss\/(postcss|vite)$/,
  /^@posthog\/cli$/,
  /^@playwright\/test$/,
  /^@clodex\/tailwindcss-color-modifiers$/,
  /^@clodex\/typescript-config$/,
  /^typescript$/,
  /^concurrently$/,
  /^cross-env$/,
  /^dotenv-cli$/,
  /^electron-devtools-installer$/,
  /^react-devtools-electron$/,
  /^storybook$/,
  /^drizzle-kit$/,
  /^electron$/,
  /^esbuild$/,
  /^postcss$/,
  /^vite$/,
  /^tailwindcss$/,
  /^tailwind-scrollbar$/,
  /^license-checker-rseidelsohn$/,
];

const UNKNOWN_LICENSE_PATTERN =
  /^(?:unknown|unlicensed|noassertion|none|n\/a|not specified)$/i;
const SPDX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

export class AttributionGateError extends Error {
  constructor(blockers) {
    super(
      `Release attribution gate is blocked:\n${blockers
        .map((blocker) => `- [${blocker.code}] ${blocker.message}`)
        .join('\n')}`,
    );
    this.name = 'AttributionGateError';
    this.blockers = blockers;
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `${label} is not readable JSON: ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256FileSync(filePath) {
  return sha256Bytes(readFileSync(filePath));
}

function normalizeReleasePlatform(platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return String(platform ?? '')
    .trim()
    .toLowerCase();
}

function normalizeReleaseArchitecture(arch) {
  if (arch === 'aarch64') return 'arm64';
  if (arch === 'x86_64') return 'x64';
  return String(arch ?? '')
    .trim()
    .toLowerCase();
}

function isCanonicalSha512Base64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={2}$/.test(value)) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === 64 && decoded.toString('base64') === value;
  } catch {
    return false;
  }
}

function isPublicHttpsReference(reference) {
  return typeof reference === 'string' && reference.startsWith('https://');
}

function bundledComponentEvidenceFile({
  blockers,
  componentId,
  evidence,
  label,
  registryDirectory,
}) {
  if (
    !evidence ||
    typeof evidence.path !== 'string' ||
    !evidence.path.trim() ||
    !SHA256_PATTERN.test(String(evidence.sha256 ?? '')) ||
    !Array.isArray(evidence.sourceReferences) ||
    evidence.sourceReferences.length === 0 ||
    evidence.sourceReferences.some(
      (reference) => !isPublicHttpsReference(reference),
    )
  ) {
    blockers.push({
      code: 'BUNDLED_COMPONENT_EVIDENCE_INVALID',
      message: `${componentId} ${label} evidence has an incomplete path, hash, or source reference.`,
    });
    return '';
  }

  let relativePath = '';
  try {
    relativePath = safeRelativePath(evidence.path);
  } catch (error) {
    blockers.push({
      code: 'BUNDLED_COMPONENT_EVIDENCE_PATH_UNSAFE',
      message: `${componentId} ${label} evidence path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
    });
    return '';
  }
  const evidencePath = path.join(registryDirectory, relativePath);
  if (!existsSync(evidencePath) || !statSync(evidencePath).isFile()) {
    blockers.push({
      code: 'BUNDLED_COMPONENT_EVIDENCE_MISSING',
      message: `${componentId} ${label} evidence is missing: ${evidencePath}.`,
    });
    return '';
  }
  const text = readFileSync(evidencePath, 'utf8');
  if (!text.trim()) {
    blockers.push({
      code: 'BUNDLED_COMPONENT_EVIDENCE_EMPTY',
      message: `${componentId} ${label} evidence is empty: ${evidencePath}.`,
    });
  }
  const actualHash = sha256FileSync(evidencePath);
  if (actualHash !== evidence.sha256) {
    blockers.push({
      code: 'BUNDLED_COMPONENT_EVIDENCE_HASH_MISMATCH',
      message: `${componentId} ${label} evidence hash ${actualHash} does not match ${evidence.sha256}.`,
    });
  }
  return text;
}

function bundledArtifactRecordBlockers(componentId, record) {
  const blockers = [];
  if (
    !record ||
    !['application', 'resources'].includes(record.location) ||
    typeof record.path !== 'string' ||
    !record.path.trim()
  ) {
    blockers.push({
      code: 'BUNDLED_COMPONENT_ARTIFACT_INVALID',
      message: `${componentId} contains an artifact with an invalid location or path.`,
    });
    return blockers;
  }
  try {
    safeRelativePath(record.path);
  } catch (error) {
    blockers.push({
      code: 'BUNDLED_COMPONENT_ARTIFACT_PATH_UNSAFE',
      message: `${componentId} artifact path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (
    !Number.isSafeInteger(record.bytes) ||
    record.bytes <= 0 ||
    !SHA256_PATTERN.test(String(record.sha256 ?? '')) ||
    typeof record.role !== 'string' ||
    !record.role.trim()
  ) {
    blockers.push({
      code: 'BUNDLED_COMPONENT_ARTIFACT_DIGEST_INVALID',
      message: `${componentId} artifact ${record.path || '<missing>'} needs an exact byte count, SHA-256, and role.`,
    });
  }
  if (record.archivePath !== undefined) {
    try {
      safeRelativePath(String(record.archivePath));
    } catch (error) {
      blockers.push({
        code: 'BUNDLED_COMPONENT_ARCHIVE_PATH_UNSAFE',
        message: `${componentId} archive path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return blockers;
}

function bundledComponentSourceBlockers(componentId, component) {
  const blockers = [];
  const source = component.source;
  if (
    !source ||
    !['git-archive', 'nuget-package'].includes(source.type) ||
    typeof source.url !== 'string' ||
    !source.url.startsWith('https://') ||
    !SHA256_PATTERN.test(String(source.sha256 ?? '')) ||
    !Array.isArray(source.sourceReferences) ||
    source.sourceReferences.length === 0 ||
    source.sourceReferences.some(
      (reference) => !isPublicHttpsReference(reference),
    )
  ) {
    blockers.push({
      code: 'BUNDLED_COMPONENT_SOURCE_INVALID',
      message: `${componentId} source must have an HTTPS URL, exact type, SHA-256, and public references.`,
    });
    return blockers;
  }

  if (source.type === 'git-archive') {
    if (
      !GIT_REVISION_PATTERN.test(String(source.immutableRevision ?? '')) ||
      typeof source.versionRef !== 'string' ||
      !source.versionRef.trim() ||
      !source.url.includes(source.immutableRevision) ||
      !source.sourceReferences.some((reference) =>
        reference.includes(source.immutableRevision),
      )
    ) {
      blockers.push({
        code: 'BUNDLED_COMPONENT_GIT_PIN_INVALID',
        message: `${componentId} Git archive must bind its version ref to an immutable 40-character revision in the download URL.`,
      });
    }
  } else {
    const packageId = String(source.packageId ?? '');
    const version = String(source.version ?? '');
    const expectedUrl = `https://api.nuget.org/v3-flatcontainer/${packageId.toLowerCase()}/${version.toLowerCase()}/${packageId.toLowerCase()}.${version.toLowerCase()}.nupkg`;
    if (
      packageId !== component.name ||
      version !== component.version ||
      source.url !== expectedUrl ||
      !isCanonicalSha512Base64(source.nugetSha512) ||
      !GIT_REVISION_PATTERN.test(String(source.sourceRevision ?? '')) ||
      !SHA256_PATTERN.test(String(source.signatureEntrySha256 ?? '')) ||
      !source.sourceReferences.some((reference) =>
        reference.includes(source.sourceRevision),
      )
    ) {
      blockers.push({
        code: 'BUNDLED_COMPONENT_NUGET_PIN_INVALID',
        message: `${componentId} NuGet source must bind the exact package/version URL, SHA-256, catalog SHA-512, source revision, and signature-entry hash.`,
      });
    }
  }
  return blockers;
}

function loadEmbeddedBundledDependencies({
  component,
  componentId,
  registryDirectory,
}) {
  const blockers = [];
  const lockText = bundledComponentEvidenceFile({
    blockers,
    componentId,
    evidence: component?.embeddedDependencyLock,
    label: 'embedded dependency lock',
    registryDirectory,
  });
  let lock = null;
  if (lockText) {
    try {
      lock = JSON.parse(lockText);
    } catch (error) {
      blockers.push({
        code: 'BUNDLED_COMPONENT_EMBEDDED_LOCK_INVALID',
        message: `${componentId} embedded dependency lock is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const lockByIdentity = new Map();
  if (!lock?.packages || typeof lock.packages !== 'object') {
    blockers.push({
      code: 'BUNDLED_COMPONENT_EMBEDDED_LOCK_PACKAGES_MISSING',
      message: `${componentId} embedded dependency lock has no packages map.`,
    });
  } else {
    for (const [packagePath, record] of Object.entries(lock.packages)) {
      if (
        !packagePath.startsWith('node_modules/') ||
        !record ||
        typeof record !== 'object' ||
        record.dev === true
      ) {
        continue;
      }
      const packageName = packagePath.slice('node_modules/'.length);
      const version = String(record.version ?? '').trim();
      if (packageName && version) {
        lockByIdentity.set(`${packageName}@${version}`, record);
      }
    }
  }

  if (
    !Array.isArray(component?.embeddedDependencies) ||
    component.embeddedDependencies.length === 0
  ) {
    blockers.push({
      code: 'BUNDLED_COMPONENT_EMBEDDED_DEPENDENCIES_MISSING',
      message: `${componentId} source bundle has no exact embedded dependency inventory.`,
    });
  }
  const dependencies = [];
  const seenIdentities = new Set();
  for (const dependency of component?.embeddedDependencies ?? []) {
    const name = String(dependency?.name ?? '').trim();
    const version = String(dependency?.version ?? '').trim();
    const identity = `${name}@${version}`;
    const recordBlockers = [];
    if (
      !name ||
      !version ||
      seenIdentities.has(identity) ||
      typeof dependency?.license !== 'string' ||
      !dependency.license.trim() ||
      UNKNOWN_LICENSE_PATTERN.test(dependency.license.trim()) ||
      typeof dependency?.publisher !== 'string' ||
      !dependency.publisher.trim() ||
      typeof dependency?.repository !== 'string' ||
      !dependency.repository.startsWith('https://') ||
      typeof dependency?.purl !== 'string' ||
      !dependency.purl.startsWith('pkg:npm/')
    ) {
      recordBlockers.push({
        code: 'BUNDLED_COMPONENT_EMBEDDED_DEPENDENCY_INVALID',
        message: `${componentId} embedded dependency has incomplete or duplicate metadata: ${identity}.`,
      });
    }
    seenIdentities.add(identity);
    const locked = lockByIdentity.get(identity);
    const packageSource = dependency?.packageSource;
    if (
      !locked ||
      packageSource?.registry !== 'npm' ||
      packageSource?.tarball !== locked.resolved ||
      packageSource?.integrity !== locked.integrity ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(
        String(packageSource?.integrity ?? ''),
      ) ||
      !SHA256_PATTERN.test(String(packageSource?.sha256 ?? ''))
    ) {
      recordBlockers.push({
        code: 'BUNDLED_COMPONENT_EMBEDDED_PACKAGE_SOURCE_INVALID',
        message: `${componentId} embedded dependency ${identity} is not bound to its exact archived npm lock record and SHA-256.`,
      });
    }
    const licenseText = bundledComponentEvidenceFile({
      blockers: recordBlockers,
      componentId: `${componentId}/${identity}`,
      evidence: dependency?.licenseEvidence,
      label: 'embedded dependency license',
      registryDirectory,
    });
    try {
      safeRelativePath(String(dependency?.licenseEvidence?.packagePath ?? ''));
    } catch (error) {
      recordBlockers.push({
        code: 'BUNDLED_COMPONENT_EMBEDDED_LICENSE_PATH_UNSAFE',
        message: `${componentId} embedded dependency ${identity} package license path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (
      typeof dependency?.licenseEvidence?.packagePath !== 'string' ||
      !dependency.licenseEvidence.packagePath.trim()
    ) {
      recordBlockers.push({
        code: 'BUNDLED_COMPONENT_EMBEDDED_LICENSE_PATH_MISSING',
        message: `${componentId} embedded dependency ${identity} has no exact package license path.`,
      });
    }
    blockers.push(...recordBlockers);
    if (recordBlockers.length === 0) {
      dependencies.push({
        ...dependency,
        license: dependency.license.trim(),
        licenseText,
      });
    }
  }
  const lockedIdentities = [...lockByIdentity.keys()].sort();
  const reviewedIdentities = [...seenIdentities].sort();
  if (JSON.stringify(lockedIdentities) !== JSON.stringify(reviewedIdentities)) {
    blockers.push({
      code: 'BUNDLED_COMPONENT_EMBEDDED_LOCK_COVERAGE_MISMATCH',
      message: `${componentId} embedded dependency inventory does not exactly cover its production lock: expected ${lockedIdentities.join(', ')}; got ${reviewedIdentities.join(', ')}.`,
    });
  }
  return { blockers, dependencies, lockText };
}

export function loadBundledComponentRegistry({
  arch = undefined,
  platform = undefined,
  registryPath,
  strict = false,
}) {
  const blockers = [];
  const components = [];
  if (!existsSync(registryPath) || !statSync(registryPath).isFile()) {
    blockers.push({
      code: 'BUNDLED_COMPONENT_REGISTRY_MISSING',
      message: `Reviewed bundled-component registry is missing: ${registryPath}.`,
    });
  } else {
    const registry = readJson(registryPath, 'Bundled component registry');
    if (registry.schemaVersion !== 1) {
      blockers.push({
        code: 'BUNDLED_COMPONENT_REGISTRY_SCHEMA_UNSUPPORTED',
        message: `Bundled component registry schemaVersion must be 1, got ${String(registry.schemaVersion ?? '<missing>')}.`,
      });
    }
    if (registry.status !== BUNDLED_COMPONENT_REVIEW_STATUS) {
      blockers.push({
        code: 'BUNDLED_COMPONENT_REGISTRY_UNREVIEWED',
        message: `Bundled component registry status must be ${BUNDLED_COMPONENT_REVIEW_STATUS}.`,
      });
    }
    if (registry.legalConclusion !== false) {
      blockers.push({
        code: 'BUNDLED_COMPONENT_REGISTRY_LEGAL_CLAIM_INVALID',
        message:
          'Bundled component registry must explicitly state legalConclusion=false.',
      });
    }
    if (!Array.isArray(registry.components)) {
      blockers.push({
        code: 'BUNDLED_COMPONENT_REGISTRY_COMPONENTS_INVALID',
        message: 'Bundled component registry components must be an array.',
      });
    }

    const registryDirectory = path.dirname(registryPath);
    const seenIds = new Set();
    const seenIdentities = new Set();
    for (const component of Array.isArray(registry.components)
      ? registry.components
      : []) {
      const componentBlockers = [];
      const componentId = String(component?.id ?? '').trim();
      const name = String(component?.name ?? '').trim();
      const version = String(component?.version ?? '').trim();
      const identity = `${name}@${version}`;
      if (!componentId || !name || !version) {
        componentBlockers.push({
          code: 'BUNDLED_COMPONENT_IDENTITY_INVALID',
          message: `Bundled component has an incomplete identity: ${componentId || '<missing-id>'}/${identity}.`,
        });
      }
      if (seenIds.has(componentId) || seenIdentities.has(identity)) {
        componentBlockers.push({
          code: 'BUNDLED_COMPONENT_DUPLICATE',
          message: `Bundled component registry duplicates ${componentId || identity}.`,
        });
      }
      seenIds.add(componentId);
      seenIdentities.add(identity);
      if (
        !['bundled-source-build', 'bundled-binary-archive'].includes(
          component?.kind,
        ) ||
        component?.reviewStatus !== BUNDLED_COMPONENT_REVIEW_STATUS ||
        typeof component?.license !== 'string' ||
        !component.license.trim() ||
        UNKNOWN_LICENSE_PATTERN.test(component.license.trim()) ||
        typeof component?.publisher !== 'string' ||
        !component.publisher.trim() ||
        typeof component?.repository !== 'string' ||
        !component.repository.startsWith('https://') ||
        typeof component?.purl !== 'string' ||
        !component.purl.startsWith('pkg:') ||
        !Array.isArray(component?.platforms) ||
        component.platforms.length === 0 ||
        component.platforms.some(
          (value) => !['linux', 'macos', 'windows'].includes(value),
        ) ||
        !Array.isArray(component?.architectures) ||
        component.architectures.length === 0 ||
        component.architectures.some(
          (value) => !['arm64', 'x64'].includes(value),
        )
      ) {
        componentBlockers.push({
          code: 'BUNDLED_COMPONENT_METADATA_INVALID',
          message: `${componentId || identity} has incomplete reviewed license, publisher, repository, platform, architecture, or kind metadata.`,
        });
      }
      componentBlockers.push(
        ...bundledComponentSourceBlockers(componentId || identity, component),
      );
      let embeddedDependencyLockText = '';
      let embeddedDependencies = [];
      if (component?.kind === 'bundled-source-build') {
        if (
          !Array.isArray(component.buildTransforms) ||
          component.buildTransforms.length === 0
        ) {
          componentBlockers.push({
            code: 'BUNDLED_COMPONENT_BUILD_TRANSFORMS_MISSING',
            message: `${componentId || identity} source build must record every local source transform.`,
          });
        }
        const transformIds = new Set();
        for (const transform of component.buildTransforms ?? []) {
          let targetPath = '';
          try {
            targetPath = safeRelativePath(String(transform?.targetPath ?? ''));
          } catch (error) {
            componentBlockers.push({
              code: 'BUNDLED_COMPONENT_BUILD_TRANSFORM_PATH_UNSAFE',
              message: `${componentId || identity} build transform path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
          if (
            typeof transform?.id !== 'string' ||
            !transform.id.trim() ||
            transformIds.has(transform.id) ||
            !targetPath ||
            !SHA256_PATTERN.test(String(transform?.beforeSha256 ?? '')) ||
            !SHA256_PATTERN.test(String(transform?.afterSha256 ?? '')) ||
            transform.beforeSha256 === transform.afterSha256 ||
            typeof transform?.description !== 'string' ||
            !transform.description.trim()
          ) {
            componentBlockers.push({
              code: 'BUNDLED_COMPONENT_BUILD_TRANSFORM_INVALID',
              message: `${componentId || identity} build transform is incomplete, duplicated, or not digest-bound: ${String(transform?.id ?? '<missing>')}.`,
            });
          }
          transformIds.add(transform?.id);
        }
        const embedded = loadEmbeddedBundledDependencies({
          component,
          componentId: componentId || identity,
          registryDirectory,
        });
        componentBlockers.push(...embedded.blockers);
        embeddedDependencyLockText = embedded.lockText;
        embeddedDependencies = embedded.dependencies;
      }
      const licenseText = bundledComponentEvidenceFile({
        blockers: componentBlockers,
        componentId: componentId || identity,
        evidence: component?.licenseEvidence,
        label: 'license',
        registryDirectory,
      });
      let metadataText = '';
      if (component?.kind === 'bundled-binary-archive') {
        metadataText = bundledComponentEvidenceFile({
          blockers: componentBlockers,
          componentId: componentId || identity,
          evidence: component?.metadataEvidence,
          label: 'package metadata',
          registryDirectory,
        });
      }
      if (
        !component?.noticeEvidence ||
        typeof component.noticeEvidence.status !== 'string' ||
        !component.noticeEvidence.status.trim() ||
        component.noticeEvidence.sourceArchiveInspectedSha256 !==
          component?.source?.sha256 ||
        !Array.isArray(component.noticeEvidence.sourceReferences) ||
        component.noticeEvidence.sourceReferences.length === 0 ||
        component.noticeEvidence.sourceReferences.some(
          (reference) => !isPublicHttpsReference(reference),
        )
      ) {
        componentBlockers.push({
          code: 'BUNDLED_COMPONENT_NOTICE_EVIDENCE_INVALID',
          message: `${componentId || identity} notice evidence is missing or is not bound to the exact source archive.`,
        });
      }
      if (
        !component?.redistributionReview ||
        !['CONDITIONAL_UPSTREAM_TERMS', 'UPSTREAM_LICENSE_RECORDED'].includes(
          component.redistributionReview.status,
        ) ||
        component.redistributionReview.legalConclusion !== false ||
        !Array.isArray(component.redistributionReview.sourceReferences) ||
        component.redistributionReview.sourceReferences.length === 0 ||
        component.redistributionReview.sourceReferences.some(
          (reference) => !isPublicHttpsReference(reference),
        ) ||
        typeof component.redistributionReview.notes !== 'string' ||
        !component.redistributionReview.notes.trim()
      ) {
        componentBlockers.push({
          code: 'BUNDLED_COMPONENT_REDISTRIBUTION_REVIEW_INVALID',
          message: `${componentId || identity} must retain a non-legal redistribution review status, notes, and upstream references.`,
        });
      }

      const packagedArtifacts = component?.packagedArtifacts;
      if (
        !packagedArtifacts ||
        !['fixed-files', 'generated-manifest'].includes(packagedArtifacts.mode)
      ) {
        componentBlockers.push({
          code: 'BUNDLED_COMPONENT_ARTIFACT_POLICY_INVALID',
          message: `${componentId || identity} has no supported packaged-artifact policy.`,
        });
      } else if (packagedArtifacts.mode === 'fixed-files') {
        if (
          !Array.isArray(packagedArtifacts.files) ||
          packagedArtifacts.files.length === 0
        ) {
          componentBlockers.push({
            code: 'BUNDLED_COMPONENT_ARTIFACTS_MISSING',
            message: `${componentId || identity} has no fixed packaged artifacts.`,
          });
        }
        const fixedArtifactPaths = new Set();
        const fixedArchivePaths = new Set();
        for (const record of packagedArtifacts.files ?? []) {
          componentBlockers.push(
            ...bundledArtifactRecordBlockers(componentId || identity, record),
          );
          if (typeof record?.archivePath !== 'string') {
            componentBlockers.push({
              code: 'BUNDLED_COMPONENT_ARCHIVE_PATH_MISSING',
              message: `${componentId || identity} fixed artifact ${record?.path || '<missing>'} has no exact archive path.`,
            });
          }
          const artifactIdentity = `${record?.location}\0${record?.path}`;
          if (
            fixedArtifactPaths.has(artifactIdentity) ||
            fixedArchivePaths.has(record?.archivePath)
          ) {
            componentBlockers.push({
              code: 'BUNDLED_COMPONENT_ARTIFACT_DUPLICATE',
              message: `${componentId || identity} duplicates fixed artifact or archive path ${record?.path || '<missing>'}.`,
            });
          }
          fixedArtifactPaths.add(artifactIdentity);
          fixedArchivePaths.add(record?.archivePath);
        }
        const exclusiveMatch = packagedArtifacts.exclusiveFileMatch;
        if (
          !exclusiveMatch ||
          !['application', 'resources'].includes(exclusiveMatch.location) ||
          typeof exclusiveMatch.path !== 'string' ||
          !exclusiveMatch.path.trim() ||
          typeof exclusiveMatch.fileNamePattern !== 'string' ||
          !exclusiveMatch.fileNamePattern.startsWith('^') ||
          !exclusiveMatch.fileNamePattern.endsWith('$')
        ) {
          componentBlockers.push({
            code: 'BUNDLED_COMPONENT_EXCLUSIVE_MATCH_INVALID',
            message: `${componentId || identity} fixed binary policy needs an anchored exclusive file-name match.`,
          });
        } else {
          try {
            safeRelativePath(exclusiveMatch.path);
            new RegExp(exclusiveMatch.fileNamePattern);
          } catch (error) {
            componentBlockers.push({
              code: 'BUNDLED_COMPONENT_EXCLUSIVE_MATCH_UNSAFE',
              message: `${componentId || identity} exclusive file match is invalid: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
      } else {
        for (const locationRecord of [
          packagedArtifacts.manifest,
          packagedArtifacts.artifactDirectory,
        ]) {
          if (
            !locationRecord ||
            locationRecord.location !== 'resources' ||
            typeof locationRecord.path !== 'string' ||
            !locationRecord.path.trim()
          ) {
            componentBlockers.push({
              code: 'BUNDLED_COMPONENT_GENERATED_PATH_INVALID',
              message: `${componentId || identity} generated bundle needs resource-relative manifest and artifact-directory paths.`,
            });
            continue;
          }
          try {
            safeRelativePath(locationRecord.path);
          } catch (error) {
            componentBlockers.push({
              code: 'BUNDLED_COMPONENT_GENERATED_PATH_UNSAFE',
              message: `${componentId || identity} generated path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
        if (
          !Array.isArray(packagedArtifacts.fixedFiles) ||
          packagedArtifacts.fixedFiles.length === 0
        ) {
          componentBlockers.push({
            code: 'BUNDLED_COMPONENT_FIXED_EVIDENCE_MISSING',
            message: `${componentId || identity} generated bundle must ship at least one fixed license/notice file.`,
          });
        }
        if (
          !Array.isArray(packagedArtifacts.requiredFiles) ||
          packagedArtifacts.requiredFiles.length === 0
        ) {
          componentBlockers.push({
            code: 'BUNDLED_COMPONENT_GENERATED_FILES_MISSING',
            message: `${componentId || identity} generated bundle must name every required output file and role.`,
          });
        }
        const generatedRequiredPaths = new Set();
        for (const record of packagedArtifacts.requiredFiles ?? []) {
          let relativePath = '';
          try {
            relativePath = safeRelativePath(String(record?.path ?? ''));
          } catch (error) {
            componentBlockers.push({
              code: 'BUNDLED_COMPONENT_GENERATED_FILE_PATH_UNSAFE',
              message: `${componentId || identity} generated file path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
          if (
            !relativePath ||
            typeof record?.role !== 'string' ||
            !record.role.trim() ||
            generatedRequiredPaths.has(relativePath)
          ) {
            componentBlockers.push({
              code: 'BUNDLED_COMPONENT_GENERATED_FILE_INVALID',
              message: `${componentId || identity} generated file record is incomplete or duplicated: ${relativePath || '<missing>'}.`,
            });
          }
          generatedRequiredPaths.add(relativePath);
        }
        const generatedFixedPaths = new Set();
        for (const record of packagedArtifacts.fixedFiles ?? []) {
          componentBlockers.push(
            ...bundledArtifactRecordBlockers(componentId || identity, record),
          );
          const artifactIdentity = `${record?.location}\0${record?.path}`;
          if (generatedFixedPaths.has(artifactIdentity)) {
            componentBlockers.push({
              code: 'BUNDLED_COMPONENT_ARTIFACT_DUPLICATE',
              message: `${componentId || identity} duplicates generated fixed artifact ${record?.path || '<missing>'}.`,
            });
          }
          generatedFixedPaths.add(artifactIdentity);
        }
      }

      blockers.push(...componentBlockers);
      if (componentBlockers.length === 0) {
        components.push({
          ...component,
          license: component.license.trim(),
          licenseText,
          metadataText,
          embeddedDependencyLockText,
          embeddedDependencies,
        });
      }
    }
  }

  const normalizedPlatform = normalizeReleasePlatform(platform);
  const normalizedArch = normalizeReleaseArchitecture(arch);
  const applicableComponents = components.filter(
    (component) =>
      (!normalizedPlatform ||
        component.platforms.includes(normalizedPlatform)) &&
      (!normalizedArch || component.architectures.includes(normalizedArch)),
  );
  const deduplicatedBlockers = [
    ...new Map(
      blockers.map((blocker) => [
        `${blocker.code}\0${blocker.message}`,
        blocker,
      ]),
    ).values(),
  ].sort((left, right) =>
    `${left.code}:${left.message}`.localeCompare(
      `${right.code}:${right.message}`,
    ),
  );
  if (strict && deduplicatedBlockers.length > 0) {
    throw new AttributionGateError(deduplicatedBlockers);
  }
  return {
    applicableComponents,
    applicableEmbeddedDependencyCount: applicableComponents.reduce(
      (count, component) =>
        count + (component.embeddedDependencies?.length ?? 0),
      0,
    ),
    blockers: deduplicatedBlockers,
    components,
    embeddedDependencyCount: components.reduce(
      (count, component) =>
        count + (component.embeddedDependencies?.length ?? 0),
      0,
    ),
    entryCount: components.length,
    registryPath,
    status:
      deduplicatedBlockers.length === 0
        ? BUNDLED_COMPONENT_REVIEW_STATUS
        : 'BLOCKED',
  };
}

async function sha256File(filePath) {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export function verifyBundledComponentSourceBytes({ component, bytes }) {
  const sourceBytes = Buffer.from(bytes);
  const actualSha256 = sha256Bytes(sourceBytes);
  if (actualSha256 !== component.source.sha256) {
    throw new Error(
      `${component.id} source archive hash mismatch: ${actualSha256} != ${component.source.sha256}`,
    );
  }
  let actualSha512 = null;
  if (component.source.type === 'nuget-package') {
    actualSha512 = createHash('sha512').update(sourceBytes).digest('base64');
    if (actualSha512 !== component.source.nugetSha512) {
      throw new Error(
        `${component.id} NuGet catalog SHA-512 mismatch: ${actualSha512} != ${component.source.nugetSha512}`,
      );
    }
  }
  return {
    bytes: sourceBytes.byteLength,
    sha256: actualSha256,
    sha512: actualSha512,
  };
}

export function verifyBundledComponentFixedArtifactBytes({
  artifact,
  bytes,
  component,
}) {
  const artifactBytes = Buffer.from(bytes);
  const actualHash = sha256Bytes(artifactBytes);
  if (
    artifactBytes.byteLength !== artifact.bytes ||
    actualHash !== artifact.sha256
  ) {
    throw new Error(
      `${component.id} fixed artifact drift for ${artifact.path}: ${artifactBytes.byteLength} bytes/${actualHash} != ${artifact.bytes} bytes/${artifact.sha256}`,
    );
  }
  return {
    bytes: artifactBytes.byteLength,
    sha256: actualHash,
  };
}

export function verifyBundledEmbeddedDependencySourceBytes({
  componentId,
  dependency,
  bytes,
}) {
  const packageBytes = Buffer.from(bytes);
  const actualSha256 = sha256Bytes(packageBytes);
  const actualIntegrity = `sha512-${createHash('sha512')
    .update(packageBytes)
    .digest('base64')}`;
  if (
    actualSha256 !== dependency.packageSource.sha256 ||
    actualIntegrity !== dependency.packageSource.integrity
  ) {
    throw new Error(
      `${componentId} embedded package source drift for ${dependency.name}@${dependency.version}: SHA-256 ${actualSha256}, integrity ${actualIntegrity}`,
    );
  }
  return {
    bytes: packageBytes.byteLength,
    integrity: actualIntegrity,
    sha256: actualSha256,
  };
}

function isBuildOnly(packageName) {
  return BUILD_ONLY_PATTERNS.some((pattern) => pattern.test(packageName));
}

function isNucleoPackage(packageName) {
  return packageName.startsWith('nucleo-');
}

function canonicalNpmTarballUrl(packageName, version) {
  const unscopedName = packageName.includes('/')
    ? packageName.slice(packageName.lastIndexOf('/') + 1)
    : packageName;
  return `https://registry.npmjs.org/${packageName}/-/${unscopedName}-${version}.tgz`;
}

function loadPnpmLockPackageSources(repositoryDirectory) {
  const lockPath = path.join(repositoryDirectory, PNPM_LOCK_RELATIVE_PATH);
  if (!existsSync(lockPath) || !statSync(lockPath).isFile()) {
    return {
      byIdentity: new Map(),
      error: `Exact package provenance lock is missing: ${lockPath}`,
      lockPath,
    };
  }

  let lock;
  try {
    lock = parseYaml(readFileSync(lockPath, 'utf8'));
  } catch (error) {
    return {
      byIdentity: new Map(),
      error: `Exact package provenance lock is unreadable: ${lockPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      lockPath,
    };
  }
  if (!lock?.packages || typeof lock.packages !== 'object') {
    return {
      byIdentity: new Map(),
      error: `Exact package provenance lock has no packages map: ${lockPath}`,
      lockPath,
    };
  }

  const byIdentity = new Map();
  for (const [rawIdentity, record] of Object.entries(lock.packages)) {
    const identity = String(rawIdentity).replace(/^\//, '');
    if (!identity || !record || typeof record !== 'object') continue;
    const resolution = record.resolution;
    if (!resolution || typeof resolution !== 'object') continue;
    byIdentity.set(identity, {
      integrity:
        typeof resolution.integrity === 'string'
          ? resolution.integrity.trim()
          : '',
      tarball:
        typeof resolution.tarball === 'string' ? resolution.tarball.trim() : '',
    });
  }
  return { byIdentity, error: null, lockPath };
}

function validateLicenseOverridePackageSource({
  identity,
  lockPackageSources,
  override,
}) {
  const blockers = [];
  const source = override.packageSource;
  if (!source || source.registry !== 'npm') {
    blockers.push({
      code: 'LICENSE_OVERRIDE_PACKAGE_REGISTRY_INVALID',
      message: `${identity} override package source must name the npm registry.`,
    });
    return blockers;
  }
  if (lockPackageSources.error) {
    blockers.push({
      code: 'LICENSE_OVERRIDE_LOCK_UNAVAILABLE',
      message: `${identity} override cannot be bound to the install lock: ${lockPackageSources.error}`,
    });
    return blockers;
  }

  const locked = lockPackageSources.byIdentity.get(identity);
  if (!locked) {
    blockers.push({
      code: 'LICENSE_OVERRIDE_LOCK_ENTRY_MISSING',
      message: `${identity} override has no exact package entry in ${PNPM_LOCK_RELATIVE_PATH}.`,
    });
    return blockers;
  }
  if (!locked.integrity) {
    blockers.push({
      code: 'LICENSE_OVERRIDE_LOCK_INTEGRITY_MISSING',
      message: `${identity} lock entry has no integrity value.`,
    });
  } else if (source.integrity !== locked.integrity) {
    blockers.push({
      code: 'LICENSE_OVERRIDE_PACKAGE_INTEGRITY_MISMATCH',
      message: `${identity} override integrity does not match ${PNPM_LOCK_RELATIVE_PATH}.`,
    });
  }

  const expectedTarball =
    locked.tarball ||
    canonicalNpmTarballUrl(String(override.package), String(override.version));
  if (source.tarball !== expectedTarball) {
    blockers.push({
      code: 'LICENSE_OVERRIDE_PACKAGE_TARBALL_MISMATCH',
      message: `${identity} override tarball does not match the exact locked npm package source.`,
    });
  }
  return blockers;
}

function loadExactDependencyRemovalOverrides(repositoryDirectory) {
  const rootManifestPath = path.join(repositoryDirectory, 'package.json');
  if (!existsSync(rootManifestPath)) return new Set();

  const rootManifest = readJson(rootManifestPath, 'Repository package');
  const overrides = rootManifest.pnpm?.overrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return new Set();
  }

  return new Set(
    Object.entries(overrides)
      .filter(([, replacement]) => replacement === '-')
      .map(([selector]) => selector),
  );
}

function isDependencyExplicitlyRemoved({
  dependencyName,
  exactRemovalOverrides,
  requesterManifestPath,
}) {
  if (exactRemovalOverrides.size === 0) return false;

  const requesterManifest = readJson(
    requesterManifestPath,
    'Dependency requester package',
  );
  const requesterName = String(requesterManifest.name ?? '');
  const requesterVersion = String(requesterManifest.version ?? '');
  if (!requesterName || !requesterVersion) return false;

  return exactRemovalOverrides.has(
    `${requesterName}@${requesterVersion}>${dependencyName}`,
  );
}

function normalizeLicense(packageJson) {
  if (typeof packageJson.license === 'string') {
    return packageJson.license.trim();
  }
  if (Array.isArray(packageJson.licenses)) {
    const values = packageJson.licenses
      .map((entry) => (typeof entry === 'string' ? entry : (entry?.type ?? '')))
      .map((value) => String(value).trim())
      .filter(Boolean);
    return values.join(' OR ');
  }
  return '';
}

function normalizeRepository(repository) {
  const raw =
    typeof repository === 'string' ? repository : (repository?.url ?? '');
  return String(raw)
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '');
}

function normalizePublisher(author) {
  if (typeof author === 'string') return author.replace(/<[^>]+>/, '').trim();
  return String(author?.name ?? '').trim();
}

function readLicenseText(packageDirectory, repositoryDirectory, license) {
  const entries = readdirSync(packageDirectory, { withFileTypes: true });
  const licenseFile = entries.find(
    (entry) =>
      entry.isFile() && LICENSE_FILE_PATTERNS.some((p) => p.test(entry.name)),
  );
  if (licenseFile) {
    return readFileSync(path.join(packageDirectory, licenseFile.name), 'utf8');
  }

  if (
    license === 'AGPL-3.0-only' &&
    path
      .resolve(packageDirectory)
      .startsWith(`${path.resolve(repositoryDirectory)}${path.sep}`)
  ) {
    return readFileSync(path.join(repositoryDirectory, 'LICENSE'), 'utf8');
  }
  return '';
}

function loadLicenseOverrideRegistry(repositoryDirectory) {
  const registryPath = path.join(
    repositoryDirectory,
    LICENSE_OVERRIDE_REGISTRY_RELATIVE_PATH,
  );
  const blockers = [];
  const byIdentity = new Map();
  if (!existsSync(registryPath) || !statSync(registryPath).isFile()) {
    blockers.push({
      code: 'LICENSE_OVERRIDE_REGISTRY_MISSING',
      message: `Reviewed dependency-license override registry is missing: ${registryPath}`,
    });
    return {
      blockers,
      byIdentity,
      entryCount: 0,
      registryPath,
      status: 'MISSING',
    };
  }

  const registry = readJson(
    registryPath,
    'Dependency license override registry',
  );
  if (registry.schemaVersion !== 1) {
    blockers.push({
      code: 'LICENSE_OVERRIDE_REGISTRY_SCHEMA_UNSUPPORTED',
      message: `Dependency license override registry schemaVersion must be 1, got ${String(registry.schemaVersion ?? '<missing>')}.`,
    });
  }
  if (registry.status !== LICENSE_OVERRIDE_REVIEW_STATUS) {
    blockers.push({
      code: 'LICENSE_OVERRIDE_REGISTRY_UNREVIEWED',
      message: `Dependency license override registry status must be ${LICENSE_OVERRIDE_REVIEW_STATUS}.`,
    });
  }
  if (!Array.isArray(registry.entries)) {
    blockers.push({
      code: 'LICENSE_OVERRIDE_REGISTRY_ENTRIES_INVALID',
      message: 'Dependency license override registry entries must be an array.',
    });
  }

  for (const record of Array.isArray(registry.entries)
    ? registry.entries
    : []) {
    const packageName = String(record?.package ?? '').trim();
    const version = String(record?.version ?? '').trim();
    const identity = `${packageName}@${version}`;
    const source = record?.licenseTextSource;
    const recordBlockers = [];
    if (!packageName || !version) {
      recordBlockers.push({
        code: 'LICENSE_OVERRIDE_IDENTITY_INVALID',
        message: `A reviewed license override has an incomplete identity: ${identity}.`,
      });
    }
    if (byIdentity.has(identity)) {
      recordBlockers.push({
        code: 'LICENSE_OVERRIDE_DUPLICATE',
        message: `Dependency license override registry contains duplicate ${identity}.`,
      });
    }
    if (record?.reviewStatus !== LICENSE_OVERRIDE_REVIEW_STATUS) {
      recordBlockers.push({
        code: 'LICENSE_OVERRIDE_UNREVIEWED',
        message: `${identity} override is not ${LICENSE_OVERRIDE_REVIEW_STATUS}.`,
      });
    }
    if (
      typeof record?.license !== 'string' ||
      !record.license.trim() ||
      UNKNOWN_LICENSE_PATTERN.test(record.license.trim())
    ) {
      recordBlockers.push({
        code: 'LICENSE_OVERRIDE_LICENSE_INVALID',
        message: `${identity} override has a missing or Unknown license.`,
      });
    }
    if (typeof record?.basis !== 'string' || !record.basis.trim()) {
      recordBlockers.push({
        code: 'LICENSE_OVERRIDE_BASIS_MISSING',
        message: `${identity} override has no review basis.`,
      });
    }
    if (
      !source ||
      !['package-file', 'repository-file'].includes(source.type) ||
      typeof source.path !== 'string' ||
      !source.path.trim() ||
      !/^[a-f0-9]{64}$/.test(String(source.sha256 ?? '')) ||
      !Array.isArray(source.sourceReferences) ||
      source.sourceReferences.length === 0 ||
      source.sourceReferences.some(
        (reference) => typeof reference !== 'string' || !reference.trim(),
      )
    ) {
      recordBlockers.push({
        code: 'LICENSE_OVERRIDE_SOURCE_INVALID',
        message: `${identity} override has incomplete source path, hash, type, or references.`,
      });
    }
    if (
      record?.packageSource?.registry !== 'npm' ||
      typeof record?.packageSource?.tarball !== 'string' ||
      !record.packageSource.tarball.trim() ||
      typeof record?.packageSource?.integrity !== 'string' ||
      !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(
        record.packageSource.integrity.trim(),
      )
    ) {
      recordBlockers.push({
        code: 'LICENSE_OVERRIDE_PACKAGE_SOURCE_INVALID',
        message: `${identity} override has no exact npm registry, tarball, or SRI provenance.`,
      });
    }

    let licenseText = '';
    if (source?.type === 'repository-file' && typeof source.path === 'string') {
      let relativePath = '';
      try {
        relativePath = safeRelativePath(source.path);
      } catch (error) {
        recordBlockers.push({
          code: 'LICENSE_OVERRIDE_SOURCE_PATH_UNSAFE',
          message: `${identity} override source path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (relativePath) {
        const sourcePath = path.join(repositoryDirectory, relativePath);
        if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
          recordBlockers.push({
            code: 'LICENSE_OVERRIDE_SOURCE_MISSING',
            message: `${identity} reviewed license text is missing: ${sourcePath}.`,
          });
        } else {
          licenseText = readFileSync(sourcePath, 'utf8');
          if (!licenseText.trim()) {
            recordBlockers.push({
              code: 'LICENSE_OVERRIDE_SOURCE_EMPTY',
              message: `${identity} reviewed license text is empty: ${sourcePath}.`,
            });
          }
          const actualHash = sha256FileSync(sourcePath);
          if (actualHash !== source.sha256) {
            recordBlockers.push({
              code: 'LICENSE_OVERRIDE_SOURCE_HASH_MISMATCH',
              message: `${identity} reviewed license text hash ${actualHash} does not match ${source.sha256}.`,
            });
          }
        }
      }
    }

    blockers.push(...recordBlockers);
    if (recordBlockers.length === 0) {
      byIdentity.set(identity, {
        ...record,
        license: record.license.trim(),
        licenseText,
      });
    }
  }

  return {
    blockers,
    byIdentity,
    entryCount: Array.isArray(registry.entries) ? registry.entries.length : 0,
    registryPath,
    status: registry.status ?? 'UNKNOWN',
  };
}

function applyLicenseOverride({
  declaredLicense,
  existingLicenseText,
  identity,
  lockPackageSources,
  override,
  packageDirectory,
}) {
  if (!override) {
    return {
      blockers: [],
      evidence: undefined,
      license: declaredLicense,
      licenseText: existingLicenseText,
    };
  }
  const needsLicense =
    !declaredLicense || UNKNOWN_LICENSE_PATTERN.test(declaredLicense);
  const needsLicenseText = !existingLicenseText.trim();
  if (!needsLicense && !needsLicenseText) {
    return {
      blockers: [],
      evidence: undefined,
      license: declaredLicense,
      licenseText: existingLicenseText,
    };
  }

  const blockers = [];
  blockers.push(
    ...validateLicenseOverridePackageSource({
      identity,
      lockPackageSources,
      override,
    }),
  );
  if (
    declaredLicense &&
    !needsLicense &&
    declaredLicense !== override.license
  ) {
    blockers.push({
      code: 'LICENSE_OVERRIDE_CONFLICT',
      message: `${identity} declares ${declaredLicense}, but its reviewed override declares ${override.license}.`,
    });
  }

  let overrideText = override.licenseText;
  if (override.licenseTextSource.type === 'package-file') {
    let relativePath = '';
    try {
      relativePath = safeRelativePath(override.licenseTextSource.path);
    } catch (error) {
      blockers.push({
        code: 'LICENSE_OVERRIDE_PACKAGE_PATH_UNSAFE',
        message: `${identity} package license path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (relativePath) {
      const sourcePath = path.join(packageDirectory, relativePath);
      if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
        blockers.push({
          code: 'LICENSE_OVERRIDE_PACKAGE_FILE_MISSING',
          message: `${identity} exact package license file is missing: ${sourcePath}.`,
        });
      } else {
        overrideText = readFileSync(sourcePath, 'utf8');
        const actualHash = sha256FileSync(sourcePath);
        if (actualHash !== override.licenseTextSource.sha256) {
          blockers.push({
            code: 'LICENSE_OVERRIDE_PACKAGE_FILE_HASH_MISMATCH',
            message: `${identity} package license hash ${actualHash} does not match ${override.licenseTextSource.sha256}.`,
          });
        }
      }
    }
  }
  if (!overrideText.trim()) {
    blockers.push({
      code: 'LICENSE_OVERRIDE_TEXT_EMPTY',
      message: `${identity} reviewed override produced no distributable license text.`,
    });
  }

  const licenseText = needsLicenseText ? overrideText : existingLicenseText;
  const selectedTextHash = sha256Bytes(licenseText);
  if (selectedTextHash !== override.licenseTextSource.sha256) {
    blockers.push({
      code: 'LICENSE_OVERRIDE_SELECTED_TEXT_HASH_MISMATCH',
      message: `${identity} selected license text hash ${selectedTextHash} does not match ${override.licenseTextSource.sha256}.`,
    });
  }

  if (blockers.length > 0) {
    return {
      blockers,
      evidence: undefined,
      license: declaredLicense,
      licenseText: existingLicenseText,
    };
  }

  return {
    blockers,
    evidence: {
      basis: override.basis,
      licenseTextSha256: sha256Bytes(licenseText),
      packageSource: {
        integrity: override.packageSource.integrity,
        tarball: override.packageSource.tarball,
      },
      registryIdentity: identity,
      reviewStatus: override.reviewStatus,
      sourceReferences: [...override.licenseTextSource.sourceReferences],
      sourceType: override.licenseTextSource.type,
    },
    license: needsLicense ? override.license : declaredLicense,
    licenseText,
  };
}

function walkToPackageManifest(entryPath, expectedName) {
  let current = statSync(entryPath).isDirectory()
    ? entryPath
    : path.dirname(entryPath);
  while (current !== path.dirname(current)) {
    const manifestPath = path.join(current, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = readJson(manifestPath, `Package ${expectedName}`);
      if (manifest.name === expectedName) return manifestPath;
    }
    current = path.dirname(current);
  }
  return null;
}

function resolvePackageManifest(requesterManifestPath, packageName) {
  const requesterDirectory = path.dirname(requesterManifestPath);
  const resolver = createRequire(
    path.join(requesterDirectory, '__clodex_resolver.cjs'),
  );

  // Do not rely on `packageName/package.json`: modern packages commonly hide
  // package.json behind `exports`, and workspace packages may point their main
  // entry at build output that does not exist yet when Forge evaluates its
  // configuration. Node still exposes the exact node_modules lookup roots,
  // so inspect those roots first and verify the manifest identity ourselves.
  for (const lookupRoot of resolver.resolve.paths(packageName) ?? []) {
    const candidate = path.join(
      lookupRoot,
      ...packageName.split('/'),
      'package.json',
    );
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    const manifest = readJson(candidate, `Package ${packageName}`);
    if (manifest.name === packageName) return realpathSync(candidate);
  }

  try {
    return realpathSync(resolver.resolve(`${packageName}/package.json`));
  } catch {
    try {
      const entryPath = realpathSync(resolver.resolve(packageName));
      return walkToPackageManifest(entryPath, packageName);
    } catch {
      return null;
    }
  }
}

export function resolveElectronRuntimeNoticePaths({ appDirectory }) {
  const appManifestPath = path.join(appDirectory, 'package.json');
  const electronManifestPath = resolvePackageManifest(
    appManifestPath,
    'electron',
  );
  if (!electronManifestPath) {
    throw new Error(
      `Could not resolve the Electron package from ${appManifestPath}`,
    );
  }
  const electronDirectory = path.dirname(electronManifestPath);
  const electronManifest = readJson(
    electronManifestPath,
    'Electron runtime package',
  );
  const version = String(electronManifest.version ?? '').trim();
  const license = normalizeLicense(electronManifest);
  if (!version) {
    throw new Error(
      `Electron runtime package has no exact version: ${electronManifestPath}`,
    );
  }
  if (!license || UNKNOWN_LICENSE_PATTERN.test(license)) {
    throw new Error(
      `Electron runtime package has no usable license declaration: ${electronManifestPath}`,
    );
  }
  const electronLicenseCandidates = [
    path.join(electronDirectory, 'dist', 'LICENSE'),
    path.join(electronDirectory, 'LICENSE'),
  ];
  const electronLicensePath = electronLicenseCandidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  const chromiumLicensePath = path.join(
    electronDirectory,
    'dist',
    'LICENSES.chromium.html',
  );
  if (!electronLicensePath) {
    throw new Error(
      `Electron license text is missing; checked: ${electronLicenseCandidates.join(', ')}`,
    );
  }
  if (
    !existsSync(chromiumLicensePath) ||
    !statSync(chromiumLicensePath).isFile()
  ) {
    throw new Error(
      `Chromium runtime notice inventory is missing: ${chromiumLicensePath}. Run the Electron install step before packaging.`,
    );
  }
  return {
    chromium: chromiumLicensePath,
    electron: electronLicensePath,
    license,
    version,
  };
}

function validateNucleoEvidence(evidence, nucleoPackageNames, now) {
  const blockers = [];
  const coveredPackages = new Set(
    Array.isArray(evidence.packageNames) ? evidence.packageNames : [],
  );
  const missingPackages = nucleoPackageNames.filter(
    (packageName) => !coveredPackages.has(packageName),
  );

  if (evidence.status !== 'APPROVED') {
    blockers.push({
      code: 'NUCLEO_REDISTRIBUTION_RIGHTS_UNVERIFIED',
      message:
        'Nucleo assets are part of the desktop dependency graph, but redistribution evidence is not APPROVED.',
    });
    return blockers;
  }
  if (missingPackages.length > 0) {
    blockers.push({
      code: 'NUCLEO_EVIDENCE_COVERAGE_INCOMPLETE',
      message: `Nucleo redistribution evidence does not cover: ${missingPackages.join(', ')}`,
    });
  }
  if (
    !Array.isArray(evidence.redistributionScope) ||
    !evidence.redistributionScope.includes('desktop-application-binary')
  ) {
    blockers.push({
      code: 'NUCLEO_DESKTOP_REDISTRIBUTION_SCOPE_MISSING',
      message:
        'Approved Nucleo evidence must explicitly cover desktop-application-binary redistribution.',
    });
  }
  if (
    !Array.isArray(evidence.evidenceReferences) ||
    evidence.evidenceReferences.length === 0 ||
    evidence.evidenceReferences.some(
      (reference) => typeof reference !== 'string' || !reference.trim(),
    )
  ) {
    blockers.push({
      code: 'NUCLEO_EVIDENCE_REFERENCE_MISSING',
      message:
        'Approved Nucleo evidence must name at least one non-secret external evidence record.',
    });
  }
  if (
    typeof evidence.licenseName !== 'string' ||
    !evidence.licenseName.trim()
  ) {
    blockers.push({
      code: 'NUCLEO_LICENSE_NAME_MISSING',
      message: 'Approved Nucleo evidence must name the applicable license.',
    });
  }
  if (typeof evidence.approvedBy !== 'string' || !evidence.approvedBy.trim()) {
    blockers.push({
      code: 'NUCLEO_APPROVER_MISSING',
      message: 'Approved Nucleo evidence must name its accountable approver.',
    });
  }
  if (
    typeof evidence.approvedAt !== 'string' ||
    Number.isNaN(Date.parse(evidence.approvedAt))
  ) {
    blockers.push({
      code: 'NUCLEO_APPROVAL_TIMESTAMP_INVALID',
      message:
        'Approved Nucleo evidence must contain a valid approvedAt timestamp.',
    });
  }
  if (
    evidence.expiresAt !== null &&
    evidence.expiresAt !== undefined &&
    (typeof evidence.expiresAt !== 'string' ||
      Number.isNaN(Date.parse(evidence.expiresAt)) ||
      Date.parse(evidence.expiresAt) <= now.getTime())
  ) {
    blockers.push({
      code: 'NUCLEO_REDISTRIBUTION_EVIDENCE_EXPIRED',
      message:
        'Nucleo redistribution evidence is expired or has an invalid expiry.',
    });
  }
  return blockers;
}

/**
 * @returns {{
 *   blockers: import('./release-attribution.mjs').AttributionBlocker[];
 *   entry: import('./release-attribution.mjs').AttributionEntry;
 * }}
 */
function makeOpenSourceEntry({
  licenseOverride,
  lockPackageSources,
  packageDirectory,
  packageJson,
  repositoryDirectory,
}) {
  const name = String(packageJson.name ?? '');
  const version = String(packageJson.version ?? '');
  const declaredLicense = normalizeLicense(packageJson);
  const existingLicenseText = readLicenseText(
    packageDirectory,
    repositoryDirectory,
    declaredLicense,
  );
  const appliedOverride = applyLicenseOverride({
    declaredLicense,
    existingLicenseText,
    identity: `${name}@${version}`,
    lockPackageSources,
    override: licenseOverride,
    packageDirectory,
  });
  return {
    blockers: appliedOverride.blockers,
    entry: {
      kind:
        appliedOverride.evidence?.basis === 'PINNED_CUSTOM_LICENSE'
          ? 'custom_license'
          : 'open_source',
      name,
      version,
      license: appliedOverride.license,
      repository: normalizeRepository(packageJson.repository),
      publisher: normalizePublisher(packageJson.author),
      licenseText: appliedOverride.licenseText,
      ...(appliedOverride.evidence
        ? { licenseEvidence: appliedOverride.evidence }
        : {}),
    },
  };
}

/**
 * @param {import('./release-attribution.mjs').BundledComponent} component
 * @returns {import('./release-attribution.mjs').AttributionEntry}
 */
function makeBundledComponentEntry(component) {
  return {
    kind: 'bundled_component',
    name: component.name,
    version: component.version,
    license: component.license,
    repository: component.repository,
    purl: component.purl,
    publisher: component.publisher,
    licenseText: component.licenseText,
    bundledComponentEvidence: {
      registryId: component.id,
      reviewStatus: component.reviewStatus,
      source: component.source,
      licenseEvidence: component.licenseEvidence,
      ...(component.metadataEvidence
        ? { metadataEvidence: component.metadataEvidence }
        : {}),
      noticeEvidence: component.noticeEvidence,
      packagedArtifacts: component.packagedArtifacts,
      ...(component.buildTransforms
        ? { buildTransforms: component.buildTransforms }
        : {}),
      ...(component.embeddedDependencyLock
        ? { embeddedDependencyLock: component.embeddedDependencyLock }
        : {}),
      ...(component.embeddedDependencies
        ? { embeddedDependencies: component.embeddedDependencies }
        : {}),
      redistributionReview: component.redistributionReview,
      platforms: component.platforms,
      architectures: component.architectures,
    },
  };
}

function licenseEntryBlockers(entry) {
  const blockers = [];
  if (!entry.name || !entry.version) {
    blockers.push({
      code: 'PACKAGE_IDENTITY_INCOMPLETE',
      message: `A packaged dependency has missing name/version metadata: ${entry.name || '<missing-name>'}@${entry.version || '<missing-version>'}`,
    });
  }
  if (!entry.license || UNKNOWN_LICENSE_PATTERN.test(entry.license)) {
    blockers.push({
      code: 'PACKAGE_LICENSE_UNKNOWN',
      message: `${entry.name}@${entry.version} has a missing or Unknown license declaration.`,
    });
  }
  if (!entry.licenseText.trim()) {
    blockers.push({
      code: 'PACKAGE_LICENSE_TEXT_MISSING',
      message: `${entry.name}@${entry.version} has no distributable license text.`,
    });
  }
  if (entry.licenseEvidence) {
    const evidence = entry.licenseEvidence;
    if (
      evidence.reviewStatus !== LICENSE_OVERRIDE_REVIEW_STATUS ||
      evidence.registryIdentity !== `${entry.name}@${entry.version}` ||
      evidence.licenseTextSha256 !== sha256Bytes(entry.licenseText) ||
      !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(
        String(evidence.packageSource?.integrity ?? ''),
      ) ||
      typeof evidence.packageSource?.tarball !== 'string' ||
      !evidence.packageSource.tarball ||
      !Array.isArray(evidence.sourceReferences) ||
      evidence.sourceReferences.length === 0
    ) {
      blockers.push({
        code: 'PACKAGE_LICENSE_EVIDENCE_INVALID',
        message: `${entry.name}@${entry.version} has invalid reviewed license evidence metadata.`,
      });
    }
  }
  if (entry.kind === 'bundled_component') {
    const evidence = entry.bundledComponentEvidence;
    if (
      !evidence ||
      typeof evidence.registryId !== 'string' ||
      !evidence.registryId ||
      evidence.reviewStatus !== BUNDLED_COMPONENT_REVIEW_STATUS ||
      evidence.licenseEvidence?.sha256 !== sha256Bytes(entry.licenseText) ||
      !SHA256_PATTERN.test(String(evidence.source?.sha256 ?? '')) ||
      typeof evidence.source?.url !== 'string' ||
      !evidence.source.url.startsWith('https://') ||
      !evidence.packagedArtifacts ||
      !evidence.redistributionReview ||
      evidence.redistributionReview.legalConclusion !== false
    ) {
      blockers.push({
        code: 'BUNDLED_COMPONENT_EVIDENCE_INVALID',
        message: `${entry.name}@${entry.version} has invalid bundled-component provenance metadata.`,
      });
    }
  }
  return blockers;
}

export function collectReleaseDependencyInventory({
  arch = process.arch,
  appDirectory,
  platform = process.platform,
  repositoryDirectory,
  now = new Date(),
  strict = false,
}) {
  const appManifestPath = path.join(appDirectory, 'package.json');
  const appManifest = readJson(appManifestPath, 'Browser package');
  const evidencePath = path.join(
    repositoryDirectory,
    NUCLEO_EVIDENCE_RELATIVE_PATH,
  );
  const nucleoEvidence = readJson(
    evidencePath,
    'Nucleo redistribution evidence',
  );
  const licenseOverrides = loadLicenseOverrideRegistry(repositoryDirectory);
  const bundledComponents = loadBundledComponentRegistry({
    arch,
    platform,
    registryPath: path.join(
      repositoryDirectory,
      BUNDLED_COMPONENT_REGISTRY_RELATIVE_PATH,
    ),
  });
  const lockPackageSources = loadPnpmLockPackageSources(repositoryDirectory);
  const exactRemovalOverrides =
    loadExactDependencyRemovalOverrides(repositoryDirectory);
  const rootDependencies = {
    ...(appManifest.dependencies ?? {}),
    ...(appManifest.devDependencies ?? {}),
  };
  const queue = Object.keys(rootDependencies)
    .filter((packageName) => !isBuildOnly(packageName))
    .sort()
    .map((packageName) => ({
      optional: false,
      packageName,
      requesterManifestPath: appManifestPath,
    }));
  const visitedManifests = new Set();
  /** @type {import('./release-attribution.mjs').AttributionEntry[]} */
  const entries = bundledComponents.applicableComponents.map(
    makeBundledComponentEntry,
  );
  const blockers = [
    ...licenseOverrides.blockers,
    ...bundledComponents.blockers,
  ];
  const nucleoPackageNames = new Set();

  while (queue.length > 0) {
    const request = queue.shift();
    const manifestPath = resolvePackageManifest(
      request.requesterManifestPath,
      request.packageName,
    );
    if (!manifestPath) {
      if (
        isDependencyExplicitlyRemoved({
          dependencyName: request.packageName,
          exactRemovalOverrides,
          requesterManifestPath: request.requesterManifestPath,
        })
      ) {
        continue;
      }
      if (!request.optional) {
        blockers.push({
          code: 'DEPENDENCY_MANIFEST_UNRESOLVED',
          message: `Could not resolve ${request.packageName} from ${path.relative(
            repositoryDirectory,
            request.requesterManifestPath,
          )}.`,
        });
      }
      continue;
    }
    if (visitedManifests.has(manifestPath)) continue;
    visitedManifests.add(manifestPath);

    const packageJson = readJson(
      manifestPath,
      `Package ${request.packageName}`,
    );
    const packageDirectory = path.dirname(manifestPath);
    const packageName = String(packageJson.name ?? request.packageName);
    if (isNucleoPackage(packageName)) {
      nucleoPackageNames.add(packageName);
      entries.push({
        kind: 'commercial_asset',
        name: packageName,
        version: String(packageJson.version ?? ''),
        license:
          nucleoEvidence.status === 'APPROVED'
            ? String(nucleoEvidence.licenseName ?? '')
            : 'UNVERIFIED',
        repository: '',
        publisher: 'Nucleo',
        licenseText: '',
        evidenceReferences: Array.isArray(nucleoEvidence.evidenceReferences)
          ? [...nucleoEvidence.evidenceReferences]
          : [],
      });
    } else {
      const identity = `${packageName}@${String(packageJson.version ?? '')}`;
      const result = makeOpenSourceEntry({
        licenseOverride: licenseOverrides.byIdentity.get(identity),
        lockPackageSources,
        packageDirectory,
        packageJson,
        repositoryDirectory,
      });
      entries.push(result.entry);
      blockers.push(...result.blockers, ...licenseEntryBlockers(result.entry));
    }

    const dependencies = packageJson.dependencies ?? {};
    for (const dependencyName of Object.keys(dependencies).sort()) {
      if (!isBuildOnly(dependencyName)) {
        queue.push({
          optional: false,
          packageName: dependencyName,
          requesterManifestPath: manifestPath,
        });
      }
    }
    const optionalDependencies = packageJson.optionalDependencies ?? {};
    for (const dependencyName of Object.keys(optionalDependencies).sort()) {
      if (!isBuildOnly(dependencyName)) {
        queue.push({
          optional: true,
          packageName: dependencyName,
          requesterManifestPath: manifestPath,
        });
      }
    }
  }

  const sortedNucleoPackages = [...nucleoPackageNames].sort();
  if (sortedNucleoPackages.length > 0) {
    blockers.push(
      ...validateNucleoEvidence(nucleoEvidence, sortedNucleoPackages, now),
    );
  }

  const entriesByIdentity = new Map();
  for (const entry of entries) {
    const identity = `${entry.name}\0${entry.version}`;
    const previous = entriesByIdentity.get(identity);
    if (!previous) {
      entriesByIdentity.set(identity, entry);
      continue;
    }
    if (JSON.stringify(previous) !== JSON.stringify(entry)) {
      blockers.push({
        code: 'PACKAGE_METADATA_CONFLICT',
        message: `${entry.name}@${entry.version} resolves to conflicting license or provenance metadata.`,
      });
    }
  }
  const uniqueEntries = [...entriesByIdentity.values()].sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(
      `${right.name}@${right.version}`,
    ),
  );
  const deduplicatedBlockers = [
    ...new Map(
      blockers.map((blocker) => [
        `${blocker.code}\0${blocker.message}`,
        blocker,
      ]),
    ).values(),
  ].sort((left, right) =>
    `${left.code}:${left.message}`.localeCompare(
      `${right.code}:${right.message}`,
    ),
  );
  if (strict && deduplicatedBlockers.length > 0) {
    throw new AttributionGateError(deduplicatedBlockers);
  }

  return {
    blockers: deduplicatedBlockers,
    entries: uniqueEntries,
    licenseOverrides: {
      appliedCount: uniqueEntries.filter((entry) => entry.licenseEvidence)
        .length,
      entryCount: licenseOverrides.entryCount,
      registryPath: LICENSE_OVERRIDE_REGISTRY_RELATIVE_PATH,
      status: licenseOverrides.status,
    },
    bundledComponents: {
      applicableCount: bundledComponents.applicableComponents.length,
      applicableEmbeddedDependencyCount:
        bundledComponents.applicableEmbeddedDependencyCount,
      embeddedDependencyCount: bundledComponents.embeddedDependencyCount,
      entryCount: bundledComponents.entryCount,
      registryPath: BUNDLED_COMPONENT_REGISTRY_RELATIVE_PATH,
      status: bundledComponents.status,
    },
    nucleo: {
      evidencePath: NUCLEO_EVIDENCE_RELATIVE_PATH,
      packageNames: sortedNucleoPackages,
      status: nucleoEvidence.status ?? 'UNVERIFIED',
    },
  };
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function safeRelativePath(relativePath) {
  if (
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).some((segment) => segment === '..')
  ) {
    throw new Error(`Unsafe attribution path: ${relativePath}`);
  }
  return relativePath;
}

export function prepareReleaseAttributionBundle({
  arch = process.arch,
  appDirectory,
  outputDirectory,
  platform = process.platform,
  releaseChannel = 'dev',
  repositoryDirectory,
  now = new Date(),
}) {
  const strict = releaseChannel !== 'dev';
  const inventory = collectReleaseDependencyInventory({
    arch,
    appDirectory,
    platform,
    repositoryDirectory,
    now,
    strict,
  });

  rmSync(outputDirectory, { force: true, recursive: true });
  mkdirSync(outputDirectory, { recursive: true });
  for (const { source, target } of REQUIRED_NOTICE_SOURCES) {
    const sourcePath = path.join(repositoryDirectory, source);
    if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
      throw new Error(`Required attribution source is missing: ${sourcePath}`);
    }
    const targetPath = path.join(outputDirectory, safeRelativePath(target));
    mkdirSync(path.dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }

  const dependencyInventory = {
    schemaVersion: 1,
    status: inventory.blockers.length === 0 ? 'READY' : 'BLOCKED_DEV_ONLY',
    releaseChannel,
    blockers: inventory.blockers,
    entries: inventory.entries,
    bundledComponents: inventory.bundledComponents,
    licenseOverrides: inventory.licenseOverrides,
    nucleo: inventory.nucleo,
  };
  writeJson(
    path.join(outputDirectory, 'dependency-licenses.json'),
    dependencyInventory,
  );

  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) {
        const relativePath = path
          .relative(outputDirectory, entryPath)
          .split(path.sep)
          .join('/');
        files.push({
          path: relativePath,
          bytes: statSync(entryPath).size,
          sha256: sha256FileSync(entryPath),
        });
      }
    }
  };
  visit(outputDirectory);
  files.sort((left, right) => left.path.localeCompare(right.path));

  const manifest = {
    schemaVersion: 1,
    status: dependencyInventory.status,
    releaseChannel,
    files,
    dependencyCount: inventory.entries.length,
    blockerCount: inventory.blockers.length,
    bundledComponentApplicableCount:
      inventory.bundledComponents.applicableCount,
    bundledComponentApplicableEmbeddedDependencyCount:
      inventory.bundledComponents.applicableEmbeddedDependencyCount,
    bundledComponentEmbeddedDependencyCount:
      inventory.bundledComponents.embeddedDependencyCount,
    bundledComponentEntryCount: inventory.bundledComponents.entryCount,
    bundledComponentStatus: inventory.bundledComponents.status,
    licenseOverrideAppliedCount: inventory.licenseOverrides.appliedCount,
    licenseOverrideEntryCount: inventory.licenseOverrides.entryCount,
    licenseOverrideStatus: inventory.licenseOverrides.status,
    nucleoStatus: inventory.nucleo.status,
  };
  writeJson(path.join(outputDirectory, 'manifest.json'), manifest);
  return { inventory, manifest, outputDirectory };
}

export function writeLicenseUiJson({
  appDirectory,
  outputPath,
  releaseChannel = 'dev',
  repositoryDirectory,
}) {
  const inventory = collectReleaseDependencyInventory({
    appDirectory,
    repositoryDirectory,
    strict: releaseChannel !== 'dev',
  });
  const entries = inventory.entries
    .filter((entry) => entry.kind !== 'commercial_asset')
    .map(
      ({ kind: _kind, evidenceReferences: _evidenceReferences, ...entry }) =>
        entry,
    );
  writeJson(outputPath, entries);
  return { blockers: inventory.blockers, entries };
}

function assertFile(filePath, label) {
  if (!existsSync(filePath))
    throw new Error(`${label} is missing: ${filePath}`);
  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size === 0) {
    throw new Error(`${label} is empty or not a file: ${filePath}`);
  }
  return stats;
}

export function inspectPackagedAttribution({
  attributionDirectory,
  requireReady = true,
}) {
  const manifestPath = path.join(attributionDirectory, 'manifest.json');
  assertFile(manifestPath, 'Attribution manifest');
  const manifest = readJson(manifestPath, 'Attribution manifest');
  if (requireReady && manifest.status !== 'READY') {
    throw new Error(
      `Packaged attribution status is ${manifest.status ?? 'missing'}; READY is required`,
    );
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error('Attribution manifest files must be an array');
  }
  const manifestPaths = new Set();
  for (const record of manifest.files) {
    const relativePath = safeRelativePath(String(record.path ?? ''));
    const filePath = path.join(attributionDirectory, relativePath);
    const stats = assertFile(filePath, `Attributed file ${relativePath}`);
    const actualHash = sha256FileSync(filePath);
    if (actualHash !== record.sha256) {
      throw new Error(
        `Attribution hash mismatch for ${relativePath}: ${actualHash} != ${record.sha256}`,
      );
    }
    if (stats.size !== record.bytes) {
      throw new Error(`Attribution size mismatch for ${relativePath}`);
    }
    manifestPaths.add(relativePath);
  }
  for (const requiredPath of REQUIRED_ATTRIBUTION_PATHS) {
    if (requiredPath === 'manifest.json') continue;
    if (!manifestPaths.has(requiredPath)) {
      throw new Error(
        `Required attribution file is absent from manifest: ${requiredPath}`,
      );
    }
  }

  const inventoryPath = path.join(
    attributionDirectory,
    'dependency-licenses.json',
  );
  const inventory = readJson(inventoryPath, 'Dependency license inventory');
  if (manifest.status !== inventory.status) {
    throw new Error(
      `Attribution manifest status ${manifest.status ?? 'missing'} does not match dependency inventory status ${inventory.status ?? 'missing'}`,
    );
  }
  if (requireReady && inventory.status !== 'READY') {
    throw new Error(
      `Dependency license inventory is not READY: ${inventory.status}`,
    );
  }
  if (!Array.isArray(inventory.entries)) {
    throw new Error('Dependency license inventory entries must be an array');
  }
  if (!Array.isArray(inventory.blockers)) {
    throw new Error('Dependency license inventory blockers must be an array');
  }
  if (
    !inventory.bundledComponents ||
    inventory.bundledComponents.status !== BUNDLED_COMPONENT_REVIEW_STATUS
  ) {
    throw new Error(
      `Bundled component registry is not ${BUNDLED_COMPONENT_REVIEW_STATUS}.`,
    );
  }
  const packagedBundledComponents = loadBundledComponentRegistry({
    registryPath: path.join(
      attributionDirectory,
      'provenance/BUNDLED_COMPONENTS.json',
    ),
    strict: true,
  });
  if (
    packagedBundledComponents.entryCount !==
      inventory.bundledComponents.entryCount ||
    packagedBundledComponents.embeddedDependencyCount !==
      inventory.bundledComponents.embeddedDependencyCount ||
    packagedBundledComponents.status !== inventory.bundledComponents.status
  ) {
    throw new Error(
      'Packaged bundled-component registry does not match the reviewed inventory metadata.',
    );
  }
  const packagedBundledById = new Map(
    packagedBundledComponents.components.map((component) => [
      component.id,
      component,
    ]),
  );
  const bundledInventoryEntries = inventory.entries.filter(
    (entry) => entry.kind === 'bundled_component',
  );
  if (
    bundledInventoryEntries.length !==
    inventory.bundledComponents.applicableCount
  ) {
    throw new Error(
      'Packaged bundled-component applicable count does not match the inventory entries.',
    );
  }
  const seenBundledIds = new Set();
  for (const entry of bundledInventoryEntries) {
    const registryId = entry.bundledComponentEvidence?.registryId;
    if (!registryId || seenBundledIds.has(registryId)) {
      throw new Error(
        `Packaged bundled-component identity is missing or duplicated: ${String(registryId ?? '<missing>')}.`,
      );
    }
    seenBundledIds.add(registryId);
    const component = packagedBundledById.get(registryId);
    const expectedEntry = component
      ? makeBundledComponentEntry(component)
      : null;
    if (
      !expectedEntry ||
      JSON.stringify(expectedEntry) !== JSON.stringify(entry)
    ) {
      throw new Error(
        `Packaged bundled-component evidence does not match ${entry.name}@${entry.version}.`,
      );
    }
  }
  if (
    !inventory.licenseOverrides ||
    inventory.licenseOverrides.status !== LICENSE_OVERRIDE_REVIEW_STATUS
  ) {
    throw new Error(
      `Dependency license override registry is not ${LICENSE_OVERRIDE_REVIEW_STATUS}.`,
    );
  }
  const packagedOverrideRegistry = readJson(
    path.join(
      attributionDirectory,
      'provenance/DEPENDENCY_LICENSE_OVERRIDES.json',
    ),
    'Packaged dependency license override registry',
  );
  if (
    packagedOverrideRegistry.status !== LICENSE_OVERRIDE_REVIEW_STATUS ||
    !Array.isArray(packagedOverrideRegistry.entries) ||
    packagedOverrideRegistry.entries.length !==
      inventory.licenseOverrides.entryCount
  ) {
    throw new Error(
      'Packaged dependency license override registry does not match the reviewed inventory metadata.',
    );
  }
  const packagedOverridesByIdentity = new Map(
    packagedOverrideRegistry.entries.map((record) => [
      `${String(record?.package ?? '')}@${String(record?.version ?? '')}`,
      record,
    ]),
  );
  if (
    packagedOverridesByIdentity.size !== packagedOverrideRegistry.entries.length
  ) {
    throw new Error(
      'Packaged dependency license override registry contains duplicate identities.',
    );
  }
  const appliedOverrideCount = inventory.entries.filter(
    (entry) => entry.licenseEvidence,
  ).length;
  if (appliedOverrideCount !== inventory.licenseOverrides.appliedCount) {
    throw new Error(
      `Packaged applied license override count mismatch: ${appliedOverrideCount} != ${inventory.licenseOverrides.appliedCount}`,
    );
  }
  for (const entry of inventory.entries) {
    if (!entry.licenseEvidence) continue;
    const record = packagedOverridesByIdentity.get(
      entry.licenseEvidence.registryIdentity,
    );
    if (
      !record ||
      record.reviewStatus !== LICENSE_OVERRIDE_REVIEW_STATUS ||
      record.basis !== entry.licenseEvidence.basis ||
      record.license !== entry.license ||
      record.licenseTextSource?.sha256 !==
        entry.licenseEvidence.licenseTextSha256 ||
      record.packageSource?.integrity !==
        entry.licenseEvidence.packageSource?.integrity ||
      record.packageSource?.tarball !==
        entry.licenseEvidence.packageSource?.tarball ||
      JSON.stringify(record.licenseTextSource?.sourceReferences ?? []) !==
        JSON.stringify(entry.licenseEvidence.sourceReferences)
    ) {
      throw new Error(
        `Packaged reviewed license evidence does not match ${entry.name}@${entry.version}.`,
      );
    }
  }
  if (requireReady && inventory.blockers.length > 0) {
    throw new AttributionGateError(inventory.blockers);
  }
  if (manifest.dependencyCount !== inventory.entries.length) {
    throw new Error(
      `Attribution dependency count mismatch: ${manifest.dependencyCount} != ${inventory.entries.length}`,
    );
  }
  if (manifest.blockerCount !== inventory.blockers.length) {
    throw new Error(
      `Attribution blocker count mismatch: ${manifest.blockerCount} != ${inventory.blockers.length}`,
    );
  }
  if (
    manifest.bundledComponentApplicableCount !==
      inventory.bundledComponents.applicableCount ||
    manifest.bundledComponentApplicableEmbeddedDependencyCount !==
      inventory.bundledComponents.applicableEmbeddedDependencyCount ||
    manifest.bundledComponentEmbeddedDependencyCount !==
      inventory.bundledComponents.embeddedDependencyCount ||
    manifest.bundledComponentEntryCount !==
      inventory.bundledComponents.entryCount ||
    manifest.bundledComponentStatus !== inventory.bundledComponents.status ||
    manifest.licenseOverrideAppliedCount !==
      inventory.licenseOverrides.appliedCount ||
    manifest.licenseOverrideEntryCount !==
      inventory.licenseOverrides.entryCount ||
    manifest.licenseOverrideStatus !== inventory.licenseOverrides.status
  ) {
    throw new Error(
      'Attribution manifest bundled-component or license-override metadata does not match the dependency inventory.',
    );
  }
  const blockers = inventory.entries
    .filter((entry) => entry.kind !== 'commercial_asset')
    .flatMap(licenseEntryBlockers);
  if (blockers.length > 0) throw new AttributionGateError(blockers);

  return {
    attributionDirectory,
    dependencyCount: inventory.entries.length,
    inventory,
    manifest,
    manifestSha256: sha256FileSync(manifestPath),
    noticePaths: REQUIRED_NOTICE_SOURCES.map(({ target }) => target),
  };
}

function collectPackagedPackageManifests(rootDirectory) {
  if (!existsSync(rootDirectory)) return [];
  const packages = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name === 'package.json') {
        const packageJson = readJson(entryPath, 'Packaged package manifest');
        if (typeof packageJson.name === 'string' && packageJson.name) {
          packages.push({
            name: packageJson.name,
            version: String(packageJson.version ?? ''),
            path: entryPath,
          });
        }
      }
    }
  };
  visit(rootDirectory);
  return packages.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(
      `${right.name}@${right.version}`,
    ),
  );
}

function findElectronRuntimeNotice(applicationDirectory, fileNames) {
  const matches = [];
  const visit = (directory, depth) => {
    if (depth > 10) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (
          entry.name === ATTRIBUTION_DIRECTORY_NAME ||
          entry.name === 'app.asar.unpacked' ||
          entry.name === 'node_modules'
        ) {
          continue;
        }
        visit(entryPath, depth + 1);
      } else if (entry.isFile() && fileNames.has(entry.name)) {
        matches.push(entryPath);
      }
    }
  };
  visit(applicationDirectory, 0);
  return matches.sort()[0] ?? null;
}

export function inspectElectronRuntimeNotices(applicationDirectory) {
  const electronLicensePath = findElectronRuntimeNotice(
    applicationDirectory,
    new Set(['LICENSE', 'LICENSE.electron.txt']),
  );
  const chromiumLicensePath = findElectronRuntimeNotice(
    applicationDirectory,
    new Set(['LICENSES.chromium.html']),
  );
  if (!electronLicensePath) {
    throw new Error(
      `Electron runtime license is missing from the packaged application: ${applicationDirectory}`,
    );
  }
  if (!chromiumLicensePath) {
    throw new Error(
      `Chromium license inventory is missing from the packaged application: ${applicationDirectory}`,
    );
  }
  assertFile(electronLicensePath, 'Electron runtime license');
  assertFile(chromiumLicensePath, 'Chromium license inventory');
  return {
    chromium: {
      path: chromiumLicensePath,
      sha256: sha256FileSync(chromiumLicensePath),
    },
    electron: {
      path: electronLicensePath,
      sha256: sha256FileSync(electronLicensePath),
    },
  };
}

function cyclonedxLicense(license) {
  if (SPDX_ID_PATTERN.test(license)) return { license: { id: license } };
  return { license: { name: license } };
}

function componentReference(entry) {
  return `urn:clodex:dependency:${sha256Bytes(`${entry.name}\0${entry.version}`).slice(0, 32)}`;
}

function resolveBundledArtifactPath(
  record,
  applicationDirectory,
  resourcesDirectory,
) {
  const root =
    record.location === 'application'
      ? applicationDirectory
      : resourcesDirectory;
  return path.join(root, safeRelativePath(record.path));
}

function inspectExactBundledArtifact({
  applicationDirectory,
  componentId,
  record,
  resourcesDirectory,
}) {
  const filePath = resolveBundledArtifactPath(
    record,
    applicationDirectory,
    resourcesDirectory,
  );
  const stats = assertFile(filePath, `${componentId} ${record.role}`);
  const actualHash = sha256FileSync(filePath);
  if (stats.size !== record.bytes || actualHash !== record.sha256) {
    throw new Error(
      `${componentId} packaged artifact drift for ${record.path}: ${stats.size} bytes/${actualHash} != ${record.bytes} bytes/${record.sha256}`,
    );
  }
  return {
    bytes: stats.size,
    location: record.location,
    path: record.path,
    role: record.role,
    sha256: actualHash,
  };
}

function collectRegularFilesStrict(rootDirectory) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Bundled component directory contains a symbolic link: ${entryPath}`,
        );
      }
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
      else {
        throw new Error(
          `Bundled component directory contains a non-regular file: ${entryPath}`,
        );
      }
    }
  };
  visit(rootDirectory);
  return files.sort();
}

function embeddedDependencyProvenance(component) {
  return (component.embeddedDependencies ?? []).map(
    ({ licenseText: _licenseText, ...dependency }) => dependency,
  );
}

export function inspectBundledComponentArtifacts({
  applicationDirectory,
  component,
  resourcesDirectory,
}) {
  const policy = component.packagedArtifacts;
  if (policy.mode === 'fixed-files') {
    const files = policy.files.map((record) =>
      inspectExactBundledArtifact({
        applicationDirectory,
        componentId: component.id,
        record,
        resourcesDirectory,
      }),
    );
    const exclusiveDirectory = resolveBundledArtifactPath(
      policy.exclusiveFileMatch,
      applicationDirectory,
      resourcesDirectory,
    );
    if (
      !existsSync(exclusiveDirectory) ||
      !statSync(exclusiveDirectory).isDirectory()
    ) {
      throw new Error(
        `${component.id} exclusive artifact directory is missing: ${exclusiveDirectory}`,
      );
    }
    const expectedPaths = new Set(
      policy.files.map((record) =>
        path.resolve(
          resolveBundledArtifactPath(
            record,
            applicationDirectory,
            resourcesDirectory,
          ),
        ),
      ),
    );
    const pattern = new RegExp(policy.exclusiveFileMatch.fileNamePattern);
    const unexpected = readdirSync(exclusiveDirectory, {
      withFileTypes: true,
    })
      .filter((entry) => pattern.test(entry.name))
      .map((entry) => {
        const entryPath = path.resolve(exclusiveDirectory, entry.name);
        if (!entry.isFile()) {
          throw new Error(
            `${component.id} matched artifact is not a regular file: ${entryPath}`,
          );
        }
        return entryPath;
      })
      .filter((entryPath) => !expectedPaths.has(entryPath));
    if (unexpected.length > 0) {
      throw new Error(
        `${component.id} has unreviewed matching packaged artifacts: ${unexpected.join(', ')}`,
      );
    }
    return {
      componentId: component.id,
      files,
      mode: policy.mode,
    };
  }

  const artifactDirectory = resolveBundledArtifactPath(
    policy.artifactDirectory,
    applicationDirectory,
    resourcesDirectory,
  );
  if (
    !existsSync(artifactDirectory) ||
    !statSync(artifactDirectory).isDirectory()
  ) {
    throw new Error(
      `${component.id} generated artifact directory is missing: ${artifactDirectory}`,
    );
  }
  const manifestPath = resolveBundledArtifactPath(
    policy.manifest,
    applicationDirectory,
    resourcesDirectory,
  );
  assertFile(manifestPath, `${component.id} generated provenance manifest`);
  const manifest = readJson(
    manifestPath,
    `${component.id} generated provenance manifest`,
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.componentId !== component.id ||
    manifest.name !== component.name ||
    manifest.version !== component.version ||
    manifest.reviewStatus !== component.reviewStatus ||
    JSON.stringify(manifest.source) !== JSON.stringify(component.source) ||
    JSON.stringify(manifest.buildTransforms) !==
      JSON.stringify(component.buildTransforms) ||
    JSON.stringify(manifest.embeddedDependencyLock) !==
      JSON.stringify(component.embeddedDependencyLock) ||
    JSON.stringify(manifest.embeddedDependencies) !==
      JSON.stringify(embeddedDependencyProvenance(component)) ||
    manifest.licenseEvidence?.sha256 !== component.licenseEvidence.sha256 ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length === 0
  ) {
    throw new Error(
      `${component.id} generated provenance manifest does not match the reviewed registry.`,
    );
  }
  const expectedGeneratedFiles = policy.requiredFiles
    .map((record) => `${record.path}\0${record.role}`)
    .sort();
  const manifestedGeneratedFiles = manifest.artifacts
    .map(
      (record) =>
        `${String(record?.path ?? '')}\0${String(record?.role ?? '')}`,
    )
    .sort();
  if (
    JSON.stringify(expectedGeneratedFiles) !==
    JSON.stringify(manifestedGeneratedFiles)
  ) {
    throw new Error(
      `${component.id} generated file set does not match the reviewed registry: expected ${expectedGeneratedFiles.join(', ')}; got ${manifestedGeneratedFiles.join(', ')}.`,
    );
  }

  const generatedFiles = [];
  const expectedAbsolutePaths = new Set([path.resolve(manifestPath)]);
  const reservedAbsolutePaths = new Set([
    path.resolve(manifestPath),
    ...policy.fixedFiles.map((record) =>
      path.resolve(
        resolveBundledArtifactPath(
          record,
          applicationDirectory,
          resourcesDirectory,
        ),
      ),
    ),
  ]);
  const seenRelativePaths = new Set();
  for (const artifact of manifest.artifacts) {
    let relativePath;
    try {
      relativePath = safeRelativePath(String(artifact?.path ?? ''));
    } catch (error) {
      throw new Error(
        `${component.id} generated artifact path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      !relativePath ||
      seenRelativePaths.has(relativePath) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      !SHA256_PATTERN.test(String(artifact.sha256 ?? '')) ||
      typeof artifact.role !== 'string' ||
      !artifact.role.trim()
    ) {
      throw new Error(
        `${component.id} generated artifact record is incomplete or duplicated: ${relativePath || '<missing>'}.`,
      );
    }
    seenRelativePaths.add(relativePath);
    const absolutePath = path.resolve(artifactDirectory, relativePath);
    const artifactRoot = `${path.resolve(artifactDirectory)}${path.sep}`;
    if (!absolutePath.startsWith(artifactRoot)) {
      throw new Error(
        `${component.id} generated artifact escapes its directory: ${relativePath}.`,
      );
    }
    if (reservedAbsolutePaths.has(absolutePath)) {
      throw new Error(
        `${component.id} generated artifact overlaps fixed evidence or its provenance manifest: ${relativePath}.`,
      );
    }
    const stats = assertFile(
      absolutePath,
      `${component.id} generated artifact ${relativePath}`,
    );
    const actualHash = sha256FileSync(absolutePath);
    if (stats.size !== artifact.bytes || actualHash !== artifact.sha256) {
      throw new Error(
        `${component.id} generated artifact drift for ${relativePath}: ${stats.size} bytes/${actualHash} != ${artifact.bytes} bytes/${artifact.sha256}`,
      );
    }
    expectedAbsolutePaths.add(absolutePath);
    generatedFiles.push({
      bytes: stats.size,
      location: policy.artifactDirectory.location,
      path: path
        .join(policy.artifactDirectory.path, relativePath)
        .split(path.sep)
        .join('/'),
      role: artifact.role,
      sha256: actualHash,
    });
  }

  const fixedFiles = policy.fixedFiles.map((record) => {
    const inspected = inspectExactBundledArtifact({
      applicationDirectory,
      componentId: component.id,
      record,
      resourcesDirectory,
    });
    expectedAbsolutePaths.add(
      resolveBundledArtifactPath(
        record,
        applicationDirectory,
        resourcesDirectory,
      ),
    );
    return inspected;
  });
  const actualPaths = collectRegularFilesStrict(artifactDirectory).map(
    (value) => path.resolve(value),
  );
  const missingOrExtra = [
    ...new Set([
      ...actualPaths.filter((value) => !expectedAbsolutePaths.has(value)),
      ...[...expectedAbsolutePaths].filter(
        (value) => !actualPaths.includes(value),
      ),
    ]),
  ];
  if (missingOrExtra.length > 0) {
    throw new Error(
      `${component.id} generated artifact set differs from its provenance manifest: ${missingOrExtra.join(', ')}`,
    );
  }
  return {
    componentId: component.id,
    files: [
      ...generatedFiles,
      ...fixedFiles,
      {
        bytes: statSync(manifestPath).size,
        location: policy.manifest.location,
        path: policy.manifest.path,
        role: 'provenance-manifest',
        sha256: sha256FileSync(manifestPath),
      },
    ].sort((left, right) => left.path.localeCompare(right.path)),
    mode: policy.mode,
  };
}

export async function writeFinalArtifactSbom({
  applicationDirectory,
  appName,
  appVersion,
  arch,
  attribution,
  electronRuntime,
  outputPath,
  platform,
  resourcesDirectory,
  timestamp = new Date(),
}) {
  const asarPath = path.join(resourcesDirectory, 'app.asar');
  assertFile(asarPath, 'Packaged app.asar');
  const asarSha256 = await sha256File(asarPath);
  const nativePackageRoots = [
    path.join(resourcesDirectory, 'app.asar.unpacked', 'node_modules'),
    path.join(resourcesDirectory, 'node_modules'),
  ];
  const nativePackages = nativePackageRoots.flatMap(
    collectPackagedPackageManifests,
  );
  const inventoryByNameVersion = new Set(
    attribution.inventory.entries.map(
      (entry) => `${entry.name}\0${entry.version}`,
    ),
  );
  const missingNativePackages = nativePackages.filter(
    (entry) => !inventoryByNameVersion.has(`${entry.name}\0${entry.version}`),
  );
  if (missingNativePackages.length > 0) {
    throw new Error(
      `Packaged native dependencies are missing from the license inventory: ${missingNativePackages
        .map((entry) => `${entry.name}@${entry.version}`)
        .join(', ')}`,
    );
  }
  const nativeKeys = new Set(
    nativePackages.map((entry) => `${entry.name}\0${entry.version}`),
  );
  const electronNotices = inspectElectronRuntimeNotices(applicationDirectory);
  if (
    !electronRuntime ||
    electronRuntime.name !== 'electron' ||
    typeof electronRuntime.version !== 'string' ||
    !electronRuntime.version.trim() ||
    typeof electronRuntime.license !== 'string' ||
    !electronRuntime.license.trim() ||
    UNKNOWN_LICENSE_PATTERN.test(electronRuntime.license.trim())
  ) {
    throw new Error(
      'Final-artifact SBOM requires exact Electron runtime name, version, and license metadata.',
    );
  }

  const bundledRegistry = loadBundledComponentRegistry({
    arch,
    platform,
    registryPath: path.join(
      attribution.attributionDirectory,
      'provenance/BUNDLED_COMPONENTS.json',
    ),
    strict: true,
  });
  const expectedBundledIds = bundledRegistry.applicableComponents
    .map((component) => component.id)
    .sort();
  const inventoriedBundledIds = attribution.inventory.entries
    .filter((entry) => entry.kind === 'bundled_component')
    .map((entry) => entry.bundledComponentEvidence?.registryId)
    .sort();
  if (
    JSON.stringify(expectedBundledIds) !== JSON.stringify(inventoriedBundledIds)
  ) {
    throw new Error(
      `Packaged bundled-component inventory does not match ${normalizeReleasePlatform(platform)}/${normalizeReleaseArchitecture(arch)}: expected ${expectedBundledIds.join(', ') || '<none>'}; got ${inventoriedBundledIds.join(', ') || '<none>'}.`,
    );
  }
  const bundledArtifactReports = bundledRegistry.applicableComponents.map(
    (component) => ({
      component,
      report: inspectBundledComponentArtifacts({
        applicationDirectory,
        component,
        resourcesDirectory,
      }),
    }),
  );

  const components = attribution.inventory.entries.map((entry) => ({
    type: entry.kind === 'commercial_asset' ? 'library' : 'library',
    'bom-ref': componentReference(entry),
    name: entry.name,
    version: entry.version,
    ...(entry.purl ? { purl: entry.purl } : {}),
    licenses: [cyclonedxLicense(entry.license)],
    properties: [
      {
        name: 'clodex:component-kind',
        value: entry.kind,
      },
      {
        name: 'clodex:license-text-sha256',
        value: entry.licenseText
          ? sha256Bytes(entry.licenseText)
          : 'not-public',
      },
      {
        name: 'clodex:packaged-native-manifest-observed',
        value: String(nativeKeys.has(`${entry.name}\0${entry.version}`)),
      },
      ...(entry.kind === 'bundled_component'
        ? [
            {
              name: 'clodex:bundled-component-registry-id',
              value: entry.bundledComponentEvidence.registryId,
            },
            {
              name: 'clodex:source-archive-sha256',
              value: entry.bundledComponentEvidence.source.sha256,
            },
            {
              name: 'clodex:source-url',
              value: entry.bundledComponentEvidence.source.url,
            },
            {
              name: 'clodex:redistribution-review-status',
              value: entry.bundledComponentEvidence.redistributionReview.status,
            },
          ]
        : []),
    ],
  }));
  const bundledDependencyRelationships = [];
  for (const { component } of bundledArtifactReports) {
    const parentEntry = attribution.inventory.entries.find(
      (entry) =>
        entry.kind === 'bundled_component' &&
        entry.bundledComponentEvidence?.registryId === component.id,
    );
    if (!parentEntry) {
      throw new Error(
        `Bundled component ${component.id} has no parent attribution entry.`,
      );
    }
    const childReferences = [];
    for (const dependency of component.embeddedDependencies ?? []) {
      const childReference = `urn:clodex:bundled-dependency:${sha256Bytes(
        `${component.id}\0${dependency.name}\0${dependency.version}`,
      ).slice(0, 32)}`;
      childReferences.push(childReference);
      components.push({
        type: 'library',
        'bom-ref': childReference,
        name: dependency.name,
        version: dependency.version,
        purl: dependency.purl,
        licenses: [cyclonedxLicense(dependency.license)],
        properties: [
          {
            name: 'clodex:component-kind',
            value: 'embedded-bundle-dependency',
          },
          {
            name: 'clodex:bundled-component-registry-id',
            value: component.id,
          },
          {
            name: 'clodex:package-integrity',
            value: dependency.packageSource.integrity,
          },
          {
            name: 'clodex:package-tarball-sha256',
            value: dependency.packageSource.sha256,
          },
          {
            name: 'clodex:license-text-sha256',
            value: dependency.licenseEvidence.sha256,
          },
        ],
      });
    }
    if (childReferences.length > 0) {
      bundledDependencyRelationships.push({
        ref: componentReference(parentEntry),
        dependsOn: childReferences,
      });
    }
  }
  components.push({
    type: 'framework',
    'bom-ref': `urn:clodex:runtime:${sha256Bytes(
      `${electronRuntime.name}\0${electronRuntime.version}`,
    ).slice(0, 32)}`,
    name: electronRuntime.name,
    version: electronRuntime.version,
    purl: `pkg:npm/electron@${electronRuntime.version}`,
    licenses: [cyclonedxLicense(electronRuntime.license)],
    properties: [
      {
        name: 'clodex:component-kind',
        value: 'shipped-runtime-framework',
      },
      {
        name: 'clodex:electron-license-sha256',
        value: electronNotices.electron.sha256,
      },
      {
        name: 'clodex:chromium-notices-sha256',
        value: electronNotices.chromium.sha256,
      },
    ],
  });
  components.push({
    type: 'file',
    'bom-ref': 'urn:clodex:artifact:app-asar',
    name: 'app.asar',
    hashes: [{ alg: 'SHA-256', content: asarSha256 }],
    properties: [
      {
        name: 'clodex:artifact-path',
        value: path
          .relative(resourcesDirectory, asarPath)
          .split(path.sep)
          .join('/'),
      },
    ],
  });
  for (const [name, notice] of Object.entries(electronNotices)) {
    components.push({
      type: 'file',
      'bom-ref': `urn:clodex:artifact:${name}-license`,
      name: path.basename(notice.path),
      hashes: [{ alg: 'SHA-256', content: notice.sha256 }],
      properties: [
        {
          name: 'clodex:artifact-path',
          value: path
            .relative(applicationDirectory, notice.path)
            .split(path.sep)
            .join('/'),
        },
      ],
    });
  }
  for (const { component, report } of bundledArtifactReports) {
    for (const artifact of report.files) {
      components.push({
        type: 'file',
        'bom-ref': `urn:clodex:bundled-artifact:${sha256Bytes(
          `${component.id}\0${artifact.location}\0${artifact.path}`,
        ).slice(0, 32)}`,
        name: path.basename(artifact.path),
        hashes: [{ alg: 'SHA-256', content: artifact.sha256 }],
        properties: [
          {
            name: 'clodex:bundled-component-registry-id',
            value: component.id,
          },
          {
            name: 'clodex:artifact-location',
            value: artifact.location,
          },
          {
            name: 'clodex:artifact-path',
            value: artifact.path,
          },
          {
            name: 'clodex:artifact-role',
            value: artifact.role,
          },
        ],
      });
    }
  }

  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: timestamp.toISOString(),
      tools: {
        components: [
          {
            type: 'application',
            name: 'clodex-release-attribution',
            version: '1',
          },
        ],
      },
      component: {
        type: 'application',
        name: appName,
        version: appVersion,
        properties: [
          { name: 'clodex:platform', value: platform },
          { name: 'clodex:arch', value: arch },
          {
            name: 'clodex:attribution-manifest-sha256',
            value: attribution.manifestSha256,
          },
        ],
      },
    },
    components,
    ...(bundledDependencyRelationships.length > 0
      ? { dependencies: bundledDependencyRelationships }
      : {}),
  };
  writeJson(outputPath, sbom);
  return {
    bytes: statSync(outputPath).size,
    componentCount: components.length,
    electronRuntime: {
      license: electronRuntime.license,
      name: electronRuntime.name,
      version: electronRuntime.version,
    },
    nativePackageCount: nativePackages.length,
    bundledComponentCount: bundledArtifactReports.length,
    bundledEmbeddedDependencyCount: bundledRegistry.applicableComponents.reduce(
      (count, component) =>
        count + (component.embeddedDependencies?.length ?? 0),
      0,
    ),
    bundledArtifactCount: bundledArtifactReports.reduce(
      (count, entry) => count + entry.report.files.length,
      0,
    ),
    electronNotices: Object.fromEntries(
      Object.entries(electronNotices).map(([name, notice]) => [
        name,
        {
          path: path.relative(applicationDirectory, notice.path),
          sha256: notice.sha256,
        },
      ]),
    ),
    path: outputPath,
    sha256: await sha256File(outputPath),
  };
}

function parseCliArguments(values) {
  const options = {
    action: 'check',
    channel: process.env.RELEASE_CHANNEL ?? 'release',
    output: undefined,
  };
  for (const value of values) {
    if (value === '--') continue;
    if (value === 'check' || value === 'prepare') options.action = value;
    else if (value.startsWith('--channel=')) {
      options.channel = value.slice('--channel='.length);
    } else if (value.startsWith('--output=')) {
      options.output = value.slice('--output='.length);
    } else if (value === '--help') {
      console.log(
        'Usage: node scripts/release-attribution.mjs [check|prepare] [--channel=<channel>] [--output=<path>]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return options;
}

async function main() {
  const options = parseCliArguments(process.argv.slice(2));
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const appDirectory = path.resolve(scriptDirectory, '..');
  const repositoryDirectory = path.resolve(appDirectory, '../..');
  if (options.action === 'check') {
    const inventory = collectReleaseDependencyInventory({
      appDirectory,
      repositoryDirectory,
      strict: options.channel !== 'dev',
    });
    console.log(
      `[release-attribution] ${inventory.entries.length} dependencies; ${inventory.blockers.length} blocker(s); Nucleo=${inventory.nucleo.status}`,
    );
    return;
  }
  const outputDirectory = path.resolve(
    appDirectory,
    options.output ?? path.join('.generated', ATTRIBUTION_DIRECTORY_NAME),
  );
  const result = prepareReleaseAttributionBundle({
    appDirectory,
    outputDirectory,
    releaseChannel: options.channel,
    repositoryDirectory,
  });
  console.log(
    `[release-attribution] Prepared ${result.manifest.dependencyCount} dependencies at ${outputDirectory}`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(
      `[release-attribution] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
