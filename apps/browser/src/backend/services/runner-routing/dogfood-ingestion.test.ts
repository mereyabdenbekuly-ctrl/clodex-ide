import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AeadDataProtection,
  ProtectedFileStorage,
} from '@clodex/agent-core/host';
import { P256RunnerSigningAuthority } from '@clodex/agent-shell';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '@/services/logger';
import { signRunnerDogfoodEvidenceBundle } from './dogfood-evidence';
import {
  ingestRunnerDogfoodEvidenceDirectory,
  parseTrustedRunnerDogfoodCollectorKeys,
} from './dogfood-ingestion';
import { RunnerRoutingShadowLedger } from './shadow-ledger';

describe('runner dogfood evidence ingestion', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-dogfood-inbox-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('imports trusted files, rejects invalid files, and reports progress', async () => {
    const collector = P256RunnerSigningAuthority.generate();
    const ledger = new RunnerRoutingShadowLedger(
      new ProtectedFileStorage(new AeadDataProtection(randomBytes(32))),
      path.join(root, 'shadow.jsonl'),
      {} as Logger,
    );
    const bundle = signRunnerDogfoodEvidenceBundle(
      {
        schemaVersion: 2,
        bundleId: '00000000-0000-4000-8000-000000000001',
        collectedAt: 42,
        sourceCommitSha: '9'.repeat(40),
        samples: [
          {
            sampleId: '00000000-0000-4000-8000-000000000002',
            profile: 'ssh-read-only',
            commandClassHash: 'a'.repeat(64),
            snapshotHash: 'b'.repeat(64),
            actual: execution('local', 'local', 20),
            replay: {
              ...execution('ssh', 'ssh', 10),
              preparationDurationMs: 5,
              totalDurationMs: 15,
            },
          },
        ],
      },
      collector,
    );
    const inbox = path.join(root, 'inbox');
    await fs.mkdir(inbox);
    await fs.writeFile(path.join(inbox, 'valid.json'), JSON.stringify(bundle), {
      mode: 0o600,
    });
    await fs.writeFile(path.join(inbox, 'invalid.json'), '{"broken":true}');

    await expect(
      ingestRunnerDogfoodEvidenceDirectory({
        directory: inbox,
        trustedCollectorPublicKeys: [collector.publicKey],
        ledger,
      }),
    ).resolves.toMatchObject({
      scannedFiles: 2,
      acceptedFiles: 1,
      rejectedFiles: 1,
      importedSamples: 1,
      duplicateSamples: 0,
      profileProgress: [
        expect.objectContaining({
          profile: 'ssh-read-only',
          promotionReady: false,
        }),
      ],
      diagnostics: {
        sampleCount: 1,
        promotionEligibleCount: 1,
        controlledSampleCount: 0,
        scenarioMetrics: [
          expect.objectContaining({
            scenario: 'organic-read-only',
            sampleCount: 1,
          }),
        ],
      },
    });
  });

  it('parses a bounded explicit collector trust list', () => {
    expect(
      parseTrustedRunnerDogfoodCollectorKeys('abc_def-1234567890'),
    ).toEqual(['abc_def-1234567890']);
    expect(() => parseTrustedRunnerDogfoodCollectorKeys('not a key')).toThrow(
      'base64url',
    );
  });
});

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
