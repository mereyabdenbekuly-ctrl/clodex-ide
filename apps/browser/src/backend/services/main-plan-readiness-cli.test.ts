import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMainPlanReadinessCli } from '../../../scripts/check-main-plan-readiness';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('main plan readiness CLI', () => {
  it('writes an owner-only machine-readable closure report', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'main-plan-ready-'));
    temporaryRoots.push(root);
    const outputPath = path.join(root, 'readiness.json');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const report = await runMainPlanReadinessCli(
      ['--channel', 'release', '--out', outputPath],
      {
        now: () => new Date('2026-07-12T00:00:00.000Z'),
        inspectSource: () => ({
          commitSha: 'a'.repeat(40),
          clean: true,
        }),
        collectPromotions: () => ({}),
      },
    );

    expect(report).toMatchObject({
      schemaVersion: 1,
      codeComplete: true,
      buildReady: true,
      promotionReady: false,
      ready: true,
    });
    expect(JSON.parse(await fs.readFile(outputPath, 'utf8'))).toEqual(report);
    if (process.platform !== 'win32') {
      expect((await fs.stat(outputPath)).mode & 0o077).toBe(0);
    }
  });

  it('fails readiness when an explicitly requested promotion is absent', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const report = await runMainPlanReadinessCli(
      ['--channel', 'release', '--require-promotion', 'evidence-memory'],
      {
        now: () => new Date('2026-07-12T00:00:00.000Z'),
        inspectSource: () => ({
          commitSha: 'a'.repeat(40),
          clean: true,
        }),
        collectPromotions: () => ({}),
      },
    );

    expect(report?.ready).toBe(false);
    expect(report?.blockers).toContain(
      'evidence-memory:required-promotion-not-ready',
    );
  });

  it('fails closed when Model Fabric promotion is requested', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const report = await runMainPlanReadinessCli(
      ['--channel', 'release', '--require-promotion', 'model-fabric'],
      {
        now: () => new Date('2026-07-20T00:00:00.000Z'),
        inspectSource: () => ({
          commitSha: 'a'.repeat(40),
          clean: true,
        }),
        collectPromotions: () => ({}),
      },
    );

    expect(report?.ready).toBe(false);
    expect(report?.blockers).toContain(
      'model-fabric:required-promotion-not-ready',
    );
    expect(
      report?.epics.find((epic) => epic.id === 'model-fabric'),
    ).toMatchObject({
      promotionContract: 'not-yet-defined',
      promotionState: 'unsupported',
    });
  });

  it('rejects unknown epic identifiers', async () => {
    await expect(
      runMainPlanReadinessCli(['--require-promotion', 'not-a-real-epic']),
    ).rejects.toThrow('Unknown main-plan epic');
  });
});
