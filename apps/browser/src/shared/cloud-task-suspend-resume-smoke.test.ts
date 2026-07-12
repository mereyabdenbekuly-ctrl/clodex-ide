import { describe, expect, it } from 'vitest';
import {
  cloudTaskSuspendResumeSmokeChecks,
  createCloudTaskSuspendResumeSmokeEvidence,
  parseCloudTaskSuspendResumeSmokeEvidence,
} from './cloud-task-suspend-resume-smoke';

describe('Cloud Tasks suspend/resume smoke evidence', () => {
  it('refuses to emit evidence with an unconfirmed gate', () => {
    expect(() =>
      createCloudTaskSuspendResumeSmokeEvidence({
        platform: 'darwin',
        arch: 'arm64',
        appVersion: '1.0.0',
        checks: {
          networkReconnect: true,
          systemSuspendResume: true,
          orphanCancellation: true,
          artifactRangeResume: true,
          contentFreeAudit: false,
        },
      }),
    ).toThrow('contentFreeAudit');
  });

  it('emits a fixed-shape content-free record after all gates pass', () => {
    const evidence = createCloudTaskSuspendResumeSmokeEvidence({
      platform: 'linux',
      arch: 'x64',
      appVersion: '1.0.0',
      completedAt: new Date('2026-07-11T00:00:00.000Z'),
      checks: Object.fromEntries(
        cloudTaskSuspendResumeSmokeChecks.map((check) => [check, true]),
      ),
    });

    expect(evidence).toEqual({
      schemaVersion: 1,
      platform: 'linux',
      arch: 'x64',
      appVersion: '1.0.0',
      completedAt: '2026-07-11T00:00:00.000Z',
      checks: {
        networkReconnect: true,
        systemSuspendResume: true,
        orphanCancellation: true,
        artifactRangeResume: true,
        contentFreeAudit: true,
      },
    });
  });

  it('strictly rejects inserted fields and false checks', () => {
    const evidence = createCloudTaskSuspendResumeSmokeEvidence({
      platform: 'linux',
      arch: 'x64',
      appVersion: '1.0.0',
      checks: Object.fromEntries(
        cloudTaskSuspendResumeSmokeChecks.map((check) => [check, true]),
      ),
    });
    expect(() =>
      parseCloudTaskSuspendResumeSmokeEvidence({
        ...evidence,
        workspacePath: '/private/project',
      }),
    ).toThrow('invalid');
    expect(() =>
      parseCloudTaskSuspendResumeSmokeEvidence({
        ...evidence,
        checks: { ...evidence.checks, contentFreeAudit: false },
      }),
    ).toThrow('invalid');
  });
});
