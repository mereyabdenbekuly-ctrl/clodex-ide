import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { P256RunnerSigningAuthority } from '@clodex/agent-shell';
import { afterEach, describe, expect, it } from 'vitest';
import { signRunnerDogfoodEvidenceBundle } from './runner-routing/dogfood-evidence';
import {
  assessRunnerPromotion,
  evaluateRunnerPromotionBundles,
} from './main-plan-promotion-assessments';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('main plan promotion assessments', () => {
  it('accepts fresh signed SSH paired replay with bounded workload coverage', () => {
    const identity = P256RunnerSigningAuthority.generate();
    const now = new Date('2026-07-12T00:00:00.000Z');
    const bundle = signRunnerDogfoodEvidenceBundle(
      unsignedBundle(now.getTime()),
      identity,
    );

    expect(evaluateRunnerPromotionBundles([bundle], now)).toMatchObject({
      state: 'ready',
      blockers: [],
      details: {
        bundleCount: 1,
        physicalSampleCount: 4,
        distinctCommandClasses: 2,
        providerKinds: 'ssh',
      },
    });
  });

  it('rejects physical runner evidence collected from another source commit', () => {
    const identity = P256RunnerSigningAuthority.generate();
    const now = new Date('2026-07-12T00:00:00.000Z');
    const bundle = signRunnerDogfoodEvidenceBundle(
      unsignedBundle(now.getTime()),
      identity,
    );

    expect(
      evaluateRunnerPromotionBundles(
        [bundle],
        now,
        'in-memory',
        '8'.repeat(40),
      ),
    ).toMatchObject({
      state: 'not-ready',
      blockers: expect.arrayContaining(['runner-source-commit-mismatch']),
    });
  });

  it('verifies pinned collectors from disk and rejects untrusted bundles', async () => {
    const root = await temporaryRoot();
    const evidenceDirectoryPath = path.join(root, 'runner-routing');
    const trustedCollectorPublicKeysPath = path.join(root, 'collectors.txt');
    await fs.mkdir(evidenceDirectoryPath);
    const now = new Date('2026-07-12T00:00:00.000Z');
    const identity = P256RunnerSigningAuthority.generate();
    const bundle = signRunnerDogfoodEvidenceBundle(
      unsignedBundle(now.getTime()),
      identity,
    );
    await fs.writeFile(
      path.join(evidenceDirectoryPath, 'ssh.json'),
      JSON.stringify(bundle),
      'utf8',
    );
    await fs.writeFile(
      trustedCollectorPublicKeysPath,
      identity.publicKey,
      'utf8',
    );

    expect(
      assessRunnerPromotion({
        now,
        buildCommitSha: '9'.repeat(40),
        evidenceDirectoryPath,
        trustedCollectorPublicKeysPath,
      }),
    ).toMatchObject({ state: 'ready', blockers: [] });

    const untrusted = P256RunnerSigningAuthority.generate();
    await fs.writeFile(
      trustedCollectorPublicKeysPath,
      untrusted.publicKey,
      'utf8',
    );
    expect(
      assessRunnerPromotion({
        now,
        buildCommitSha: '9'.repeat(40),
        evidenceDirectoryPath,
        trustedCollectorPublicKeysPath,
      }),
    ).toMatchObject({
      state: 'invalid',
      blockers: ['runner-evidence-validation-failed'],
    });
  });

  it('does not let controlled-only or stale replay unlock promotion', () => {
    const identity = P256RunnerSigningAuthority.generate();
    const now = new Date('2026-07-12T00:00:00.000Z');
    const controlled = unsignedBundle(now.getTime() - 8 * 24 * 60 * 60_000);
    const bundle = signRunnerDogfoodEvidenceBundle(
      {
        ...controlled,
        samples: controlled.samples.map((sample) => ({
          ...sample,
          scenario: 'controlled-local-failure' as const,
          promotionEligible: false,
        })),
      },
      identity,
    );
    const assessment = evaluateRunnerPromotionBundles([bundle], now);

    expect(assessment.state).toBe('not-ready');
    expect(assessment.blockers).toEqual(
      expect.arrayContaining([
        'runner-evidence-stale',
        'runner-physical-samples-insufficient',
        'runner-command-class-coverage-insufficient',
      ]),
    );
  });

  it('rejects duplicated signed bundles instead of counting replayed evidence', () => {
    const identity = P256RunnerSigningAuthority.generate();
    const now = new Date('2026-07-12T00:00:00.000Z');
    const bundle = signRunnerDogfoodEvidenceBundle(
      unsignedBundle(now.getTime()),
      identity,
    );
    const assessment = evaluateRunnerPromotionBundles([bundle, bundle], now);

    expect(assessment.state).toBe('not-ready');
    expect(assessment.blockers).toEqual(
      expect.arrayContaining([
        'runner-bundle-replay-detected',
        'runner-sample-replay-detected',
        'runner-receipt-replay-detected',
        'runner-job-replay-detected',
      ]),
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'main-plan-promotion-'));
  temporaryRoots.push(root);
  return root;
}

function unsignedBundle(collectedAt: number) {
  return {
    schemaVersion: 2 as const,
    bundleId: randomUUID(),
    collectedAt,
    sourceCommitSha: '9'.repeat(40),
    samples: Array.from({ length: 4 }, (_, index) => ({
      sampleId: randomUUID(),
      profile: 'ssh-read-only' as const,
      commandClassHash: (index % 2 === 0 ? 'a' : 'b').repeat(64),
      snapshotHash: 'c'.repeat(64),
      actual: execution(`local-${index}`, 'local', 20 + index),
      replay: execution(`ssh-${index}`, 'ssh', 10 + index),
    })),
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
    environmentFingerprintHash: 'd'.repeat(64),
    outcome: 'completed' as const,
    durationMs,
    timedOut: false,
    exitCodeClass: 'zero' as const,
    receiptHash: hash(`${providerId}:receipt`),
    jobHash: hash(`${providerId}:job`),
    outputHash: hash(`${providerId}:output`),
    artifactManifestHash: null,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
