import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCloudTaskReleaseEvidenceCollector } from '../../../scripts/collect-cloud-task-release-evidence';
import { createCloudTaskSuspendResumeSmokeEvidence } from '../../shared/cloud-task-suspend-resume-smoke';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('Cloud Task release evidence collector CLI', () => {
  it('writes owner-only candidate evidence from three platform smokes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T00:00:00.000Z'));
    const root = await temporaryRoot();
    const aggregatePath = path.join(root, 'aggregate.json');
    const outputPath = path.join(root, 'cloud-tasks.json');
    await fs.writeFile(aggregatePath, JSON.stringify(readyAggregate()), 'utf8');
    const smokePaths = await writeSmokes(root);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runCloudTaskReleaseEvidenceCollector([
      '--aggregate',
      aggregatePath,
      '--source-commit',
      'a'.repeat(40),
      ...smokePaths.flatMap((smokePath) => ['--smoke', smokePath]),
      '--backend-conformance-passed',
      '--content-free-telemetry-audit-passed',
      '--product-signoff',
      '--security-signoff',
      '--operations-signoff',
      '--output',
      outputPath,
    ]);

    const evidence = JSON.parse(await fs.readFile(outputPath, 'utf8'));
    expect(evidence).toMatchObject({
      schemaVersion: 2,
      sourceCommitSha: 'a'.repeat(40),
      qualityGates: {
        macosSuspendResumePassed: true,
        windowsSuspendResumePassed: true,
        linuxSuspendResumePassed: true,
      },
      humanSignoff: { product: true, security: true, operations: true },
    });
    if (process.platform !== 'win32') {
      expect((await fs.stat(outputPath)).mode & 0o077).toBe(0);
    }
    vi.useRealTimers();
  });

  it('writes nothing without explicit security sign-off', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T00:00:00.000Z'));
    const root = await temporaryRoot();
    const aggregatePath = path.join(root, 'aggregate.json');
    const outputPath = path.join(root, 'cloud-tasks.json');
    await fs.writeFile(aggregatePath, JSON.stringify(readyAggregate()), 'utf8');
    const smokePaths = await writeSmokes(root);

    await expect(
      runCloudTaskReleaseEvidenceCollector([
        '--aggregate',
        aggregatePath,
        '--source-commit',
        'a'.repeat(40),
        ...smokePaths.flatMap((smokePath) => ['--smoke', smokePath]),
        '--backend-conformance-passed',
        '--content-free-telemetry-audit-passed',
        '--product-signoff',
        '--operations-signoff',
        '--output',
        outputPath,
      ]),
    ).rejects.toThrow('--security-signoff');
    await expect(fs.stat(outputPath)).rejects.toThrow();
    vi.useRealTimers();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-task-release-'));
  temporaryRoots.push(root);
  return root;
}

async function writeSmokes(root: string): Promise<string[]> {
  return await Promise.all(
    (['darwin', 'win32', 'linux'] as const).map(async (platform) => {
      const smokePath = path.join(root, `${platform}.json`);
      await fs.writeFile(
        smokePath,
        JSON.stringify(
          createCloudTaskSuspendResumeSmokeEvidence({
            platform,
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
        'utf8',
      );
      return smokePath;
    }),
  );
}

function readyAggregate() {
  return {
    schemaVersion: 2,
    sourceChannel: 'prerelease',
    observationStartedAt: '2026-07-07T00:00:00.000Z',
    observationEndedAt: '2026-07-10T12:00:00.000Z',
    observedBuildCount: 3,
    observedInstallCount: 40,
    executions: { completed: 245, failed: 3, cancelled: 12 },
    failures: { network: 4, resume: 1, integrity: 0, policyLimit: 1 },
    reconciliation: { inspected: 80, failed: 0 },
    artifactActions: { attempted: 100, failed: 1 },
    latency: { startP95Ms: 2_400, reconnectP95Ms: 1_200 },
  };
}
