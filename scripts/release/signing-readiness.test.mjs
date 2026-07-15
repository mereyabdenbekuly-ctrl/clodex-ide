import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  evaluateReleaseEnvironment,
  inspectConfiguredDeveloperIdIdentity,
  inspectDeveloperIdSignature,
  inspectUpdateServerOrigin,
  MACOS_RELEASE_SECRETS,
  OBSERVATION_RELEASE_SECRETS,
  parseCodesignAuthorities,
  REQUIRED_RELEASE_SECRETS,
  REQUIRED_RELEASE_VARIABLES,
} from './signing-readiness.mjs';

const repositoryRoot = new URL('../../', import.meta.url);

function completeEnvironment() {
  return Object.fromEntries(
    [...REQUIRED_RELEASE_SECRETS, ...REQUIRED_RELEASE_VARIABLES].map((name) => [
      name,
      name === 'UPDATE_SERVER_ORIGIN'
        ? 'https://updates.example.com/api'
        : `configured-${name}`,
    ]),
  );
}

test('returns one stable blocker code per missing GitHub environment entry', () => {
  const report = evaluateReleaseEnvironment({}, { artifacts: 'all' });
  assert.equal(report.status, 'blocked');
  assert.deepEqual(
    report.blockers.map((blocker) => blocker.code),
    [
      ...REQUIRED_RELEASE_SECRETS.map(
        (name) => `GH_ENV_RELEASE_SECRET_${name}_MISSING`,
      ),
      'GH_ENV_RELEASE_VAR_UPDATE_SERVER_ORIGIN_MISSING',
    ],
  );
});

test('does not require Azure credentials for macOS-only readiness', () => {
  const environment = Object.fromEntries(
    MACOS_RELEASE_SECRETS.map((name) => [name, `configured-${name}`]),
  );
  environment.UPDATE_SERVER_ORIGIN = 'https://updates.example.com/api';

  const macosReport = evaluateReleaseEnvironment(environment, {
    artifacts: 'macos',
  });
  assert.equal(macosReport.status, 'ready');
  assert.equal(
    macosReport.requirements.some((item) => item.name.startsWith('AZURE_')),
    false,
  );

  const crossPlatformReport = evaluateReleaseEnvironment(environment, {
    artifacts: 'all',
  });
  assert.equal(crossPlatformReport.status, 'blocked');
  assert.ok(
    crossPlatformReport.blockers.some(
      (item) => item.code === 'GH_ENV_RELEASE_SECRET_AZURE_TENANT_ID_MISSING',
    ),
  );
});

test('requires PostHog before preview, alpha, or beta tag creation', () => {
  const environment = completeEnvironment();
  for (const channel of ['preview', 'alpha', 'beta']) {
    const blocked = evaluateReleaseEnvironment(environment, {
      artifacts: 'all',
      channel,
    });
    assert.equal(blocked.status, 'blocked');
    assert.deepEqual(
      blocked.blockers.map((item) => item.code),
      OBSERVATION_RELEASE_SECRETS.map(
        (name) => `GH_ENV_RELEASE_SECRET_${name}_MISSING`,
      ),
    );

    const ready = evaluateReleaseEnvironment(
      { ...environment, POSTHOG_API_KEY: 'configured-project-token' },
      { artifacts: 'all', channel },
    );
    assert.equal(ready.status, 'ready');
  }

  assert.equal(
    evaluateReleaseEnvironment(environment, {
      artifacts: 'all',
      channel: 'release',
    }).status,
    'ready',
  );
});

test('never includes configured values in the content-free report', () => {
  const secretSentinel = 'super-sensitive-secret-value';
  const environment = completeEnvironment();
  for (const name of REQUIRED_RELEASE_SECRETS) {
    environment[name] = secretSentinel;
  }

  const serialized = JSON.stringify(
    evaluateReleaseEnvironment(environment, { artifacts: 'all' }),
  );
  assert.equal(serialized.includes(secretSentinel), false);
  assert.equal(serialized.includes(environment.UPDATE_SERVER_ORIGIN), false);
});

test('CLI output never logs configured secret or variable values', () => {
  const environment = completeEnvironment();
  const secretSentinel = 'cli-super-sensitive-secret-value';
  for (const name of REQUIRED_RELEASE_SECRETS) {
    environment[name] = secretSentinel;
  }
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./signing-readiness.mjs', import.meta.url)),
      '--artifacts=all',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ...environment },
    },
  );
  assert.equal(result.status, 0);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(output.includes(secretSentinel), false);
  assert.equal(output.includes(environment.UPDATE_SERVER_ORIGIN), false);
});

test('requires an HTTPS update-server URL without credentials, query, or hash', () => {
  assert.equal(
    inspectUpdateServerOrigin('https://updates.example.com/api').ok,
    true,
  );
  for (const value of [
    undefined,
    'http://updates.example.com',
    'https://user:password@updates.example.com',
    'https://updates.example.com?token=value',
    'https://updates.example.com#fragment',
    'not-a-url',
  ]) {
    assert.equal(inspectUpdateServerOrigin(value).ok, false);
  }
});

test('recognizes a matching Developer ID Application identity in the keychain', () => {
  const output = `
  1) ABCDEF0123456789 "Developer ID Application: Example Corp (TEAM123456)"
     1 valid identities found
`;
  assert.equal(
    inspectConfiguredDeveloperIdIdentity(
      output,
      'Developer ID Application: Example Corp (TEAM123456)',
    ).ok,
    true,
  );
  assert.equal(
    inspectConfiguredDeveloperIdIdentity(output, 'ABCDEF0123456789').ok,
    true,
  );
  assert.equal(
    inspectConfiguredDeveloperIdIdentity(output, 'missing').code,
    'MACOS_DEVELOPER_ID_IDENTITY_NOT_FOUND',
  );
});

test('rejects a non-Developer-ID application signature and team mismatch', () => {
  const details = `
Authority=Developer ID Application: Example Corp (TEAM123456)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
`;
  const authorities = parseCodesignAuthorities(details);
  assert.equal(
    inspectDeveloperIdSignature({
      authorities,
      teamIdentifier: 'TEAM123456',
    }).ok,
    true,
  );
  assert.equal(
    inspectDeveloperIdSignature({
      authorities: ['Apple Development: Example Corp (TEAM123456)'],
      teamIdentifier: 'TEAM123456',
    }).code,
    'MACOS_DEVELOPER_ID_AUTHORITY_MISSING',
  );
  assert.equal(
    inspectDeveloperIdSignature({
      authorities: [
        'Apple Root CA',
        'Developer ID Application: Example Corp (TEAM123456)',
      ],
      teamIdentifier: 'TEAM123456',
    }).code,
    'MACOS_DEVELOPER_ID_AUTHORITY_MISSING',
  );
  assert.equal(
    inspectDeveloperIdSignature({
      authorities,
      teamIdentifier: 'OTHERTEAM1',
    }).code,
    'MACOS_DEVELOPER_ID_TEAM_MISMATCH',
  );
});

test('macOS validator wires HTTPS origin and Developer ID authority checks', () => {
  const validatorSource = readFileSync(
    new URL('apps/browser/scripts/validate-macos-release.mjs', repositoryRoot),
    'utf8',
  );
  assert.match(validatorSource, /inspectUpdateServerOrigin/);
  assert.match(validatorSource, /inspectDeveloperIdSignature/);
  assert.match(validatorSource, /parseCodesignAuthorities/);
});

test('release workflows bind the fail-fast contract to the Release environment', () => {
  const reusableSource = readFileSync(
    new URL('.github/workflows/_release-browser.yml', repositoryRoot),
    'utf8',
  );
  assert.match(
    reusableSource,
    /promotion-gate:\n[\s\S]*?runs-on: ubuntu-latest\n\s+environment: Release/,
  );
  assert.match(
    reusableSource,
    /\n {2}build:\n[\s\S]*?\n {4}environment: Release\n/,
  );

  const readinessStepStart = reusableSource.indexOf(
    '- name: Validate signing and update-server contract',
  );
  const readinessStepEnd = reusableSource.indexOf(
    '- name: Publish signing readiness summary',
    readinessStepStart,
  );
  assert.ok(readinessStepStart >= 0 && readinessStepEnd > readinessStepStart);
  const readinessStep = reusableSource.slice(
    readinessStepStart,
    readinessStepEnd,
  );
  assert.match(readinessStep, /signing-readiness\.mjs/);
  assert.match(readinessStep, /--artifacts=all/);
  assert.match(
    readinessStep,
    /RELEASE_CHANNEL_INPUT: \$\{\{ inputs\.channel \}\}/,
  );
  assert.match(readinessStep, /--channel="\$RELEASE_CHANNEL_INPUT"/);
  assert.doesNotMatch(
    readinessStep.match(/run: \|[\s\S]*/u)?.[0] ?? '',
    /\$\{\{/,
  );
  for (const name of REQUIRED_RELEASE_SECRETS) {
    assert.ok(readinessStep.includes(`${name}: \${{ secrets.${name} }}`));
  }
  assert.ok(
    readinessStep.includes(
      `UPDATE_SERVER_ORIGIN: \${{ vars.UPDATE_SERVER_ORIGIN }}`,
    ),
  );
  assert.ok(
    readinessStep.includes(`POSTHOG_API_KEY: \${{ secrets.POSTHOG_API_KEY }}`),
  );

  const readinessWorkflowSource = readFileSync(
    new URL('.github/workflows/release-signing-readiness.yml', repositoryRoot),
    'utf8',
  );
  assert.match(readinessWorkflowSource, /permissions:\n\s+contents: read\n/);
  assert.match(
    readinessWorkflowSource,
    /source-gate:\n[\s\S]*?permissions:\n\s+contents: read/,
  );
  assert.match(
    readinessWorkflowSource,
    /\n {2}contract:\n[\s\S]*?\n {4}needs: source-gate\n[\s\S]*?\n {4}environment: Release\n/,
  );
  assert.match(
    readinessWorkflowSource,
    /artifact_set:\n[\s\S]*?default: macos\n/,
  );
  assert.ok(
    (readinessWorkflowSource.match(/Reassert exact current main/g) ?? [])
      .length >= 2,
  );
  assert.match(readinessWorkflowSource, /GITHUB_WORKFLOW_SHA.*RELEASE_REF/s);
  assert.match(readinessWorkflowSource, /remote_main=.*refs\/heads\/main/s);
  assert.doesNotMatch(
    readinessWorkflowSource,
    /softprops\/action-gh-release|gh\s+release|electron-forge\s+make/,
  );
});
