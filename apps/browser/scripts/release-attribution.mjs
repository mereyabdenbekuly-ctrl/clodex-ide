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

export const ATTRIBUTION_DIRECTORY_NAME = 'release-attribution';
export const NUCLEO_EVIDENCE_RELATIVE_PATH =
  'docs/provenance/NUCLEO_REDISTRIBUTION_EVIDENCE.json';
export const LICENSE_OVERRIDE_REGISTRY_RELATIVE_PATH =
  'docs/provenance/DEPENDENCY_LICENSE_OVERRIDES.json';

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

async function sha256File(filePath) {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function isBuildOnly(packageName) {
  return BUILD_ONLY_PATTERNS.some((pattern) => pattern.test(packageName));
}

function isNucleoPackage(packageName) {
  return packageName.startsWith('nucleo-');
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
      typeof record?.packageSource?.tarball !== 'string' ||
      !record.packageSource.tarball.trim() ||
      typeof record?.packageSource?.integrity !== 'string' ||
      !record.packageSource.integrity.trim()
    ) {
      recordBlockers.push({
        code: 'LICENSE_OVERRIDE_PACKAGE_SOURCE_INVALID',
        message: `${identity} override has no exact npm tarball/integrity provenance.`,
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

function makeOpenSourceEntry({
  licenseOverride,
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
      !Array.isArray(evidence.sourceReferences) ||
      evidence.sourceReferences.length === 0
    ) {
      blockers.push({
        code: 'PACKAGE_LICENSE_EVIDENCE_INVALID',
        message: `${entry.name}@${entry.version} has invalid reviewed license evidence metadata.`,
      });
    }
  }
  return blockers;
}

export function collectReleaseDependencyInventory({
  appDirectory,
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
  const entries = [];
  const blockers = [...licenseOverrides.blockers];
  const nucleoPackageNames = new Set();

  while (queue.length > 0) {
    const request = queue.shift();
    const manifestPath = resolvePackageManifest(
      request.requesterManifestPath,
      request.packageName,
    );
    if (!manifestPath) {
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
  appDirectory,
  outputDirectory,
  releaseChannel = 'dev',
  repositoryDirectory,
  now = new Date(),
}) {
  const strict = releaseChannel !== 'dev';
  const inventory = collectReleaseDependencyInventory({
    appDirectory,
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
    manifest.licenseOverrideAppliedCount !==
      inventory.licenseOverrides.appliedCount ||
    manifest.licenseOverrideEntryCount !==
      inventory.licenseOverrides.entryCount ||
    manifest.licenseOverrideStatus !== inventory.licenseOverrides.status
  ) {
    throw new Error(
      'Attribution manifest license-override metadata does not match the dependency inventory.',
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

export async function writeFinalArtifactSbom({
  applicationDirectory,
  appName,
  appVersion,
  arch,
  attribution,
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

  const components = attribution.inventory.entries.map((entry) => ({
    type: entry.kind === 'commercial_asset' ? 'library' : 'library',
    'bom-ref': componentReference(entry),
    name: entry.name,
    version: entry.version,
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
    ],
  }));
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
  };
  writeJson(outputPath, sbom);
  return {
    bytes: statSync(outputPath).size,
    componentCount: components.length,
    nativePackageCount: nativePackages.length,
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
