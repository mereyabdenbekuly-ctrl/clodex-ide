import { describe, expect, it } from 'vitest';
import {
  createSessionRecoveryAcceptanceEvidence,
  parseSessionRecoveryPhaseArtifact,
  sessionRecoveryAcceptanceEvidenceSchema,
  type SessionRecoverySeedArtifact,
  type SessionRecoveryVerifyArtifact,
} from './session-recovery-acceptance';

const seed: SessionRecoverySeedArtifact = {
  schemaVersion: 1,
  phase: 'seed',
  appVersion: '1.16.0',
  platform: 'darwin',
  arch: 'arm64',
  taskIdentityHash: 'a'.repeat(64),
  semanticStateDigest: 'b'.repeat(64),
  counts: { history: 0, queuedMessages: 0, mountedWorkspaces: 0 },
  checks: {
    isolatedProfile: true,
    freshProfile: true,
    targetAgentCreated: true,
    deterministicStateSeeded: true,
    persistedStateMatched: true,
    checkpointFlushed: true,
    tabStatePersisted: true,
    contentFreeAudit: true,
  },
};

const verify: SessionRecoveryVerifyArtifact = {
  schemaVersion: 1,
  phase: 'verify',
  appVersion: '1.16.0',
  platform: 'darwin',
  arch: 'arm64',
  taskIdentityHash: 'a'.repeat(64),
  semanticStateDigest: 'b'.repeat(64),
  counts: { history: 0, queuedMessages: 0, mountedWorkspaces: 0 },
  checks: {
    isolatedProfile: true,
    sameProfileRestart: true,
    targetAgentResumed: true,
    persistedStateMatched: true,
    liveStateMatched: true,
    noDataLoss: true,
    contentFreeAudit: true,
  },
};

describe('session recovery acceptance evidence', () => {
  it('emits a fixed-shape content-free record for matching restart phases', () => {
    const evidence = createSessionRecoveryAcceptanceEvidence({
      seed,
      verify,
      seedDurationMs: 1200.4,
      verifyDurationMs: 900.2,
      completedAt: new Date('2026-07-13T00:00:00.000Z'),
    });

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      completedAt: '2026-07-13T00:00:00.000Z',
      markerSetVersion: 1,
      durationsMs: { seed: 1200, verify: 900 },
      restoredCounts: {
        history: 0,
        queuedMessages: 0,
        mountedWorkspaces: 0,
      },
      checks: {
        intersessionMutexHeld: true,
        sameProfileRestart: true,
        targetAgentResumed: true,
        noDataLoss: true,
        contentFreeAudit: true,
      },
    });
    expect(JSON.stringify(evidence)).not.toContain('a'.repeat(64));
    expect(JSON.stringify(evidence)).not.toContain('b'.repeat(64));
  });

  it('fails closed when the task, state, or build changes across restart', () => {
    expect(() =>
      createSessionRecoveryAcceptanceEvidence({
        seed,
        verify: { ...verify, taskIdentityHash: 'c'.repeat(64) },
        seedDurationMs: 1,
        verifyDurationMs: 1,
      }),
    ).toThrow('different task');
    expect(() =>
      createSessionRecoveryAcceptanceEvidence({
        seed,
        verify: { ...verify, semanticStateDigest: 'c'.repeat(64) },
        seedDurationMs: 1,
        verifyDurationMs: 1,
      }),
    ).toThrow('digest changed');
    expect(() =>
      createSessionRecoveryAcceptanceEvidence({
        seed,
        verify: { ...verify, appVersion: '1.16.1' },
        seedDurationMs: 1,
        verifyDurationMs: 1,
      }),
    ).toThrow('different packaged builds');
  });

  it('strictly rejects false gates and inserted content fields', () => {
    expect(() =>
      parseSessionRecoveryPhaseArtifact({
        ...seed,
        taskId: 'raw-task-id',
      }),
    ).toThrow('invalid');
    expect(() =>
      parseSessionRecoveryPhaseArtifact({
        ...verify,
        checks: { ...verify.checks, noDataLoss: false },
      }),
    ).toThrow('invalid');
    expect(
      sessionRecoveryAcceptanceEvidenceSchema.safeParse({
        ...createSessionRecoveryAcceptanceEvidence({
          seed,
          verify,
          seedDurationMs: 1,
          verifyDurationMs: 1,
        }),
        profilePath: '/private/profile',
      }).success,
    ).toBe(false);
  });
});
