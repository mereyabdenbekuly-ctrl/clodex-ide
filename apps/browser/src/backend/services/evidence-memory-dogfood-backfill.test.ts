import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvidenceMemoryDogfoodBackfill } from './evidence-memory-dogfood-backfill';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('EvidenceMemoryDogfoodBackfill', () => {
  it('replays compressed archives into restart and supersession observations', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-backfill-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'agents', 'task-a'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'index.json'),
      JSON.stringify({ agents: { 'task-a': { messageCount: 2 } } }),
    );
    await fs.writeFile(
      path.join(root, 'agents', 'task-a', 'history.jsonl'),
      [
        JSON.stringify({
          sequence: 1,
          serializedAt: '2026-07-01T00:00:00.000Z',
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'Keep the API stable.' }],
            metadata: {
              compressedHistory: 'The old mode flag was enabled.',
            },
          },
        }),
        JSON.stringify({
          sequence: 2,
          serializedAt: '2026-07-01T00:00:01.000Z',
          message: {
            role: 'assistant',
            parts: [{ type: 'text', text: 'I will inspect the API mode.' }],
          },
        }),
      ].join('\n'),
    );
    const recordLiveDogfoodComparison = vi.fn(async (input: any) => ({
      observation: {},
      report: {},
      cohortReport: {},
      input,
    }));
    const evidenceMemory = {
      getLatestRepositoryRevision: vi.fn(async () => 'revision-a'),
      buildContextPack: vi.fn(async ({ taskId }: any) => ({
        id: 'pack',
        taskId,
        queryHash: 'query',
        tokenBudget: 4_000,
        estimatedTokens: 100,
        items: [{ claim: { id: 'current' } }],
        excludedStaleClaimIds: [],
        exclusions: [],
        diagnostics: {},
        createdAt: 1,
        shadow: true,
      })),
      evaluateContextPackForDogfood: vi.fn(async ({ pack }: any) => ({
        admitted: true,
        reasonCodes: ['admitted'],
        estimatedTokens: 100,
        claimCount: 1,
        selectedItems: pack.items,
        policyHash: 'a'.repeat(64),
      })),
      searchClaims: vi.fn(async () => [
        {
          claim: { id: 'old', status: 'superseded' },
          revisionStatus: 'unbound',
        },
      ]),
      recordLiveDogfoodComparison,
    };
    const backfill = new EvidenceMemoryDogfoodBackfill({
      memoryDir: root,
      evidenceMemory: evidenceMemory as never,
    });

    const result = await backfill.run();

    expect(result).toEqual({
      archivesScanned: 1,
      archivesWithCompression: 1,
      observationsReplayed: 2,
      observationsSkipped: 0,
      failures: 0,
    });
    expect(recordLiveDogfoodComparison).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        categoryOverride: 'restart',
        observedAt: Date.parse('2026-07-01T00:00:00.000Z'),
      }),
    );
    expect(recordLiveDogfoodComparison).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        categoryOverride: 'supersession',
        forbiddenClaimIds: ['old'],
      }),
    );
  });

  it('skips archives without compressed history', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-backfill-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'agents', 'task-a'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'index.json'),
      JSON.stringify({ agents: { 'task-a': {} } }),
    );
    await fs.writeFile(
      path.join(root, 'agents', 'task-a', 'history.jsonl'),
      `${JSON.stringify({
        sequence: 1,
        serializedAt: '2026-07-01T00:00:00.000Z',
        message: {
          role: 'user',
          parts: [{ type: 'text', text: 'Short task.' }],
        },
      })}\n`,
    );
    const backfill = new EvidenceMemoryDogfoodBackfill({
      memoryDir: root,
      evidenceMemory: {} as never,
    });

    await expect(backfill.run()).resolves.toEqual({
      archivesScanned: 1,
      archivesWithCompression: 0,
      observationsReplayed: 0,
      observationsSkipped: 0,
      failures: 0,
    });
  });

  it('skips compressed archives until repository revision evidence exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-backfill-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'agents', 'task-a'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'index.json'),
      JSON.stringify({ agents: { 'task-a': {} } }),
    );
    await fs.writeFile(
      path.join(root, 'agents', 'task-a', 'history.jsonl'),
      `${JSON.stringify({
        sequence: 1,
        serializedAt: '2026-07-01T00:00:00.000Z',
        message: {
          role: 'user',
          parts: [{ type: 'text', text: 'Keep the API stable.' }],
          metadata: { compressedHistory: 'Keep the API stable.' },
        },
      })}\n`,
    );
    const evidenceMemory = {
      getLatestRepositoryRevision: vi.fn(async () => null),
      buildContextPack: vi.fn(),
      evaluateContextPackForDogfood: vi.fn(),
      recordLiveDogfoodComparison: vi.fn(),
      searchClaims: vi.fn(),
    };
    const backfill = new EvidenceMemoryDogfoodBackfill({
      memoryDir: root,
      evidenceMemory: evidenceMemory as never,
    });

    await expect(backfill.run()).resolves.toEqual({
      archivesScanned: 1,
      archivesWithCompression: 1,
      observationsReplayed: 0,
      observationsSkipped: 1,
      failures: 0,
    });
    expect(evidenceMemory.buildContextPack).not.toHaveBeenCalled();
    expect(evidenceMemory.recordLiveDogfoodComparison).not.toHaveBeenCalled();
  });

  it('isolates an explicit cohort and can replay only the restart checkpoint', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-backfill-'));
    roots.push(root);
    for (const taskId of ['task-a', 'task-b']) {
      await fs.mkdir(path.join(root, 'agents', taskId), { recursive: true });
      await fs.writeFile(
        path.join(root, 'agents', taskId, 'history.jsonl'),
        [1, 2]
          .map((sequence) =>
            JSON.stringify({
              sequence,
              serializedAt: `2026-07-01T00:00:0${sequence}.000Z`,
              message: {
                role: 'user',
                parts: [{ type: 'text', text: `${taskId} query ${sequence}` }],
                metadata: {
                  compressedHistory: `${taskId} summary ${sequence}`,
                },
              },
            }),
          )
          .join('\n'),
      );
    }
    await fs.writeFile(
      path.join(root, 'index.json'),
      JSON.stringify({ agents: { 'task-a': {}, 'task-b': {} } }),
    );
    const recordLiveDogfoodComparison = vi.fn(async () => ({
      observation: {},
      report: {},
      cohortReport: {},
    }));
    const evidenceMemory = {
      getLatestRepositoryRevision: vi.fn(async () => 'revision-a'),
      buildContextPack: vi.fn(async ({ taskId }: any) => ({
        id: 'pack',
        taskId,
        queryHash: 'query',
        tokenBudget: 4_000,
        estimatedTokens: 10,
        items: [{ claim: { id: 'current' } }],
        excludedStaleClaimIds: [],
        exclusions: [],
        diagnostics: {},
        createdAt: 1,
        shadow: true,
      })),
      evaluateContextPackForDogfood: vi.fn(async ({ pack }: any) => ({
        admitted: true,
        reasonCodes: ['admitted'],
        estimatedTokens: 10,
        claimCount: 1,
        selectedItems: pack.items,
        policyHash: 'a'.repeat(64),
      })),
      searchClaims: vi.fn(async () => []),
      recordLiveDogfoodComparison,
    };
    const backfill = new EvidenceMemoryDogfoodBackfill({
      memoryDir: root,
      evidenceMemory: evidenceMemory as never,
    });

    const result = await backfill.run({
      agentIds: ['task-b'],
      firstCompressionOnly: true,
      cohortIdSeed: 'run-b',
      scenarioNamespace: 'isolated-v2',
    });

    expect(result).toEqual({
      archivesScanned: 1,
      archivesWithCompression: 1,
      observationsReplayed: 1,
      observationsSkipped: 0,
      failures: 0,
    });
    expect(evidenceMemory.buildContextPack).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-b' }),
    );
    expect(recordLiveDogfoodComparison).toHaveBeenCalledWith(
      expect.objectContaining({
        cohortIdSeed: 'run-b',
        scenarioIdSeed: 'isolated-v2:task-b:1:restart',
      }),
    );

    recordLiveDogfoodComparison.mockClear();
    evidenceMemory.searchClaims.mockClear();
    const allCheckpoints = await backfill.run({
      agentIds: ['task-a'],
      classifyEveryCompressionAsRestart: true,
      includeSupersessionProbes: false,
      cohortIdSeed: 'run-a',
      scenarioNamespace: 'restart-sweep-v2',
    });

    expect(allCheckpoints.observationsReplayed).toBe(2);
    expect(recordLiveDogfoodComparison).toHaveBeenCalledTimes(2);
    expect(recordLiveDogfoodComparison).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        categoryOverride: 'restart',
        scenarioIdSeed: 'restart-sweep-v2:task-a:1:restart',
      }),
    );
    expect(recordLiveDogfoodComparison).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        categoryOverride: 'restart',
        scenarioIdSeed: 'restart-sweep-v2:task-a:2:restart',
      }),
    );
    expect(evidenceMemory.searchClaims).not.toHaveBeenCalled();
  });

  it('retries an empty restart query with the persisted compressed summary', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-backfill-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'agents', 'task-a'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'index.json'),
      JSON.stringify({ agents: { 'task-a': {} } }),
    );
    await fs.writeFile(
      path.join(root, 'agents', 'task-a', 'history.jsonl'),
      `${JSON.stringify({
        sequence: 1,
        serializedAt: '2026-07-01T00:00:00.000Z',
        message: {
          role: 'user',
          parts: [{ type: 'text', text: 'Continue after restart.' }],
          metadata: {
            compressedHistory: 'Retain marker EMDF-RESTART-1 and value_1_1.',
          },
        },
      })}\n`,
    );
    const emptyPack = {
      id: 'empty',
      taskId: 'task-a',
      queryHash: 'empty-query',
      tokenBudget: 4_000,
      estimatedTokens: 0,
      items: [],
      excludedStaleClaimIds: [],
      exclusions: [],
      diagnostics: {},
      createdAt: 1,
      shadow: true,
    };
    const recoveredPack = {
      ...emptyPack,
      id: 'recovered',
      queryHash: 'fallback-query',
      estimatedTokens: 10,
      items: [{ claim: { id: 'restart-claim' } }],
    };
    const buildContextPack = vi
      .fn()
      .mockResolvedValueOnce(emptyPack)
      .mockResolvedValueOnce(recoveredPack);
    const recordLiveDogfoodComparison = vi.fn(async () => ({
      observation: {},
      report: {},
      cohortReport: {},
    }));
    const evidenceMemory = {
      getLatestRepositoryRevision: vi.fn(async () => 'revision-a'),
      buildContextPack,
      evaluateContextPackForDogfood: vi.fn(async () => ({
        admitted: false,
        reasonCodes: ['baseline-duplicate'],
        estimatedTokens: 0,
        claimCount: 0,
        selectedItems: [],
        policyHash: 'a'.repeat(64),
      })),
      searchClaims: vi.fn(async () => []),
      recordLiveDogfoodComparison,
    };
    const backfill = new EvidenceMemoryDogfoodBackfill({
      memoryDir: root,
      evidenceMemory: evidenceMemory as never,
    });

    await expect(
      backfill.run({ classifyEveryCompressionAsRestart: true }),
    ).resolves.toEqual({
      archivesScanned: 1,
      archivesWithCompression: 1,
      observationsReplayed: 1,
      observationsSkipped: 0,
      failures: 0,
    });
    expect(buildContextPack).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        query: expect.stringContaining('EMDF-RESTART-1'),
      }),
    );
    expect(recordLiveDogfoodComparison).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedClaimIds: ['restart-claim'],
        categoryOverride: 'restart',
      }),
    );
  });
});
