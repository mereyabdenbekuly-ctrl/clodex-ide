import { describe, expect, it } from 'vitest';
import {
  PROMOTION_PROFILE_KIND,
  PromotionAssessmentError,
  assessPromotion,
  hashPromotionProfile,
  type PromotionInvariantEvidence,
  type PromotionEvidenceTrustPort,
  type PromotionHashPort,
  type PromotionProfile,
} from './promotion-assessment.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const HASH_F = 'f'.repeat(64);
const hash: PromotionHashPort = { sha256: () => HASH_A };
const trust: PromotionEvidenceTrustPort = {
  verifyEvidence: () => true,
  assertCurrent: () => undefined,
};

function profileFixture(): PromotionProfile {
  return {
    kind: PROMOTION_PROFILE_KIND,
    version: 1,
    profileId: 'safe-coding-write-v1',
    targetGateId: 'artifact-bridge-write',
    environmentDigest: HASH_A,
    buildDigest: HASH_B,
    configurationDigest: HASH_C,
    evidencePolicyDigest: HASH_D,
    maxEvidenceAgeMs: 24 * 60 * 60 * 1_000,
    allowedIssuerIds: ['ci:trusted'],
    requirements: [
      { invariantId: 'INV-ATOMIC-001', scope: 'safe-coding-write' },
      { invariantId: 'INV-RETRY-001', scope: 'safe-coding-write' },
      { invariantId: 'INV-WAL-001', scope: 'safe-coding-write' },
    ],
  };
}

function evidenceFixture(
  invariantId: string,
  overrides: Partial<PromotionInvariantEvidence> = {},
): PromotionInvariantEvidence {
  return {
    invariantId,
    scope: 'safe-coding-write',
    status: 'ENFORCED',
    issuerId: 'ci:trusted',
    artifactDigest: HASH_E,
    verificationReceiptDigest: HASH_F,
    environmentDigest: HASH_A,
    buildDigest: HASH_B,
    configurationDigest: HASH_C,
    evidencePolicyDigest: HASH_D,
    verifiedAt: '2026-07-14T00:00:00Z',
    expiresAt: '2026-07-15T00:00:00Z',
    ...overrides,
  };
}

async function assess(
  evidence: readonly unknown[],
  overrides: Partial<Parameters<typeof assessPromotion>[0]> = {},
) {
  const profile = profileFixture();
  return await assessPromotion({
    profile,
    expectedProfileDigest: await hashPromotionProfile(profile, hash),
    evidence,
    hash,
    clock: { now: () => '2026-07-14T12:00:00Z' },
    trust,
    ...overrides,
  });
}

describe('promotion assessment', () => {
  it('returns eligibility only for exact fresh ENFORCED evidence and never enables a gate', async () => {
    const result = await assess([
      evidenceFixture('INV-ATOMIC-001'),
      evidenceFixture('INV-RETRY-001'),
      evidenceFixture('INV-WAL-001'),
    ]);

    expect(result.eligibility).toBe('eligible-for-reviewed-decision');
    expect(result.automaticEnablement).toBe(false);
    expect(result.blockers).toEqual([]);
    expect(result.assessmentDigest).toBe(HASH_A);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('blocks missing, non-enforced, stale, future, and wrong-scope evidence', async () => {
    const result = await assess([
      evidenceFixture('INV-ATOMIC-001', { status: 'TESTED' }),
      evidenceFixture('INV-RETRY-001', {
        verifiedAt: '2026-07-14T13:00:00Z',
        expiresAt: '2026-07-15T00:00:00Z',
      }),
      evidenceFixture('INV-WAL-001', { scope: 'different-scope' }),
    ]);
    expect(result.eligibility).toBe('blocked');
    expect(result.blockers).toEqual([
      {
        invariantId: 'INV-ATOMIC-001',
        observedStatus: 'TESTED',
        reason: 'status-not-enforced',
      },
      {
        invariantId: 'INV-RETRY-001',
        observedStatus: 'ENFORCED',
        reason: 'evidence-from-future',
      },
      {
        invariantId: 'INV-WAL-001',
        observedStatus: 'ENFORCED',
        reason: 'scope-mismatch',
      },
    ]);

    const missingAndExpired = await assess([
      evidenceFixture('INV-ATOMIC-001', {
        expiresAt: '2026-07-14T12:00:00Z',
      }),
      evidenceFixture('INV-WAL-001'),
    ]);
    expect(missingAndExpired.blockers.map((item) => item.reason)).toEqual([
      'evidence-expired',
      'invariant-missing',
    ]);
  });

  it('blocks old, untrusted, wrong-build, and unapproved-issuer evidence', async () => {
    const untrusted: PromotionEvidenceTrustPort = {
      verifyEvidence: (evidence) => evidence.invariantId !== 'INV-RETRY-001',
      assertCurrent: () => undefined,
    };
    const result = await assess(
      [
        evidenceFixture('INV-ATOMIC-001', {
          verifiedAt: '2000-01-01T00:00:00Z',
          expiresAt: '9999-12-31T23:59:59Z',
        }),
        evidenceFixture('INV-RETRY-001'),
        evidenceFixture('INV-WAL-001', { buildDigest: HASH_F }),
      ],
      { trust: untrusted },
    );
    expect(result.blockers.map((blocker) => blocker.reason)).toEqual([
      'evidence-too-old',
      'evidence-untrusted',
      'build-mismatch',
    ]);

    const issuer = await assess([
      evidenceFixture('INV-ATOMIC-001', { issuerId: 'ci:unknown' }),
      evidenceFixture('INV-RETRY-001'),
      evidenceFixture('INV-WAL-001'),
    ]);
    expect(issuer.blockers[0]?.reason).toBe('issuer-untrusted');
  });

  it('rejects profile digest drift and duplicate evidence', async () => {
    await expect(
      assess([], { expectedProfileDigest: HASH_B }),
    ).rejects.toMatchObject({
      code: 'profile-digest-mismatch',
    });
    await expect(
      assess([
        evidenceFixture('INV-ATOMIC-001'),
        evidenceFixture('INV-ATOMIC-001'),
      ]),
    ).rejects.toMatchObject({ code: 'evidence-duplicate' });
    await expect(
      assess([evidenceFixture('INV-UNEXPECTED-001')]),
    ).rejects.toThrow(/Unexpected evidence/);
  });

  it('rejects unknown fields, accessors, unsorted requirements, and invalid time windows', async () => {
    await expect(
      hashPromotionProfile({ ...profileFixture(), unexpected: true }, hash),
    ).rejects.toBeInstanceOf(PromotionAssessmentError);

    const accessor = { ...profileFixture() } as Record<string, unknown>;
    Object.defineProperty(accessor, 'profileId', {
      enumerable: true,
      get: () => 'unsafe',
    });
    await expect(hashPromotionProfile(accessor, hash)).rejects.toThrow(
      /accessors/,
    );

    await expect(
      hashPromotionProfile(
        {
          ...profileFixture(),
          requirements: [...profileFixture().requirements].reverse(),
        },
        hash,
      ),
    ).rejects.toThrow(/sorted/);

    await expect(
      assess([
        evidenceFixture('INV-ATOMIC-001', {
          verifiedAt: '2026-07-15T00:00:00Z',
          expiresAt: '2026-07-14T00:00:00Z',
        }),
      ]),
    ).rejects.toThrow(/expiry/);

    let evidenceGetterReads = 0;
    const evidence: unknown[] = [];
    Object.defineProperty(evidence, '0', {
      enumerable: true,
      get: () => {
        evidenceGetterReads += 1;
        return evidenceFixture('INV-ATOMIC-001');
      },
    });
    evidence.length = 1;
    await expect(assess(evidence)).rejects.toThrow(/accessors/);
    expect(evidenceGetterReads).toBe(0);

    let deep: unknown = 'leaf';
    for (let index = 0; index < 70; index += 1) deep = { child: deep };
    await expect(
      hashPromotionProfile({ ...profileFixture(), requirements: deep }, hash),
    ).rejects.toThrow(/depth budget/);
  });

  it('uses a trusted clock and a synchronous final trust fence', async () => {
    const expired = await assess(
      [
        evidenceFixture('INV-ATOMIC-001'),
        evidenceFixture('INV-RETRY-001'),
        evidenceFixture('INV-WAL-001'),
      ],
      { clock: { now: () => '2026-07-15T00:00:00Z' } },
    );
    expect(expired.eligibility).toBe('blocked');
    expect(
      expired.blockers.every((item) => item.reason === 'evidence-expired'),
    ).toBe(true);

    await expect(
      assess(
        [
          evidenceFixture('INV-ATOMIC-001'),
          evidenceFixture('INV-RETRY-001'),
          evidenceFixture('INV-WAL-001'),
        ],
        {
          trust: {
            verifyEvidence: () => true,
            assertCurrent: (() => Promise.resolve()) as never,
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'trust-port-failed' });
  });

  it('produces the same evidence digest regardless of bundle order', async () => {
    const forward = [
      evidenceFixture('INV-ATOMIC-001'),
      evidenceFixture('INV-RETRY-001'),
      evidenceFixture('INV-WAL-001'),
    ];
    const reversed = [...forward].reverse();
    expect((await assess(forward)).evidenceBundleDigest).toBe(
      (await assess(reversed)).evidenceBundleDigest,
    );
  });
});
