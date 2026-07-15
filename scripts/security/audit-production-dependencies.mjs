#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const NPM_BULK_ADVISORY_ENDPOINT =
  'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';

export const DOCUMENTED_RESIDUALS = [];
export const AUDITED_DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
]);

const REQUIRED_LOCKFILE_VERSION = '9.0';
const EXACT_NPM_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const LINKED_DEPENDENCY_PATTERN = /^(?:link|workspace):/u;
const NPM_ALIAS_PREFIX = 'npm:';
const SHA512_INTEGRITY_PATTERN = /^sha512-([A-Za-z0-9+/]{86}==)$/u;

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseArguments(values) {
  const options = {};
  for (const value of values) {
    if (value === '--') continue;
    if (value.startsWith('--report=')) {
      options.report = value.slice('--report='.length);
    } else {
      fail(`Unknown dependency-audit argument: ${value}`);
    }
  }
  return options;
}

function addVersion(inventory, name, version) {
  if (
    typeof name !== 'string' ||
    !name ||
    typeof version !== 'string' ||
    !version
  ) {
    fail('dependency inventory identity is missing');
  }
  if (!inventory.has(name)) inventory.set(name, new Set());
  inventory.get(name).add(version);
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJsonValue(child)]),
  );
}

function versionCount(inventory) {
  return [...inventory.values()].reduce(
    (count, versions) => count + versions.size,
    0,
  );
}

function targetKey(name, version) {
  return `${name}\u0000${version}`;
}

function validatePackageName(name, label) {
  if (
    typeof name !== 'string' ||
    !name ||
    /\s/u.test(name) ||
    (name.startsWith('@')
      ? !/^@[^/@]+\/[^/@]+$/u.test(name)
      : name.includes('@') || name.includes('/'))
  ) {
    fail(`${label} package name is invalid: ${name ?? '<missing>'}`);
  }
  return name;
}

function packageLocatorSeparator(locator) {
  if (locator.startsWith('@')) {
    const slash = locator.indexOf('/');
    return slash > 1 ? locator.indexOf('@', slash + 1) : -1;
  }
  return locator.indexOf('@');
}

function parsePackageLocator(locator, label = 'pnpm lockfile package') {
  if (typeof locator !== 'string' || !locator) {
    fail(`${label} locator is missing`);
  }
  const separator = packageLocatorSeparator(locator);
  if (separator <= 0 || separator === locator.length - 1) {
    fail(`${label} locator is invalid: ${locator}`);
  }
  const name = validatePackageName(
    locator.slice(0, separator),
    `${label} locator`,
  );
  return { name, resolved: locator.slice(separator + 1) };
}

function splitResolvedNpmVersion(value, label) {
  if (typeof value !== 'string' || !value) {
    fail(`${label} resolved version is missing`);
  }
  const suffixStart = value.indexOf('(');
  const version = suffixStart === -1 ? value : value.slice(0, suffixStart);
  if (!EXACT_NPM_VERSION_PATTERN.test(version)) {
    fail(`${label} resolved version is unsupported: ${value}`);
  }
  if (suffixStart !== -1) {
    const suffix = value.slice(suffixStart);
    if (suffix.includes('patch_hash=')) {
      fail(`${label} patched dependency is outside the npm advisory identity`);
    }
    let depth = 0;
    for (const character of suffix) {
      if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
      if (depth < 0) fail(`${label} peer suffix is invalid: ${value}`);
    }
    if (depth !== 0 || !suffix.endsWith(')')) {
      fail(`${label} peer suffix is invalid: ${value}`);
    }
  }
  return { resolvedReference: value, version };
}

function isResolvedNpmVersionReference(value) {
  if (typeof value !== 'string') return false;
  const suffixStart = value.indexOf('(');
  const version = suffixStart === -1 ? value : value.slice(0, suffixStart);
  return EXACT_NPM_VERSION_PATTERN.test(version);
}

export function parseNpmAliasSpecifier(specifier) {
  if (
    typeof specifier !== 'string' ||
    !specifier.startsWith(NPM_ALIAS_PREFIX)
  ) {
    fail(`npm alias specifier is invalid: ${specifier ?? '<missing>'}`);
  }
  const locator = specifier.slice(NPM_ALIAS_PREFIX.length);
  if (packageLocatorSeparator(locator) === -1) {
    return {
      targetName: validatePackageName(locator, 'npm alias'),
      targetSpecifier: null,
    };
  }
  const parsed = parsePackageLocator(locator, 'npm alias');
  if (!parsed.resolved) fail(`npm alias target is missing: ${specifier}`);
  return { targetName: parsed.name, targetSpecifier: parsed.resolved };
}

function validateSha512Integrity(integrity, locator) {
  const match =
    typeof integrity === 'string'
      ? SHA512_INTEGRITY_PATTERN.exec(integrity)
      : null;
  if (!match) {
    fail(`registry lock package has no valid sha512 integrity: ${locator}`);
  }
  const decoded = Buffer.from(match[1], 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== match[1]) {
    fail(`registry lock package has invalid sha512 integrity: ${locator}`);
  }
}

function parseLockfile(lockfileText) {
  if (typeof lockfileText !== 'string' || !lockfileText.trim()) {
    fail('pnpm lockfile text is empty');
  }
  let lockfile;
  try {
    lockfile = parseYaml(lockfileText);
  } catch {
    fail('pnpm lockfile is invalid YAML');
  }
  if (!isPlainObject(lockfile)) fail('pnpm lockfile is missing or invalid');
  if (lockfile.lockfileVersion !== REQUIRED_LOCKFILE_VERSION) {
    fail(
      `pnpm lockfileVersion must be exactly ${REQUIRED_LOCKFILE_VERSION}; got ${lockfile.lockfileVersion ?? '<missing>'}`,
    );
  }
  if (
    lockfile.patchedDependencies !== undefined &&
    (!isPlainObject(lockfile.patchedDependencies) ||
      Object.keys(lockfile.patchedDependencies).length > 0)
  ) {
    fail('pnpm patchedDependencies must be empty for the release audit');
  }
  return lockfile;
}

export function dependencyInventoryDigest(inventory) {
  return sha256Json(
    Object.fromEntries(
      [...inventory]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, versions]) => [name, [...versions].sort()]),
    ),
  );
}

function observedTargetIdentity(declaredName, dependency, label) {
  const identities = [];
  for (const field of ['from', 'name']) {
    if (dependency[field] === undefined) continue;
    identities.push(
      validatePackageName(dependency[field], `${label} ${field}`),
    );
  }
  if (new Set(identities).size > 1) {
    fail(`${label} observed from/name identity drift`);
  }
  return identities[0] ?? validatePackageName(declaredName, label);
}

function visitDependencyTree(pnpmList, visitor) {
  if (!Array.isArray(pnpmList)) fail('pnpm release list must be an array');
  const visit = (dependencies, workspace) => {
    if (dependencies === undefined) return;
    if (!isPlainObject(dependencies)) {
      fail('pnpm dependency category must be an object');
    }
    for (const [declaredName, dependency] of Object.entries(dependencies)) {
      if (!declaredName || !isPlainObject(dependency)) {
        fail(
          `pnpm dependency record is invalid: ${declaredName || '<missing>'}`,
        );
      }
      if (typeof dependency.version !== 'string' || !dependency.version) {
        fail(`pnpm dependency version is missing: ${declaredName}`);
      }
      visitor({ declaredName, dependency, workspace });
      for (const field of AUDITED_DEPENDENCY_FIELDS) {
        visit(dependency[field], workspace);
      }
    }
  };
  for (const workspace of pnpmList) {
    for (const field of AUDITED_DEPENDENCY_FIELDS) {
      visit(workspace?.[field], workspace);
    }
  }
}

export function collectDependencyInventory(pnpmList) {
  const inventory = new Map();
  visitDependencyTree(pnpmList, ({ declaredName, dependency }) => {
    if (dependency.version.startsWith('file:')) {
      fail(
        `local file dependency is outside the advisory model: ${declaredName}`,
      );
    }
    if (LINKED_DEPENDENCY_PATTERN.test(dependency.version)) return;
    const name = observedTargetIdentity(
      declaredName,
      dependency,
      `pnpm dependency ${declaredName}`,
    );
    if (!EXACT_NPM_VERSION_PATTERN.test(dependency.version)) {
      fail(
        `dependency version is not an exact npm version: ${name}@${dependency.version}`,
      );
    }
    addVersion(inventory, name, dependency.version);
  });
  if (inventory.size === 0 || versionCount(inventory) === 0) {
    fail('pnpm release dependency inventory is empty');
  }
  return inventory;
}

function multiplicityRecords(multiplicity) {
  return [...multiplicity]
    .map(([key, count]) => {
      const [name, version] = key.split('\u0000');
      return { count, name, version };
    })
    .sort((left, right) =>
      `${left.name}\u0000${left.version}`.localeCompare(
        `${right.name}\u0000${right.version}`,
      ),
    );
}

export function collectLockfileDependencyInventory(lockfileText) {
  const lockfile = parseLockfile(lockfileText);
  if (!isPlainObject(lockfile.packages)) {
    fail('pnpm lockfile packages are missing or invalid');
  }
  if (!isPlainObject(lockfile.snapshots)) {
    fail('pnpm lockfile snapshots are missing or invalid');
  }

  const inventory = new Map();
  const packageRecords = [];
  const packageTargetByLocator = new Map();
  const packageLocators = Object.keys(lockfile.packages).sort();
  for (const locator of packageLocators) {
    const metadata = lockfile.packages[locator];
    if (!isPlainObject(metadata)) {
      fail(`pnpm lockfile package metadata is invalid: ${locator}`);
    }
    if (!isPlainObject(metadata.resolution)) {
      fail(`pnpm lockfile package resolution is invalid: ${locator}`);
    }
    const parsed = parsePackageLocator(locator);
    if (!EXACT_NPM_VERSION_PATTERN.test(parsed.resolved)) {
      fail(
        `pnpm lockfile sourceLocatorCount must be 0; unsupported locator: ${locator}`,
      );
    }
    if (Object.hasOwn(metadata.resolution, 'tarball')) {
      fail(`registry lock package must not declare a tarball: ${locator}`);
    }
    validateSha512Integrity(metadata.resolution.integrity, locator);
    addVersion(inventory, parsed.name, parsed.resolved);
    packageTargetByLocator.set(locator, {
      name: parsed.name,
      version: parsed.resolved,
    });
    packageRecords.push({
      integrity: metadata.resolution.integrity,
      locator,
      name: parsed.name,
      version: parsed.resolved,
    });
  }

  const snapshotRecords = [];
  const expectedPathMultiplicity = new Map();
  const snapshotLocators = Object.keys(lockfile.snapshots).sort();
  const snapshotLocatorSet = new Set(snapshotLocators);
  for (const locator of snapshotLocators) {
    const metadata = lockfile.snapshots[locator];
    if (!isPlainObject(metadata)) {
      fail(`pnpm lockfile snapshot metadata is invalid: ${locator}`);
    }
    const parsed = parsePackageLocator(locator, 'pnpm lockfile snapshot');
    const resolved = splitResolvedNpmVersion(
      parsed.resolved,
      `pnpm lockfile snapshot ${locator}`,
    );
    const packageLocator = `${parsed.name}@${resolved.version}`;
    const target = packageTargetByLocator.get(packageLocator);
    if (!target) {
      fail(`pnpm registry snapshot has no package record: ${locator}`);
    }
    const key = targetKey(target.name, target.version);
    expectedPathMultiplicity.set(
      key,
      (expectedPathMultiplicity.get(key) ?? 0) + 1,
    );
    snapshotRecords.push({
      locator,
      metadata: canonicalJsonValue(metadata),
      name: target.name,
      version: target.version,
    });
    for (const field of ['dependencies', 'optionalDependencies']) {
      const dependencies = metadata[field] ?? {};
      if (!isPlainObject(dependencies)) {
        fail(`pnpm snapshot ${locator} ${field} must be an object`);
      }
      for (const [declaredName, reference] of Object.entries(dependencies)) {
        if (typeof reference !== 'string' || !reference) {
          fail(`pnpm snapshot ${locator} has an invalid ${field} reference`);
        }
        let targetLocator;
        if (isResolvedNpmVersionReference(reference)) {
          splitResolvedNpmVersion(
            reference,
            `pnpm snapshot ${locator} ${field} ${declaredName}`,
          );
          targetLocator = `${declaredName}@${reference}`;
        } else {
          const aliasTarget = parsePackageLocator(
            reference,
            `pnpm snapshot ${locator} ${field} ${declaredName}`,
          );
          splitResolvedNpmVersion(
            aliasTarget.resolved,
            `pnpm snapshot ${locator} ${field} ${declaredName}`,
          );
          targetLocator = reference;
        }
        if (!snapshotLocatorSet.has(targetLocator)) {
          fail(
            `pnpm snapshot ${locator} ${field} reference has no snapshot: ${targetLocator}`,
          );
        }
      }
    }
  }

  for (const target of packageTargetByLocator.values()) {
    if (!expectedPathMultiplicity.has(targetKey(target.name, target.version))) {
      fail(`pnpm package has no snapshot: ${target.name}@${target.version}`);
    }
  }
  if (
    packageLocators.length === 0 ||
    snapshotLocators.length === 0 ||
    inventory.size === 0 ||
    versionCount(inventory) === 0
  ) {
    fail('pnpm lockfile package inventory is empty');
  }

  const expectedMultiplicityRecords = multiplicityRecords(
    expectedPathMultiplicity,
  );
  return {
    expectedPathMultiplicity,
    expectedPathMultiplicitySha256: sha256Json(expectedMultiplicityRecords),
    inventory,
    packageLocatorCount: packageLocators.length,
    packageLocatorSha256: sha256Json(packageRecords),
    snapshotCount: snapshotLocators.length,
    snapshotSha256: sha256Json(snapshotRecords),
    sourceLocatorCount: 0,
  };
}

function flattenedInventory(inventory) {
  return [...inventory]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, versions]) =>
      [...versions].sort().map((version) => `${name}@${version}`),
    );
}

function normalizeImporterKey(importerPath) {
  if (
    typeof importerPath !== 'string' ||
    !importerPath ||
    importerPath.includes('\\') ||
    path.posix.isAbsolute(importerPath) ||
    path.posix.normalize(importerPath) !== importerPath ||
    importerPath === '..' ||
    importerPath.startsWith('../')
  ) {
    fail(`pnpm lockfile importer path is invalid: ${importerPath}`);
  }
  return importerPath;
}

function canonicalInsideRepository(repositoryRealPath, candidatePath, label) {
  let candidateRealPath;
  try {
    candidateRealPath = realpathSync(candidatePath);
  } catch {
    fail(`${label} does not resolve to an existing path: ${candidatePath}`);
  }
  const relativePath = path.relative(repositoryRealPath, candidateRealPath);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    fail(`${label} escapes the repository: ${candidatePath}`);
  }
  return candidateRealPath;
}

function repositoryRelativePath(repositoryRealPath, candidateRealPath) {
  const relativePath = path
    .relative(repositoryRealPath, candidateRealPath)
    .split(path.sep)
    .join('/');
  return relativePath || '.';
}

function readWorkspaceManifest(workspaceDirectory, importerPath) {
  const packageJsonPath = path.join(workspaceDirectory, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    fail(`workspace package metadata is invalid: ${importerPath}/package.json`);
  }
  if (!isPlainObject(manifest)) {
    fail(`workspace package metadata is invalid: ${importerPath}/package.json`);
  }
  validatePackageName(manifest.name, `workspace ${importerPath}`);
  return manifest;
}

function dependencyNames(record, field) {
  const dependencies = record?.[field] ?? {};
  if (!isPlainObject(dependencies)) {
    fail(`dependency category ${field} must be an object`);
  }
  return Object.keys(dependencies).sort();
}

function buildWorkspaceTopology({ lockfile, pnpmList, repositoryDirectory }) {
  if (!isPlainObject(lockfile.importers)) {
    fail('pnpm lockfile importers are missing or invalid');
  }
  if (!Array.isArray(pnpmList) || pnpmList.length === 0) {
    fail('pnpm release list is empty');
  }
  let repositoryRealPath;
  try {
    repositoryRealPath = realpathSync(repositoryDirectory);
  } catch {
    fail(`repository directory is invalid: ${repositoryDirectory}`);
  }

  const observedByImporter = new Map();
  for (const workspace of pnpmList) {
    if (!isPlainObject(workspace) || typeof workspace.path !== 'string') {
      fail('pnpm workspace record or path is invalid');
    }
    const workspaceRealPath = canonicalInsideRepository(
      repositoryRealPath,
      workspace.path,
      'pnpm workspace',
    );
    const importerPath = repositoryRelativePath(
      repositoryRealPath,
      workspaceRealPath,
    );
    if (observedByImporter.has(importerPath)) {
      fail(`pnpm release list duplicates importer ${importerPath}`);
    }
    observedByImporter.set(importerPath, { workspace, workspaceRealPath });
  }

  const expectedImporterPaths = Object.keys(lockfile.importers)
    .map(normalizeImporterKey)
    .sort();
  const observedImporterPaths = [...observedByImporter.keys()].sort();
  if (
    JSON.stringify(observedImporterPaths) !==
    JSON.stringify(expectedImporterPaths)
  ) {
    fail(
      `pnpm release list importer drift: expected ${expectedImporterPaths.join(', ')}; got ${observedImporterPaths.join(', ')}`,
    );
  }

  const byCanonicalPath = new Map();
  const byName = new Map();
  for (const importerPath of expectedImporterPaths) {
    const expectedDirectory = path.resolve(
      repositoryRealPath,
      importerPath === '.' ? '' : importerPath,
    );
    const workspaceRealPath = canonicalInsideRepository(
      repositoryRealPath,
      expectedDirectory,
      `pnpm importer ${importerPath}`,
    );
    if (
      repositoryRelativePath(repositoryRealPath, workspaceRealPath) !==
      importerPath
    ) {
      fail(`pnpm importer path is not canonical: ${importerPath}`);
    }
    const observed = observedByImporter.get(importerPath);
    if (observed.workspaceRealPath !== workspaceRealPath) {
      fail(`pnpm workspace path drift for importer ${importerPath}`);
    }
    const manifest = readWorkspaceManifest(workspaceRealPath, importerPath);
    if (observed.workspace.name !== manifest.name) {
      fail(
        `pnpm workspace name drift for ${importerPath}: expected ${manifest.name}; got ${observed.workspace.name ?? '<missing>'}`,
      );
    }
    if (byCanonicalPath.has(workspaceRealPath)) {
      fail(`duplicate canonical workspace path: ${importerPath}`);
    }
    if (byName.has(manifest.name)) {
      fail(`duplicate workspace package name: ${manifest.name}`);
    }
    const record = {
      importerPath,
      manifest,
      name: manifest.name,
      observed: observed.workspace,
      workspaceRealPath,
    };
    byCanonicalPath.set(workspaceRealPath, record);
    byName.set(manifest.name, record);
  }

  return {
    byCanonicalPath,
    byName,
    expectedImporterPaths,
    repositoryRealPath,
  };
}

function validateObservedIdentity(
  dependency,
  expectedTargetName,
  label,
  { requireExplicit = false } = {},
) {
  const identities = ['from', 'name']
    .filter((field) => dependency[field] !== undefined)
    .map((field) =>
      validatePackageName(dependency[field], `${label} ${field}`),
    );
  if (requireExplicit && identities.length === 0) {
    fail(`${label} alias target identity is missing`);
  }
  if (identities.some((name) => name !== expectedTargetName)) {
    fail(
      `${label} target identity drift: expected ${expectedTargetName}; got ${identities.join(', ') || '<missing>'}`,
    );
  }
}

function resolveWorkspaceLink({ importer, linkReference, topology, label }) {
  if (typeof linkReference !== 'string' || !linkReference.startsWith('link:')) {
    fail(`${label} must use a link: resolution`);
  }
  const relativeTarget = linkReference.slice('link:'.length);
  if (
    !relativeTarget ||
    relativeTarget.includes('\\') ||
    path.posix.isAbsolute(relativeTarget) ||
    path.posix.normalize(relativeTarget) !== relativeTarget
  ) {
    fail(`${label} link target is not canonical: ${linkReference}`);
  }
  const targetRealPath = canonicalInsideRepository(
    topology.repositoryRealPath,
    path.resolve(importer.workspaceRealPath, relativeTarget),
    `${label} link target`,
  );
  const target = topology.byCanonicalPath.get(targetRealPath);
  if (!target) {
    fail(`${label} links to a non-workspace path: ${linkReference}`);
  }
  return target;
}

function parseExpectedDirectTarget(name, dependency, label) {
  if (dependency.specifier.startsWith(NPM_ALIAS_PREFIX)) {
    const alias = parseNpmAliasSpecifier(dependency.specifier);
    const locked = parsePackageLocator(
      dependency.version,
      `${label} npm alias resolution`,
    );
    const resolved = splitResolvedNpmVersion(
      locked.resolved,
      `${label} npm alias resolution`,
    );
    if (locked.name !== alias.targetName) {
      fail(
        `${label} npm alias target drift: expected ${alias.targetName}; got ${locked.name}`,
      );
    }
    return {
      alias: true,
      targetName: alias.targetName,
      targetVersion: resolved.version,
    };
  }
  const resolved = splitResolvedNpmVersion(
    dependency.version,
    `${label} lock resolution`,
  );
  return { alias: false, targetName: name, targetVersion: resolved.version };
}

export function validateDependencyListCoverage({
  lockfileText,
  pnpmList,
  repositoryDirectory,
}) {
  const lockfile = parseLockfile(lockfileText);
  const topology = buildWorkspaceTopology({
    lockfile,
    pnpmList,
    repositoryDirectory,
  });
  let directDependencyCount = 0;
  let manifestDependencyCount = 0;
  const directDependencyRecords = [];
  const manifestDependencyRecords = [];
  const workspaceLinkRecords = [];

  for (const importerPath of topology.expectedImporterPaths) {
    const expected = lockfile.importers[importerPath];
    const importer = topology.byCanonicalPath.get(
      canonicalInsideRepository(
        topology.repositoryRealPath,
        path.resolve(
          topology.repositoryRealPath,
          importerPath === '.' ? '' : importerPath,
        ),
        `pnpm importer ${importerPath}`,
      ),
    );
    const observed = importer.observed;
    for (const field of AUDITED_DEPENDENCY_FIELDS) {
      const expectedNames = dependencyNames(expected, field);
      const observedNames = dependencyNames(observed, field);
      const manifestDependencies = importer.manifest[field] ?? {};
      if (!isPlainObject(manifestDependencies)) {
        fail(`workspace ${importerPath} ${field} must be an object`);
      }
      for (const [name, specifier] of Object.entries(manifestDependencies).sort(
        ([left], [right]) => left.localeCompare(right),
      )) {
        if (typeof specifier !== 'string' || !specifier) {
          fail(
            `workspace manifest dependency is invalid for ${importerPath} ${field} ${name}`,
          );
        }
        manifestDependencyCount += 1;
        manifestDependencyRecords.push({
          field,
          importer: importerPath,
          name,
          specifier,
        });
        if (specifier.startsWith('workspace:')) {
          const locked = expected?.[field]?.[name];
          if (
            specifier !== 'workspace:*' ||
            !isPlainObject(locked) ||
            locked.specifier !== 'workspace:*' ||
            typeof locked.version !== 'string' ||
            !locked.version.startsWith('link:')
          ) {
            fail(
              `workspace manifest link must be an exact workspace:* lock binding for ${importerPath} ${field} ${name}`,
            );
          }
        }
      }

      directDependencyCount += expectedNames.length;
      if (JSON.stringify(observedNames) !== JSON.stringify(expectedNames)) {
        fail(
          `pnpm release list direct dependency drift for ${importerPath} ${field}: expected ${expectedNames.join(', ')}; got ${observedNames.join(', ')}`,
        );
      }
      for (const name of expectedNames) {
        const expectedDependency = expected[field][name];
        const observedDependency = observed[field][name];
        const label = `pnpm ${importerPath} ${field} ${name}`;
        if (
          !isPlainObject(expectedDependency) ||
          typeof expectedDependency.specifier !== 'string' ||
          !expectedDependency.specifier ||
          typeof expectedDependency.version !== 'string' ||
          !expectedDependency.version
        ) {
          fail(`pnpm lockfile direct dependency is invalid for ${label}`);
        }
        if (!isPlainObject(observedDependency)) {
          fail(
            `pnpm release list direct dependency record is invalid for ${label}`,
          );
        }

        if (expectedDependency.version.startsWith('link:')) {
          if (
            expectedDependency.specifier !== 'workspace:*' ||
            importer.manifest[field]?.[name] !== 'workspace:*'
          ) {
            fail(`${label} workspace link must be declared as workspace:*`);
          }
          const target = resolveWorkspaceLink({
            importer,
            label,
            linkReference: expectedDependency.version,
            topology,
          });
          if (target.name !== name) {
            fail(
              `${label} workspace target name drift: expected ${name}; got ${target.name}`,
            );
          }
          if (observedDependency.version !== expectedDependency.version) {
            fail(
              `${label} workspace link drift: expected ${expectedDependency.version}; got ${observedDependency.version}`,
            );
          }
          const observedTargetPath = canonicalInsideRepository(
            topology.repositoryRealPath,
            observedDependency.path,
            `${label} observed workspace path`,
          );
          if (observedTargetPath !== target.workspaceRealPath) {
            fail(
              `${label} observed workspace path does not match the lock target`,
            );
          }
          validateObservedIdentity(observedDependency, target.name, label, {
            requireExplicit: true,
          });
          workspaceLinkRecords.push({
            field,
            importer: importerPath,
            name,
            targetImporter: target.importerPath,
            targetName: target.name,
          });
          directDependencyRecords.push({
            field,
            importer: importerPath,
            name,
            resolvedReference: expectedDependency.version,
            specifier: expectedDependency.specifier,
            targetName: target.name,
            targetVersion: null,
          });
          continue;
        }

        if (
          expectedDependency.specifier.startsWith('workspace:') ||
          LINKED_DEPENDENCY_PATTERN.test(observedDependency.version)
        ) {
          fail(`${label} has an unsupported workspace/link resolution`);
        }
        const target = parseExpectedDirectTarget(
          name,
          expectedDependency,
          label,
        );
        const observedVersion = splitResolvedNpmVersion(
          observedDependency.version,
          `${label} observed`,
        ).version;
        if (observedVersion !== target.targetVersion) {
          fail(
            `pnpm release list direct dependency version drift for ${importerPath} ${field} ${name}: expected ${target.targetVersion}; got ${observedVersion}`,
          );
        }
        validateObservedIdentity(observedDependency, target.targetName, label, {
          requireExplicit: target.alias,
        });
        directDependencyRecords.push({
          field,
          importer: importerPath,
          name,
          resolvedReference: expectedDependency.version,
          specifier: expectedDependency.specifier,
          targetName: target.targetName,
          targetVersion: target.targetVersion,
        });
      }
    }
  }
  if (directDependencyCount === 0) {
    fail('pnpm lockfile direct dependency inventory is empty');
  }
  return {
    dependencyFields: [...AUDITED_DEPENDENCY_FIELDS],
    directDependencyCount,
    directDependencySha256: sha256Json(directDependencyRecords),
    importerCount: topology.expectedImporterPaths.length,
    manifestDependencyCount,
    manifestDependencySha256: sha256Json(manifestDependencyRecords),
    workspaceLinkCount: workspaceLinkRecords.length,
    workspaceLinkSha256: sha256Json(workspaceLinkRecords),
  };
}

function canonicalRegistryTarball(name, version) {
  const tarballName = name.startsWith('@')
    ? name.slice(name.indexOf('/') + 1)
    : name;
  return `https://registry.npmjs.org/${name}/-/${tarballName}-${version}.tgz`;
}

function validateObservedDependencyGraph({
  lockfileText,
  pnpmList,
  repositoryDirectory,
}) {
  const topology = buildWorkspaceTopology({
    lockfile: parseLockfile(lockfileText),
    pnpmList,
    repositoryDirectory,
  });
  const inventory = new Map();
  const pathsByTarget = new Map();
  const ownerByPath = new Map();
  visitDependencyTree(pnpmList, ({ declaredName, dependency, workspace }) => {
    const workspaceRealPath = canonicalInsideRepository(
      topology.repositoryRealPath,
      workspace.path,
      'pnpm workspace',
    );
    if (dependency.version.startsWith('file:')) {
      fail(
        `local file dependency is outside the advisory model: ${declaredName}`,
      );
    }
    if (LINKED_DEPENDENCY_PATTERN.test(dependency.version)) {
      const importer = topology.byCanonicalPath.get(workspaceRealPath);
      const target = resolveWorkspaceLink({
        importer,
        label: `pnpm observed link ${declaredName}`,
        linkReference: dependency.version,
        topology,
      });
      const observedPath = canonicalInsideRepository(
        topology.repositoryRealPath,
        dependency.path,
        `pnpm observed link ${declaredName} path`,
      );
      if (observedPath !== target.workspaceRealPath) {
        fail(`pnpm observed link ${declaredName} path drift`);
      }
      validateObservedIdentity(
        dependency,
        target.name,
        `pnpm observed link ${declaredName}`,
        { requireExplicit: true },
      );
      return;
    }

    const name = observedTargetIdentity(
      declaredName,
      dependency,
      `pnpm dependency ${declaredName}`,
    );
    if (!EXACT_NPM_VERSION_PATTERN.test(dependency.version)) {
      fail(
        `dependency version is not an exact npm version: ${name}@${dependency.version}`,
      );
    }
    const key = targetKey(name, dependency.version);
    const expectedResolution = canonicalRegistryTarball(
      name,
      dependency.version,
    );
    if (dependency.resolved !== expectedResolution) {
      fail(
        `pnpm dependency resolved URL drift for ${name}@${dependency.version}: expected ${expectedResolution}; got ${dependency.resolved ?? '<missing>'}`,
      );
    }
    if (
      typeof dependency.path !== 'string' ||
      !path.isAbsolute(dependency.path)
    ) {
      fail(`pnpm dependency path is invalid for ${name}@${dependency.version}`);
    }
    const normalizedPath = path.resolve(dependency.path);
    const relativePath = path
      .relative(topology.repositoryRealPath, normalizedPath)
      .split(path.sep)
      .join('/');
    if (
      relativePath === '..' ||
      relativePath.startsWith('../') ||
      !relativePath.startsWith('node_modules/.pnpm/') ||
      !relativePath.endsWith(`/node_modules/${name}`)
    ) {
      fail(
        `pnpm dependency path is non-canonical for ${name}@${dependency.version}`,
      );
    }
    addVersion(inventory, name, dependency.version);
    const existingOwner = ownerByPath.get(normalizedPath);
    if (existingOwner && existingOwner !== key) {
      const [existingName, existingVersion] = existingOwner.split('\u0000');
      fail(
        `pnpm dependency path collision: ${normalizedPath} is shared by ${existingName}@${existingVersion} and ${name}@${dependency.version}`,
      );
    }
    ownerByPath.set(normalizedPath, key);
    if (!pathsByTarget.has(key)) pathsByTarget.set(key, new Set());
    pathsByTarget.get(key).add(normalizedPath);
  });
  if (inventory.size === 0 || versionCount(inventory) === 0) {
    fail('pnpm release dependency inventory is empty');
  }
  return { inventory, pathCount: ownerByPath.size, pathsByTarget };
}

function compareInventory(expectedInventory, observedInventory) {
  const expectedEntries = flattenedInventory(expectedInventory);
  const observedEntries = flattenedInventory(observedInventory);
  if (JSON.stringify(observedEntries) === JSON.stringify(expectedEntries))
    return;
  const expected = new Set(expectedEntries);
  const observed = new Set(observedEntries);
  const missing = expectedEntries.filter((entry) => !observed.has(entry));
  const excess = observedEntries.filter((entry) => !expected.has(entry));
  fail(
    `pnpm release list lock package closure drift: missing ${missing.slice(0, 5).join(', ') || '<none>'}; excess ${excess.slice(0, 5).join(', ') || '<none>'}`,
  );
}

export function validateDependencyInventoryCoverage({
  lockfileText,
  pnpmList,
  repositoryDirectory,
}) {
  const lockInventory = collectLockfileDependencyInventory(lockfileText);
  const observed = validateObservedDependencyGraph({
    lockfileText,
    pnpmList,
    repositoryDirectory,
  });
  compareInventory(lockInventory.inventory, observed.inventory);

  const observedMultiplicity = new Map(
    [...observed.pathsByTarget].map(([key, paths]) => [key, paths.size]),
  );
  const expectedRecords = multiplicityRecords(
    lockInventory.expectedPathMultiplicity,
  );
  const observedRecords = multiplicityRecords(observedMultiplicity);
  if (JSON.stringify(observedRecords) !== JSON.stringify(expectedRecords)) {
    const expected = new Map(
      expectedRecords.map((record) => [
        targetKey(record.name, record.version),
        record.count,
      ]),
    );
    const observedCounts = new Map(
      observedRecords.map((record) => [
        targetKey(record.name, record.version),
        record.count,
      ]),
    );
    const drift = [...new Set([...expected.keys(), ...observedCounts.keys()])]
      .sort()
      .filter((key) => expected.get(key) !== observedCounts.get(key))
      .slice(0, 5)
      .map((key) => {
        const [name, version] = key.split('\u0000');
        return `${name}@${version} expected ${expected.get(key) ?? 0}, got ${observedCounts.get(key) ?? 0}`;
      });
    fail(`pnpm snapshot path multiplicity drift: ${drift.join('; ')}`);
  }

  return {
    expectedPathMultiplicitySha256:
      lockInventory.expectedPathMultiplicitySha256,
    inventory: lockInventory.inventory,
    observedInventorySha256: dependencyInventoryDigest(observed.inventory),
    observedPathCount: observed.pathCount,
    observedPathMultiplicitySha256: sha256Json(observedRecords),
    packageLocatorCount: lockInventory.packageLocatorCount,
    packageLocatorSha256: lockInventory.packageLocatorSha256,
    snapshotCount: lockInventory.snapshotCount,
    snapshotSha256: lockInventory.snapshotSha256,
    sourceLocatorCount: lockInventory.sourceLocatorCount,
  };
}

function advisoryIdentity(advisory) {
  return `${advisory?.url ?? ''}\u0000${advisory?.title ?? ''}`;
}

async function fetchJsonEndpoint(endpoint, options, fetchImpl, serviceName) {
  let response;
  try {
    response = await fetchImpl(endpoint, options);
  } catch (error) {
    fail(
      `${serviceName} endpoint request failed: ${error instanceof Error ? error.message : error}`,
    );
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail(`${serviceName} endpoint returned invalid JSON`);
  }
  if (!response.ok || !isPlainObject(payload)) {
    fail(
      `${serviceName} endpoint failed with HTTP ${response.status ?? '<missing>'}`,
    );
  }
  return payload;
}

async function postBulkAudit(body, fetchImpl) {
  return fetchJsonEndpoint(
    NPM_BULK_ADVISORY_ENDPOINT,
    {
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'clodex-release-dependency-audit/1',
      },
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
    },
    fetchImpl,
    'npm bulk advisory',
  );
}

function validateNpmAdvisory(advisory, name) {
  if (
    !isPlainObject(advisory) ||
    typeof advisory.severity !== 'string' ||
    !advisory.severity ||
    typeof advisory.title !== 'string' ||
    !advisory.title ||
    typeof advisory.url !== 'string' ||
    !advisory.url
  ) {
    fail(`npm advisory response is invalid for ${name}`);
  }
}

export async function queryAdvisories(inventory, fetchImpl = fetch) {
  if (!(inventory instanceof Map) || inventory.size === 0) {
    fail('npm advisory inventory is empty');
  }
  const request = Object.fromEntries(
    [...inventory]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, versions]) => [name, [...versions].sort()]),
  );
  const response = await postBulkAudit(request, fetchImpl);
  const findings = [];
  for (const [name, advisories] of Object.entries(response)) {
    if (!inventory.has(name) || !Array.isArray(advisories)) {
      fail(`npm advisory response is invalid for ${name}`);
    }
    const versions = [...inventory.get(name)].sort();
    for (const advisory of advisories) {
      validateNpmAdvisory(advisory, name);
      const affectedVersions = [];
      for (const version of versions) {
        const single = await postBulkAudit({ [name]: [version] }, fetchImpl);
        for (const responseName of Object.keys(single)) {
          if (responseName !== name || !Array.isArray(single[responseName])) {
            fail(`npm advisory response is invalid for ${responseName}`);
          }
        }
        const matching = Array.isArray(single[name])
          ? single[name].some((candidate) => {
              validateNpmAdvisory(candidate, name);
              return advisoryIdentity(candidate) === advisoryIdentity(advisory);
            })
          : false;
        if (matching) affectedVersions.push(version);
      }
      if (affectedVersions.length === 0) {
        fail(
          `npm advisory did not resolve to an exact locked version: ${name}`,
        );
      }
      findings.push({
        affectedVersions,
        name,
        severity: advisory.severity,
        title: advisory.title,
        url: advisory.url,
      });
    }
  }
  return findings.sort((left, right) =>
    `${left.name}\u0000${left.url}`.localeCompare(
      `${right.name}\u0000${right.url}`,
    ),
  );
}

export function evaluateFindings(findings, { now = new Date() } = {}) {
  const timeBoundResiduals = [];
  const blockers = [];
  for (const finding of findings) {
    const approval = DOCUMENTED_RESIDUALS.find(
      (candidate) =>
        candidate.name === finding.name &&
        candidate.severity === finding.severity &&
        candidate.url === finding.url &&
        JSON.stringify(candidate.affectedVersions) ===
          JSON.stringify(finding.affectedVersions),
    );
    if (!approval) {
      blockers.push({ ...finding, reasonCode: 'UNAPPROVED_ADVISORY' });
      continue;
    }
    if (now.getTime() >= new Date(approval.expiresAt).getTime()) {
      blockers.push({ ...finding, reasonCode: 'ADVISORY_EXCEPTION_EXPIRED' });
      continue;
    }
    timeBoundResiduals.push({ ...finding, expiresAt: approval.expiresAt });
  }
  return { blockers, timeBoundResiduals };
}

export function buildPnpmListInvocation({
  nodeExecutable = process.execPath,
  npmExecPath = process.env.npm_execpath,
  platform = process.platform,
} = {}) {
  if (platform === 'win32') {
    fail('run the lockfile dependency audit in the canonical Linux CI job');
  }
  return {
    command: npmExecPath ? nodeExecutable : 'pnpm',
    arguments: [
      ...(npmExecPath ? [npmExecPath] : []),
      'list',
      '-r',
      '--json',
      '--depth',
      'Infinity',
      '--lockfile-only',
    ],
  };
}

export function loadReleaseDependencyList({
  execFileSyncImpl = execFileSync,
  nodeExecutable,
  npmExecPath,
  platform,
} = {}) {
  const invocation = buildPnpmListInvocation({
    nodeExecutable,
    npmExecPath,
    platform,
  });
  const rawList = execFileSyncImpl(invocation.command, invocation.arguments, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const parsed = JSON.parse(rawList);
  if (!Array.isArray(parsed)) fail('pnpm release list must be an array');
  return parsed;
}

export async function buildDependencyAuditReport({
  fetchImpl = fetch,
  lockfileText,
  now = new Date(),
  pnpmList,
  repositoryDirectory,
}) {
  const coverage = validateDependencyListCoverage({
    lockfileText,
    pnpmList,
    repositoryDirectory,
  });
  const inventoryCoverage = validateDependencyInventoryCoverage({
    lockfileText,
    pnpmList,
    repositoryDirectory,
  });
  const npmFindings = await queryAdvisories(
    inventoryCoverage.inventory,
    fetchImpl,
  );
  const evaluated = evaluateFindings(npmFindings, { now });
  const blockers = evaluated.blockers;
  const inventory = inventoryCoverage.inventory;
  return {
    schemaVersion: 3,
    reportKind: 'release-dependency-audit',
    status: blockers.length === 0 ? 'passed' : 'blocked',
    generatedAt: now.toISOString(),
    endpoint: NPM_BULK_ADVISORY_ENDPOINT,
    lockfileSha256: createHash('sha256').update(lockfileText).digest('hex'),
    inventory: {
      ...coverage,
      exactVersionSha256: dependencyInventoryDigest(inventory),
      expectedPathMultiplicitySha256:
        inventoryCoverage.expectedPathMultiplicitySha256,
      lockfileVersion: REQUIRED_LOCKFILE_VERSION,
      observedInventorySha256: inventoryCoverage.observedInventorySha256,
      observedPathCount: inventoryCoverage.observedPathCount,
      observedPathMultiplicitySha256:
        inventoryCoverage.observedPathMultiplicitySha256,
      packageLocatorCount: inventoryCoverage.packageLocatorCount,
      packageLocatorSha256: inventoryCoverage.packageLocatorSha256,
      packageNames: inventory.size,
      packageVersions: versionCount(inventory),
      snapshotCount: inventoryCoverage.snapshotCount,
      snapshotSha256: inventoryCoverage.snapshotSha256,
      sourceLocatorCount: inventoryCoverage.sourceLocatorCount,
    },
    findings: npmFindings,
    blockers,
    timeBoundResiduals: evaluated.timeBoundResiduals,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repositoryDirectory = process.cwd();
  const pnpmList = loadReleaseDependencyList();
  const lockfileText = readFileSync(
    path.join(repositoryDirectory, 'pnpm-lock.yaml'),
    'utf8',
  );
  const report = await buildDependencyAuditReport({
    lockfileText,
    pnpmList,
    repositoryDirectory,
  });
  if (options.report) {
    const reportPath = path.resolve(options.report);
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'passed') {
    fail(`release dependency audit has ${report.blockers.length} blocker(s)`);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(
      `[dependency-audit] ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
