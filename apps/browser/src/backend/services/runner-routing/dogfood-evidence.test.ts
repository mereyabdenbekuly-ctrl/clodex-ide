import { randomUUID } from 'node:crypto';
import { P256RunnerSigningAuthority } from '@clodex/agent-shell';
import { describe, expect, it } from 'vitest';
import {
  signRunnerDogfoodEvidenceBundle,
  verifyRunnerDogfoodEvidenceBundle,
} from './dogfood-evidence';

describe('runner dogfood evidence', () => {
  it('signs and verifies a strict content-free profile bundle', () => {
    const generated = P256RunnerSigningAuthority.generate();
    const bundle = signRunnerDogfoodEvidenceBundle(unsignedBundle(), generated);

    expect(
      verifyRunnerDogfoodEvidenceBundle(bundle, [generated.publicKey]),
    ).toEqual(bundle);
    expect(JSON.stringify(bundle)).not.toContain('git status');
    expect(JSON.stringify(bundle)).not.toContain('/private/workspace');
  });

  it('rejects untrusted, tampered, and profile-mismatched evidence', () => {
    const generated = P256RunnerSigningAuthority.generate();
    const other = P256RunnerSigningAuthority.generate();
    const bundle = signRunnerDogfoodEvidenceBundle(unsignedBundle(), generated);

    expect(() =>
      verifyRunnerDogfoodEvidenceBundle(bundle, [other.publicKey]),
    ).toThrow('not trusted');
    expect(() =>
      verifyRunnerDogfoodEvidenceBundle(
        {
          ...bundle,
          samples: bundle.samples.map((sample) => ({
            ...sample,
            replay: { ...sample.replay, durationMs: 1 },
          })),
        },
        [generated.publicKey],
      ),
    ).toThrow('signature is invalid');
    expect(() =>
      signRunnerDogfoodEvidenceBundle(
        {
          ...unsignedBundle(),
          samples: unsignedBundle().samples.map((sample) => ({
            ...sample,
            profile: 'cargo-cache' as const,
          })),
        },
        generated,
      ),
    ).toThrow('does not match replay provider');
  });

  it('keeps controlled faults diagnostic-only', () => {
    const generated = P256RunnerSigningAuthority.generate();
    const controlled = unsignedBundle();
    const bundle = signRunnerDogfoodEvidenceBundle(
      {
        ...controlled,
        samples: controlled.samples.map((sample) => ({
          ...sample,
          scenario: 'controlled-local-timeout' as const,
          promotionEligible: false,
        })),
      },
      generated,
    );

    expect(
      verifyRunnerDogfoodEvidenceBundle(bundle, [generated.publicKey])
        .samples[0],
    ).toMatchObject({
      scenario: 'controlled-local-timeout',
      promotionEligible: false,
    });
    expect(() =>
      signRunnerDogfoodEvidenceBundle(
        {
          ...controlled,
          samples: controlled.samples.map((sample) => ({
            ...sample,
            scenario: 'controlled-local-timeout' as const,
            promotionEligible: true,
          })),
        },
        generated,
      ),
    ).toThrow('cannot unlock promotion');
  });
});

function unsignedBundle() {
  return {
    schemaVersion: 2 as const,
    bundleId: randomUUID(),
    collectedAt: 42,
    sourceCommitSha: '9'.repeat(40),
    samples: [
      {
        sampleId: randomUUID(),
        profile: 'ssh-read-only' as const,
        commandClassHash: 'a'.repeat(64),
        snapshotHash: 'b'.repeat(64),
        actual: execution('local-dogfood', 'local', 20),
        replay: {
          ...execution('ssh-dogfood', 'ssh', 10),
          preparationDurationMs: 5,
          totalDurationMs: 15,
        },
      },
    ],
  };
}

function execution(
  providerId: string,
  providerKind: 'local' | 'ssh',
  durationMs: number,
) {
  return {
    providerId,
    providerKind,
    environmentFingerprintHash: 'c'.repeat(64),
    outcome: 'completed' as const,
    durationMs,
    timedOut: false,
    exitCodeClass: 'zero' as const,
    receiptHash: providerKind === 'local' ? 'd'.repeat(64) : 'e'.repeat(64),
    jobHash: providerKind === 'local' ? 'f'.repeat(64) : '1'.repeat(64),
    outputHash: '2'.repeat(64),
    artifactManifestHash: null,
  };
}
