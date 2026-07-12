import { describe, expect, it } from 'vitest';
import {
  AgentSessionCheckpointSafePointError,
  agentSessionCheckpointSchema,
  assertAgentSessionCheckpointSafePoint,
  createAgentSessionCheckpoint,
  hashSessionCheckpointHistory,
} from './session-checkpoint';

function makeCheckpoint() {
  return createAgentSessionCheckpoint({
    id: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-07-11T10:00:00.000Z',
    task: {
      agentInstanceId: 'agent-1',
      agentType: 'chat',
      title: 'Checkpoint task',
      goal: null,
      lineage: {
        parentAgentInstanceId: null,
        forkedFromAgentId: null,
        forkedFromMessageId: null,
      },
    },
    execution: {
      state: 'idle',
      target: 'local',
      activeModelId: 'model-1',
      approvalProfile: 'alwaysAsk',
      usedTokens: 12,
      historyMessageCount: 2,
      lastMessageId: 'message-2',
    },
    memory: {
      history: {
        kind: 'agent-memory-jsonl',
        agentInstanceId: 'agent-1',
        messageCount: 2,
        contentHash: hashSessionCheckpointHistory([
          { id: 'message-1' },
          { id: 'message-2' },
        ]),
      },
      compressedHistory: null,
    },
    workspace: {
      capturedAt: '2026-07-11T10:00:00.000Z',
      snapshot: null,
      workspaces: [
        {
          path: '/repo',
          permissions: ['read', 'edit'],
          repositoryId: 'repo-1',
          worktreeId: 'worktree-1',
          revision: 'abc123',
        },
      ],
    },
    persistence: {
      agentStateFlushedAt: '2026-07-11T09:59:59.000Z',
      memoryFlushedAt: '2026-07-11T10:00:00.000Z',
    },
  });
}

describe('Session Checkpoint Protocol v1', () => {
  it('accepts an idle safe point', () => {
    expect(() =>
      assertAgentSessionCheckpointSafePoint({
        isWorking: false,
        hasRunningToolTransaction: false,
        pendingApprovalCount: 0,
      }),
    ).not.toThrow();
  });

  it('rejects a running tool transaction', () => {
    expect(() =>
      assertAgentSessionCheckpointSafePoint({
        isWorking: true,
        hasRunningToolTransaction: true,
        pendingApprovalCount: 0,
      }),
    ).toThrowError(
      new AgentSessionCheckpointSafePointError('tool-transaction-running'),
    );
  });

  it('rejects a pending approval', () => {
    expect(() =>
      assertAgentSessionCheckpointSafePoint({
        isWorking: false,
        hasRunningToolTransaction: false,
        pendingApprovalCount: 1,
      }),
    ).toThrowError(
      new AgentSessionCheckpointSafePointError('approval-pending'),
    );
  });

  it('survives a restart-style JSON serialization round-trip', () => {
    const checkpoint = makeCheckpoint();
    const restored = agentSessionCheckpointSchema.parse(
      JSON.parse(JSON.stringify(checkpoint)),
    );
    expect(restored).toEqual(checkpoint);
  });

  it('binds an optional content-free Evidence Memory checkpoint identity', () => {
    const checkpoint = makeCheckpoint();
    const restored = agentSessionCheckpointSchema.parse({
      ...checkpoint,
      memory: {
        ...checkpoint.memory,
        evidence: {
          version: 1,
          checkpointId: `memory:${'b'.repeat(64)}`,
          eventCount: 42,
          headEventId: 'event-42',
          headTimestamp: 1_700_000_000_000,
          ledgerHash: 'c'.repeat(64),
        },
      },
    });
    expect(restored.memory.evidence).toEqual({
      version: 1,
      checkpointId: `memory:${'b'.repeat(64)}`,
      eventCount: 42,
      headEventId: 'event-42',
      headTimestamp: 1_700_000_000_000,
      ledgerHash: 'c'.repeat(64),
    });
  });
});
