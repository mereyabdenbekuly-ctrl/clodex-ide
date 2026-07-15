#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const NPM_BULK_ADVISORY_ENDPOINT =
  'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';

export const DOCUMENTED_RESIDUALS = [];

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

export function collectDependencyInventory(pnpmList) {
  if (!Array.isArray(pnpmList)) fail('pnpm production list must be an array');
  const inventory = new Map();
  const visit = (dependencies) => {
    if (!dependencies || typeof dependencies !== 'object') return;
    for (const [declaredName, dependency] of Object.entries(dependencies)) {
      if (!dependency || typeof dependency !== 'object') continue;
      const linkedWorkspace =
        typeof dependency.version === 'string' &&
        /^(?:file|link|workspace):/u.test(dependency.version);
      let name = declaredName;
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
      if (!linkedWorkspace) addVersion(inventory, name, version);
      visit(dependency.dependencies);
      visit(dependency.optionalDependencies);
    }
  };
  for (const workspace of pnpmList) {
    visit(workspace?.dependencies);
    visit(workspace?.optionalDependencies);
  }
  return inventory;
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
      '--prod',
      '--json',
      '--depth',
      'Infinity',
      '--lockfile-only',
    ],
  };
}

export function loadProductionDependencyList({
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
  if (!Array.isArray(parsed)) fail('pnpm production list must be an array');
  return parsed;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const inventory = collectDependencyInventory(loadProductionDependencyList());
  const findings = await queryAdvisories(inventory);
  const evaluated = evaluateFindings(findings);
  const report = {
    schemaVersion: 1,
    reportKind: 'production-dependency-audit',
    status: evaluated.blockers.length === 0 ? 'passed' : 'blocked',
    generatedAt: new Date().toISOString(),
    endpoint: NPM_BULK_ADVISORY_ENDPOINT,
    inventory: {
      packageNames: inventory.size,
      packageVersions: [...inventory.values()].reduce(
        (total, versions) => total + versions.size,
        0,
      ),
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
    fail(
      `production dependency audit has ${report.blockers.length} blocker(s)`,
    );
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
