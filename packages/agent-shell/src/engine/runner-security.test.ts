import { describe, expect, it } from 'vitest';
import {
  P256RunnerSigningAuthority,
  createSignedExecutionReceipt,
  createSignedRunnerJob,
  hashRunnerJob,
  hashRunnerPayload,
  verifySignedExecutionReceipt,
  verifySignedRunnerJob,
} from './runner-security';

const SNAPSHOT_HASH = 'a'.repeat(64);
const ENVIRONMENT_HASH = 'b'.repeat(64);

describe('runner security contracts', () => {
  it('signs a canonical job and rejects field tampering', () => {
    const authority = P256RunnerSigningAuthority.generate().authority;
    const signed = createSignedRunnerJob({
      providerId: 'local-runner',
      leaseId: 'lease-1',
      snapshotHash: SNAPSHOT_HASH,
      operation: 'execute-command',
      payloadHash: hashRunnerPayload('execute-command', {
        command: 'pnpm test',
      }),
      environmentFingerprintHash: ENVIRONMENT_HASH,
      authority,
      now: 1_000,
      jobId: '00000000-0000-4000-8000-000000000001',
      nonce: 'abcdefghijklmnop',
    });

    expect(verifySignedRunnerJob(signed, authority.publicKey)).toBe(true);
    expect(
      verifySignedRunnerJob(
        {
          ...signed,
          job: { ...signed.job, snapshotHash: 'c'.repeat(64) },
        },
        authority.publicKey,
      ),
    ).toBe(false);
  });

  it('produces an immutable receipt bound to the exact job and environment', () => {
    const authority = P256RunnerSigningAuthority.generate().authority;
    const signedJob = createSignedRunnerJob({
      providerId: 'local-runner',
      leaseId: 'lease-1',
      snapshotHash: SNAPSHOT_HASH,
      operation: 'execute-command',
      payloadHash: 'd'.repeat(64),
      environmentFingerprintHash: ENVIRONMENT_HASH,
      authority,
    });
    const signedReceipt = createSignedExecutionReceipt({
      signedJob,
      authority,
      startedAt: 10,
      finishedAt: 20,
      outcome: 'completed',
      exitCode: 0,
      resolvedBy: 'exit',
      output: 'ok',
      executionTimingHash: 'e'.repeat(64),
    });

    expect(Object.isFrozen(signedReceipt)).toBe(true);
    expect(Object.isFrozen(signedReceipt.receipt)).toBe(true);
    expect(
      verifySignedExecutionReceipt(signedReceipt, authority.publicKey),
    ).toBe(true);
    expect(signedReceipt.receipt).toMatchObject({
      jobId: signedJob.job.jobId,
      jobHash: hashRunnerJob(signedJob.job),
      snapshotHash: SNAPSHOT_HASH,
      environmentFingerprintHash: ENVIRONMENT_HASH,
      outcome: 'completed',
      exitCode: 0,
      resolvedBy: 'exit',
      executionTimingHash: 'e'.repeat(64),
    });
    expect(
      verifySignedExecutionReceipt(
        {
          ...signedReceipt,
          receipt: {
            ...signedReceipt.receipt,
            executionTimingHash: 'f'.repeat(64),
          },
        },
        authority.publicKey,
      ),
    ).toBe(false);
  });

  it('does not accept signatures from another Guardian identity', () => {
    const trusted = P256RunnerSigningAuthority.generate().authority;
    const attacker = P256RunnerSigningAuthority.generate().authority;
    const signed = createSignedRunnerJob({
      providerId: 'local-runner',
      leaseId: 'lease-1',
      snapshotHash: SNAPSHOT_HASH,
      operation: 'kill-session',
      payloadHash: 'e'.repeat(64),
      environmentFingerprintHash: ENVIRONMENT_HASH,
      authority: attacker,
    });

    expect(verifySignedRunnerJob(signed, trusted.publicKey)).toBe(false);
  });

  it('rejects signed envelopes whose declared key identity was tampered', () => {
    const authority = P256RunnerSigningAuthority.generate().authority;
    const signedJob = createSignedRunnerJob({
      providerId: 'local-runner',
      leaseId: 'lease-1',
      snapshotHash: SNAPSHOT_HASH,
      operation: 'execute-command',
      payloadHash: 'f'.repeat(64),
      environmentFingerprintHash: ENVIRONMENT_HASH,
      authority,
    });
    const signedReceipt = createSignedExecutionReceipt({
      signedJob,
      authority,
      startedAt: 10,
      finishedAt: 20,
      outcome: 'completed',
    });

    expect(
      verifySignedRunnerJob(
        {
          ...signedJob,
          job: {
            ...signedJob.job,
            authorityKeyId: 'tampered-key-id-1',
          },
        },
        authority.publicKey,
      ),
    ).toBe(false);
    expect(
      verifySignedExecutionReceipt(
        {
          ...signedReceipt,
          receipt: {
            ...signedReceipt.receipt,
            runnerKeyId: 'tampered-key-id-1',
          },
        },
        authority.publicKey,
      ),
    ).toBe(false);
  });
});
