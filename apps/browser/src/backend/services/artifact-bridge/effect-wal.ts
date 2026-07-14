import { z } from 'zod';

export const artifactBridgeEffectWalStateSchema = z.enum([
  'PREPARED',
  'DISPATCHING',
  'COMMITTED',
  'RESULT_UNAVAILABLE',
  'UNCERTAIN',
  'FAILED_PRE_EFFECT',
]);
export type ArtifactBridgeEffectWalState = z.infer<
  typeof artifactBridgeEffectWalStateSchema
>;

const effectWalRecordSchema = z
  .object({
    version: z.literal(1),
    effectId: z.string().uuid(),
    kind: z.enum([
      'mcp-write',
      'sensitive-mcp',
      'agent-ask',
      'automation',
      'mcp-read-async',
    ]),
    commitmentHash: z.string().regex(/^[a-f0-9]{64}$/),
    ticketHash: z.string().regex(/^[a-f0-9]{64}$/),
    actionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    definitionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    adapterHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    state: artifactBridgeEffectWalStateSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    dispatchStartedAt: z.string().datetime().nullable(),
    terminalAt: z.string().datetime().nullable(),
    resultHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    error: z.string().max(500).nullable(),
  })
  .strict();

export type ArtifactBridgeEffectWalRecord = z.infer<
  typeof effectWalRecordSchema
>;

export const effectWalStoreSchema = z
  .object({
    version: z.literal(1),
    records: z.record(z.string().uuid(), effectWalRecordSchema),
  })
  .strict();

type EffectWalStore = z.infer<typeof effectWalStoreSchema>;

export interface ArtifactBridgeEffectWalPersistence {
  load(): Promise<unknown>;
  save(store: EffectWalStore): Promise<void>;
}

export class PersistedArtifactBridgeEffectWal
  implements ArtifactBridgeEffectWalPersistence
{
  public async load(): Promise<unknown> {
    const { readPersistedData } = await import('@/utils/persisted-data');
    return await readPersistedData(
      'artifact-effect-wal',
      effectWalStoreSchema,
      { version: 1, records: {} },
      {
        encrypt: true,
        requireEncryption: true,
        allowPlaintextMigration: false,
      },
    );
  }

  public async save(store: EffectWalStore): Promise<void> {
    const { writePersistedData } = await import('@/utils/persisted-data');
    await writePersistedData(
      'artifact-effect-wal',
      effectWalStoreSchema,
      store,
      { encrypt: true, requireEncryption: true },
    );
  }
}

export class MemoryArtifactBridgeEffectWal
  implements ArtifactBridgeEffectWalPersistence
{
  private store: EffectWalStore = { version: 1, records: {} };

  public async load(): Promise<unknown> {
    return structuredClone(this.store);
  }

  public async save(store: EffectWalStore): Promise<void> {
    this.store = structuredClone(store);
  }
}

export interface ArtifactBridgeEffectPreparation {
  effectId: string;
  kind: ArtifactBridgeEffectWalRecord['kind'];
  commitmentHash: string;
  ticketHash: string;
  actionHash?: string;
  definitionHash?: string;
  adapterHash?: string;
}

const MAX_EFFECT_WAL_RECORDS = 10_000;
const TERMINAL_STATES = new Set<ArtifactBridgeEffectWalState>([
  'COMMITTED',
  'RESULT_UNAVAILABLE',
  'UNCERTAIN',
  'FAILED_PRE_EFFECT',
]);
const UNIVERSAL_EFFECT_KINDS = new Set<ArtifactBridgeEffectWalRecord['kind']>([
  'agent-ask',
  'automation',
  'mcp-read-async',
]);

/**
 * Durable, serialized state machine for one-shot irreversible effects.
 * Records contain hashes and bounded diagnostics only, never arguments,
 * credentials, prompts, provider results, or other request content.
 */
export class ArtifactBridgeEffectWal {
  private store: EffectWalStore;
  private mutation = Promise.resolve();

  private constructor(
    private readonly persistence: ArtifactBridgeEffectWalPersistence,
    private readonly now: () => number,
    store: EffectWalStore,
  ) {
    this.store = store;
  }

  public static async create(
    persistence: ArtifactBridgeEffectWalPersistence,
    now: () => number = Date.now,
  ): Promise<ArtifactBridgeEffectWal> {
    const store = effectWalStoreSchema.parse(await persistence.load());
    const wal = new ArtifactBridgeEffectWal(persistence, now, store);
    await wal.recoverInterruptedDispatches();
    return wal;
  }

  public get(effectId: string): ArtifactBridgeEffectWalRecord | null {
    const id = z.string().uuid().parse(effectId);
    const record = this.store.records[id];
    return record ? structuredClone(record) : null;
  }

  public async prepare(
    raw: ArtifactBridgeEffectPreparation,
  ): Promise<ArtifactBridgeEffectWalRecord> {
    const input = z
      .object({
        effectId: z.string().uuid(),
        kind: z.enum([
          'mcp-write',
          'sensitive-mcp',
          'agent-ask',
          'automation',
          'mcp-read-async',
        ]),
        commitmentHash: z.string().regex(/^[a-f0-9]{64}$/),
        ticketHash: z.string().regex(/^[a-f0-9]{64}$/),
        actionHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        definitionHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        adapterHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (!UNIVERSAL_EFFECT_KINDS.has(value.kind)) return;
        for (const field of [
          'actionHash',
          'definitionHash',
          'adapterHash',
        ] as const) {
          if (!value[field]) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [field],
              message: `${field} is required for a universal effect`,
            });
          }
        }
      })
      .parse(raw);
    return await this.mutate(async (next) => {
      const existing = next.records[input.effectId];
      if (existing) {
        this.assertExactTicket(existing, input);
        return existing;
      }
      if (Object.keys(next.records).length >= MAX_EFFECT_WAL_RECORDS) {
        throw new Error('Artifact Bridge effect WAL is full');
      }
      const timestamp = new Date(this.now()).toISOString();
      const record = effectWalRecordSchema.parse({
        version: 1,
        ...input,
        actionHash: input.actionHash ?? null,
        definitionHash: input.definitionHash ?? null,
        adapterHash: input.adapterHash ?? null,
        state: 'PREPARED',
        createdAt: timestamp,
        updatedAt: timestamp,
        dispatchStartedAt: null,
        terminalAt: null,
        resultHash: null,
        error: null,
      });
      next.records[input.effectId] = record;
      return record;
    });
  }

  public async beginDispatch(input: {
    effectId: string;
    commitmentHash: string;
    ticketHash: string;
    actionHash?: string;
    definitionHash?: string;
    adapterHash?: string;
  }): Promise<ArtifactBridgeEffectWalRecord> {
    return await this.transition(input, 'DISPATCHING');
  }

  public async markCommitted(
    effectId: string,
    resultHash?: string,
  ): Promise<ArtifactBridgeEffectWalRecord> {
    return await this.transition({ effectId, resultHash }, 'COMMITTED');
  }

  public async markResultUnavailable(
    effectId: string,
    error: string,
  ): Promise<ArtifactBridgeEffectWalRecord> {
    return await this.transition({ effectId, error }, 'RESULT_UNAVAILABLE');
  }

  public async markUncertain(
    effectId: string,
    error: string,
  ): Promise<ArtifactBridgeEffectWalRecord> {
    return await this.transition({ effectId, error }, 'UNCERTAIN');
  }

  public async markFailedPreEffect(
    effectId: string,
    error: string,
  ): Promise<ArtifactBridgeEffectWalRecord> {
    return await this.transition({ effectId, error }, 'FAILED_PRE_EFFECT');
  }

  public async flush(): Promise<void> {
    await this.mutation;
  }

  private async recoverInterruptedDispatches(): Promise<void> {
    const interrupted = Object.values(this.store.records).filter(
      (record) =>
        record.state === 'DISPATCHING' ||
        (record.state === 'PREPARED' &&
          UNIVERSAL_EFFECT_KINDS.has(record.kind)) ||
        (record.state === 'COMMITTED' &&
          UNIVERSAL_EFFECT_KINDS.has(record.kind)),
    );
    if (interrupted.length === 0) return;
    await this.mutate(async (next) => {
      const timestamp = new Date(this.now()).toISOString();
      for (const record of Object.values(next.records)) {
        if (record.state === 'DISPATCHING') {
          record.state = 'UNCERTAIN';
          record.error =
            'Process stopped while effect dispatch was in progress';
        } else if (
          record.state === 'PREPARED' &&
          UNIVERSAL_EFFECT_KINDS.has(record.kind)
        ) {
          // Direct/async universal requests have no durable caller continuation.
          // Burning an orphaned PREPARED record prevents startup or request
          // recovery from silently replaying it under the same request ID.
          record.state = 'FAILED_PRE_EFFECT';
          record.error =
            'Process stopped before effect dispatch; a fresh request is required';
        } else if (
          record.state === 'COMMITTED' &&
          UNIVERSAL_EFFECT_KINDS.has(record.kind)
        ) {
          // Universal results are intentionally held only by the live caller or
          // async-operation registry. A restart proves that the committed result
          // can no longer be delivered, so preserve no-replay while recording
          // the loss explicitly instead of leaving a misleading COMMITTED state.
          record.state = 'RESULT_UNAVAILABLE';
          record.error =
            'Process stopped after effect commit; the result is unavailable';
        } else {
          continue;
        }
        record.updatedAt = timestamp;
        record.terminalAt = timestamp;
      }
    });
  }

  private async transition(
    raw: {
      effectId: string;
      commitmentHash?: string;
      ticketHash?: string;
      resultHash?: string;
      error?: string;
      actionHash?: string;
      definitionHash?: string;
      adapterHash?: string;
    },
    target: ArtifactBridgeEffectWalState,
  ): Promise<ArtifactBridgeEffectWalRecord> {
    const input = z
      .object({
        effectId: z.string().uuid(),
        commitmentHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        ticketHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        resultHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        error: z.string().max(500).optional(),
        actionHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        definitionHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        adapterHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .parse(raw);
    return await this.mutate(async (next) => {
      const record = next.records[input.effectId];
      if (!record)
        throw new Error('Artifact Bridge effect WAL record is absent');
      if (input.commitmentHash && input.ticketHash) {
        this.assertExactTicket(record, {
          effectId: input.effectId,
          kind: record.kind,
          commitmentHash: input.commitmentHash,
          ticketHash: input.ticketHash,
          actionHash: input.actionHash,
          definitionHash: input.definitionHash,
          adapterHash: input.adapterHash,
        });
      }
      if (!isLegalTransition(record.state, target)) {
        throw new Error(
          `Illegal Artifact Bridge effect WAL transition ${record.state} -> ${target}`,
        );
      }
      const timestamp = new Date(this.now()).toISOString();
      record.state = target;
      record.updatedAt = timestamp;
      if (target === 'DISPATCHING') record.dispatchStartedAt = timestamp;
      if (TERMINAL_STATES.has(target)) record.terminalAt = timestamp;
      if (target === 'COMMITTED') record.resultHash = input.resultHash ?? null;
      if (input.error) record.error = input.error;
      return record;
    });
  }

  private assertExactTicket(
    record: ArtifactBridgeEffectWalRecord,
    input: ArtifactBridgeEffectPreparation,
  ): void {
    if (
      record.kind !== input.kind ||
      record.commitmentHash !== input.commitmentHash ||
      record.ticketHash !== input.ticketHash ||
      (input.actionHash !== undefined &&
        record.actionHash !== input.actionHash) ||
      (input.definitionHash !== undefined &&
        record.definitionHash !== input.definitionHash) ||
      (input.adapterHash !== undefined &&
        record.adapterHash !== input.adapterHash)
    ) {
      throw new Error('Artifact Bridge effect ticket or commitment mismatch');
    }
  }

  private async mutate<T>(
    operation: (next: EffectWalStore) => Promise<T> | T,
  ): Promise<T> {
    const result = this.mutation.then(async () => {
      const next = structuredClone(this.store);
      const value = await operation(next);
      const parsed = effectWalStoreSchema.parse(next);
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
  current: ArtifactBridgeEffectWalState,
  target: ArtifactBridgeEffectWalState,
): boolean {
  if (current === 'PREPARED') {
    return target === 'DISPATCHING' || target === 'FAILED_PRE_EFFECT';
  }
  if (current === 'DISPATCHING') {
    return (
      target === 'COMMITTED' ||
      target === 'RESULT_UNAVAILABLE' ||
      target === 'UNCERTAIN' ||
      target === 'FAILED_PRE_EFFECT'
    );
  }
  return current === 'COMMITTED' && target === 'RESULT_UNAVAILABLE';
}
