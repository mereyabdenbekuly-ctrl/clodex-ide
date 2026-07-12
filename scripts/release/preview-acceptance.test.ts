import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTOMATED_CHECK_IDS,
  type AcceptanceCheckReceipt,
  CANARY_5_POLICY,
  collectMacosArtifactChecks,
  createPreviewAcceptanceTemplate,
  evaluatePreviewAcceptance,
  getCanaryStopReasons,
  MANUAL_CHECK_IDS,
  PREVIEW_ACCEPTANCE_MATRIX,
  ROLLBACK_TARGET_TAG,
  type CanaryMetrics,
} from './preview-acceptance.js';

const sourceCommit = '1'.repeat(40);

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

function acceptedInput() {
  const input = createPreviewAcceptanceTemplate(sourceCommit);
  for (const id of MANUAL_CHECK_IDS) {
    input.manualChecks[id] = { status: 'pass' };
  }
  input.rollback = {
    operatorReviewed: true,
    readOnlyVerificationPassed: true,
    targetTag: ROLLBACK_TARGET_TAG,
  };
  return input;
}

describe('preview release acceptance', () => {
  it('covers every required acceptance surface', () => {
    expect(new Set(PREVIEW_ACCEPTANCE_MATRIX.map((check) => check.id))).toEqual(
      new Set([...AUTOMATED_CHECK_IDS, ...MANUAL_CHECK_IDS]),
    );
    expect(PREVIEW_ACCEPTANCE_MATRIX.every((check) => check.required)).toBe(
      true,
    );
  });

  it('holds when package evidence and manual checks are missing', () => {
    const input = createPreviewAcceptanceTemplate(sourceCommit);
    const report = evaluatePreviewAcceptance(input, [], new Date('2026-07-13'));
    expect(report.status).toBe('hold');
    expect(report.blockers).toContain(
      'artifact.validation-manifest:evidence-missing',
    );
    expect(report.blockers).toContain('manual.terminal:operator-pending');
  });

  it('becomes ready for canary when all checks and rollback review pass', () => {
    const report = evaluatePreviewAcceptance(
      acceptedInput(),
      passedAutomatedChecks(),
      new Date('2026-07-13'),
    );
    expect(report.status).toBe('ready-for-canary');
    expect(report.blockers).toEqual([]);
  });

  it('requires the complete 24-hour canary-5 floor', () => {
    const input = acceptedInput();
    input.canary = { ...passingCanary(), endedAt: null };
    const report = evaluatePreviewAcceptance(
      input,
      passedAutomatedChecks(),
      new Date('2026-07-13T12:00:00.000Z'),
    );
    expect(report.status).toBe('canary-running');
    expect(report.canary.observedHours).toBe(12);
    expect(report.canary.targetInstallations).toBe(
      CANARY_5_POLICY.targetInstallations,
    );
  });

  it('promotes only after all canary exit criteria pass', () => {
    const input = acceptedInput();
    input.canary = passingCanary();
    const report = evaluatePreviewAcceptance(
      input,
      passedAutomatedChecks(),
      new Date('2026-07-14T00:00:00.000Z'),
    );
    expect(report.status).toBe('ready-for-expansion');
    expect(report.canary.stopReasons).toEqual([]);
  });

  it('requires rollback on an unexpected egress allow', () => {
    const input = acceptedInput();
    input.canary = { ...passingCanary(), egressUnexpectedAllows: 1 };
    const report = evaluatePreviewAcceptance(
      input,
      passedAutomatedChecks(),
      new Date('2026-07-14T00:00:00.000Z'),
    );
    expect(report.status).toBe('rollback-required');
    expect(report.canary.stopReasons).toContain('unexpected-egress-allow');
  });

  it('stops when authentication failures exceed twenty percent', () => {
    expect(
      getCanaryStopReasons({
        ...passingCanary(),
        authAttempts: 5,
        authFailures: 2,
      }),
    ).toContain('auth-failure-rate');
  });

  it('keeps reports content-free and points rollback at preview.1', () => {
    const report = evaluatePreviewAcceptance(
      acceptedInput(),
      passedAutomatedChecks(),
      new Date('2026-07-13'),
    );
    const text = JSON.stringify(report);
    expect(text).not.toContain('/private/');
    expect(text).not.toContain('workspaceId');
    expect(report.rollback.targetTag).toBe('v1.16.0-preview.1');
    expect(report.rollback.note).toContain('forward-only');
  });

  it('accepts a valid macOS manifest but blocks ad-hoc distribution trust', () => {
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
        schemaVersion: 1,
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
      channel: 'prerelease',
      sourceCommit,
      version: '1.16.0-preview.2',
    });
    expect(
      checks.find((check) => check.id === 'artifact.validation-manifest'),
    ).toMatchObject({ status: 'pass' });
    expect(
      checks.find((check) => check.id === 'artifact.packaged-smoke'),
    ).toMatchObject({ status: 'pass' });
    expect(
      checks.find((check) => check.id === 'artifact.clean-profile-launch'),
    ).toMatchObject({ status: 'pass' });
    expect(
      checks.find((check) => check.id === 'security.distribution-trust'),
    ).toMatchObject({
      reasonCode: 'developer-id-or-notarization-missing',
      status: 'blocked',
    });
  });
});
