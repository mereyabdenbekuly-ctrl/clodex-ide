import { describe, expect, it } from 'vitest';
import { createAgentSessionCheckpoint } from '@clodex/agent-core/agents';
import { createWorkspaceSnapshot } from '@clodex/agent-core/agents';
import {
  CloudTaskRestoreHandshakeError,
  createCloudTaskRestoreCheckpointBinding,
} from './cloud-task-restore-handshake';

function checkpoint(agentInstanceId = 'agent-1') {
  return createAgentSessionCheckpoint({
    id: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-07-11T10:00:00.000Z',
    task: {
      agentInstanceId,
      agentType: 'chat',
      title: 'Teleport',
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
      usedTokens: 1,
      historyMessageCount: 1,
      lastMessageId: 'message-1',
    },
    memory: {
      history: {
        kind: 'agent-memory-jsonl',
        agentInstanceId,
        messageCount: 1,
        contentHash: 'a'.repeat(64),
      },
      compressedHistory: null,
      evidence: {
        version: 1,
        checkpointId: `memory:${'b'.repeat(64)}`,
        eventCount: 12,
        headEventId: 'event-12',
        headTimestamp: 1_700_000_000_000,
        ledgerHash: 'c'.repeat(64),
      },
    },
    workspace: {
      capturedAt: '2026-07-11T10:00:00.000Z',
      snapshot: createWorkspaceSnapshot({
        createdAt: Date.parse('2026-07-11T10:00:00.000Z'),
        selection: 'mounted-workspaces',
        entries: [],
      }),
      workspaces: [
        {
          path: '/private/local/path',
          permissions: ['read', 'edit'],
          repositoryId: 'repo-1',
          worktreeId: 'worktree-1',
          revision: 'abc123',
        },
      ],
    },
    persistence: {
      agentStateFlushedAt: '2026-07-11T10:00:00.000Z',
      memoryFlushedAt: '2026-07-11T10:00:00.000Z',
    },
  });
}

describe('cloud task restore checkpoint binding', () => {
  it('binds history and workspace revisions without leaking local paths', () => {
    const binding = createCloudTaskRestoreCheckpointBinding(
      checkpoint(),
      'agent-1',
    );

    expect(binding).toEqual({
      checkpointId: '11111111-1111-4111-8111-111111111111',
      historyContentHash: 'a'.repeat(64),
      workspaceRevisionHash: checkpoint().workspace.snapshot?.snapshotHash,
      memoryCheckpointId: `memory:${'b'.repeat(64)}`,
      memoryLedgerHash: 'c'.repeat(64),
      memoryEventCount: 12,
    });
    expect(JSON.stringify(binding)).not.toContain('/private/local/path');
  });

  it('rejects a checkpoint belonging to another agent', () => {
    expect(() =>
      createCloudTaskRestoreCheckpointBinding(checkpoint('agent-2'), 'agent-1'),
    ).toThrowError(new CloudTaskRestoreHandshakeError('checkpoint-mismatch'));
  });
});
