import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATED_CHECK_IDS,
  type AcceptanceCheckReceipt,
  CANARY_5_POLICY,
  collectGitHubPublicationCheck,
  collectMacosArtifactChecks,
  createPreviewAcceptanceTemplate,
  evaluatePreviewAcceptance,
  getCanaryStopReasons,
  MANUAL_CHECK_IDS,
  PREVIEW_ACCEPTANCE_MATRIX,
  sanitizeChildEnvironment,
  type CanaryMetrics,
  type PreviewAcceptanceContext,
} from './preview-acceptance.js';
import { REQUIRED_ACCEPTANCE_CHECK_IDS } from './release-plan.mjs';

const sourceCommit = '1'.repeat(40);
const manifestSha256 = '2'.repeat(64);

function context(
  promotionRole: 'canary' | 'rollback-baseline',
): PreviewAcceptanceContext {
  const canary = promotionRole === 'canary';
  const version = canary ? '1.16.0-preview.3' : '1.16.0-preview.2';
  return {
    manifestPath: '.release-notes/clodex-technical-preview.json',
    manifestSha256,
    plan: {
      acceptance: canary
        ? {
            binding: 'manifest-sha256+source-commit',
            entryStatus: 'ready-for-canary',
            requiredStatus: 'ready-for-stable',
          }
        : {
            binding: 'manifest-sha256+source-commit',
            requiredStatus: 'ready-as-rollback-baseline',
          },
      authentication: {
        oauthWebAuthReady: false,
        releaseClaim: 'OAuth/WebAuth is not included.',
      },
      buildChannel: 'prerelease',
      channel: 'preview',
      distribution: {
        access: canary ? 'controlled-canary' : 'release-operators-only',
        githubReleaseState: 'draft',
        canaryInstallations: canary ? 5 : 0,
        protectedEnvironment: 'Release',
        publicDownloadLinks: false,
      },
      githubArtifactBundles: [],
      ...(canary
        ? { promotionEvidence: '.release-evidence/preview.2.json' }
        : {}),
      promotionRole,
      releaseKind: 'technical-preview',
      rollback: {
        mode: 'distribution-stop-only',
        ...(canary ? { targetTag: 'v1.16.0-preview.2' } : {}),
      },
      schemaVersion: 2,
      sourceRef: 'main',
      tag: `v${version}`,
      validationArtifacts: [],
      version,
    },
    releaseRef: sourceCommit,
  };
}

function passedAutomatedChecks(): AcceptanceCheckReceipt[] {
  return AUTOMATED_CHECK_IDS.map((id) => ({
    id,
    reasonCode: 'test-pass',
    status: 'pass',
  }));
}

function passingCanary(): CanaryMetrics {
  return {
    authAttempts: 5,
    authFailures: 0,
    crashLoops: 0,
    crashes: 0,
    dataLossIncidents: 0,
    distributionClosedAt: '2026-07-14T00:00:00.000Z',
    egressMissingPrompts: 0,
    egressPromptAttempts: 5,
    egressUnexpectedAllows: 0,
    endedAt: '2026-07-14T00:00:00.000Z',
    guardianBypassIncidents: 0,
    launchAttempts: 10,
    launchFailures: 0,
    recoveryAttempts: 5,
    recoveryFailures: 0,
    signatureTrustFailures: 0,
    startedAt: '2026-07-13T00:00:00.000Z',
    uniqueInstallations: 5,
  };
}

function acceptedInput(releaseContext: PreviewAcceptanceContext) {
  const input = createPreviewAcceptanceTemplate(releaseContext);
  for (const id of MANUAL_CHECK_IDS) {
    input.manualChecks[id] = { status: 'pass' };
  }
  input.publication = {
    githubReleaseId: 12345,
    githubReleaseState: 'draft',
    tag: releaseContext.plan.tag,
    targetCommit: releaseContext.releaseRef,
  };
  input.rollback = {
    operatorReviewed: true,
    readOnlyVerificationPassed: true,
  };
  return input;
}

describe('manifest-bound preview release acceptance', () => {
  it('strips ambient GitHub Actions credentials from every child environment', () => {
    const blockedNames = [
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_RUNTIME_TOKEN',
      'ACTIONS_RUNTIME_URL',
      'GH_TOKEN',
      'GITHUB_ENV',
      'GITHUB_OUTPUT',
      'GITHUB_TOKEN',
    ] as const;
    const previous = new Map(
      [...blockedNames, 'CLODEX_TEST_SAFE_MARKER'].map((name) => [
        name,
        process.env[name],
      ]),
    );
    try {
      for (const name of blockedNames) process.env[name] = `dummy-${name}`;
      process.env.CLODEX_TEST_SAFE_MARKER = 'preserved';
      const environment = sanitizeChildEnvironment();
      for (const name of blockedNames)
        expect(environment[name]).toBeUndefined();
      expect(environment.CLODEX_TEST_SAFE_MARKER).toBe('preserved');
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('covers every required acceptance surface', () => {
    expect(new Set(PREVIEW_ACCEPTANCE_MATRIX.map((check) => check.id))).toEqual(
      new Set([...AUTOMATED_CHECK_IDS, ...MANUAL_CHECK_IDS]),
    );
    expect(PREVIEW_ACCEPTANCE_MATRIX.every((check) => check.required)).toBe(
      true,
    );
    expect(new Set(REQUIRED_ACCEPTANCE_CHECK_IDS)).toEqual(
      new Set([...AUTOMATED_CHECK_IDS, ...MANUAL_CHECK_IDS]),
    );
  });

  it('holds when package, publication, and manual evidence are missing', () => {
    const releaseContext = context('rollback-baseline');
    const input = createPreviewAcceptanceTemplate(releaseContext);
    const report = evaluatePreviewAcceptance(
      releaseContext,
      input,
      [],
      new Date('2026-07-13'),
    );
    expect(report.status).toBe('hold');
    expect(report.blockers).toContain(
      'artifact.validation-manifest:evidence-missing',
    );
    expect(report.blockers).toContain('manual.terminal:operator-pending');
    expect(report.blockers).toContain(
      'publication:verified-draft-release-required',
    );
  });

  it('makes preview.2 only a rollback baseline with no target tag', () => {
    const releaseContext = context('rollback-baseline');
    const report = evaluatePreviewAcceptance(
      releaseContext,
      acceptedInput(releaseContext),
      passedAutomatedChecks(),
      new Date('2026-07-13'),
    );
    expect(report.status).toBe('ready-as-rollback-baseline');
    expect(report.blockers).toEqual([]);
    expect(report.canary.targetInstallations).toBe(0);
    expect(report.canary.observedInstallations).toBeNull();
    expect(report.rollback).not.toHaveProperty('targetTag');
    expect(report.rollback.note).toContain('no earlier trusted target tag');
  });

  it('rejects acceptance input detached from the manifest hash', () => {
    const releaseContext = context('rollback-baseline');
    const input = acceptedInput(releaseContext);
    input.manifest.sha256 = '3'.repeat(64);
    expect(() =>
      evaluatePreviewAcceptance(releaseContext, input, passedAutomatedChecks()),
    ).toThrow('acceptance-manifest-binding-invalid');
  });

  it('rejects free-form manual evidence and strips unknown publication fields', () => {
    const releaseContext = context('rollback-baseline');
    const invalid = acceptedInput(releaseContext);
    invalid.manualChecks['manual.terminal'] = {
      reasonCode: 'raw operator log\nwith content',
      status: 'pass',
    };
    expect(() =>
      evaluatePreviewAcceptance(
        releaseContext,
        invalid,
        passedAutomatedChecks(),
      ),
    ).toThrow('acceptance-manual-check-invalid:manual.terminal');

    const valid = acceptedInput(releaseContext) as ReturnType<
      typeof acceptedInput
    > & {
      publication: ReturnType<typeof acceptedInput>['publication'] & {
        rawApiResponse?: string;
      };
    };
    valid.publication.rawApiResponse = 'must-not-be-copied';
    const report = evaluatePreviewAcceptance(
      releaseContext,
      valid,
      passedAutomatedChecks(),
    );
    expect(JSON.stringify(report)).not.toContain('must-not-be-copied');
  });

  it('verifies the real draft release and exact local tag through GitHub', () => {
    const releaseContext = context('rollback-baseline');
    releaseContext.releaseRef = execFileSync(
      '/usr/bin/git',
      ['rev-parse', 'HEAD'],
      {
        encoding: 'utf8',
      },
    ).trim();
    releaseContext.plan.tag = 'v1.16.0-preview.2';
    const publication = {
      githubReleaseId: 12345,
      githubReleaseState: 'draft' as const,
      tag: 'v1.16.0-preview.2',
      targetCommit: releaseContext.releaseRef,
    };
    const check = collectGitHubPublicationCheck(
      {
        context: releaseContext,
        githubRepository: 'mereyabdenbekuly-ctrl/clodex-ide',
        publication,
        repositoryDirectory: process.cwd(),
      },
      (() =>
        ({
          error: undefined,
          status: 0,
          stdout: JSON.stringify({
            draft: true,
            id: 12345,
            prerelease: true,
            published_at: null,
            tag_name: 'v1.16.0-preview.2',
          }),
        }) as never) as typeof import('node:child_process').spawnSync,
      ((_repositoryDirectory: string, args: string[]) => {
        expect(args).toEqual([
          'rev-parse',
          '--verify',
          'refs/tags/v1.16.0-preview.2^{commit}',
        ]);
        return releaseContext.releaseRef;
      }) as never,
    );
    expect(check).toMatchObject({
      reasonCode: 'github-draft-release-verified',
      status: 'pass',
    });
  });

  it('makes preview.3 ready for canary only after entry acceptance', () => {
    const releaseContext = context('canary');
    const report = evaluatePreviewAcceptance(
      releaseContext,
      acceptedInput(releaseContext),
      passedAutomatedChecks(),
      new Date('2026-07-13'),
    );
    expect(report.status).toBe('ready-for-canary');
    expect(report.rollback.targetTag).toBe('v1.16.0-preview.2');
  });

  it('requires the complete 24-hour canary-5 floor', () => {
    const releaseContext = context('canary');
    const input = acceptedInput(releaseContext);
    input.canary = {
      ...passingCanary(),
      distributionClosedAt: null,
      endedAt: null,
    };
    const report = evaluatePreviewAcceptance(
      releaseContext,
      input,
      passedAutomatedChecks(),
      new Date('2026-07-13T12:00:00.000Z'),
    );
    expect(report.status).toBe('canary-running');
    expect(report.canary.observedHours).toBe(12);
    expect(report.canary.targetInstallations).toBe(
      CANARY_5_POLICY.targetInstallations,
    );
    expect(report.canary.observedInstallations).toBe(5);
    expect(report.canary.endedAt).toBeNull();
  });

  it('emits stable-promotion evidence only after all canary exits pass', () => {
    const releaseContext = context('canary');
    const input = acceptedInput(releaseContext);
    input.canary = passingCanary();
    const report = evaluatePreviewAcceptance(
      releaseContext,
      input,
      passedAutomatedChecks(),
      new Date('2026-07-14T00:00:00.000Z'),
    );
    expect(report.status).toBe('ready-for-stable');
    expect(report.canary.stopReasons).toEqual([]);
    expect(report.canary.startedAt).toBe('2026-07-13T00:00:00.000Z');
    expect(report.canary.endedAt).toBe('2026-07-14T00:00:00.000Z');
    expect(report.canary.distributionClosedAt).toBe('2026-07-14T00:00:00.000Z');
  });

  it('rejects invalid canary windows', () => {
    const releaseContext = context('canary');
    const input = acceptedInput(releaseContext);
    input.canary = {
      ...passingCanary(),
      endedAt: '2026-07-16T01:00:00.000Z',
      startedAt: '2026-07-15T00:00:00.000Z',
    };
    expect(() =>
      evaluatePreviewAcceptance(
        releaseContext,
        input,
        passedAutomatedChecks(),
        new Date('2026-07-15T00:01:00.000Z'),
      ),
    ).toThrow('acceptance-canary-window-invalid');
  });

  it('stops when canary scope exceeds five', () => {
    const releaseContext = context('canary');
    const input = acceptedInput(releaseContext);
    input.canary = { ...passingCanary(), uniqueInstallations: 6 };
    const report = evaluatePreviewAcceptance(
      releaseContext,
      input,
      passedAutomatedChecks(),
      new Date('2026-07-14T00:00:00.000Z'),
    );
    expect(report.status).toBe('rollback-required');
    expect(report.canary.stopReasons).toContain(
      'canary-installation-scope-exceeded',
    );
  });

  it('requires rollback on an unexpected egress allow', () => {
    const releaseContext = context('canary');
    const input = acceptedInput(releaseContext);
    input.canary = { ...passingCanary(), egressUnexpectedAllows: 1 };
    expect(
      evaluatePreviewAcceptance(
        releaseContext,
        input,
        passedAutomatedChecks(),
        new Date('2026-07-14T00:00:00.000Z'),
      ).canary.stopReasons,
    ).toContain('unexpected-egress-allow');
  });

  it('stops on the first authentication failure', () => {
    expect(
      getCanaryStopReasons({
        ...passingCanary(),
        authAttempts: 5,
        authFailures: 1,
      }),
    ).toContain('auth-failure');
  });

  it('accepts a schema-v2 macOS manifest but blocks ad-hoc trust', () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), 'preview-acceptance.'),
    );
    const manifestPath = path.join(directory, 'manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        artifacts: {
          app: { path: path.join(directory, 'missing.app') },
          dmg: { sha256: 'a'.repeat(64) },
          zip: { sha256: 'b'.repeat(64) },
        },
        build: {
          nodeVersion: '22.23.1',
          pnpmVersion: '10.30.3',
          version: '1.16.0-preview.2',
        },
        checks: {
          cleanProfileUiLaunch: {
            fatalLines: [],
            startupComplete: true,
            windowShown: true,
          },
          smoke: { exitCode: 0, fatalLines: [], successMarker: true },
        },
        schemaVersion: 2,
        signature: {
          copied: { isAdhoc: true },
          mounted: { isAdhoc: true },
          packaged: { isAdhoc: true },
          requiredMode: 'adhoc-allowed',
        },
        status: 'passed',
        trust: {
          applicationGatekeeper: { passed: false },
          applicationStapler: { passed: false },
          copiedApplicationGatekeeper: { passed: false },
          copiedApplicationStapler: { passed: false },
          dmgGatekeeper: { passed: false },
          dmgStapler: { passed: false },
        },
      }),
    );

    const checks = collectMacosArtifactChecks(manifestPath, {
      sourceCommit,
      version: '1.16.0-preview.2',
    });
    expect(
      checks.find((check) => check.id === 'artifact.validation-manifest'),
    ).toMatchObject({ status: 'pass' });
    expect(
      checks.find((check) => check.id === 'security.distribution-trust'),
    ).toMatchObject({
      reasonCode: 'developer-id-or-notarization-missing',
      status: 'blocked',
    });
  });
});
