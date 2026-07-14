import { createHash } from 'node:crypto';
import type { AgentStore } from '@clodex/agent-core';
import { z } from 'zod';
import { DisposableService } from '../disposable';
import {
  createTrustedMcpApprovalAuthority,
  hashTrustedMcpFinalAuthorityEffect,
  hashTrustedMcpFinalAuthorityEffectForDescriptorDigest,
  type TrustedMcpDescriptorCommitment,
  type TrustedMcpFinalAuthority,
  type TrustedMcpFinalAuthorityEffect,
} from './trusted-dispatch-gateway';

const DEFAULT_CLAIM_TTL_MS = 24 * 60 * 60_000;
const MAX_APPROVAL_RECORDS = 10_000;
const MAX_IDENTIFIER_LENGTH = 4_096;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const safeTimestampSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const boundedIdentifierSchema = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .refine((value) => !value.includes('\0'), {
    message: 'MCP approval identifier contains a NUL byte',
  })
  .refine((value) => value === value.trim(), {
    message: 'MCP approval identifier is not canonical',
  });

export const trustedMcpApprovalRecordStateSchema = z.enum([
  'STAGED',
  'RESPONSE_RECORDED',
  'APPROVED',
  'DENIED',
  'CLAIMED',
  'EXPIRED',
  'INVALIDATED',
]);
export type TrustedMcpApprovalRecordState = z.infer<
  typeof trustedMcpApprovalRecordStateSchema
>;

const trustedMcpApprovalDecisionSchema = z.enum(['APPROVE', 'DENY']);
export type TrustedMcpApprovalDecision = z.infer<
  typeof trustedMcpApprovalDecisionSchema
>;

type ApprovalDecisionDigestBinding = {
  recordId: string;
  agentInstanceId: string;
  toolCallId: string;
  aiToolName: string;
  descriptorDigest: string;
  approvalContextDigest: string;
  effectDigest: string;
};

const trustedMcpApprovalRecordSchema = z
  .object({
    version: z.literal(1),
    recordId: sha256Schema,
    agentInstanceId: boundedIdentifierSchema,
    toolCallId: boundedIdentifierSchema,
    aiToolName: boundedIdentifierSchema,
    descriptorDigest: sha256Schema,
    approvalContextDigest: sha256Schema,
    effectDigest: sha256Schema,
    approvalId: boundedIdentifierSchema.nullable().default(null),
    approvalDecision: trustedMcpApprovalDecisionSchema.nullable().default(null),
    approvalDecisionDigest: sha256Schema.nullable().default(null),
    decisionRecordedAt: safeTimestampSchema.nullable().default(null),
    responseCommittedAt: safeTimestampSchema.nullable().default(null),
    approvalEvidenceDigest: sha256Schema.nullable(),
    state: trustedMcpApprovalRecordStateSchema,
    createdAt: safeTimestampSchema,
    updatedAt: safeTimestampSchema,
    expiresAt: safeTimestampSchema.refine((value) => value > 0),
    claimedAt: safeTimestampSchema.nullable(),
    terminalReason: z.string().min(1).max(100).nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.updatedAt < record.createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updatedAt'],
        message: 'MCP approval update precedes record creation',
      });
    }
    if (record.expiresAt <= record.createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'MCP approval expiry must follow record creation',
      });
    }
    if ((record.state === 'CLAIMED') !== (record.claimedAt !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claimedAt'],
        message: 'MCP approval claimed timestamp does not match state',
      });
    }
    if (
      (record.state === 'CLAIMED') !==
      (record.approvalEvidenceDigest !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvalEvidenceDigest'],
        message: 'MCP approval evidence digest does not match state',
      });
    }
    const approvalId = record.approvalId;
    const approvalDecision = record.approvalDecision;
    const approvalDecisionDigest = record.approvalDecisionDigest;
    const decisionRecordedAt = record.decisionRecordedAt;
    const hasDecisionMetadata =
      approvalId !== null &&
      approvalDecision !== null &&
      approvalDecisionDigest !== null &&
      decisionRecordedAt !== null;
    const hasPartialDecisionMetadata =
      approvalId !== null ||
      approvalDecision !== null ||
      approvalDecisionDigest !== null ||
      decisionRecordedAt !== null;
    if (hasPartialDecisionMetadata && !hasDecisionMetadata) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvalDecisionDigest'],
        message: 'MCP approval decision metadata is incomplete',
      });
    }
    const decisionRequired =
      record.state === 'RESPONSE_RECORDED' ||
      record.state === 'APPROVED' ||
      record.state === 'DENIED';
    if (decisionRequired && !hasDecisionMetadata) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvalDecision'],
        message: 'MCP approval state is missing its durable decision',
      });
    }
    if (record.state === 'STAGED' && hasDecisionMetadata) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvalDecision'],
        message: 'MCP staged approval cannot contain a decision',
      });
    }
    if (
      approvalId !== null &&
      approvalDecision !== null &&
      approvalDecisionDigest !== null &&
      decisionRecordedAt !== null &&
      createApprovalDecisionDigest(
        record,
        approvalId,
        approvalDecision,
        record.effectDigest,
      ) !== approvalDecisionDigest
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvalDecisionDigest'],
        message: 'MCP approval decision digest is inconsistent',
      });
    }
    if (record.state === 'APPROVED' && record.approvalDecision !== 'APPROVE') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvalDecision'],
        message: 'MCP approved state does not contain approval',
      });
    }
    if (record.state === 'DENIED' && record.approvalDecision !== 'DENY') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvalDecision'],
        message: 'MCP denied state does not contain denial',
      });
    }
    if (
      record.state === 'CLAIMED' &&
      hasDecisionMetadata &&
      (approvalDecision !== 'APPROVE' ||
        record.approvalEvidenceDigest !== approvalDecisionDigest)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvalEvidenceDigest'],
        message:
          'MCP claimed state does not contain matching approval evidence',
      });
    }
    const responseCommitted = record.responseCommittedAt !== null;
    const responseCommitRequired =
      record.state === 'APPROVED' ||
      record.state === 'DENIED' ||
      (record.state === 'CLAIMED' && hasDecisionMetadata);
    const responseCommitForbidden =
      record.state === 'STAGED' || record.state === 'RESPONSE_RECORDED';
    if (
      (responseCommitRequired && !responseCommitted) ||
      (responseCommitForbidden && responseCommitted) ||
      (responseCommitted && !hasDecisionMetadata)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['responseCommittedAt'],
        message: 'MCP approval response commit does not match state',
      });
    }
    if (
      record.decisionRecordedAt !== null &&
      (record.decisionRecordedAt < record.createdAt ||
        record.decisionRecordedAt > record.updatedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisionRecordedAt'],
        message: 'MCP approval decision timestamp is inconsistent',
      });
    }
    if (
      record.responseCommittedAt !== null &&
      (record.decisionRecordedAt === null ||
        record.responseCommittedAt < record.decisionRecordedAt ||
        record.responseCommittedAt > record.updatedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['responseCommittedAt'],
        message: 'MCP approval response timestamp is inconsistent',
      });
    }
    if (
      record.claimedAt !== null &&
      (record.claimedAt < record.createdAt ||
        record.claimedAt > record.updatedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claimedAt'],
        message: 'MCP approval claim timestamp is inconsistent',
      });
    }
    const terminalReasonRequired =
      record.state === 'DENIED' ||
      record.state === 'EXPIRED' ||
      record.state === 'INVALIDATED';
    if (terminalReasonRequired !== (record.terminalReason !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['terminalReason'],
        message: 'MCP approval terminal reason does not match state',
      });
    }
  });

export type TrustedMcpApprovalRecord = z.infer<
  typeof trustedMcpApprovalRecordSchema
>;

const trustedMcpApprovalStoreSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    records: z.record(sha256Schema, trustedMcpApprovalRecordSchema),
  })
  .strict()
  .superRefine((store, context) => {
    const entries = Object.entries(store.records);
    if (entries.length > MAX_APPROVAL_RECORDS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['records'],
        message: 'MCP approval authority store exceeds its fail-closed limit',
      });
    }
    for (const [recordId, record] of entries) {
      if (
        recordId !== record.recordId ||
        recordId !==
          createApprovalRecordId(record.agentInstanceId, record.toolCallId)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['records', recordId],
          message: 'MCP approval authority record identity is inconsistent',
        });
      }
    }
  });

export type TrustedMcpApprovalStore = z.infer<
  typeof trustedMcpApprovalStoreSchema
>;

export interface TrustedMcpApprovalPersistence {
  load(): Promise<unknown>;
  save(store: TrustedMcpApprovalStore): Promise<void>;
}

export class PersistedTrustedMcpApprovalPersistence
  implements TrustedMcpApprovalPersistence
{
  public async load(): Promise<unknown> {
    const { readPersistedData } = await import('@/utils/persisted-data');
    return await readPersistedData(
      'mcp-approval-authority',
      trustedMcpApprovalStoreSchema,
      { version: 1, revision: 0, records: {} },
      {
        encrypt: true,
        requireEncryption: true,
        allowPlaintextMigration: false,
      },
    );
  }

  public async save(store: TrustedMcpApprovalStore): Promise<void> {
    const { writePersistedData } = await import('@/utils/persisted-data');
    await writePersistedData(
      'mcp-approval-authority',
      trustedMcpApprovalStoreSchema,
      store,
      { encrypt: true, requireEncryption: true },
    );
  }
}

export class MemoryTrustedMcpApprovalPersistence
  implements TrustedMcpApprovalPersistence
{
  private store: TrustedMcpApprovalStore = {
    version: 1,
    revision: 0,
    records: {},
  };

  public async load(): Promise<unknown> {
    return structuredClone(this.store);
  }

  public async save(store: TrustedMcpApprovalStore): Promise<void> {
    this.store = structuredClone(store);
  }
}

export interface ClaimTrustedMcpApprovalInput {
  agentInstanceId: string;
  toolCallId: string;
  aiToolName: string;
  arguments: Record<string, unknown>;
  descriptor: TrustedMcpDescriptorCommitment;
  approvalContextDigest: string;
}

export type StageTrustedMcpApprovalInput = ClaimTrustedMcpApprovalInput;

export interface PrepareTrustedMcpApprovalResponseInput {
  agentInstanceId: string;
  approvalId: string;
  toolCallId: string;
  aiToolName: string;
  input: unknown;
  approved: boolean;
}

export type TrustedMcpApprovalInvalidationReason =
  | 'new-user-message'
  | 'queue-flush'
  | 'user-stop'
  | 'system-interrupted';

export interface InvalidateTrustedMcpApprovalsInput {
  agentInstanceId: string;
  toolCallIds: readonly string[];
  reason: TrustedMcpApprovalInvalidationReason;
  includeAllOpenForAgent?: boolean;
}

const trustedMcpApprovalResponseReceiptBrand: unique symbol = Symbol(
  'TrustedMcpApprovalResponseReceipt',
);

export interface TrustedMcpApprovalResponseReceipt {
  readonly [trustedMcpApprovalResponseReceiptBrand]: true;
}

export interface TrustedMcpApprovalBrokerOptions {
  persistence?: TrustedMcpApprovalPersistence;
  now?: () => number;
  claimTtlMs?: number;
}

type ApprovalBinding = {
  recordId: string;
  agentInstanceId: string;
  toolCallId: string;
  aiToolName: string;
  descriptorDigest: string;
  approvalContextDigest: string;
  effectDigest: string;
  descriptor: TrustedMcpDescriptorCommitment;
  effect: TrustedMcpFinalAuthorityEffect;
};

type ApprovalDecisionBinding = {
  recordId: string;
  agentInstanceId: string;
  approvalId: string;
  toolCallId: string;
  aiToolName: string;
  descriptorDigest: string;
  approvalContextDigest: string;
  effectDigest: string;
  decision: TrustedMcpApprovalDecision;
  decisionDigest: string;
};

type ApprovalResponseSnapshot = {
  recordId: string;
  agentInstanceId: string;
  approvalId: string;
  toolCallId: string;
  aiToolName: string;
  decision: TrustedMcpApprovalDecision;
  input: unknown;
};

type InternalApprovalResponseReceipt = TrustedMcpApprovalResponseReceipt &
  ApprovalDecisionBinding;

type StageOutcome =
  | 'staged'
  | 'already-staged'
  | 'binding-mismatch'
  | 'already-terminal'
  | 'capacity-exhausted';

type ClaimOutcome =
  | 'claimed'
  | 'not-staged'
  | 'approval-not-recorded'
  | 'approval-response-not-committed'
  | 'binding-mismatch'
  | 'already-claimed'
  | 'expired'
  | 'rejected'
  | 'approval-evidence-ambiguous'
  | 'approval-evidence-invalid'
  | 'approval-decision-mismatch'
  | 'approval-denied'
  | 'approval-tool-mismatch'
  | 'approval-input-mismatch';

type ClaimMutationOutcome =
  | { kind: 'claimed'; approvalEvidenceDigest: string }
  | { kind: Exclude<ClaimOutcome, 'claimed'> };

type PrepareResponseOutcome =
  | { kind: 'not-managed' }
  | { kind: 'prepared'; binding: ApprovalDecisionBinding }
  | {
      kind:
        | 'binding-mismatch'
        | 'already-claimed'
        | 'expired'
        | 'rejected'
        | 'decision-conflict'
        | 'input-invalid';
    };

type CommitResponseOutcome =
  | 'committed'
  | 'already-committed'
  | 'not-recorded'
  | 'binding-mismatch'
  | 'already-claimed'
  | 'expired'
  | 'rejected'
  | 'approval-evidence-ambiguous'
  | 'approval-evidence-invalid'
  | 'approval-decision-mismatch';

type StoreMutation<T> = {
  changed: boolean;
  value: T;
};

/**
 * Durable one-shot authority broker for MCP approval continuations.
 *
 * Only hashes and bounded identifiers are persisted. A successful claim is
 * durably burned before the final-authority object is returned, so process
 * death before, during, or after dispatch cannot make old affirmative
 * AgentStore history reusable. Terminal tombstones are intentionally retained;
 * exhausting the bounded store fails closed rather than pruning replay state.
 */
export class TrustedMcpApprovalBroker extends DisposableService {
  private mutation = Promise.resolve();
  private faulted: Error | null = null;
  // Exact read-back can preserve a tombstone after an ambiguous save, but the
  // rejected durability barrier must be retried before any later mutation can
  // report success.
  private durabilityPending = false;

  private constructor(
    private readonly agentStore: AgentStore,
    private readonly persistence: TrustedMcpApprovalPersistence,
    private readonly now: () => number,
    private readonly claimTtlMs: number,
    private store: TrustedMcpApprovalStore,
  ) {
    super();
  }

  public static async create(
    agentStore: AgentStore,
    options: TrustedMcpApprovalBrokerOptions = {},
  ): Promise<TrustedMcpApprovalBroker> {
    const claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    if (!Number.isSafeInteger(claimTtlMs) || claimTtlMs <= 0) {
      throw new Error('MCP approval claim TTL is invalid');
    }
    const persistence =
      options.persistence ?? new PersistedTrustedMcpApprovalPersistence();
    const store = trustedMcpApprovalStoreSchema.parse(await persistence.load());
    const broker = new TrustedMcpApprovalBroker(
      agentStore,
      persistence,
      options.now ?? Date.now,
      claimTtlMs,
      store,
    );
    await broker.recoverExpiredApprovals();
    return broker;
  }

  public list(): TrustedMcpApprovalRecord[] {
    this.assertNotDisposed();
    this.assertOperational();
    return structuredClone(Object.values(this.store.records));
  }

  public async stage(input: StageTrustedMcpApprovalInput): Promise<void> {
    this.assertNotDisposed();
    this.assertOperational();
    const binding = createApprovalBinding(input);

    const outcome = await this.mutate<StageOutcome>((next) => {
      const now = this.readNow();
      const expiresAt = now + this.claimTtlMs;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new Error('MCP approval claim expiry exceeds the safe range');
      }
      const expired = expirePendingRecords(next, now);
      const existing = next.records[binding.recordId];
      if (existing) {
        const value: StageOutcome =
          existing.state !== 'STAGED'
            ? 'already-terminal'
            : recordMatchesBinding(existing, binding)
              ? 'already-staged'
              : 'binding-mismatch';
        return { changed: expired, value };
      }
      if (Object.keys(next.records).length >= MAX_APPROVAL_RECORDS) {
        return { changed: expired, value: 'capacity-exhausted' };
      }
      next.records[binding.recordId] = trustedMcpApprovalRecordSchema.parse({
        version: 1,
        recordId: binding.recordId,
        agentInstanceId: binding.agentInstanceId,
        toolCallId: binding.toolCallId,
        aiToolName: binding.aiToolName,
        descriptorDigest: binding.descriptorDigest,
        approvalContextDigest: binding.approvalContextDigest,
        effectDigest: binding.effectDigest,
        approvalId: null,
        approvalDecision: null,
        approvalDecisionDigest: null,
        decisionRecordedAt: null,
        responseCommittedAt: null,
        approvalEvidenceDigest: null,
        state: 'STAGED',
        createdAt: now,
        updatedAt: now,
        expiresAt,
        claimedAt: null,
        terminalReason: null,
      });
      return { changed: true, value: 'staged' };
    });

    if (outcome === 'staged' || outcome === 'already-staged') return;
    if (outcome === 'binding-mismatch') {
      throw new Error('MCP pending approval cannot be replaced');
    }
    if (outcome === 'already-terminal') {
      throw new Error('MCP approval identity was already terminally consumed');
    }
    throw new Error('MCP pending approval capacity is exhausted');
  }

  public async prepareResponse(
    input: PrepareTrustedMcpApprovalResponseInput,
  ): Promise<TrustedMcpApprovalResponseReceipt | null> {
    this.assertNotDisposed();
    this.assertOperational();
    const snapshot = createApprovalResponseSnapshot(input);
    const outcome = await this.mutate<PrepareResponseOutcome>((next) => {
      const now = this.readNow();
      const expired = expirePendingRecords(next, now);
      const record = next.records[snapshot.recordId];
      if (!record) {
        return { changed: expired, value: { kind: 'not-managed' } };
      }
      if (record.state === 'CLAIMED') {
        return { changed: expired, value: { kind: 'already-claimed' } };
      }
      if (record.state === 'EXPIRED') {
        return { changed: expired, value: { kind: 'expired' } };
      }
      if (record.state === 'INVALIDATED') {
        return { changed: expired, value: { kind: 'rejected' } };
      }
      if (
        record.agentInstanceId !== snapshot.agentInstanceId ||
        record.toolCallId !== snapshot.toolCallId ||
        record.aiToolName !== snapshot.aiToolName
      ) {
        if (record.state !== 'DENIED') {
          rejectRecord(record, now, 'approval-response-binding-mismatch');
          return { changed: true, value: { kind: 'binding-mismatch' } };
        }
        return { changed: expired, value: { kind: 'binding-mismatch' } };
      }

      let binding: ApprovalDecisionBinding;
      try {
        binding = createApprovalDecisionBinding(record, snapshot);
      } catch {
        if (record.state !== 'DENIED') {
          rejectRecord(record, now, 'approval-response-input-invalid');
          return { changed: true, value: { kind: 'input-invalid' } };
        }
        return { changed: expired, value: { kind: 'input-invalid' } };
      }

      if (record.state === 'STAGED') {
        const transitionAt = recordTransitionTimestamp(record, now);
        record.state = 'RESPONSE_RECORDED';
        record.approvalId = binding.approvalId;
        record.approvalDecision = binding.decision;
        record.approvalDecisionDigest = binding.decisionDigest;
        record.decisionRecordedAt = transitionAt;
        record.responseCommittedAt = null;
        record.updatedAt = transitionAt;
        record.terminalReason = null;
        return {
          changed: true,
          value: { kind: 'prepared', binding },
        };
      }

      if (!recordMatchesDecisionBinding(record, binding)) {
        if (record.state !== 'DENIED') {
          rejectRecord(record, now, 'approval-response-decision-conflict');
          return { changed: true, value: { kind: 'decision-conflict' } };
        }
        return { changed: expired, value: { kind: 'decision-conflict' } };
      }
      return {
        changed: expired,
        value: { kind: 'prepared', binding },
      };
    });

    if (outcome.kind === 'not-managed') return null;
    if (outcome.kind !== 'prepared') throwPrepareResponseError(outcome.kind);

    this.assertNotDisposed();
    return Object.freeze({
      [trustedMcpApprovalResponseReceiptBrand]: true as const,
      ...outcome.binding,
    }) as InternalApprovalResponseReceipt;
  }

  public async commitResponse(
    receipt: TrustedMcpApprovalResponseReceipt,
  ): Promise<void> {
    this.assertNotDisposed();
    this.assertOperational();
    const binding = requireApprovalResponseReceipt(receipt);
    const outcome = await this.mutate<CommitResponseOutcome>((next) => {
      const now = this.readNow();
      const expired = expirePendingRecords(next, now);
      const record = next.records[binding.recordId];
      if (!record || record.state === 'STAGED') {
        return { changed: expired, value: 'not-recorded' };
      }
      if (record.state === 'CLAIMED') {
        return { changed: expired, value: 'already-claimed' };
      }
      if (record.state === 'EXPIRED') {
        return { changed: expired, value: 'expired' };
      }
      if (record.state === 'INVALIDATED') {
        return { changed: expired, value: 'rejected' };
      }
      if (!recordMatchesDecisionBinding(record, binding)) {
        if (record.state !== 'DENIED') {
          rejectRecord(record, now, 'approval-response-binding-drift');
          return { changed: true, value: 'binding-mismatch' };
        }
        return { changed: expired, value: 'binding-mismatch' };
      }

      const evidenceOutcome = validateCurrentApprovalDecisionEvidence(
        this.agentStore,
        record,
        binding,
      );
      if (evidenceOutcome !== 'valid') {
        if (record.state !== 'DENIED') {
          rejectRecord(record, now, evidenceOutcome);
          return { changed: true, value: evidenceOutcome };
        }
        return { changed: expired, value: evidenceOutcome };
      }

      const committedState =
        binding.decision === 'APPROVE' ? 'APPROVED' : 'DENIED';
      if (record.state === committedState) {
        return { changed: expired, value: 'already-committed' };
      }
      if (record.state !== 'RESPONSE_RECORDED') {
        rejectRecord(record, now, 'approval-response-state-invalid');
        return { changed: true, value: 'rejected' };
      }
      const transitionAt = recordTransitionTimestamp(record, now);
      record.state = committedState;
      record.updatedAt = transitionAt;
      record.responseCommittedAt = transitionAt;
      record.terminalReason =
        committedState === 'DENIED' ? 'approval-denied' : null;
      return { changed: true, value: 'committed' };
    });

    if (outcome !== 'committed' && outcome !== 'already-committed') {
      throwCommitResponseError(outcome);
    }

    this.assertNotDisposed();
    requireCurrentApprovalDecisionEvidence(
      this.agentStore,
      binding,
      binding.decisionDigest,
    );
  }

  public async invalidateOpen(
    input: InvalidateTrustedMcpApprovalsInput,
  ): Promise<number> {
    this.assertNotDisposed();
    this.assertOperational();
    const agentInstanceId = boundedIdentifierSchema.parse(
      input.agentInstanceId,
    );
    if (input.toolCallIds.length > MAX_APPROVAL_RECORDS) {
      throw new Error('MCP approval invalidation batch is too large');
    }
    if (
      input.includeAllOpenForAgent !== undefined &&
      typeof input.includeAllOpenForAgent !== 'boolean'
    ) {
      throw new Error('MCP approval invalidation scope is invalid');
    }
    const includeAllOpenForAgent = input.includeAllOpenForAgent === true;
    const toolCallIds = includeAllOpenForAgent
      ? new Set<string>()
      : new Set(
          input.toolCallIds.map((id) => boundedIdentifierSchema.parse(id)),
        );
    const terminalReason = approvalInvalidationReason(input.reason);

    return await this.mutate((next) => {
      const now = this.readNow();
      let changed = expirePendingRecords(next, now);
      let invalidatedCount = 0;
      for (const record of Object.values(next.records)) {
        if (
          record.agentInstanceId !== agentInstanceId ||
          (!includeAllOpenForAgent && !toolCallIds.has(record.toolCallId)) ||
          (record.state !== 'STAGED' &&
            record.state !== 'RESPONSE_RECORDED' &&
            record.state !== 'APPROVED')
        ) {
          continue;
        }
        rejectRecord(record, now, terminalReason);
        changed = true;
        invalidatedCount += 1;
      }
      return { changed, value: invalidatedCount };
    });
  }

  public async claim(
    input: ClaimTrustedMcpApprovalInput,
  ): Promise<TrustedMcpFinalAuthority | null> {
    this.assertNotDisposed();
    this.assertOperational();
    const binding = createApprovalBinding(input);
    const outcome = await this.mutate<ClaimMutationOutcome>((next) => {
      const now = this.readNow();
      const expired = expirePendingRecords(next, now);
      const record = next.records[binding.recordId];
      if (!record) {
        return { changed: expired, value: { kind: 'not-staged' } };
      }
      if (record.state === 'CLAIMED') {
        return { changed: expired, value: { kind: 'already-claimed' } };
      }
      if (record.state === 'EXPIRED') {
        return { changed: expired, value: { kind: 'expired' } };
      }
      if (record.state === 'INVALIDATED') {
        return { changed: expired, value: { kind: 'rejected' } };
      }
      if (record.state === 'DENIED') {
        return { changed: expired, value: { kind: 'approval-denied' } };
      }
      if (record.state === 'STAGED') {
        return {
          changed: expired,
          value: { kind: 'approval-not-recorded' },
        };
      }
      if (record.state === 'RESPONSE_RECORDED') {
        return {
          changed: expired,
          value: { kind: 'approval-response-not-committed' },
        };
      }
      if (record.state !== 'APPROVED') {
        return { changed: expired, value: { kind: 'rejected' } };
      }
      if (!recordMatchesBinding(record, binding)) {
        return { changed: expired, value: { kind: 'binding-mismatch' } };
      }

      const evidence = findApprovalResponses(
        this.agentStore,
        binding.agentInstanceId,
        binding.toolCallId,
      );
      if (evidence.length === 0) {
        return {
          changed: expired,
          value: { kind: 'approval-not-recorded' },
        };
      }
      if (evidence.length !== 1) {
        rejectRecord(record, now, 'approval-evidence-ambiguous');
        return {
          changed: true,
          value: { kind: 'approval-evidence-ambiguous' },
        };
      }
      const approved = evidence[0]!;
      if (!approved.valid) {
        rejectRecord(record, now, 'approval-evidence-invalid');
        return {
          changed: true,
          value: { kind: 'approval-evidence-invalid' },
        };
      }
      if (!approved.approved) {
        rejectRecord(record, now, 'approval-denied');
        return { changed: true, value: { kind: 'approval-denied' } };
      }
      if (approved.toolName !== binding.aiToolName) {
        rejectRecord(record, now, 'approval-tool-mismatch');
        return {
          changed: true,
          value: { kind: 'approval-tool-mismatch' },
        };
      }
      const approvedEffect: TrustedMcpFinalAuthorityEffect = {
        ...binding.effect,
        arguments: approved.input,
      };
      let approvedEffectDigest: string;
      try {
        approvedEffectDigest = hashTrustedMcpFinalAuthorityEffect(
          binding.descriptor,
          approvedEffect,
        );
      } catch {
        rejectRecord(record, now, 'approval-evidence-invalid');
        return {
          changed: true,
          value: { kind: 'approval-evidence-invalid' },
        };
      }
      if (approvedEffectDigest !== binding.effectDigest) {
        rejectRecord(record, now, 'approval-input-mismatch');
        return {
          changed: true,
          value: { kind: 'approval-input-mismatch' },
        };
      }

      let approvalEvidenceDigest: string;
      try {
        approvalEvidenceDigest = createApprovalEvidenceDigest(
          binding,
          approved,
        );
      } catch {
        rejectRecord(record, now, 'approval-evidence-invalid');
        return {
          changed: true,
          value: { kind: 'approval-evidence-invalid' },
        };
      }
      if (
        record.approvalDecision !== 'APPROVE' ||
        record.approvalId !== approved.approvalId ||
        record.approvalDecisionDigest !== approvalEvidenceDigest
      ) {
        rejectRecord(record, now, 'approval-decision-mismatch');
        return {
          changed: true,
          value: { kind: 'approval-decision-mismatch' },
        };
      }

      const transitionAt = recordTransitionTimestamp(record, now);
      record.state = 'CLAIMED';
      record.updatedAt = transitionAt;
      record.claimedAt = transitionAt;
      record.approvalEvidenceDigest = approvalEvidenceDigest;
      record.terminalReason = null;
      return {
        changed: true,
        value: { kind: 'claimed', approvalEvidenceDigest },
      };
    });

    if (outcome.kind === 'not-staged') return null;
    if (outcome.kind !== 'claimed') throwClaimError(outcome.kind);

    this.assertNotDisposed();
    requireCurrentApprovalEvidence(
      this.agentStore,
      binding,
      outcome.approvalEvidenceDigest,
    );

    return createTrustedMcpApprovalAuthority({
      descriptor: binding.descriptor,
      effect: binding.effect,
    });
  }

  public async flush(): Promise<void> {
    this.assertNotDisposed();
    this.assertOperational();
    await this.mutate(() => ({ changed: false, value: undefined }));
  }

  protected async onTeardown(): Promise<void> {
    await this.mutate(() => ({ changed: false, value: undefined }));
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('MCP approval broker clock returned an invalid time');
    }
    return now;
  }

  private assertOperational(): void {
    if (this.faulted) {
      throw new Error('MCP approval broker persistence is faulted', {
        cause: this.faulted,
      });
    }
  }

  private async recoverExpiredApprovals(): Promise<void> {
    const now = this.readNow();
    if (
      !Object.values(this.store.records).some(
        (record) =>
          (record.state === 'STAGED' ||
            record.state === 'RESPONSE_RECORDED' ||
            record.state === 'APPROVED') &&
          now >= record.expiresAt,
      )
    ) {
      return;
    }
    await this.mutate((next) => ({
      changed: expirePendingRecords(next, now),
      value: undefined,
    }));
  }

  private async mutate<T>(
    operation: (
      next: TrustedMcpApprovalStore,
    ) => Promise<StoreMutation<T>> | StoreMutation<T>,
  ): Promise<T> {
    const result = this.mutation.then(async () => {
      this.assertOperational();
      const previous = this.store;
      const next = structuredClone(this.store);
      const { changed, value } = await operation(next);
      if (!changed && !this.durabilityPending) {
        return structuredClone(value);
      }
      const candidate = changed
        ? trustedMcpApprovalStoreSchema.parse(next)
        : structuredClone(previous);
      if (changed) {
        if (candidate.revision >= Number.MAX_SAFE_INTEGER) {
          throw new Error('MCP approval store revision space is exhausted');
        }
        candidate.revision += 1;
      }
      const parsed = trustedMcpApprovalStoreSchema.parse(candidate);
      try {
        await this.persistence.save(parsed);
      } catch (error) {
        const reconciliation = await this.reconcileAmbiguousSave(
          previous,
          parsed,
          error,
        );
        if (reconciliation === 'intended') {
          this.store = parsed;
          this.durabilityPending = true;
        }
        throw error;
      }
      this.store = parsed;
      this.durabilityPending = false;
      return structuredClone(value);
    });
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  private async reconcileAmbiguousSave(
    previous: TrustedMcpApprovalStore,
    intended: TrustedMcpApprovalStore,
    originalError: unknown,
  ): Promise<'previous' | 'intended'> {
    try {
      const disk = trustedMcpApprovalStoreSchema.parse(
        await this.persistence.load(),
      );
      const diskDigest = approvalStoreDigest(disk);
      if (diskDigest === approvalStoreDigest(intended)) return 'intended';
      if (diskDigest === approvalStoreDigest(previous)) return 'previous';
      this.faulted = new Error(
        'MCP approval store diverged during persistence reconciliation',
        { cause: originalError },
      );
    } catch (reconciliationError) {
      this.faulted = new Error(
        'MCP approval store could not reconcile an ambiguous persistence failure',
        { cause: reconciliationError },
      );
    }
    throw (
      this.faulted ??
      new Error('MCP approval store persistence reconciliation failed')
    );
  }
}

function createApprovalBinding(
  input: ClaimTrustedMcpApprovalInput,
): ApprovalBinding {
  const agentInstanceId = boundedIdentifierSchema.parse(input.agentInstanceId);
  const toolCallId = boundedIdentifierSchema.parse(input.toolCallId);
  const aiToolName = boundedIdentifierSchema.parse(input.aiToolName);
  const descriptorDigest = sha256Schema.parse(input.descriptor.digest);
  const approvalContextDigest = sha256Schema.parse(input.approvalContextDigest);
  const originalEffect: TrustedMcpFinalAuthorityEffect = {
    principalId: agentInstanceId,
    toolCallId,
    arguments: input.arguments,
  };
  const effectDigest = hashTrustedMcpFinalAuthorityEffect(
    input.descriptor,
    originalEffect,
  );
  const argumentsSnapshot = structuredClone(input.arguments);
  const effect: TrustedMcpFinalAuthorityEffect = {
    principalId: agentInstanceId,
    toolCallId,
    arguments: deepFreeze(argumentsSnapshot),
  };
  if (
    hashTrustedMcpFinalAuthorityEffect(input.descriptor, effect) !==
    effectDigest
  ) {
    throw new Error('MCP approval arguments changed while being staged');
  }

  return {
    recordId: createApprovalRecordId(agentInstanceId, toolCallId),
    agentInstanceId,
    toolCallId,
    aiToolName,
    descriptorDigest,
    approvalContextDigest,
    effectDigest,
    descriptor: input.descriptor,
    effect,
  };
}

function createApprovalResponseSnapshot(
  input: PrepareTrustedMcpApprovalResponseInput,
): ApprovalResponseSnapshot {
  if (typeof input.approved !== 'boolean') {
    throw new Error('MCP approval response decision is invalid');
  }
  const agentInstanceId = boundedIdentifierSchema.parse(input.agentInstanceId);
  const approvalId = boundedIdentifierSchema.parse(input.approvalId);
  const toolCallId = boundedIdentifierSchema.parse(input.toolCallId);
  const aiToolName = boundedIdentifierSchema.parse(input.aiToolName);
  let inputSnapshot: unknown;
  try {
    inputSnapshot = deepFreeze(structuredClone(input.input));
  } catch {
    throw new Error('MCP approval response input cannot be snapshotted');
  }
  return {
    recordId: createApprovalRecordId(agentInstanceId, toolCallId),
    agentInstanceId,
    approvalId,
    toolCallId,
    aiToolName,
    decision: input.approved ? 'APPROVE' : 'DENY',
    input: inputSnapshot,
  };
}

function createApprovalDecisionBinding(
  record: TrustedMcpApprovalRecord,
  snapshot: ApprovalResponseSnapshot,
): ApprovalDecisionBinding {
  if (!isRecord(snapshot.input)) {
    throw new Error('MCP approval response input is not a record');
  }
  const originalEffectDigest =
    hashTrustedMcpFinalAuthorityEffectForDescriptorDigest(
      record.descriptorDigest,
      {
        principalId: snapshot.agentInstanceId,
        toolCallId: snapshot.toolCallId,
        arguments: snapshot.input,
      },
    );
  const inputSnapshot = structuredClone(snapshot.input);
  if (!isRecord(inputSnapshot)) {
    throw new Error('MCP approval response input snapshot is invalid');
  }
  deepFreeze(inputSnapshot);
  const effectDigest = hashTrustedMcpFinalAuthorityEffectForDescriptorDigest(
    record.descriptorDigest,
    {
      principalId: snapshot.agentInstanceId,
      toolCallId: snapshot.toolCallId,
      arguments: inputSnapshot,
    },
  );
  if (
    effectDigest !== originalEffectDigest ||
    effectDigest !== record.effectDigest
  ) {
    throw new Error('MCP approval response input changed or does not match');
  }

  return {
    recordId: snapshot.recordId,
    agentInstanceId: snapshot.agentInstanceId,
    approvalId: snapshot.approvalId,
    toolCallId: snapshot.toolCallId,
    aiToolName: snapshot.aiToolName,
    descriptorDigest: record.descriptorDigest,
    approvalContextDigest: record.approvalContextDigest,
    effectDigest: record.effectDigest,
    decision: snapshot.decision,
    decisionDigest: createApprovalDecisionDigest(
      record,
      snapshot.approvalId,
      snapshot.decision,
      effectDigest,
    ),
  };
}

function createApprovalRecordId(
  agentInstanceId: string,
  toolCallId: string,
): string {
  return createHash('sha256')
    .update('clodex.mcp.approval-record.v1\0')
    .update(agentInstanceId)
    .update('\0')
    .update(toolCallId)
    .digest('hex');
}

function recordMatchesBinding(
  record: TrustedMcpApprovalRecord,
  binding: ApprovalBinding,
): boolean {
  return (
    record.agentInstanceId === binding.agentInstanceId &&
    record.toolCallId === binding.toolCallId &&
    record.aiToolName === binding.aiToolName &&
    record.descriptorDigest === binding.descriptorDigest &&
    record.approvalContextDigest === binding.approvalContextDigest &&
    record.effectDigest === binding.effectDigest
  );
}

function recordMatchesDecisionBinding(
  record: TrustedMcpApprovalRecord,
  binding: ApprovalDecisionBinding,
): boolean {
  return (
    record.recordId === binding.recordId &&
    record.agentInstanceId === binding.agentInstanceId &&
    record.toolCallId === binding.toolCallId &&
    record.aiToolName === binding.aiToolName &&
    record.descriptorDigest === binding.descriptorDigest &&
    record.approvalContextDigest === binding.approvalContextDigest &&
    record.effectDigest === binding.effectDigest &&
    record.approvalId === binding.approvalId &&
    record.approvalDecision === binding.decision &&
    record.approvalDecisionDigest === binding.decisionDigest
  );
}

function createApprovalDecisionDigest(
  binding: ApprovalDecisionDigestBinding,
  approvalId: string,
  decision: TrustedMcpApprovalDecision,
  effectDigest: string,
): string {
  if (effectDigest !== binding.effectDigest) {
    throw new Error('MCP approval decision effect does not match staging');
  }
  return createHash('sha256')
    .update('clodex.mcp.approval-decision.v1\0')
    .update(binding.recordId)
    .update('\0')
    .update(binding.agentInstanceId)
    .update('\0')
    .update(binding.toolCallId)
    .update('\0')
    .update(binding.aiToolName)
    .update('\0')
    .update(binding.descriptorDigest)
    .update('\0')
    .update(binding.approvalContextDigest)
    .update('\0')
    .update(effectDigest)
    .update('\0')
    .update(approvalId)
    .update('\0decision=')
    .update(decision)
    .digest('hex');
}

function createApprovalEvidenceDigest(
  binding: ApprovalBinding,
  approval: Extract<ApprovalResponse, { valid: true }>,
): string {
  if (!approval.approved) {
    throw new Error(
      'MCP approval evidence digest requires affirmative evidence',
    );
  }
  if (binding.descriptor.digest !== binding.descriptorDigest) {
    throw new Error('MCP approval descriptor changed while evidence was read');
  }
  const approvedEffectDigest = hashTrustedMcpFinalAuthorityEffect(
    binding.descriptor,
    {
      ...binding.effect,
      arguments: approval.input,
    },
  );
  if (approvedEffectDigest !== binding.effectDigest) {
    throw new Error('MCP approval evidence does not match the staged effect');
  }
  return createApprovalDecisionDigest(
    binding,
    approval.approvalId,
    'APPROVE',
    approvedEffectDigest,
  );
}

function requireApprovalResponseReceipt(
  receipt: TrustedMcpApprovalResponseReceipt,
): InternalApprovalResponseReceipt {
  const candidate = receipt as Partial<InternalApprovalResponseReceipt>;
  if (candidate[trustedMcpApprovalResponseReceiptBrand] !== true) {
    throw new Error('MCP approval response receipt is invalid');
  }
  return {
    [trustedMcpApprovalResponseReceiptBrand]: true,
    recordId: sha256Schema.parse(candidate.recordId),
    agentInstanceId: boundedIdentifierSchema.parse(candidate.agentInstanceId),
    approvalId: boundedIdentifierSchema.parse(candidate.approvalId),
    toolCallId: boundedIdentifierSchema.parse(candidate.toolCallId),
    aiToolName: boundedIdentifierSchema.parse(candidate.aiToolName),
    descriptorDigest: sha256Schema.parse(candidate.descriptorDigest),
    approvalContextDigest: sha256Schema.parse(candidate.approvalContextDigest),
    effectDigest: sha256Schema.parse(candidate.effectDigest),
    decision: trustedMcpApprovalDecisionSchema.parse(candidate.decision),
    decisionDigest: sha256Schema.parse(candidate.decisionDigest),
  };
}

type ApprovalDecisionEvidenceOutcome =
  | 'valid'
  | 'approval-evidence-ambiguous'
  | 'approval-evidence-invalid'
  | 'approval-decision-mismatch';

function validateCurrentApprovalDecisionEvidence(
  store: AgentStore,
  record: TrustedMcpApprovalRecord,
  binding: ApprovalDecisionBinding,
): ApprovalDecisionEvidenceOutcome {
  const evidence = findApprovalResponses(
    store,
    binding.agentInstanceId,
    binding.toolCallId,
  );
  if (evidence.length !== 1) {
    return evidence.length === 0
      ? 'approval-evidence-invalid'
      : 'approval-evidence-ambiguous';
  }
  const current = evidence[0]!;
  if (!current.valid) return 'approval-evidence-invalid';
  if (
    current.approvalId !== binding.approvalId ||
    current.approved !== (binding.decision === 'APPROVE') ||
    current.toolName !== binding.aiToolName
  ) {
    return 'approval-decision-mismatch';
  }
  let effectDigest: string;
  try {
    effectDigest = hashTrustedMcpFinalAuthorityEffectForDescriptorDigest(
      record.descriptorDigest,
      {
        principalId: binding.agentInstanceId,
        toolCallId: binding.toolCallId,
        arguments: current.input,
      },
    );
  } catch {
    return 'approval-evidence-invalid';
  }
  if (effectDigest !== record.effectDigest) {
    return 'approval-decision-mismatch';
  }
  try {
    return createApprovalDecisionDigest(
      record,
      current.approvalId,
      current.approved ? 'APPROVE' : 'DENY',
      effectDigest,
    ) === binding.decisionDigest
      ? 'valid'
      : 'approval-decision-mismatch';
  } catch {
    return 'approval-evidence-invalid';
  }
}

function requireCurrentApprovalDecisionEvidence(
  store: AgentStore,
  binding: ApprovalDecisionBinding,
  expectedDigest: string,
): void {
  sha256Schema.parse(expectedDigest);
  const evidence = findApprovalResponses(
    store,
    binding.agentInstanceId,
    binding.toolCallId,
  );
  if (evidence.length !== 1) {
    throw new Error('MCP approval response evidence changed after commit');
  }
  const current = evidence[0]!;
  if (
    !current.valid ||
    current.approvalId !== binding.approvalId ||
    current.approved !== (binding.decision === 'APPROVE') ||
    current.toolName !== binding.aiToolName
  ) {
    throw new Error('MCP approval response evidence changed after commit');
  }
  let effectDigest: string;
  try {
    effectDigest = hashTrustedMcpFinalAuthorityEffectForDescriptorDigest(
      binding.descriptorDigest,
      {
        principalId: binding.agentInstanceId,
        toolCallId: binding.toolCallId,
        arguments: current.input,
      },
    );
  } catch {
    throw new Error('MCP approval response evidence changed after commit');
  }
  if (
    effectDigest !== binding.effectDigest ||
    createApprovalDecisionDigest(
      binding,
      current.approvalId,
      current.approved ? 'APPROVE' : 'DENY',
      effectDigest,
    ) !== expectedDigest
  ) {
    throw new Error('MCP approval response evidence changed after commit');
  }
}

function requireCurrentApprovalEvidence(
  store: AgentStore,
  binding: ApprovalBinding,
  expectedDigest: string,
): void {
  sha256Schema.parse(expectedDigest);
  const evidence = findApprovalResponses(
    store,
    binding.agentInstanceId,
    binding.toolCallId,
  );
  if (evidence.length !== 1) {
    throw new Error('MCP approval evidence changed after durable claim');
  }
  const current = evidence[0]!;
  if (
    !current.valid ||
    !current.approved ||
    current.toolName !== binding.aiToolName
  ) {
    throw new Error('MCP approval evidence changed after durable claim');
  }
  if (createApprovalEvidenceDigest(binding, current) !== expectedDigest) {
    throw new Error('MCP approval evidence changed after durable claim');
  }
}

function approvalStoreDigest(store: TrustedMcpApprovalStore): string {
  const recordIds = Object.keys(store.records).sort();
  const hash = createHash('sha256')
    .update('clodex.mcp.approval-store.v1\0')
    .update(JSON.stringify([store.version, store.revision, recordIds.length]));
  for (const recordId of recordIds) {
    const record = store.records[recordId]!;
    hash
      .update('\0')
      .update(
        JSON.stringify([
          recordId,
          record.version,
          record.recordId,
          record.agentInstanceId,
          record.toolCallId,
          record.aiToolName,
          record.descriptorDigest,
          record.approvalContextDigest,
          record.effectDigest,
          record.approvalId,
          record.approvalDecision,
          record.approvalDecisionDigest,
          record.decisionRecordedAt,
          record.responseCommittedAt,
          record.approvalEvidenceDigest,
          record.state,
          record.createdAt,
          record.updatedAt,
          record.expiresAt,
          record.claimedAt,
          record.terminalReason,
        ]),
      );
  }
  return hash.digest('hex');
}

function expirePendingRecords(
  store: TrustedMcpApprovalStore,
  now: number,
): boolean {
  let changed = false;
  for (const record of Object.values(store.records)) {
    if (
      (record.state !== 'STAGED' &&
        record.state !== 'RESPONSE_RECORDED' &&
        record.state !== 'APPROVED') ||
      now < record.expiresAt
    ) {
      continue;
    }
    record.state = 'EXPIRED';
    record.updatedAt = now;
    record.claimedAt = null;
    record.approvalEvidenceDigest = null;
    record.terminalReason = 'approval-expired';
    changed = true;
  }
  return changed;
}

function rejectRecord(
  record: TrustedMcpApprovalRecord,
  now: number,
  reason: string,
): void {
  const transitionAt = recordTransitionTimestamp(record, now);
  record.state = 'INVALIDATED';
  record.updatedAt = transitionAt;
  record.claimedAt = null;
  record.approvalEvidenceDigest = null;
  record.terminalReason = reason;
}

function recordTransitionTimestamp(
  record: TrustedMcpApprovalRecord,
  observedNow: number,
): number {
  return Math.max(observedNow, record.updatedAt);
}

function throwPrepareResponseError(
  outcome: Exclude<PrepareResponseOutcome['kind'], 'not-managed' | 'prepared'>,
): never {
  switch (outcome) {
    case 'binding-mismatch':
      throw new Error('MCP approval response does not match staged authority');
    case 'already-claimed':
      throw new Error('MCP approval was already durably claimed');
    case 'expired':
      throw new Error('MCP approval expired before the response was recorded');
    case 'rejected':
      throw new Error('MCP approval identity was previously rejected');
    case 'decision-conflict':
      throw new Error('MCP approval response conflicts with durable evidence');
    case 'input-invalid':
      throw new Error('MCP approval response input is invalid');
  }
  const exhaustive: never = outcome;
  throw new Error(`Unsupported MCP approval response outcome: ${exhaustive}`);
}

function throwCommitResponseError(
  outcome: Exclude<CommitResponseOutcome, 'committed' | 'already-committed'>,
): never {
  switch (outcome) {
    case 'not-recorded':
      throw new Error('MCP approval response was not durably recorded');
    case 'binding-mismatch':
      throw new Error('MCP approval response binding changed before commit');
    case 'already-claimed':
      throw new Error('MCP approval was already durably claimed');
    case 'expired':
      throw new Error('MCP approval expired before response commit');
    case 'rejected':
      throw new Error('MCP approval identity was rejected before commit');
    case 'approval-evidence-ambiguous':
      throw new Error('MCP approval response evidence is ambiguous');
    case 'approval-evidence-invalid':
      throw new Error('MCP approval response evidence is invalid');
    case 'approval-decision-mismatch':
      throw new Error('MCP approval response decision changed before commit');
  }
  const exhaustive: never = outcome;
  throw new Error(`Unsupported MCP approval commit outcome: ${exhaustive}`);
}

function approvalInvalidationReason(
  reason: TrustedMcpApprovalInvalidationReason,
): string {
  switch (reason) {
    case 'new-user-message':
      return 'approval-invalidated-by-new-user-message';
    case 'queue-flush':
      return 'approval-invalidated-by-queue-flush';
    case 'user-stop':
      return 'approval-invalidated-by-user-stop';
    case 'system-interrupted':
      return 'approval-invalidated-by-system-interruption';
  }
  const exhaustive: never = reason;
  throw new Error(`Unsupported MCP approval invalidation: ${exhaustive}`);
}

function throwClaimError(
  outcome: Exclude<ClaimOutcome, 'claimed' | 'not-staged'>,
): never {
  switch (outcome) {
    case 'approval-not-recorded':
      throw new Error('MCP approval response evidence is missing');
    case 'approval-response-not-committed':
      throw new Error('MCP approval response was not durably committed');
    case 'binding-mismatch':
      throw new Error('MCP staged approval does not match execution');
    case 'already-claimed':
      throw new Error('MCP approval was already durably claimed');
    case 'expired':
      throw new Error('MCP approval expired and cannot be reused');
    case 'rejected':
      throw new Error('MCP approval identity was previously rejected');
    case 'approval-evidence-ambiguous':
      throw new Error('MCP approval evidence is ambiguous');
    case 'approval-evidence-invalid':
      throw new Error('MCP approval evidence is invalid');
    case 'approval-decision-mismatch':
      throw new Error('MCP approval decision does not match execution');
    case 'approval-denied':
      throw new Error('MCP approval was denied');
    case 'approval-tool-mismatch':
      throw new Error('MCP approved tool name does not match execution');
    case 'approval-input-mismatch':
      throw new Error('MCP approved input does not match execution');
  }
  const exhaustive: never = outcome;
  throw new Error(`Unsupported MCP approval claim outcome: ${exhaustive}`);
}

type ApprovalResponse =
  | {
      valid: true;
      approvalId: string;
      approved: boolean;
      toolName: string;
      input: Record<string, unknown>;
    }
  | {
      valid: false;
      approvalId: '';
      approved: false;
      toolName: '';
      input: Record<string, never>;
    };

function findApprovalResponses(
  store: AgentStore,
  agentInstanceId: string,
  toolCallId: string,
): ApprovalResponse[] {
  const history = store.get().agents.instances[agentInstanceId]?.state.history;
  if (!history) return [];
  const matches: ApprovalResponse[] = [];
  for (const message of history) {
    if (message.role !== 'assistant') continue;
    for (const rawPart of message.parts) {
      if (!isRecord(rawPart)) continue;
      // `UIMessagePart` is a closed union, so TypeScript preserves the union
      // even after the runtime record check. Treat only the validated non-array
      // record as untrusted evidence and parse every field below.
      const part = rawPart as unknown as Record<string, unknown>;
      if (
        part.toolCallId !== toolCallId ||
        part.state !== 'approval-responded'
      ) {
        continue;
      }
      const approval = part.approval;
      const approvalRecord = isRecord(approval) ? approval : null;
      const approvalId = approvalRecord?.id;
      const approved = approvalRecord?.approved;
      const type = typeof part.type === 'string' ? part.type : '';
      const toolName =
        type === 'dynamic-tool' && typeof part.toolName === 'string'
          ? part.toolName
          : type.startsWith('tool-')
            ? type.slice('tool-'.length)
            : '';
      const parsedApprovalId = boundedIdentifierSchema.safeParse(approvalId);
      const parsedToolName = boundedIdentifierSchema.safeParse(toolName);
      if (
        !parsedApprovalId.success ||
        typeof approved !== 'boolean' ||
        !parsedToolName.success ||
        !isRecord(part.input)
      ) {
        matches.push({
          valid: false,
          approvalId: '',
          approved: false,
          toolName: '',
          input: {},
        });
        continue;
      }
      matches.push({
        valid: true,
        approvalId: parsedApprovalId.data,
        approved,
        toolName: parsedToolName.data,
        input: part.input,
      });
    }
  }
  return matches;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  if (seen.has(value)) return value;
  seen.add(value);
  for (const entry of Object.values(value)) deepFreeze(entry, seen);
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
