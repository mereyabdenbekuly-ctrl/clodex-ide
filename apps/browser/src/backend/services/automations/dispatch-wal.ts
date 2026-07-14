import { createHash } from 'node:crypto';
import type { AutomationDefinition } from '@shared/automations';
import { automationDefinitionSchema } from '@shared/automations';
import { z } from 'zod';

export const automationDispatchTriggerSchema = z.enum([
  'manual',
  'timer',
  'system-resumed',
  'startup-reconcile',
]);
export type AutomationDispatchTrigger = z.infer<
  typeof automationDispatchTriggerSchema
>;

export const automationDispatchWalStateSchema = z.enum([
  'PREPARED',
  'DISPATCHING',
  'SUCCEEDED',
  'FAILED_PRE_EFFECT',
  'UNCERTAIN',
]);
export type AutomationDispatchWalState = z.infer<
  typeof automationDispatchWalStateSchema
>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_AUTOMATION_DISPATCH_WAL_RECORDS = 10_000;
const MAX_CANONICAL_DEPTH = 100;
const MAX_CANONICAL_NODES = 100_000;
const MAX_CANONICAL_BYTES = 4_000_000;

const automationDispatchWalRecordSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().uuid(),
    automationId: z.string().uuid(),
    trigger: automationDispatchTriggerSchema,
    scheduledFor: z.string().datetime(),
    attempt: z.literal(1),
    occurrenceHash: sha256Schema,
    definitionHash: sha256Schema,
    attemptHash: sha256Schema,
    state: automationDispatchWalStateSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    dispatchStartedAt: z.string().datetime().nullable(),
    terminalAt: z.string().datetime().nullable(),
    resultHash: sha256Schema.nullable(),
    error: z.string().max(500).nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    const terminal =
      record.state === 'SUCCEEDED' ||
      record.state === 'FAILED_PRE_EFFECT' ||
      record.state === 'UNCERTAIN';
    if (terminal !== (record.terminalAt !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['terminalAt'],
        message: 'Automation WAL terminal timestamp does not match its state',
      });
    }
    if (
      (record.state === 'DISPATCHING' || record.state === 'SUCCEEDED') &&
      record.dispatchStartedAt === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dispatchStartedAt'],
        message: 'Dispatched automation WAL record has no dispatch timestamp',
      });
    }
    if ((record.state === 'SUCCEEDED') !== (record.resultHash !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resultHash'],
        message: 'Automation WAL result commitment does not match its state',
      });
    }
    if (
      (record.state === 'FAILED_PRE_EFFECT' || record.state === 'UNCERTAIN') !==
      (record.error !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['error'],
        message: 'Automation WAL diagnostic does not match its state',
      });
    }
  });

export type AutomationDispatchWalRecord = z.infer<
  typeof automationDispatchWalRecordSchema
>;

const automationDispatchWalStoreSchema = z
  .object({
    version: z.literal(1),
    records: z.record(z.string().uuid(), automationDispatchWalRecordSchema),
  })
  .strict()
  .superRefine((store, context) => {
    const entries = Object.entries(store.records);
    if (entries.length > MAX_AUTOMATION_DISPATCH_WAL_RECORDS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['records'],
        message: 'Automation dispatch WAL exceeds its fail-closed limit',
      });
    }
    const occurrences = new Set<string>();
    for (const [runId, record] of entries) {
      if (runId !== record.runId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['records', runId],
          message: 'Automation dispatch WAL key does not match its run ID',
        });
      }
      if (occurrences.has(record.occurrenceHash)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['records', runId, 'occurrenceHash'],
          message: 'Automation dispatch WAL occurrence is duplicated',
        });
      }
      occurrences.add(record.occurrenceHash);
    }
  });

type AutomationDispatchWalStore = z.infer<
  typeof automationDispatchWalStoreSchema
>;

export interface AutomationDispatchWalPersistence {
  load(): Promise<unknown>;
  save(store: AutomationDispatchWalStore): Promise<void>;
}

export class PersistedAutomationDispatchWal
  implements AutomationDispatchWalPersistence
{
  public async load(): Promise<unknown> {
    const { readPersistedData } = await import('@/utils/persisted-data');
    return await readPersistedData(
      'automation-dispatch-wal',
      automationDispatchWalStoreSchema,
      { version: 1, records: {} },
      {
        encrypt: true,
        requireEncryption: true,
        allowPlaintextMigration: false,
      },
    );
  }

  public async save(store: AutomationDispatchWalStore): Promise<void> {
    const { writePersistedData } = await import('@/utils/persisted-data');
    await writePersistedData(
      'automation-dispatch-wal',
      automationDispatchWalStoreSchema,
      store,
      { encrypt: true, requireEncryption: true },
    );
  }
}

export class MemoryAutomationDispatchWal
  implements AutomationDispatchWalPersistence
{
  private store: AutomationDispatchWalStore = { version: 1, records: {} };

  public async load(): Promise<unknown> {
    return structuredClone(this.store);
  }

  public async save(store: AutomationDispatchWalStore): Promise<void> {
    this.store = structuredClone(store);
  }
}

export interface AutomationDispatchCommitments {
  definitionHash: string;
  occurrenceHash: string;
  attemptHash: string;
}

export interface AutomationDispatchPreparation
  extends AutomationDispatchCommitments {
  runId: string;
  automationId: string;
  trigger: AutomationDispatchTrigger;
  scheduledFor: string;
  attempt: 1;
}

export interface AutomationDispatchCommitmentInput {
  runId: string;
  trigger: AutomationDispatchTrigger;
  scheduledFor: string;
  automation: AutomationDefinition;
  prompt: string;
}

const TERMINAL_STATES = new Set<AutomationDispatchWalState>([
  'SUCCEEDED',
  'FAILED_PRE_EFFECT',
  'UNCERTAIN',
]);

/**
 * Creates the two independent commitments checked at the last synchronous
 * adapter fence. The definition commitment covers the exact persisted
 * automation snapshot. The attempt commitment additionally binds the live
 * prompt, trigger, occurrence, schedule and one-shot run identifier.
 */
export function createAutomationDispatchCommitments(
  raw: AutomationDispatchCommitmentInput,
): AutomationDispatchCommitments {
  // Inspect descriptors/cycles/bounds before Zod is allowed to read fields.
  canonicalJson(raw);
  const input = z
    .object({
      runId: z.string().uuid(),
      trigger: automationDispatchTriggerSchema,
      scheduledFor: z.string().datetime(),
      automation: z.unknown(),
      prompt: z.string(),
    })
    .strict()
    .parse(raw);
  const automation = automationDefinitionSchema.parse(input.automation);
  if (canonicalJson(input.automation) !== canonicalJson(automation)) {
    throw new Error(
      'Automation dispatch definition is not an exact canonical schema value',
    );
  }
  if (input.prompt !== automation.prompt) {
    throw new Error('Automation dispatch prompt differs from its definition');
  }

  const definitionHash = hashCanonical({
    domain: 'clodex.automation.definition.v1',
    definition: automation,
  });
  const occurrenceHash = createAutomationOccurrenceHash({
    automationId: automation.id,
    scheduledFor: input.scheduledFor,
    trigger: input.trigger,
    runId: input.runId,
  });
  const attemptHash = hashCanonical({
    domain: 'clodex.automation.dispatch-attempt.v1',
    runId: input.runId,
    automationId: automation.id,
    trigger: input.trigger,
    scheduledFor: input.scheduledFor,
    attempt: 1,
    occurrenceHash,
    definitionHash,
    prompt: input.prompt,
  });
  return { definitionHash, occurrenceHash, attemptHash };
}

export function createScheduledAutomationOccurrenceHash(
  automationId: string,
  scheduledFor: string,
): string {
  return hashCanonical({
    domain: 'clodex.automation.scheduled-occurrence.v1',
    automationId: z.string().uuid().parse(automationId),
    scheduledFor: z.string().datetime().parse(scheduledFor),
  });
}

function createAutomationOccurrenceHash(input: {
  automationId: string;
  scheduledFor: string;
  trigger: AutomationDispatchTrigger;
  runId: string;
}): string {
  if (input.trigger !== 'manual') {
    return createScheduledAutomationOccurrenceHash(
      input.automationId,
      input.scheduledFor,
    );
  }
  return hashCanonical({
    domain: 'clodex.automation.manual-occurrence.v1',
    automationId: input.automationId,
    scheduledFor: input.scheduledFor,
    runId: input.runId,
  });
}

/**
 * Durable one-shot journal for every automation dispatch path. It never
 * replays PREPARED or DISPATCHING records. Restart recovery closes PREPARED as
 * FAILED_PRE_EFFECT and DISPATCHING as UNCERTAIN, preserving the occurrence
 * commitment so startup reconciliation advances without dispatching it again.
 */
export class AutomationDispatchWal {
  private mutation = Promise.resolve();

  private constructor(
    private readonly persistence: AutomationDispatchWalPersistence,
    private readonly now: () => number,
    private store: AutomationDispatchWalStore,
  ) {}

  public static async create(
    persistence: AutomationDispatchWalPersistence,
    now: () => number = Date.now,
  ): Promise<AutomationDispatchWal> {
    const store = automationDispatchWalStoreSchema.parse(
      await persistence.load(),
    );
    const wal = new AutomationDispatchWal(persistence, now, store);
    await wal.recoverInterruptedDispatches();
    return wal;
  }

  public list(): AutomationDispatchWalRecord[] {
    return structuredClone(Object.values(this.store.records));
  }

  public get(runId: string): AutomationDispatchWalRecord | null {
    const id = z.string().uuid().parse(runId);
    const record = this.store.records[id];
    return record ? structuredClone(record) : null;
  }

  public findScheduledOccurrence(
    automationId: string,
    scheduledFor: string,
  ): AutomationDispatchWalRecord | null {
    const occurrenceHash = createScheduledAutomationOccurrenceHash(
      automationId,
      scheduledFor,
    );
    const record = Object.values(this.store.records).find(
      (candidate) => candidate.occurrenceHash === occurrenceHash,
    );
    return record ? structuredClone(record) : null;
  }

  public async prepare(
    raw: AutomationDispatchPreparation,
  ): Promise<AutomationDispatchWalRecord> {
    const input = z
      .object({
        runId: z.string().uuid(),
        automationId: z.string().uuid(),
        trigger: automationDispatchTriggerSchema,
        scheduledFor: z.string().datetime(),
        attempt: z.literal(1),
        occurrenceHash: sha256Schema,
        definitionHash: sha256Schema,
        attemptHash: sha256Schema,
      })
      .strict()
      .parse(raw);
    return await this.mutate((next) => {
      if (next.records[input.runId]) {
        throw new Error('Automation dispatch run already has a WAL record');
      }
      if (
        Object.values(next.records).some(
          (record) => record.occurrenceHash === input.occurrenceHash,
        )
      ) {
        throw new Error(
          'Automation dispatch occurrence already has a durable WAL record',
        );
      }
      if (
        Object.keys(next.records).length >= MAX_AUTOMATION_DISPATCH_WAL_RECORDS
      ) {
        throw new Error('Automation dispatch WAL is full');
      }
      const timestamp = new Date(this.now()).toISOString();
      const record = automationDispatchWalRecordSchema.parse({
        version: 1,
        ...input,
        state: 'PREPARED',
        createdAt: timestamp,
        updatedAt: timestamp,
        dispatchStartedAt: null,
        terminalAt: null,
        resultHash: null,
        error: null,
      });
      next.records[input.runId] = record;
      return record;
    });
  }

  public async beginDispatch(
    input: AutomationDispatchPreparation,
  ): Promise<AutomationDispatchWalRecord> {
    return await this.transition(input, 'DISPATCHING');
  }

  public async markSucceeded(
    runId: string,
    result: unknown,
  ): Promise<AutomationDispatchWalRecord> {
    return await this.transition(
      {
        runId,
        resultHash: hashCanonical({
          domain: 'clodex.automation.dispatch-result.v1',
          result,
        }),
      },
      'SUCCEEDED',
    );
  }

  public async markFailedPreEffect(
    runId: string,
    error: string,
  ): Promise<AutomationDispatchWalRecord> {
    return await this.transition({ runId, error }, 'FAILED_PRE_EFFECT');
  }

  public async markUncertain(
    runId: string,
    error: string,
  ): Promise<AutomationDispatchWalRecord> {
    return await this.transition({ runId, error }, 'UNCERTAIN');
  }

  public async flush(): Promise<void> {
    await this.mutation;
  }

  private async recoverInterruptedDispatches(): Promise<void> {
    if (
      !Object.values(this.store.records).some(
        (record) =>
          record.state === 'PREPARED' || record.state === 'DISPATCHING',
      )
    ) {
      return;
    }
    await this.mutate((next) => {
      const timestamp = new Date(this.now()).toISOString();
      for (const record of Object.values(next.records)) {
        if (record.state !== 'PREPARED' && record.state !== 'DISPATCHING') {
          continue;
        }
        const interruptedState = record.state;
        record.state =
          interruptedState === 'PREPARED' ? 'FAILED_PRE_EFFECT' : 'UNCERTAIN';
        record.updatedAt = timestamp;
        record.terminalAt = timestamp;
        record.error =
          interruptedState === 'PREPARED'
            ? 'Process stopped before durable dispatch began; the occurrence was burned without replay'
            : 'Process stopped while automation dispatch was in progress; the occurrence was not replayed';
      }
    });
  }

  private async transition(
    raw:
      | AutomationDispatchPreparation
      | { runId: string; resultHash: string }
      | { runId: string; error: string },
    target: AutomationDispatchWalState,
  ): Promise<AutomationDispatchWalRecord> {
    const input = z
      .object({
        runId: z.string().uuid(),
        automationId: z.string().uuid().optional(),
        trigger: automationDispatchTriggerSchema.optional(),
        scheduledFor: z.string().datetime().optional(),
        attempt: z.literal(1).optional(),
        occurrenceHash: sha256Schema.optional(),
        definitionHash: sha256Schema.optional(),
        attemptHash: sha256Schema.optional(),
        resultHash: sha256Schema.optional(),
        error: z.string().max(500).optional(),
      })
      .strict()
      .parse(raw);
    return await this.mutate((next) => {
      const record = next.records[input.runId];
      if (!record) throw new Error('Automation dispatch WAL record is absent');
      if (input.definitionHash) this.assertExactAttempt(record, input);
      if (!isLegalTransition(record.state, target)) {
        throw new Error(
          `Illegal automation dispatch WAL transition ${record.state} -> ${target}`,
        );
      }
      const timestamp = new Date(this.now()).toISOString();
      record.state = target;
      record.updatedAt = timestamp;
      if (target === 'DISPATCHING') record.dispatchStartedAt = timestamp;
      if (TERMINAL_STATES.has(target)) record.terminalAt = timestamp;
      if (target === 'SUCCEEDED') record.resultHash = input.resultHash ?? null;
      if (input.error) record.error = input.error;
      return record;
    });
  }

  private assertExactAttempt(
    record: AutomationDispatchWalRecord,
    input: {
      automationId?: string;
      trigger?: AutomationDispatchTrigger;
      scheduledFor?: string;
      attempt?: 1;
      occurrenceHash?: string;
      definitionHash?: string;
      attemptHash?: string;
    },
  ): void {
    if (
      record.automationId !== input.automationId ||
      record.trigger !== input.trigger ||
      record.scheduledFor !== input.scheduledFor ||
      record.attempt !== input.attempt ||
      record.occurrenceHash !== input.occurrenceHash ||
      record.definitionHash !== input.definitionHash ||
      record.attemptHash !== input.attemptHash
    ) {
      throw new Error('Automation dispatch definition or attempt mismatch');
    }
  }

  private async mutate<T>(
    operation: (next: AutomationDispatchWalStore) => Promise<T> | T,
  ): Promise<T> {
    const result = this.mutation.then(async () => {
      const next = structuredClone(this.store);
      const value = await operation(next);
      const parsed = automationDispatchWalStoreSchema.parse(next);
      await this.persistence.save(parsed);
      this.store = parsed;
      return structuredClone(value);
    });
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

function isLegalTransition(
  current: AutomationDispatchWalState,
  target: AutomationDispatchWalState,
): boolean {
  if (current === 'PREPARED') {
    return target === 'DISPATCHING' || target === 'FAILED_PRE_EFFECT';
  }
  if (current === 'DISPATCHING') {
    return (
      target === 'SUCCEEDED' ||
      target === 'FAILED_PRE_EFFECT' ||
      target === 'UNCERTAIN'
    );
  }
  return false;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return canonicalize(value, new WeakSet<object>(), { nodes: 0, bytes: 0 }, 0);
}

function canonicalize(
  value: unknown,
  active: WeakSet<object>,
  budget: { nodes: number; bytes: number },
  depth: number,
): string {
  budget.nodes += 1;
  if (budget.nodes > MAX_CANONICAL_NODES) {
    throw new Error('Automation commitment is too complex');
  }
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new Error('Automation commitment is too deeply nested');
  }

  if (value === null) return accountCanonicalBytes('null', budget);
  switch (typeof value) {
    case 'boolean':
      return accountCanonicalBytes(value ? 'true' : 'false', budget);
    case 'string':
      return accountCanonicalBytes(JSON.stringify(value), budget);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('Automation commitment numbers must be finite');
      }
      return accountCanonicalBytes(
        Object.is(value, -0) ? '0' : JSON.stringify(value),
        budget,
      );
    case 'object':
      return canonicalizeObject(value, active, budget, depth);
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      throw new Error(
        `Automation commitment cannot contain ${typeof value} values`,
      );
  }
  throw new Error('Automation commitment contains an unsupported value');
}

function canonicalizeObject(
  value: object,
  active: WeakSet<object>,
  budget: { nodes: number; bytes: number },
  depth: number,
): string {
  if (active.has(value)) {
    throw new Error('Automation commitment cannot contain cycles');
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return canonicalizeArray(value, active, budget, depth);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(
        'Automation commitment objects must be plain data records',
      );
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > MAX_CANONICAL_NODES) {
      throw new Error('Automation commitment record has too many fields');
    }
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new Error('Automation commitment cannot contain symbol keys');
    }
    const entries = (ownKeys as string[]).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new Error(
          'Automation commitment records require enumerable data properties',
        );
      }
      return [key, descriptor.value] as const;
    });
    entries.sort(([left], [right]) => compareUtf8(left, right));

    const parts = [accountCanonicalBytes('{', budget)];
    for (const [index, [key, field]] of entries.entries()) {
      if (index > 0) parts.push(accountCanonicalBytes(',', budget));
      parts.push(accountCanonicalBytes(JSON.stringify(key), budget));
      parts.push(accountCanonicalBytes(':', budget));
      parts.push(canonicalize(field, active, budget, depth + 1));
    }
    parts.push(accountCanonicalBytes('}', budget));
    return parts.join('');
  } finally {
    active.delete(value);
  }
}

function canonicalizeArray(
  value: unknown[],
  active: WeakSet<object>,
  budget: { nodes: number; bytes: number },
  depth: number,
): string {
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    !ownKeys.includes('length') ||
    value.length > MAX_CANONICAL_NODES
  ) {
    throw new Error(
      'Automation commitment arrays must be dense and index-only',
    );
  }
  const parts = [accountCanonicalBytes('[', budget)];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new Error(
        'Automation commitment arrays require enumerable data elements',
      );
    }
    if (index > 0) parts.push(accountCanonicalBytes(',', budget));
    parts.push(canonicalize(descriptor.value, active, budget, depth + 1));
  }
  parts.push(accountCanonicalBytes(']', budget));
  return parts.join('');
}

function accountCanonicalBytes(
  chunk: string,
  budget: { bytes: number },
): string {
  budget.bytes += Buffer.byteLength(chunk, 'utf8');
  if (budget.bytes > MAX_CANONICAL_BYTES) {
    throw new Error('Automation commitment exceeds its byte limit');
  }
  return chunk;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
