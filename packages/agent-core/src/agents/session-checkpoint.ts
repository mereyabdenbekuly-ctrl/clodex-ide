import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mountPermissionSchema } from '../env/types';
import { toolApprovalModeSchema } from '../types/tool-approval';
import { workspaceSnapshotV1Schema } from './workspace-snapshot';

export const SESSION_CHECKPOINT_VERSION = 1 as const;

const taskGoalSchema = z.object({
  objective: z.string(),
  status: z.enum(['active', 'completed', 'cancelled', 'blocked']),
  tokenBudget: z.number().int().positive().nullable(),
  startedUsedTokens: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

const sessionCheckpointWorkspaceSchema = z.object({
  path: z.string().min(1),
  permissions: z.array(mountPermissionSchema),
  repositoryId: z.string().nullable(),
  worktreeId: z.string().nullable(),
  revision: z.string().nullable(),
});

export const evidenceMemoryCheckpointIdentitySchema = z.object({
  version: z.literal(1),
  checkpointId: z.string().regex(/^memory:[a-f0-9]{64}$/),
  eventCount: z.number().int().nonnegative(),
  headEventId: z.string().min(1).nullable(),
  headTimestamp: z.number().int().nonnegative().nullable(),
  ledgerHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const agentSessionCheckpointSchema = z.object({
  version: z.literal(SESSION_CHECKPOINT_VERSION),
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  task: z.object({
    agentInstanceId: z.string().min(1),
    agentType: z.string().min(1),
    title: z.string(),
    goal: taskGoalSchema.nullable(),
    lineage: z.object({
      parentAgentInstanceId: z.string().nullable(),
      forkedFromAgentId: z.string().nullable(),
      forkedFromMessageId: z.string().nullable(),
    }),
  }),
  execution: z.object({
    state: z.literal('idle'),
    target: z.literal('local'),
    activeModelId: z.string().min(1),
    approvalProfile: toolApprovalModeSchema,
    usedTokens: z.number().int().nonnegative(),
    historyMessageCount: z.number().int().nonnegative(),
    lastMessageId: z.string().nullable(),
  }),
  memory: z.object({
    history: z.object({
      kind: z.literal('agent-memory-jsonl'),
      agentInstanceId: z.string().min(1),
      messageCount: z.number().int().nonnegative(),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    compressedHistory: z
      .object({
        messageId: z.string().min(1),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .nullable(),
    evidence: evidenceMemoryCheckpointIdentitySchema.nullable().default(null),
  }),
  workspace: z.object({
    capturedAt: z.string().datetime(),
    /**
     * Canonical, path-free workspace identity shared by Session Teleporter
     * and every local/remote execution provider. Legacy checkpoints may not
     * have populated it yet, so readers retain the old mount list as fallback.
     */
    snapshot: workspaceSnapshotV1Schema.nullable().default(null),
    workspaces: z.array(sessionCheckpointWorkspaceSchema),
  }),
  persistence: z.object({
    agentStateFlushedAt: z.string().datetime(),
    memoryFlushedAt: z.string().datetime(),
  }),
});

export type AgentSessionCheckpoint = z.infer<
  typeof agentSessionCheckpointSchema
>;
export type CreateAgentSessionCheckpointInput = Omit<
  z.input<typeof agentSessionCheckpointSchema>,
  'version' | 'id'
> & {
  id?: string;
};

export type AgentSessionCheckpointSafePointReason =
  | 'agent-not-found'
  | 'agent-step-running'
  | 'tool-transaction-running'
  | 'approval-pending'
  | 'state-changed-during-flush';

export class AgentSessionCheckpointSafePointError extends Error {
  public constructor(
    public readonly reason: AgentSessionCheckpointSafePointReason,
  ) {
    super(
      reason === 'agent-not-found'
        ? 'Agent session was not found'
        : reason === 'agent-step-running'
          ? 'Session checkpoint requires an idle agent step'
          : reason === 'tool-transaction-running'
            ? 'Session checkpoint cannot be created during a tool transaction'
            : reason === 'approval-pending'
              ? 'Session checkpoint cannot be created with a pending approval'
              : 'Agent state changed while the session checkpoint was flushing',
    );
    this.name = 'AgentSessionCheckpointSafePointError';
  }
}

export function assertAgentSessionCheckpointSafePoint(input: {
  isWorking: boolean;
  hasRunningToolTransaction?: boolean;
  pendingApprovalCount: number;
}): void {
  if (input.hasRunningToolTransaction) {
    throw new AgentSessionCheckpointSafePointError('tool-transaction-running');
  }
  if (input.isWorking) {
    throw new AgentSessionCheckpointSafePointError('agent-step-running');
  }
  if (input.pendingApprovalCount > 0) {
    throw new AgentSessionCheckpointSafePointError('approval-pending');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashSessionCheckpointHistory(
  history: readonly { id: string }[],
): string {
  return sha256(history.map((message) => message.id).join('\n'));
}

export function findCompressedHistoryReference(
  history: readonly {
    id: string;
    metadata?: { compressedHistory?: unknown } | null;
  }[],
): AgentSessionCheckpoint['memory']['compressedHistory'] {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    const compressedHistory = message?.metadata?.compressedHistory;
    if (message && typeof compressedHistory === 'string') {
      return {
        messageId: message.id,
        contentHash: sha256(compressedHistory),
      };
    }
  }
  return null;
}

export function createAgentSessionCheckpoint(
  input: CreateAgentSessionCheckpointInput,
): AgentSessionCheckpoint {
  return agentSessionCheckpointSchema.parse({
    ...input,
    version: SESSION_CHECKPOINT_VERSION,
    id: input.id ?? randomUUID(),
  });
}

export function resolveAgentSessionCheckpointFromMessages(
  messages: readonly {
    role: string;
    metadata?: { sessionCheckpoint?: unknown };
  }[],
): AgentSessionCheckpoint | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    const parsed = agentSessionCheckpointSchema.safeParse(
      message.metadata?.sessionCheckpoint,
    );
    return parsed.success ? parsed.data : null;
  }
  return null;
}
