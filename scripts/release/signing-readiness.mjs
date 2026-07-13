#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_ENVIRONMENT = 'Release';

export const MACOS_RELEASE_SECRETS = Object.freeze([
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_SIGNING_IDENTITY',
  'MACOS_CERT_P12_BASE64',
  'MACOS_CERT_P12_PASSWORD',
]);

export const WINDOWS_RELEASE_SECRETS = Object.freeze([
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_ACCOUNT_NAME',
  'AZURE_ACCOUNT_ENDPOINT_URI',
  'AZURE_CERTIFICATE_PROFILE_NAME',
]);

export const REQUIRED_RELEASE_SECRETS = Object.freeze([
  ...MACOS_RELEASE_SECRETS,
  ...WINDOWS_RELEASE_SECRETS,
]);

export const REQUIRED_RELEASE_VARIABLES = Object.freeze([
  'UPDATE_SERVER_ORIGIN',
]);

const blockerCode = (kind, name, suffix) =>
  `GH_ENV_RELEASE_${kind}_${name}_${suffix}`;

export function inspectUpdateServerOrigin(value) {
  if (!value?.trim()) {
    return {
      code: blockerCode('VAR', 'UPDATE_SERVER_ORIGIN', 'MISSING'),
      ok: false,
    };
  }

  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.hostname
    ) {
      return {
        code: blockerCode('VAR', 'UPDATE_SERVER_ORIGIN', 'INVALID'),
        ok: false,
      };
    }
  } catch {
    return {
      code: blockerCode('VAR', 'UPDATE_SERVER_ORIGIN', 'INVALID'),
      ok: false,
    };
  }

  return { code: null, ok: true };
}

export function parseCodesignAuthorities(output) {
  return [...output.matchAll(/^Authority=(.+)$/gm)].map((match) =>
    match[1].trim(),
  );
}

export function inspectDeveloperIdSignature(signature) {
  const developerIdAuthority = signature.authorities?.[0];
  if (!developerIdAuthority?.startsWith('Developer ID Application:')) {
    return { code: 'MACOS_DEVELOPER_ID_AUTHORITY_MISSING', ok: false };
  }

  const authorityTeam = developerIdAuthority.match(/\(([A-Z0-9]+)\)$/)?.[1];
  if (
    authorityTeam &&
    signature.teamIdentifier &&
    authorityTeam !== signature.teamIdentifier
  ) {
    return { code: 'MACOS_DEVELOPER_ID_TEAM_MISMATCH', ok: false };
  }

  return { code: null, ok: true };
}

export function parseKeychainIdentities(output) {
  const identities = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\)\s+([A-Fa-f0-9]+)\s+"(.+)"\s*$/);
    if (match) identities.push({ fingerprint: match[1], name: match[2] });
  }
  return identities;
}

export function inspectConfiguredDeveloperIdIdentity(
  output,
  configuredIdentity,
) {
  if (!configuredIdentity?.trim()) {
    return {
      code: blockerCode('SECRET', 'APPLE_SIGNING_IDENTITY', 'MISSING'),
      ok: false,
    };
  }

  const configured = configuredIdentity.trim();
  const identity = parseKeychainIdentities(output).find(
    (candidate) =>
      candidate.fingerprint.toLowerCase() === configured.toLowerCase() ||
      candidate.name === configured,
  );
  if (!identity) {
    return { code: 'MACOS_DEVELOPER_ID_IDENTITY_NOT_FOUND', ok: false };
  }
  if (!identity.name.startsWith('Developer ID Application:')) {
    return { code: 'MACOS_DEVELOPER_ID_IDENTITY_TYPE_INVALID', ok: false };
  }
  return { code: null, ok: true };
}

function requirement(kind, name, present, code = null) {
  return {
    blockerCode: present ? null : code,
    kind,
    name,
    status: present ? 'present' : 'missing',
  };
}

function secretsForArtifactSet(artifactSet) {
  if (artifactSet === 'macos') return MACOS_RELEASE_SECRETS;
  if (artifactSet === 'windows') return WINDOWS_RELEASE_SECRETS;
  if (artifactSet === 'all') return REQUIRED_RELEASE_SECRETS;
  throw new Error(`Unsupported artifact set: ${artifactSet}`);
}

export function evaluateReleaseEnvironment(
  environment = process.env,
  options = {},
) {
  const artifactSet = options.artifacts ?? 'macos';
  const requirements = [];
  const blockers = [];

  for (const name of secretsForArtifactSet(artifactSet)) {
    const present = Boolean(environment[name]?.trim());
    const code = blockerCode('SECRET', name, 'MISSING');
    requirements.push(requirement('secret', name, present, code));
    if (!present) blockers.push({ code, kind: 'secret', name });
  }

  const updateServer = inspectUpdateServerOrigin(
    environment.UPDATE_SERVER_ORIGIN,
  );
  const updateServerPresent = Boolean(environment.UPDATE_SERVER_ORIGIN?.trim());
  requirements.push({
    blockerCode: updateServer.ok ? null : updateServer.code,
    kind: 'variable',
    name: 'UPDATE_SERVER_ORIGIN',
    status: updateServer.ok
      ? 'present'
      : updateServerPresent
        ? 'invalid'
        : 'missing',
  });
  if (!updateServer.ok) {
    blockers.push({
      code: updateServer.code,
      kind: 'variable',
      name: 'UPDATE_SERVER_ORIGIN',
    });
  }

  return {
    blockers,
    contract: 'distributable-signing-update-server-v1',
    environment: RELEASE_ENVIRONMENT,
    artifactSet,
    requirements,
    schemaVersion: 1,
    status: blockers.length === 0 ? 'ready' : 'blocked',
  };
}

function parseArguments(values) {
  const options = {
    allowBlocked: false,
    artifacts: 'macos',
    checkKeychain: false,
    githubAnnotations: false,
    report: undefined,
    summary: undefined,
  };

  for (const value of values) {
    if (value === '--') continue;
    if (value === '--allow-blocked') options.allowBlocked = true;
    else if (value.startsWith('--artifacts=')) {
      options.artifacts = value.slice('--artifacts='.length);
      secretsForArtifactSet(options.artifacts);
    } else if (value === '--check-keychain') options.checkKeychain = true;
    else if (value === '--github-annotations') options.githubAnnotations = true;
    else if (value.startsWith('--report=')) {
      options.report = value.slice('--report='.length);
    } else if (value.startsWith('--summary=')) {
      options.summary = value.slice('--summary='.length);
    } else if (value === '--help') {
      console.log(`
Validate the GitHub Release environment contract without printing values.

Usage:
  node scripts/release/signing-readiness.mjs [options]

Options:
  --allow-blocked       Exit successfully while still reporting blockers
  --artifacts=<set>     macos (default), windows, or all
  --check-keychain      Verify APPLE_SIGNING_IDENTITY in the macOS keychain
  --github-annotations  Emit content-free GitHub Actions annotations
  --report=<path>       Write a content-free JSON readiness report
  --summary=<path>      Append a content-free Markdown summary
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return options;
}

function appendKeychainCheck(report, environment) {
  if (process.platform !== 'darwin') {
    report.blockers.push({
      code: 'MACOS_KEYCHAIN_CHECK_REQUIRES_MACOS',
      kind: 'runtime',
      name: 'macos-keychain',
    });
    report.status = 'blocked';
    return;
  }

  const result = spawnSync(
    '/usr/bin/security',
    ['find-identity', '-v', '-p', 'codesigning'],
    { encoding: 'utf8', stdio: 'pipe' },
  );
  const check =
    result.status === 0
      ? inspectConfiguredDeveloperIdIdentity(
          `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
          environment.APPLE_SIGNING_IDENTITY,
        )
      : { code: 'MACOS_KEYCHAIN_IDENTITY_QUERY_FAILED', ok: false };

  report.runtimeChecks = [
    {
      blockerCode: check.code,
      name: 'developer-id-keychain-identity',
      status: check.ok ? 'passed' : 'failed',
    },
  ];
  if (!check.ok) {
    report.blockers.push({
      code: check.code,
      kind: 'runtime',
      name: 'developer-id-keychain-identity',
    });
    report.status = 'blocked';
  }
}

function renderSummary(report) {
  const lines = [
    '## Signing and update-server readiness',
    '',
    `- Environment: \`${report.environment}\``,
    `- Artifact set: \`${report.artifactSet}\``,
    `- Status: **${report.status.toUpperCase()}**`,
    `- Blockers: ${report.blockers.length}`,
    '',
  ];
  if (report.blockers.length > 0) {
    lines.push('### Blocker codes', '');
    for (const blocker of report.blockers) {
      lines.push(`- \`${blocker.code}\` (\`${blocker.name}\`)`);
    }
    lines.push('');
  }
  lines.push('No secret or variable values are included in this report.', '');
  return lines.join('\n');
}

function writeOutput(filePath, content, append = false) {
  mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  writeFileSync(filePath, content, append ? { flag: 'a' } : undefined);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = evaluateReleaseEnvironment(process.env, {
    artifacts: options.artifacts,
  });
  if (options.checkKeychain) appendKeychainCheck(report, process.env);

  if (options.report) {
    writeOutput(options.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.summary) {
    writeOutput(options.summary, renderSummary(report), true);
  }

  console.log(
    `[signing-readiness] status=${report.status} blockers=${report.blockers.length}`,
  );
  for (const blocker of report.blockers) {
    const message = `${blocker.code}: required ${blocker.kind} ${blocker.name} is not ready`;
    if (options.githubAnnotations) console.error(`::error::${message}`);
    else console.error(`[signing-readiness] ${message}`);
  }

  if (report.status !== 'ready' && !options.allowBlocked) process.exitCode = 1;
}

const isEntryPoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  main().catch((error) => {
    console.error(
      `[signing-readiness] FAILED: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  });
}
