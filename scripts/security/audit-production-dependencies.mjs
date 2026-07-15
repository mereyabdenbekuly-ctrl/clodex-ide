#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const EXACT_NPM_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function fail(message) {
  throw new Error(message);
}

function parseArguments(values) {
  const options = {};
  for (const value of values) {
    if (value === '--') {
      continue;
    }
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
    return;
  }
  if (!inventory.has(name)) inventory.set(name, new Set());
  inventory.get(name).add(version);
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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

export function collectDependencyInventory(pnpmList) {
  if (!Array.isArray(pnpmList)) fail('pnpm release list must be an array');
  const inventory = new Map();
  const visit = (dependencies) => {
    if (!dependencies || typeof dependencies !== 'object') return;
    for (const [declaredName, dependency] of Object.entries(dependencies)) {
      if (!declaredName || !dependency || typeof dependency !== 'object') {
        fail(
          `pnpm dependency record is invalid: ${declaredName || '<missing>'}`,
        );
      }
      if (typeof dependency.version !== 'string' || !dependency.version) {
        fail(`pnpm dependency version is missing: ${declaredName}`);
      }
      if (dependency.version.startsWith('file:')) {
        fail(
          `local file dependency is outside the npm advisory model: ${declaredName}`,
        );
      }
      const linkedWorkspace = /^(?:link|workspace):/u.test(dependency.version);
      let name =
        typeof dependency.name === 'string' && dependency.name
          ? dependency.name
          : declaredName;
      let version = dependency.version;
      if (typeof dependency.path === 'string') {
        const packageJsonPath = path.join(dependency.path, 'package.json');
        if (existsSync(packageJsonPath)) {
          try {
            const packageJson = JSON.parse(
              readFileSync(packageJsonPath, 'utf8'),
            );
            name = packageJson.name ?? name;
            version = packageJson.version ?? version;
          } catch {
            fail(`dependency package metadata is invalid: ${packageJsonPath}`);
          }
        }
      }
      if (!linkedWorkspace) {
        if (
          typeof name !== 'string' ||
          !name ||
          typeof version !== 'string' ||
          !EXACT_NPM_VERSION_PATTERN.test(version)
        ) {
          fail(
            `dependency version is not an exact npm version: ${name}@${version}`,
          );
        }
        addVersion(inventory, name, version);
      }
      for (const field of AUDITED_DEPENDENCY_FIELDS) visit(dependency[field]);
    }
  };
  for (const workspace of pnpmList) {
    for (const field of AUDITED_DEPENDENCY_FIELDS) visit(workspace?.[field]);
  }
  const versionCount = [...inventory.values()].reduce(
    (count, versions) => count + versions.size,
    0,
  );
  if (inventory.size === 0 || versionCount === 0) {
    fail('pnpm release dependency inventory is empty');
  }
  return inventory;
}

function normalizeImporterPath(repositoryDirectory, workspacePath) {
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) {
    fail('pnpm workspace path must be absolute');
  }
  const relativePath = path
    .relative(path.resolve(repositoryDirectory), path.resolve(workspacePath))
    .split(path.sep)
    .join('/');
  if (
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    relativePath.includes('/../')
  ) {
    fail(`pnpm workspace escapes the repository: ${workspacePath}`);
  }
  return relativePath || '.';
}

function dependencyNames(record, field) {
  const dependencies = record?.[field] ?? {};
  if (
    !dependencies ||
    typeof dependencies !== 'object' ||
    Array.isArray(dependencies)
  ) {
    fail(`dependency category ${field} must be an object`);
  }
  return Object.keys(dependencies).sort();
}

export function validateDependencyListCoverage({
  lockfileText,
  pnpmList,
  repositoryDirectory,
}) {
  if (typeof lockfileText !== 'string' || !lockfileText.trim()) {
    fail('pnpm lockfile text is empty');
  }
  const lockfile = parseYaml(lockfileText);
  if (
    !lockfile ||
    typeof lockfile !== 'object' ||
    !lockfile.importers ||
    typeof lockfile.importers !== 'object' ||
    Array.isArray(lockfile.importers)
  ) {
    fail('pnpm lockfile importers are missing or invalid');
  }
  if (!Array.isArray(pnpmList) || pnpmList.length === 0) {
    fail('pnpm release list is empty');
  }
  const observedImporters = new Map();
  for (const workspace of pnpmList) {
    const importerPath = normalizeImporterPath(
      repositoryDirectory,
      workspace?.path,
    );
    if (observedImporters.has(importerPath)) {
      fail(`pnpm release list duplicates importer ${importerPath}`);
    }
    observedImporters.set(importerPath, workspace);
  }
  const expectedImporterPaths = Object.keys(lockfile.importers).sort();
  const observedImporterPaths = [...observedImporters.keys()].sort();
  if (
    JSON.stringify(observedImporterPaths) !==
    JSON.stringify(expectedImporterPaths)
  ) {
    fail(
      `pnpm release list importer drift: expected ${expectedImporterPaths.join(', ')}; got ${observedImporterPaths.join(', ')}`,
    );
  }
  let directDependencyCount = 0;
  const directDependencyRecords = [];
  for (const importerPath of expectedImporterPaths) {
    const expected = lockfile.importers[importerPath];
    const observed = observedImporters.get(importerPath);
    for (const field of AUDITED_DEPENDENCY_FIELDS) {
      const expectedNames = dependencyNames(expected, field);
      const observedNames = dependencyNames(observed, field);
      directDependencyCount += expectedNames.length;
      directDependencyRecords.push({
        dependencies: expectedNames,
        field,
        importer: importerPath,
      });
      if (JSON.stringify(observedNames) !== JSON.stringify(expectedNames)) {
        fail(
          `pnpm release list direct dependency drift for ${importerPath} ${field}: expected ${expectedNames.join(', ')}; got ${observedNames.join(', ')}`,
        );
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
    importerCount: expectedImporterPaths.length,
  };
}

function advisoryIdentity(advisory) {
  return `${advisory?.url ?? ''}\u0000${advisory?.title ?? ''}`;
}

async function postBulkAudit(body, fetchImpl) {
  const response = await fetchImpl(NPM_BULK_ADVISORY_ENDPOINT, {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'user-agent': 'clodex-release-dependency-audit/1',
    },
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json();
  if (
    !response.ok ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    fail(`npm bulk advisory endpoint failed with HTTP ${response.status}`);
  }
  return payload;
}

export async function queryAdvisories(inventory, fetchImpl = fetch) {
  const request = Object.fromEntries(
    [...inventory]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, versions]) => [name, [...versions].sort()]),
  );
  const response = await postBulkAudit(request, fetchImpl);
  const findings = [];
  for (const [name, advisories] of Object.entries(response)) {
    if (!Array.isArray(advisories))
      fail(`npm advisory response is invalid for ${name}`);
    const versions = [...(inventory.get(name) ?? [])].sort();
    for (const advisory of advisories) {
      const affectedVersions = [];
      for (const version of versions) {
        const single = await postBulkAudit({ [name]: [version] }, fetchImpl);
        const matching = Array.isArray(single[name])
          ? single[name].some(
              (candidate) =>
                advisoryIdentity(candidate) === advisoryIdentity(advisory),
            )
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

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const repositoryDirectory = process.cwd();
  const pnpmList = loadReleaseDependencyList();
  const lockfileText = readFileSync(
    path.join(repositoryDirectory, 'pnpm-lock.yaml'),
    'utf8',
  );
  const coverage = validateDependencyListCoverage({
    lockfileText,
    pnpmList,
    repositoryDirectory,
  });
  const inventory = collectDependencyInventory(pnpmList);
  const findings = await queryAdvisories(inventory);
  const evaluated = evaluateFindings(findings);
  const report = {
    schemaVersion: 2,
    reportKind: 'release-dependency-audit',
    status: evaluated.blockers.length === 0 ? 'passed' : 'blocked',
    generatedAt: new Date().toISOString(),
    endpoint: NPM_BULK_ADVISORY_ENDPOINT,
    lockfileSha256: createHash('sha256').update(lockfileText).digest('hex'),
    inventory: {
      ...coverage,
      packageNames: inventory.size,
      packageVersions: [...inventory.values()].reduce(
        (total, versions) => total + versions.size,
        0,
      ),
      sha256: dependencyInventoryDigest(inventory),
    },
    findings,
    ...evaluated,
  };
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
