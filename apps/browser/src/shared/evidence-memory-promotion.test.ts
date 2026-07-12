import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getEvidenceMemoryRolloutPolicy } from './evidence-memory-rollout';
import {
  createEvidenceMemoryPromotionEvidence,
  EVIDENCE_MEMORY_REPOSITORY_EVIDENCE_PATHS,
  evaluateEvidenceMemoryPromotionReadiness,
  parseEvidenceMemoryPromotionEvidence,
  type EvidenceMemoryPromotionArtifactSummary,
} from './evidence-memory-promotion';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const quality = artifact({
  generatedAt: '2026-07-12T00:00:00.000Z',
  policyHash: 'a'.repeat(64),
});
const traceReplay = artifact({
  generatedAt: '2026-07-12T00:05:00.000Z',
  policyHash: 'b'.repeat(64),
  traceSetHash: 'c'.repeat(64),
  source: 'external-content-free-trace',
});
const sourceCommitSha = 'd'.repeat(40);
const buildCommitSha = 'e'.repeat(40);

describe('Evidence Memory promotion evidence', () => {
  it('verifies signed, fresh, exact-commit external evidence', () => {
    const evidence = createEvidence();
    const readiness = evaluateEvidenceMemoryPromotionReadiness(evidence, {
      publicKey,
      sourceBinding: {
        buildCommitSha: sourceCommitSha,
        sourceCommitIsAncestor: true,
        changedPaths: [],
      },
      currentPolicy: getEvidenceMemoryRolloutPolicy('prerelease'),
      quality,
      traceReplay,
      now: new Date('2026-07-12T12:00:00.000Z'),
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.validityHours).toBe(48);
  });

  it('accepts a distinct evidence-only repository commit', () => {
    const evidence = createEvidence({
      deliveryMode: 'repository-evidence-commit',
    });
    const readiness = evaluateEvidenceMemoryPromotionReadiness(evidence, {
      publicKey,
      sourceBinding: {
        buildCommitSha,
        sourceCommitIsAncestor: true,
        changedPaths: EVIDENCE_MEMORY_REPOSITORY_EVIDENCE_PATHS,
      },
      currentPolicy: getEvidenceMemoryRolloutPolicy('prerelease'),
      quality,
      traceReplay,
      now: new Date('2026-07-12T12:00:00.000Z'),
    });

    expect(readiness.ready).toBe(true);
  });

  it('fails when linked evidence or the source commit changes', () => {
    const readiness = evaluateEvidenceMemoryPromotionReadiness(
      createEvidence(),
      {
        publicKey,
        sourceBinding: {
          buildCommitSha,
          sourceCommitIsAncestor: true,
          changedPaths: [],
        },
        currentPolicy: getEvidenceMemoryRolloutPolicy('prerelease'),
        quality: { ...quality, bytes: Buffer.from('changed-quality') },
        traceReplay: {
          ...traceReplay,
          source: 'fixture',
        },
        now: new Date('2026-07-12T12:00:00.000Z'),
      },
    );

    expect(readiness.ready).toBe(false);
    expect(
      readiness.checks.filter((item) => !item.passed).map((item) => item.id),
    ).toEqual(
      expect.arrayContaining([
        'source-commit-matches-build',
        'quality-sha256-matches',
        'external-trace-evidence',
      ]),
    );
  });

  it('rejects code changes hidden behind a repository evidence commit', () => {
    const readiness = evaluateEvidenceMemoryPromotionReadiness(
      createEvidence({ deliveryMode: 'repository-evidence-commit' }),
      {
        publicKey,
        sourceBinding: {
          buildCommitSha,
          sourceCommitIsAncestor: true,
          changedPaths: [
            ...EVIDENCE_MEMORY_REPOSITORY_EVIDENCE_PATHS,
            'packages/agent-core/src/agents/base-agent.ts',
          ],
        },
        currentPolicy: getEvidenceMemoryRolloutPolicy('prerelease'),
        quality,
        traceReplay,
        now: new Date('2026-07-12T12:00:00.000Z'),
      },
    );

    expect(readiness.ready).toBe(false);
    expect(
      readiness.checks.find((item) => item.id === 'promotion-diff-allowed'),
    ).toMatchObject({ passed: false });
  });

  it('fails closed after expiry or signature tampering', () => {
    const evidence = createEvidence();
    const tampered = {
      ...evidence,
      sourceCommitSha: 'e'.repeat(40),
    };
    const readiness = evaluateEvidenceMemoryPromotionReadiness(
      parseEvidenceMemoryPromotionEvidence(tampered),
      {
        publicKey,
        sourceBinding: {
          buildCommitSha: sourceCommitSha,
          sourceCommitIsAncestor: true,
          changedPaths: [],
        },
        currentPolicy: getEvidenceMemoryRolloutPolicy('prerelease'),
        quality,
        traceReplay,
        now: new Date('2026-07-15T00:00:00.001Z'),
      },
    );

    expect(readiness.ready).toBe(false);
    expect(
      readiness.checks.filter((item) => !item.passed).map((item) => item.id),
    ).toEqual(
      expect.arrayContaining(['valid-signature', 'evidence-not-expired']),
    );
  });

  it('rejects freshly signed envelopes around stale linked reports', () => {
    const evidence = createEvidenceMemoryPromotionEvidence({
      privateKey,
      keyId: 'test-key',
      body: {
        ...createEvidenceBody(),
        generatedAt: '2026-07-15T00:00:00.000Z',
        expiresAt: '2026-07-17T00:00:00.000Z',
      },
    });
    const readiness = evaluateEvidenceMemoryPromotionReadiness(evidence, {
      publicKey,
      sourceBinding: {
        buildCommitSha: sourceCommitSha,
        sourceCommitIsAncestor: true,
        changedPaths: [],
      },
      currentPolicy: getEvidenceMemoryRolloutPolicy('prerelease'),
      quality,
      traceReplay,
      now: new Date('2026-07-15T00:00:00.000Z'),
    });

    expect(readiness.ready).toBe(false);
    expect(
      readiness.checks.filter((item) => !item.passed).map((item) => item.id),
    ).toEqual(
      expect.arrayContaining([
        'quality-evidence-fresh',
        'trace-evidence-fresh',
      ]),
    );
  });

  it('strictly rejects content-bearing or unknown fields', () => {
    expect(() =>
      parseEvidenceMemoryPromotionEvidence({
        ...createEvidence(),
        prompt: 'private task content',
      }),
    ).toThrow();
  });
});

function createEvidence(
  options: {
    deliveryMode?: 'external-ci-artifact' | 'repository-evidence-commit';
  } = {},
) {
  return createEvidenceMemoryPromotionEvidence({
    privateKey,
    keyId: 'test-key',
    body: createEvidenceBody(options),
  });
}

function createEvidenceBody(
  options: {
    deliveryMode?: 'external-ci-artifact' | 'repository-evidence-commit';
  } = {},
) {
  return {
    schemaVersion: 2 as const,
    sourceChannel: 'prerelease' as const,
    generatedAt: '2026-07-12T00:00:00.000Z',
    expiresAt: '2026-07-14T00:00:00.000Z',
    sourceCommitSha,
    delivery: {
      mode: options.deliveryMode ?? ('external-ci-artifact' as const),
    },
    targetStage: 'canary-5' as const,
    qualityEvidence: {
      generatedAt: quality.generatedAt,
      sha256: sha256(quality.bytes),
      policyHash: quality.policyHash,
    },
    traceReplayEvidence: {
      generatedAt: traceReplay.generatedAt,
      sha256: sha256(traceReplay.bytes),
      policyHash: traceReplay.policyHash,
      traceSetHash: traceReplay.traceSetHash!,
    },
  };
}

function artifact(
  overrides: Partial<EvidenceMemoryPromotionArtifactSummary>,
): EvidenceMemoryPromotionArtifactSummary {
  return {
    bytes: Buffer.from(JSON.stringify(overrides)),
    generatedAt: '2026-07-12T00:00:00.000Z',
    policyHash: 'a'.repeat(64),
    promotionReady: true,
    ...overrides,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
