import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  GeneratedAppPublisherAdministration,
  GeneratedAppPublisherPolicy,
  GeneratedAppPublisherPolicyInput,
} from '@shared/generated-apps';
import { fingerprintGeneratedAppPackagePublicKey } from './package-attestation';

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const trustEntrySchema = z
  .object({
    publisherId: z.string().min(1).max(256),
    keyId: z.string().min(1).max(256),
    publicKeyFingerprint: fingerprintSchema,
    publicKeyPem: z.string().min(1).max(4_096),
    trustedAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
  })
  .strict();

const policySchema = z
  .object({
    mode: z.enum(['allow-all', 'allowlist']),
    allowedPublisherIds: z
      .array(z.string().min(1).max(256))
      .max(10_000)
      .transform((values) => Array.from(new Set(values)).sort()),
    allowedPublicKeyFingerprints: z
      .array(fingerprintSchema)
      .max(10_000)
      .transform((values) => Array.from(new Set(values)).sort()),
    updatedAt: z.string().datetime(),
  })
  .strict();

const auditEventSchema = z
  .object({
    id: z.string().uuid(),
    at: z.string().datetime(),
    operation: z.enum(['trust', 'revoke', 'policy-update', 'policy-deny']),
    publisherId: z.string().min(1).max(256).nullable(),
    keyId: z.string().min(1).max(256).nullable(),
    publicKeyFingerprint: fingerprintSchema.nullable(),
    reason: z.string().max(1_024).nullable(),
  })
  .strict();

const legacyTrustStoreSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(trustEntrySchema).max(10_000),
  })
  .strict();

const trustStoreSchema = z
  .object({
    version: z.literal(2),
    entries: z.array(trustEntrySchema).max(10_000),
    policy: policySchema,
    audit: z.array(auditEventSchema).max(1_000),
  })
  .strict();

type TrustStore = z.infer<typeof trustStoreSchema>;
export type GeneratedAppPackageTrustEntry = z.infer<typeof trustEntrySchema>;

const DEFAULT_POLICY: GeneratedAppPublisherPolicy = {
  mode: 'allow-all',
  allowedPublisherIds: [],
  allowedPublicKeyFingerprints: [],
  updatedAt: new Date(0).toISOString(),
};
const DEFAULT_STORE: TrustStore = {
  version: 2,
  entries: [],
  policy: DEFAULT_POLICY,
  audit: [],
};

export interface GeneratedAppPackageTrustPersistence {
  load(): Promise<unknown>;
  save(store: TrustStore): Promise<void>;
}

class PersistedTrustStore implements GeneratedAppPackageTrustPersistence {
  async load(): Promise<unknown> {
    const { readPersistedData } = await import('@/utils/persisted-data');
    return await readPersistedData(
      'generated-app-package-trust',
      z.union([legacyTrustStoreSchema, trustStoreSchema]),
      DEFAULT_STORE,
      {
        encrypt: true,
        requireEncryption: true,
        allowPlaintextMigration: false,
      },
    );
  }

  async save(store: TrustStore): Promise<void> {
    const { writePersistedData } = await import('@/utils/persisted-data');
    await writePersistedData(
      'generated-app-package-trust',
      trustStoreSchema,
      store,
      { encrypt: true, requireEncryption: true },
    );
  }
}

export type GeneratedAppPublisherPolicyDecision = {
  allowed: boolean;
  reason: string | null;
};

export class GeneratedAppPackageTrustService {
  private storePromise: Promise<TrustStore> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly persistence: GeneratedAppPackageTrustPersistence = new PersistedTrustStore(),
    private readonly now: () => number = Date.now,
  ) {}

  private async load(): Promise<TrustStore> {
    this.storePromise ??= this.persistence.load().then(async (raw) => {
      const current = trustStoreSchema.safeParse(raw);
      const parsed = current.success
        ? current.data
        : migrateLegacyStore(raw, this.now());
      for (const entry of parsed.entries) {
        if (
          fingerprintGeneratedAppPackagePublicKey(entry.publicKeyPem) !==
          entry.publicKeyFingerprint
        ) {
          throw new Error('Generated app package trust entry is corrupted');
        }
      }
      if (!current.success) await this.persistence.save(parsed);
      return parsed;
    });
    return await this.storePromise;
  }

  private async mutate(
    operation: (store: TrustStore) => void,
  ): Promise<TrustStore> {
    return await this.withLock(async () => {
      const store = structuredClone(await this.load());
      operation(store);
      const parsed = trustStoreSchema.parse(store);
      await this.persistence.save(parsed);
      this.storePromise = Promise.resolve(parsed);
      return parsed;
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release: () => void = () => {};
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  public async getAdministration(): Promise<GeneratedAppPublisherAdministration> {
    const store = await this.load();
    return {
      entries: store.entries.map(
        ({ publicKeyPem: _secret, ...entry }) => entry,
      ),
      policy: structuredClone(store.policy),
      audit: structuredClone(store.audit),
    };
  }

  public async find(
    publisherId: string,
    keyId: string,
  ): Promise<GeneratedAppPackageTrustEntry | null> {
    const store = await this.load();
    return (
      store.entries.find(
        (entry) =>
          entry.publisherId === publisherId &&
          entry.keyId === keyId &&
          entry.revokedAt === null,
      ) ?? null
    );
  }

  public async getStatus(input: {
    publisherId: string;
    keyId: string;
    publicKeyFingerprint: string;
  }): Promise<'trusted' | 'revoked' | 'unknown'> {
    const store = await this.load();
    const historical = store.entries.find(
      (entry) =>
        entry.publisherId === input.publisherId &&
        entry.keyId === input.keyId &&
        entry.publicKeyFingerprint === input.publicKeyFingerprint,
    );
    if (!historical) return 'unknown';
    return historical.revokedAt ? 'revoked' : 'trusted';
  }

  public async evaluatePolicy(input: {
    publisherId: string;
    publicKeyFingerprint: string;
  }): Promise<GeneratedAppPublisherPolicyDecision> {
    const { policy } = await this.load();
    if (policy.mode === 'allow-all') return { allowed: true, reason: null };
    if (
      policy.allowedPublisherIds.includes(input.publisherId) ||
      policy.allowedPublicKeyFingerprints.includes(input.publicKeyFingerprint)
    ) {
      return { allowed: true, reason: null };
    }
    return {
      allowed: false,
      reason: `Publisher "${input.publisherId}" is not allowed by organization policy.`,
    };
  }

  public async assertCompatible(input: {
    publisherId: string;
    keyId: string;
    publicKeyFingerprint: string;
    publicKeyPem: string;
  }): Promise<GeneratedAppPackageTrustEntry | null> {
    const store = await this.load();
    const historical = store.entries.find(
      (entry) =>
        entry.publisherId === input.publisherId && entry.keyId === input.keyId,
    );
    if (
      historical &&
      (historical.publicKeyFingerprint !== input.publicKeyFingerprint ||
        historical.publicKeyPem !== input.publicKeyPem)
    ) {
      throw new Error(
        'A different signing key is already bound to this publisher and key ID',
      );
    }
    return historical?.revokedAt ? null : (historical ?? null);
  }

  public async trust(input: {
    publisherId: string;
    keyId: string;
    publicKeyFingerprint: string;
    publicKeyPem: string;
  }): Promise<GeneratedAppPackageTrustEntry> {
    const policy = await this.evaluatePolicy(input);
    if (!policy.allowed) {
      await this.recordPolicyDeny(input, policy.reason);
      throw new Error(policy.reason ?? 'Publisher is blocked by policy');
    }
    const existing = await this.assertCompatible(input);
    if (existing) return existing;
    const status = await this.getStatus(input);
    if (status === 'revoked') {
      throw new Error(
        'A revoked publisher key cannot be silently trusted again; use a new key ID',
      );
    }
    if (
      fingerprintGeneratedAppPackagePublicKey(input.publicKeyPem) !==
      input.publicKeyFingerprint
    ) {
      throw new Error('Publisher public key fingerprint does not match');
    }
    let created: GeneratedAppPackageTrustEntry | null = null;
    await this.mutate((store) => {
      const policy = evaluateStoredPolicy(store.policy, input);
      if (!policy.allowed) {
        throw new Error(policy.reason ?? 'Publisher is blocked by policy');
      }
      const historical = store.entries.find(
        (entry) =>
          entry.publisherId === input.publisherId &&
          entry.keyId === input.keyId,
      );
      if (
        historical &&
        (historical.publicKeyFingerprint !== input.publicKeyFingerprint ||
          historical.publicKeyPem !== input.publicKeyPem)
      ) {
        throw new Error(
          'A different signing key is already bound to this publisher and key ID',
        );
      }
      if (historical?.revokedAt) {
        throw new Error(
          'A revoked publisher key cannot be silently trusted again; use a new key ID',
        );
      }
      if (historical) {
        created = historical;
        return;
      }
      created = trustEntrySchema.parse({
        ...input,
        trustedAt: new Date(this.now()).toISOString(),
        revokedAt: null,
      });
      store.entries.push(created);
      appendAudit(store, this.now(), {
        operation: 'trust',
        publisherId: input.publisherId,
        keyId: input.keyId,
        publicKeyFingerprint: input.publicKeyFingerprint,
        reason: null,
      });
    });
    if (!created) throw new Error('Publisher trust could not be persisted');
    return created;
  }

  public async revoke(
    publisherId: string,
    keyId: string,
    reason: string | null,
  ): Promise<GeneratedAppPublisherAdministration> {
    await this.mutate((store) => {
      const entry = store.entries.find(
        (candidate) =>
          candidate.publisherId === publisherId &&
          candidate.keyId === keyId &&
          candidate.revokedAt === null,
      );
      if (!entry) throw new Error('Trusted publisher key was not found');
      entry.revokedAt = new Date(this.now()).toISOString();
      appendAudit(store, this.now(), {
        operation: 'revoke',
        publisherId,
        keyId,
        publicKeyFingerprint: entry.publicKeyFingerprint,
        reason,
      });
    });
    return await this.getAdministration();
  }

  public async setPolicy(
    input: GeneratedAppPublisherPolicyInput,
  ): Promise<GeneratedAppPublisherAdministration> {
    const policy = policySchema.parse({
      ...input,
      updatedAt: new Date(this.now()).toISOString(),
    });
    await this.mutate((store) => {
      store.policy = policy;
      appendAudit(store, this.now(), {
        operation: 'policy-update',
        publisherId: null,
        keyId: null,
        publicKeyFingerprint: null,
        reason: `mode=${policy.mode}`,
      });
    });
    return await this.getAdministration();
  }

  private async recordPolicyDeny(
    input: {
      publisherId: string;
      keyId?: string;
      publicKeyFingerprint: string;
    },
    reason: string | null,
  ): Promise<void> {
    await this.mutate((store) => {
      appendAudit(store, this.now(), {
        operation: 'policy-deny',
        publisherId: input.publisherId,
        keyId: input.keyId ?? null,
        publicKeyFingerprint: input.publicKeyFingerprint,
        reason,
      });
    });
  }
}

function migrateLegacyStore(raw: unknown, now: number): TrustStore {
  const legacy = legacyTrustStoreSchema.safeParse(raw);
  if (!legacy.success) {
    throw new Error('Generated app package trust store is invalid');
  }
  return trustStoreSchema.parse({
    version: 2,
    entries: legacy.data.entries,
    policy: { ...DEFAULT_POLICY, updatedAt: new Date(now).toISOString() },
    audit: [],
  });
}

function appendAudit(
  store: TrustStore,
  now: number,
  input: Omit<z.input<typeof auditEventSchema>, 'id' | 'at'>,
): void {
  store.audit.push(
    auditEventSchema.parse({
      id: randomUUID(),
      at: new Date(now).toISOString(),
      ...input,
    }),
  );
  if (store.audit.length > 1_000) {
    store.audit.splice(0, store.audit.length - 1_000);
  }
}

function evaluateStoredPolicy(
  policy: GeneratedAppPublisherPolicy,
  input: { publisherId: string; publicKeyFingerprint: string },
): GeneratedAppPublisherPolicyDecision {
  if (policy.mode === 'allow-all') return { allowed: true, reason: null };
  if (
    policy.allowedPublisherIds.includes(input.publisherId) ||
    policy.allowedPublicKeyFingerprints.includes(input.publicKeyFingerprint)
  ) {
    return { allowed: true, reason: null };
  }
  return {
    allowed: false,
    reason: `Publisher "${input.publisherId}" is not allowed by organization policy.`,
  };
}
