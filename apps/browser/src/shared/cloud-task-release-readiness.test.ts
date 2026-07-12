import { describe, expect, it } from 'vitest';
import {
  createCloudTaskReleaseEvidence,
  evaluateCloudTaskReleaseReadiness,
  parseCloudTaskReleaseEvidence,
  type CloudTaskReleaseEvidence,
} from './cloud-task-release-readiness';
import { createCloudTaskSuspendResumeSmokeEvidence } from './cloud-task-suspend-resume-smoke';

const NOW = new Date('2026-07-11T00:00:00.000Z');

describe('Cloud Tasks release readiness', () => {
  it('requires explicit human sign-off after SLO and platform gates pass', () => {
    const evidence = createEvidence();
    evidence.humanSignoff.security = false;

    expect(
      evaluateCloudTaskReleaseReadiness(evidence, { now: NOW }).status,
    ).toBe('awaiting-signoff');
  });

  it('marks evidence as candidate only when all SLOs and sign-offs pass', () => {
    const readiness = evaluateCloudTaskReleaseReadiness(createEvidence(), {
      now: NOW,
      buildCommitSha: 'a'.repeat(40),
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.status).toBe('candidate');
    expect(readiness.metrics.failureRate).toBeLessThanOrEqual(0.02);
  });

  it('fails closed on integrity failures and missing platform smoke', () => {
    const evidence = createEvidence();
    evidence.failures.integrity = 1;
    evidence.qualityGates.windowsSuspendResumePassed = false;

    const readiness = evaluateCloudTaskReleaseReadiness(evidence, {
      now: NOW,
    });

    expect(readiness.status).toBe('needs-tuning');
    expect(
      readiness.checks.find((check) => check.id === 'integrity-failures')
        ?.passed,
    ).toBe(false);
  });

  it('strictly validates bounded release evidence before evaluation', () => {
    expect(parseCloudTaskReleaseEvidence(createEvidence())).toEqual(
      createEvidence(),
    );
    expect(() =>
      parseCloudTaskReleaseEvidence({
        ...createEvidence(),
        unexpectedSecretField: 'not-allowed',
      }),
    ).toThrow('failed validation');
    expect(() =>
      parseCloudTaskReleaseEvidence({
        ...createEvidence(),
        observedInstallCount: -1,
      }),
    ).toThrow('failed validation');
  });

  it('builds candidate evidence only from fresh smoke on all platforms', () => {
    const evidence = createCloudTaskReleaseEvidence({
      aggregate: createAggregate(),
      sourceCommitSha: 'a'.repeat(40),
      platformSmokes: ['darwin', 'win32', 'linux'].map((platform) =>
        createCloudTaskSuspendResumeSmokeEvidence({
          platform: platform as 'darwin' | 'win32' | 'linux',
          arch: platform === 'darwin' ? 'arm64' : 'x64',
          appVersion: '1.0.0-beta.1',
          completedAt: new Date('2026-07-10T18:00:00.000Z'),
          checks: {
            networkReconnect: true,
            systemSuspendResume: true,
            orphanCancellation: true,
            artifactRangeResume: true,
            contentFreeAudit: true,
          },
        }),
      ),
      backendConformancePassed: true,
      contentFreeTelemetryAuditPassed: true,
      humanSignoff: { product: true, security: true, operations: true },
      now: NOW,
    });

    expect(
      evaluateCloudTaskReleaseReadiness(evidence, { now: NOW }),
    ).toMatchObject({ ready: true, status: 'candidate' });
  });

  it('rejects missing, duplicate, stale, or mixed-version platform smoke', () => {
    const aggregate = createAggregate();
    const smoke = (platform: 'darwin' | 'win32' | 'linux', version = '1.0.0') =>
      createCloudTaskSuspendResumeSmokeEvidence({
        platform,
        arch: 'x64',
        appVersion: version,
        completedAt: new Date('2026-07-10T18:00:00.000Z'),
        checks: {
          networkReconnect: true,
          systemSuspendResume: true,
          orphanCancellation: true,
          artifactRangeResume: true,
          contentFreeAudit: true,
        },
      });
    const base = {
      aggregate,
      sourceCommitSha: 'a'.repeat(40),
      backendConformancePassed: true,
      contentFreeTelemetryAuditPassed: true,
      humanSignoff: { product: true, security: true, operations: true },
      now: NOW,
    } as const;

    expect(() =>
      createCloudTaskReleaseEvidence({
        ...base,
        platformSmokes: [smoke('darwin'), smoke('linux')],
      }),
    ).toThrow('missing platforms');
    expect(() =>
      createCloudTaskReleaseEvidence({
        ...base,
        platformSmokes: [smoke('darwin'), smoke('darwin'), smoke('linux')],
      }),
    ).toThrow('Duplicate');
    expect(() =>
      createCloudTaskReleaseEvidence({
        ...base,
        platformSmokes: [
          smoke('darwin'),
          smoke('win32', '2.0.0'),
          smoke('linux'),
        ],
      }),
    ).toThrow('one app version');
    expect(() =>
      createCloudTaskReleaseEvidence({
        ...base,
        platformSmokes: [
          {
            ...smoke('darwin'),
            completedAt: '2026-07-01T00:00:00.000Z',
          },
          smoke('win32'),
          smoke('linux'),
        ],
      }),
    ).toThrow('stale');
  });
});

function createEvidence(): CloudTaskReleaseEvidence {
  return {
    schemaVersion: 2,
    sourceChannel: 'prerelease',
    sourceCommitSha: 'a'.repeat(40),
    observationStartedAt: '2026-07-07T00:00:00.000Z',
    observationEndedAt: '2026-07-10T12:00:00.000Z',
    observedBuildCount: 3,
    observedInstallCount: 40,
    executions: { completed: 245, failed: 3, cancelled: 12 },
    failures: { network: 4, resume: 1, integrity: 0, policyLimit: 1 },
    reconciliation: { inspected: 80, failed: 0 },
    artifactActions: { attempted: 100, failed: 1 },
    latency: { startP95Ms: 2_400, reconnectP95Ms: 1_200 },
    qualityGates: {
      backendConformancePassed: true,
      contentFreeTelemetryAuditPassed: true,
      macosSuspendResumePassed: true,
      windowsSuspendResumePassed: true,
      linuxSuspendResumePassed: true,
    },
    humanSignoff: {
      product: true,
      security: true,
      operations: true,
    },
  };
}

function createAggregate() {
  const {
    sourceCommitSha: _sourceCommitSha,
    qualityGates: _qualityGates,
    humanSignoff: _humanSignoff,
    ...rest
  } = createEvidence();
  return rest;
}
