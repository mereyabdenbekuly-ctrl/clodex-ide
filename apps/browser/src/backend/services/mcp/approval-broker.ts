import { createHash } from 'node:crypto';
import type { AgentStore } from '@clodex/agent-core';
import { z } from 'zod';
import { DisposableService } from '../disposable';
import {
  createTrustedMcpApprovalAuthority,
  hashTrustedMcpFinalAuthorityEffect,
  type TrustedMcpDescriptorCommitment,
  type TrustedMcpFinalAuthority,
  type TrustedMcpFinalAuthorityEffect,
} from './trusted-dispatch-gateway';

const DEFAULT_CLAIM_TTL_MS = 24 * 60 * 60_000;
const MAX_APPROVAL_RECORDS = 10_000;
const MAX_IDENTIFIER_LENGTH = 4_096;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
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
  'CLAIMED',
  'EXPIRED',
  'INVALIDATED',
]);
export type TrustedMcpApprovalRecordState = z.infer<
  typeof trustedMcpApprovalRecordStateSchema
>;

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
    approvalEvidenceDigest: sha256Schema.nullable(),
    state: trustedMcpApprovalRecordStateSchema,
    createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    claimedAt: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
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
    const terminalReasonRequired =
      record.state === 'EXPIRED' || record.state === 'INVALIDATED';
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
  | 'binding-mismatch'
  | 'already-claimed'
  | 'expired'
  | 'rejected'
  | 'approval-evidence-ambiguous'
  | 'approval-evidence-invalid'
  | 'approval-denied'
  | 'approval-tool-mismatch'
  | 'approval-input-mismatch';

type ClaimMutationOutcome =
  | { kind: 'claimed'; approvalEvidenceDigest: string }
  | { kind: Exclude<ClaimOutcome, 'claimed'> };

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

      record.state = 'CLAIMED';
      record.updatedAt = now;
      record.claimedAt = now;
      record.approvalEvidenceDigest = approvalEvidenceDigest;
      record.terminalReason = null;
      return {
        changed: true,
        value: { kind: 'claimed', approvalEvidenceDigest },
      };
    });

    if (
      outcome.kind === 'not-staged' ||
      outcome.kind === 'approval-not-recorded'
    ) {
      return null;
    }
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
        (record) => record.state === 'STAGED' && now >= record.expiresAt,
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

  return createHash('sha256')
    .update('clodex.mcp.approval-evidence.v1\0')
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
    .update(approvedEffectDigest)
    .update('\0')
    .update(approval.approvalId)
    .update('\0approved=true')
    .digest('hex');
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
    if (record.state !== 'STAGED' || now < record.expiresAt) continue;
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
  record.state = 'INVALIDATED';
  record.updatedAt = now;
  record.claimedAt = null;
  record.approvalEvidenceDigest = null;
  record.terminalReason = reason;
}

function throwClaimError(
  outcome: Exclude<
    ClaimOutcome,
    'claimed' | 'not-staged' | 'approval-not-recorded'
  >,
): never {
  switch (outcome) {
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
      const part = rawPart;
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

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
