import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import type { ModelBudgetPolicy } from '@clodex/agent-core/model-fabric';
import { modelBudgetPoliciesSchema } from '@shared/model-fabric-inspector';
import { z } from 'zod';

export interface ManagedModelFabricBudgetPolicies {
  source: 'environment' | 'signed-file' | 'control-plane';
  policies: ModelBudgetPolicy[];
  error: string | null;
  cached?: boolean;
  revision?: number;
  keysetRevision?: number;
  signingKeyId?: string;
  rootsetRevision?: number;
  rootSigningKeyId?: string;
  activeRootCount?: number;
  revokedRootCount?: number;
  expiresAt?: number;
  failureClass?: 'transient' | 'security' | 'configuration';
}

const MAX_SIGNED_POLICY_BYTES = 256 * 1024;
const MAX_CONTROL_PLANE_CACHE_BYTES = MAX_SIGNED_POLICY_BYTES * 5;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const MIN_REFRESH_INTERVAL_MS = 5_000;
const MAX_REFRESH_INTERVAL_MS = 60 * 60_000;
const DEFAULT_MAX_REFRESH_BACKOFF_MS = 15 * 60_000;

const signedPolicyEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    keyId: z.string().trim().min(1).max(256),
    revision: z.number().int().nonnegative().optional(),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    policies: modelBudgetPoliciesSchema,
    signature: z.string().trim().min(1).max(16_384),
  })
  .strict();

const controlPlanePolicyEnvelopeSchema = signedPolicyEnvelopeSchema.extend({
  revision: z.number().int().nonnegative(),
});

const modelFabricSigningKeySchema = z
  .object({
    keyId: z.string().trim().min(1).max(256),
    publicKey: z.string().trim().min(1).max(16_384),
    status: z.enum(['active', 'revoked']),
    notBefore: z.number().int().nonnegative(),
    notAfter: z.number().int().positive(),
  })
  .strict()
  .superRefine((key, context) => {
    if (key.notAfter <= key.notBefore) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['notAfter'],
        message: 'Signing key validity window is invalid',
      });
    }
  });

const signedModelFabricKeysetSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    keys: z.array(modelFabricSigningKeySchema).min(1).max(64),
    signature: z.string().trim().min(1).max(16_384),
  })
  .strict()
  .superRefine((keyset, context) => {
    if (keyset.expiresAt <= keyset.issuedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Signing keyset validity window is invalid',
      });
    }
    const seen = new Set<string>();
    for (let index = 0; index < keyset.keys.length; index += 1) {
      const keyId = keyset.keys[index]!.keyId;
      if (seen.has(keyId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['keys', index, 'keyId'],
          message: `Duplicate signing key id: ${keyId}`,
        });
      }
      seen.add(keyId);
    }
  });

const modelFabricRootKeySchema = z
  .object({
    keyId: z.string().trim().min(1).max(256),
    publicKey: z.string().trim().min(1).max(16_384),
    status: z.enum(['active', 'revoked']),
    notBefore: z.number().int().nonnegative(),
    notAfter: z.number().int().positive(),
  })
  .strict()
  .superRefine((key, context) => {
    if (key.notAfter <= key.notBefore) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['notAfter'],
        message: 'Root key validity window is invalid',
      });
    }
  });

const signedModelFabricRootsetSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    signedBy: z.string().trim().min(1).max(256),
    roots: z.array(modelFabricRootKeySchema).min(1).max(32),
    signature: z.string().trim().min(1).max(16_384),
  })
  .strict()
  .superRefine((rootset, context) => {
    if (rootset.expiresAt <= rootset.issuedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Rootset validity window is invalid',
      });
    }
    const seen = new Set<string>();
    for (let index = 0; index < rootset.roots.length; index += 1) {
      const keyId = rootset.roots[index]!.keyId;
      if (seen.has(keyId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['roots', index, 'keyId'],
          message: `Duplicate root key id: ${keyId}`,
        });
      }
      seen.add(keyId);
    }
  });

const crossSignedModelFabricKeysetSchema = z
  .object({
    schemaVersion: z.literal(2),
    rootKeyId: z.string().trim().min(1).max(256),
    revision: z.number().int().nonnegative(),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    keys: z.array(modelFabricSigningKeySchema).min(1).max(64),
    signature: z.string().trim().min(1).max(16_384),
  })
  .strict()
  .superRefine((keyset, context) => {
    if (keyset.expiresAt <= keyset.issuedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Signing keyset validity window is invalid',
      });
    }
    const seen = new Set<string>();
    for (let index = 0; index < keyset.keys.length; index += 1) {
      const keyId = keyset.keys[index]!.keyId;
      if (seen.has(keyId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['keys', index, 'keyId'],
          message: `Duplicate signing key id: ${keyId}`,
        });
      }
      seen.add(keyId);
    }
  });

const controlPlaneSnapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    keyset: signedModelFabricKeysetSchema,
    policy: controlPlanePolicyEnvelopeSchema,
  })
  .strict();

const rootsetControlPlaneSnapshotSchema = z
  .object({
    schemaVersion: z.literal(3),
    rootset: signedModelFabricRootsetSchema,
    keyset: crossSignedModelFabricKeysetSchema,
    policy: controlPlanePolicyEnvelopeSchema,
  })
  .strict();

const legacyControlPlaneCacheSchema = z
  .object({
    version: z.literal(1),
    urlHash: z.string().regex(/^[a-f0-9]{64}$/),
    highestRevision: z.number().int().nonnegative(),
    canonicalHash: z.string().regex(/^[a-f0-9]{64}$/),
    fetchedAt: z.number().int().nonnegative(),
    etag: z.string().max(1_024).nullable(),
    envelope: controlPlanePolicyEnvelopeSchema,
  })
  .strict();

const legacyControlPlaneCacheV2Schema = z
  .object({
    version: z.literal(2),
    trustMode: z.literal('legacy-root'),
    urlHash: z.string().regex(/^[a-f0-9]{64}$/),
    highestPolicyRevision: z.number().int().nonnegative(),
    policyCanonicalHash: z.string().regex(/^[a-f0-9]{64}$/),
    fetchedAt: z.number().int().nonnegative(),
    etag: z.string().max(1_024).nullable(),
    quarantined: z.boolean().default(false),
    envelope: controlPlanePolicyEnvelopeSchema,
  })
  .strict();

const keysetControlPlaneCacheV2Schema = z
  .object({
    version: z.literal(2),
    trustMode: z.literal('signed-keyset'),
    urlHash: z.string().regex(/^[a-f0-9]{64}$/),
    highestPolicyRevision: z.number().int().nonnegative(),
    policyCanonicalHash: z.string().regex(/^[a-f0-9]{64}$/),
    highestKeysetRevision: z.number().int().nonnegative(),
    keysetCanonicalHash: z.string().regex(/^[a-f0-9]{64}$/),
    fetchedAt: z.number().int().nonnegative(),
    etag: z.string().max(1_024).nullable(),
    quarantined: z.boolean().default(false),
    snapshot: controlPlaneSnapshotSchema,
  })
  .strict();

const rootsetControlPlaneCacheV3Schema = z
  .object({
    version: z.literal(3),
    trustMode: z.literal('cross-signed-rootset'),
    urlHash: z.string().regex(/^[a-f0-9]{64}$/),
    highestPolicyRevision: z.number().int().nonnegative(),
    policyCanonicalHash: z.string().regex(/^[a-f0-9]{64}$/),
    highestKeysetRevision: z.number().int().nonnegative(),
    keysetCanonicalHash: z.string().regex(/^[a-f0-9]{64}$/),
    highestRootsetRevision: z.number().int().nonnegative(),
    rootsetCanonicalHash: z.string().regex(/^[a-f0-9]{64}$/),
    fetchedAt: z.number().int().nonnegative(),
    etag: z.string().max(1_024).nullable(),
    quarantined: z.boolean().default(false),
    snapshot: rootsetControlPlaneSnapshotSchema,
  })
  .strict();

export interface ResolveSignedModelFabricBudgetPoliciesOptions {
  filePath: string | undefined;
  publicKey: string | undefined;
  now?: () => number;
  readFile?: (filePath: string) => Promise<Buffer>;
}

export interface ResolveControlPlaneModelFabricBudgetPoliciesOptions {
  url: string | undefined;
  publicKey: string | undefined;
  bearerToken?: string | undefined;
  now?: () => number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  readCache?: () => Promise<Buffer | null>;
  writeCache?: (content: Buffer) => Promise<void>;
}

export interface LiveControlPlaneModelFabricPolicyRefresherOptions {
  resolve: (
    signal: AbortSignal,
  ) => Promise<ManagedModelFabricBudgetPolicies | null>;
  onUpdate: (policies: ManagedModelFabricBudgetPolicies) => void;
  refreshIntervalMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

/**
 * Resolves the organization-controlled environment override without ever
 * returning the raw payload. Invalid input remains distinguishable from an
 * absent override so active routing can fail closed.
 */
export function resolveManagedModelFabricBudgetPolicies(
  value: string | undefined,
): ManagedModelFabricBudgetPolicies | null {
  if (!value?.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {
      source: 'environment',
      policies: [],
      error: 'Managed budget policy JSON could not be parsed',
    };
  }

  const result = modelBudgetPoliciesSchema.safeParse(parsed);
  if (!result.success) {
    return {
      source: 'environment',
      policies: [],
      error: 'Managed budget policy configuration failed validation',
    };
  }

  return {
    source: 'environment',
    policies: result.data.map((policy) => ({ ...policy })),
    error: null,
  };
}

/**
 * Loads an Ed25519-signed policy envelope. A configured but invalid source is
 * returned as a managed error rather than falling back to user preferences.
 */
export async function resolveSignedModelFabricBudgetPolicies(
  options: ResolveSignedModelFabricBudgetPoliciesOptions,
): Promise<ManagedModelFabricBudgetPolicies | null> {
  const filePath = options.filePath?.trim();
  if (!filePath) return null;
  if (!options.publicKey?.trim()) {
    return signedPolicyError('Managed signed policy public key is missing');
  }

  let raw: Buffer;
  try {
    raw = await (options.readFile ?? fs.readFile)(filePath);
  } catch {
    return signedPolicyError('Managed signed policy file could not be read');
  }
  if (raw.byteLength > MAX_SIGNED_POLICY_BYTES) {
    return signedPolicyError('Managed signed policy file is too large');
  }
  const verified = verifySignedPolicyEnvelope(
    raw,
    options.publicKey,
    (options.now ?? Date.now)(),
    false,
  );
  if (!verified.ok) return signedPolicyError(verified.error);

  return {
    source: 'signed-file',
    policies: verified.envelope.policies.map((policy) => ({ ...policy })),
    error: null,
  };
}

export async function resolveControlPlaneModelFabricBudgetPolicies(
  options: ResolveControlPlaneModelFabricBudgetPoliciesOptions,
): Promise<ManagedModelFabricBudgetPolicies | null> {
  const rawUrl = options.url?.trim();
  if (!rawUrl) return null;
  if (!options.publicKey?.trim()) {
    return controlPlanePolicyError(
      'Managed control-plane root public key is missing',
      'configuration',
    );
  }

  const url = normalizeControlPlaneUrl(rawUrl);
  if (!url) {
    return controlPlanePolicyError(
      'Managed control-plane URL is invalid',
      'configuration',
    );
  }
  const clock = options.now ?? Date.now;
  const now = clock();
  const urlHash = hashControlPlaneUrl(url);
  const cachedState = await readVerifiedControlPlaneCache(
    options.readCache,
    options.publicKey,
    urlHash,
    now,
  );
  const cached = cachedState?.usable ? cachedState : null;
  const getCurrentlyUsableCache = (): VerifiedControlPlaneCache | null => {
    return cachedState &&
      !cachedState.quarantined &&
      isControlPlaneDocumentUsable(cachedState.document, clock())
      ? cachedState
      : null;
  };
  const timeoutMs = normalizeControlPlaneTimeout(options.timeoutMs ?? 5_000);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    if (cached?.etag) headers['if-none-match'] = cached.etag;
    if (options.bearerToken?.trim()) {
      headers.authorization = `Bearer ${options.bearerToken.trim()}`;
    }
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
    if (response.status === 304) {
      const currentCache = getCurrentlyUsableCache();
      return currentCache
        ? controlPlanePolicySuccess(currentCache.document, true)
        : controlPlanePolicyError(
            'Managed control-plane policy cache is not usable',
            'transient',
          );
    }
    if (!response.ok) {
      if (response.status >= 500 && response.status <= 599) {
        const currentCache = getCurrentlyUsableCache();
        return currentCache
          ? controlPlanePolicySuccess(currentCache.document, true)
          : controlPlanePolicyError(
              'Managed control-plane policy is unavailable offline',
              'transient',
            );
      }
      return await rejectAndQuarantineControlPlaneCache(
        'Managed control-plane policy request was rejected',
        cachedState,
        options.writeCache,
      );
    }

    const raw = await readBoundedResponse(response, MAX_SIGNED_POLICY_BYTES);
    const responseTime = clock();
    const verified = verifyControlPlaneDocument(
      raw,
      options.publicKey,
      responseTime,
      false,
      cachedState,
    );
    if (!verified.ok) {
      return await rejectAndQuarantineControlPlaneCache(
        verified.error,
        cachedState,
        options.writeCache,
      );
    }

    const transitionError = validateControlPlaneTransition(
      cachedState,
      verified.document,
    );
    if (transitionError) {
      return await rejectAndQuarantineControlPlaneCache(
        transitionError,
        cachedState,
        options.writeCache,
      );
    }
    if (!options.writeCache) {
      return controlPlanePolicyError(
        'Managed control-plane cache is unavailable',
      );
    }

    const cache = createControlPlaneCache({
      document: verified.document,
      urlHash,
      fetchedAt: responseTime,
      etag: normalizeEtag(response.headers.get('etag')),
      quarantined: false,
    });
    try {
      await options.writeCache(Buffer.from(JSON.stringify(cache)));
    } catch {
      return await rejectAndQuarantineControlPlaneCache(
        'Managed control-plane policy cache could not be persisted',
        cachedState,
        options.writeCache,
      );
    }
    return controlPlanePolicySuccess(verified.document, false);
  } catch (error) {
    if (error instanceof ControlPlanePolicyResponseError) {
      return await rejectAndQuarantineControlPlaneCache(
        error.message,
        cachedState,
        options.writeCache,
      );
    }
    const currentCache = getCurrentlyUsableCache();
    return currentCache
      ? controlPlanePolicySuccess(currentCache.document, true)
      : controlPlanePolicyError(
          'Managed control-plane policy is unavailable offline',
          'transient',
        );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

/**
 * Verifies one complete control-plane document without performing network or
 * cache I/O. Publication tooling uses this exact runtime trust boundary before
 * emitting a snapshot, preventing the offline signer and the IDE verifier from
 * drifting apart. `authenticatedPreviousContent`, when supplied, must come
 * from a previously verified cache or signed publication-state envelope.
 */
export function verifyControlPlaneModelFabricPolicySnapshot(options: {
  content: Buffer;
  publicKey: string;
  now?: number;
  authenticatedPreviousContent?: Buffer | null;
}): ManagedModelFabricBudgetPolicies {
  return verifyStandaloneControlPlaneModelFabricPolicySnapshot({
    content: options.content,
    publicKey: options.publicKey,
    now: options.now,
    previousContent: options.authenticatedPreviousContent,
    allowExpired: false,
    trustMode: 'remote',
  });
}

/**
 * Verifies a snapshot recovered from an already authenticated outer cache or
 * publication-state envelope. Cache mode intentionally accepts a rotated
 * signer when the pinned root remains in the append-only root history, so raw
 * network or operator input must never be passed to this entry point.
 */
export function verifyAuthenticatedCachedControlPlaneModelFabricPolicySnapshot(options: {
  content: Buffer;
  publicKey: string;
  now?: number;
  allowExpired?: boolean;
}): ManagedModelFabricBudgetPolicies {
  return verifyStandaloneControlPlaneModelFabricPolicySnapshot({
    ...options,
    previousContent: null,
    allowExpired: options.allowExpired ?? true,
    trustMode: 'cache',
  });
}

function verifyStandaloneControlPlaneModelFabricPolicySnapshot(options: {
  content: Buffer;
  publicKey: string;
  now?: number;
  previousContent?: Buffer | null;
  allowExpired: boolean;
  trustMode: 'remote' | 'cache';
}): ManagedModelFabricBudgetPolicies {
  if (
    options.content.byteLength > MAX_SIGNED_POLICY_BYTES ||
    (options.previousContent?.byteLength ?? 0) > MAX_SIGNED_POLICY_BYTES
  ) {
    return controlPlanePolicyError(
      'Managed control-plane response is too large',
      'configuration',
    );
  }
  const now = options.now ?? Date.now();
  let previous: VerifiedControlPlaneCache | null = null;
  if (options.previousContent) {
    const verifiedPrevious = verifyControlPlaneDocument(
      options.previousContent,
      options.publicKey,
      now,
      true,
      null,
      'cache',
    );
    if (!verifiedPrevious.ok) {
      return controlPlanePolicyError(
        `Managed control-plane previous trust snapshot failed verification: ${verifiedPrevious.error}`,
        'security',
      );
    }
    previous = createStandaloneVerifiedControlPlaneCache(
      verifiedPrevious.document,
      now,
    );
  }
  const verified = verifyControlPlaneDocument(
    options.content,
    options.publicKey,
    now,
    options.allowExpired,
    previous,
    options.trustMode,
  );
  if (!verified.ok) {
    return controlPlanePolicyError(verified.error, 'security');
  }
  const transitionError = validateControlPlaneTransition(
    previous,
    verified.document,
  );
  return transitionError
    ? controlPlanePolicyError(transitionError, 'security')
    : controlPlanePolicySuccess(verified.document, false);
}

/**
 * Periodically re-resolves a configured control-plane source. Every accepted
 * update is applied atomically through `onUpdate`; any invalid refresh becomes
 * an explicit managed error so active routing fails closed immediately.
 */
export class LiveControlPlaneModelFabricPolicyRefresher {
  private readonly resolvePolicy: LiveControlPlaneModelFabricPolicyRefresherOptions['resolve'];
  private readonly onUpdate: LiveControlPlaneModelFabricPolicyRefresherOptions['onUpdate'];
  private readonly refreshIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly scheduleCallback: (
    callback: () => void,
    delayMs: number,
  ) => unknown;
  private readonly cancelCallback: (handle: unknown) => void;
  private scheduled: unknown = null;
  private currentAbort: AbortController | null = null;
  private inFlight: Promise<ManagedModelFabricBudgetPolicies> | null = null;
  private inFlightGeneration: number | null = null;
  private inFlightApplyWhenInactive = false;
  private active = false;
  private generation = 0;
  private consecutiveFailures = 0;
  private quarantined = false;

  public constructor(
    options: LiveControlPlaneModelFabricPolicyRefresherOptions,
  ) {
    this.resolvePolicy = options.resolve;
    this.onUpdate = options.onUpdate;
    this.refreshIntervalMs = normalizeRefreshInterval(
      options.refreshIntervalMs,
    );
    this.maxBackoffMs = normalizeMaxRefreshBackoff(
      options.maxBackoffMs,
      this.refreshIntervalMs,
    );
    this.now = options.now ?? Date.now;
    this.scheduleCallback = options.schedule ?? defaultSchedule;
    this.cancelCallback = options.cancelScheduled ?? defaultCancelScheduled;
  }

  public start(initial?: ManagedModelFabricBudgetPolicies): void {
    if (this.active) return;
    this.active = true;
    this.generation += 1;
    this.quarantined =
      initial?.error !== null &&
      initial?.error !== undefined &&
      initial.failureClass !== 'transient';
    this.consecutiveFailures = initial?.error ? 1 : 0;
    this.scheduleNext(
      initial === undefined
        ? this.refreshIntervalMs
        : this.getNextDelay(initial),
    );
  }

  public async refreshNow(): Promise<ManagedModelFabricBudgetPolicies> {
    return await this.refresh(false);
  }

  /**
   * Performs an operator-requested refresh even when periodic refresh is
   * disabled. It applies the same fail-closed/quarantine semantics without
   * enabling the scheduler.
   */
  public async refreshOnce(): Promise<ManagedModelFabricBudgetPolicies> {
    return await this.refresh(true);
  }

  private async refresh(
    applyWhenInactive: boolean,
  ): Promise<ManagedModelFabricBudgetPolicies> {
    if (this.inFlight) {
      if (
        applyWhenInactive &&
        this.inFlightGeneration !== null &&
        this.inFlightGeneration !== this.generation
      ) {
        await this.inFlight;
        return await this.refresh(true);
      }
      if (applyWhenInactive) this.inFlightApplyWhenInactive = true;
      return await this.inFlight;
    }
    this.cancelNext();
    const generation = this.generation;
    const controller = new AbortController();
    this.currentAbort = controller;
    this.inFlightGeneration = generation;
    this.inFlightApplyWhenInactive = applyWhenInactive;
    let resolved: ManagedModelFabricBudgetPolicies | null = null;

    const operation = (async () => {
      try {
        resolved = await this.resolvePolicy(controller.signal);
      } catch {
        resolved = null;
      }
      let result =
        resolved ??
        controlPlanePolicyError(
          'Managed control-plane policy refresh failed closed',
          'transient',
        );
      if (
        generation === this.generation &&
        (this.active || this.inFlightApplyWhenInactive)
      ) {
        if (result.error && result.failureClass !== 'transient') {
          this.quarantined = true;
        } else if (!result.error && !result.cached) {
          this.quarantined = false;
        } else if (!result.error && result.cached && this.quarantined) {
          result = controlPlanePolicyError(
            'Managed control-plane policy remains quarantined pending a valid remote revision',
            'security',
          );
        }
        resolved = result;
        this.consecutiveFailures = result.error
          ? this.consecutiveFailures + 1
          : 0;
        try {
          this.onUpdate(result);
        } catch {
          // A diagnostics or logging sink must not stop future refreshes.
        }
      }
      return result;
    })();
    this.inFlight = operation;

    try {
      return await operation;
    } finally {
      if (this.inFlight === operation) this.inFlight = null;
      if (this.inFlightGeneration === generation) {
        this.inFlightGeneration = null;
      }
      if (this.currentAbort === controller) this.currentAbort = null;
      this.inFlightApplyWhenInactive = false;
      if (this.active && generation === this.generation) {
        this.scheduleNext(this.getNextDelay(resolved));
      }
    }
  }

  public teardown(): void {
    if (!this.active && !this.currentAbort && this.scheduled === null) {
      return;
    }
    this.active = false;
    this.generation += 1;
    this.cancelNext();
    this.currentAbort?.abort();
    this.currentAbort = null;
  }

  private scheduleNext(delayMs: number): void {
    if (!this.active) return;
    this.cancelNext();
    this.scheduled = this.scheduleCallback(() => {
      this.scheduled = null;
      void this.refreshNow();
    }, delayMs);
  }

  private cancelNext(): void {
    if (this.scheduled === null) return;
    this.cancelCallback(this.scheduled);
    this.scheduled = null;
  }

  private getNextDelay(
    result: ManagedModelFabricBudgetPolicies | null,
  ): number {
    if (!result || result.error) {
      const multiplier = 2 ** Math.min(this.consecutiveFailures - 1, 10);
      return Math.min(
        this.maxBackoffMs,
        this.refreshIntervalMs * Math.max(1, multiplier),
      );
    }
    if (!result.expiresAt) return this.refreshIntervalMs;
    const remaining = result.expiresAt - this.now();
    if (remaining <= 1_000) return 1_000;
    const refreshLead = Math.min(
      30_000,
      Math.max(1_000, Math.floor(remaining / 4)),
    );
    return Math.max(
      1_000,
      Math.min(this.refreshIntervalMs, remaining - refreshLead),
    );
  }
}

export function canonicalizeSignedModelFabricPolicy(input: {
  schemaVersion: 1;
  keyId: string;
  revision?: number;
  issuedAt: number;
  expiresAt: number;
  policies: readonly ModelBudgetPolicy[];
}): string {
  return JSON.stringify({
    schemaVersion: input.schemaVersion,
    keyId: input.keyId.trim(),
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    policies: input.policies.map((policy) => ({
      id: policy.id,
      scope: policy.scope,
      scopeRef: policy.scopeRef,
      windowMs: policy.windowMs,
      limitUsd: policy.limitUsd,
      mode: policy.mode,
    })),
  });
}

export function canonicalizeSignedModelFabricKeyset(input: {
  schemaVersion: 1;
  revision: number;
  issuedAt: number;
  expiresAt: number;
  keys: readonly {
    keyId: string;
    publicKey: string;
    status: 'active' | 'revoked';
    notBefore: number;
    notAfter: number;
  }[];
}): string {
  return JSON.stringify({
    schemaVersion: input.schemaVersion,
    revision: input.revision,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    keys: [...input.keys]
      .sort((left, right) =>
        left.keyId.trim().localeCompare(right.keyId.trim()),
      )
      .map((key) => ({
        keyId: key.keyId.trim(),
        publicKey: key.publicKey.trim(),
        status: key.status,
        notBefore: key.notBefore,
        notAfter: key.notAfter,
      })),
  });
}

export function canonicalizeCrossSignedModelFabricKeyset(input: {
  schemaVersion: 2;
  rootKeyId: string;
  revision: number;
  issuedAt: number;
  expiresAt: number;
  keys: readonly {
    keyId: string;
    publicKey: string;
    status: 'active' | 'revoked';
    notBefore: number;
    notAfter: number;
  }[];
}): string {
  return JSON.stringify({
    schemaVersion: input.schemaVersion,
    rootKeyId: input.rootKeyId.trim(),
    revision: input.revision,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    keys: [...input.keys]
      .sort((left, right) =>
        left.keyId.trim().localeCompare(right.keyId.trim()),
      )
      .map((key) => ({
        keyId: key.keyId.trim(),
        publicKey: key.publicKey.trim(),
        status: key.status,
        notBefore: key.notBefore,
        notAfter: key.notAfter,
      })),
  });
}

export function canonicalizeSignedModelFabricRootset(input: {
  schemaVersion: 1;
  revision: number;
  issuedAt: number;
  expiresAt: number;
  signedBy: string;
  roots: readonly {
    keyId: string;
    publicKey: string;
    status: 'active' | 'revoked';
    notBefore: number;
    notAfter: number;
  }[];
}): string {
  return JSON.stringify({
    schemaVersion: input.schemaVersion,
    revision: input.revision,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    signedBy: input.signedBy.trim(),
    roots: [...input.roots]
      .sort((left, right) =>
        left.keyId.trim().localeCompare(right.keyId.trim()),
      )
      .map((key) => ({
        keyId: key.keyId.trim(),
        publicKey: key.publicKey.trim(),
        status: key.status,
        notBefore: key.notBefore,
        notAfter: key.notAfter,
      })),
  });
}

type SignedPolicyEnvelope = z.infer<typeof signedPolicyEnvelopeSchema>;
type ControlPlanePolicyEnvelope = z.infer<
  typeof controlPlanePolicyEnvelopeSchema
>;
type ModelFabricSigningKey = z.infer<typeof modelFabricSigningKeySchema>;
type SignedModelFabricKeyset = z.infer<typeof signedModelFabricKeysetSchema>;
type ControlPlaneSnapshot = z.infer<typeof controlPlaneSnapshotSchema>;
type ModelFabricRootKey = z.infer<typeof modelFabricRootKeySchema>;
type SignedModelFabricRootset = z.infer<typeof signedModelFabricRootsetSchema>;
type CrossSignedModelFabricKeyset = z.infer<
  typeof crossSignedModelFabricKeysetSchema
>;
type RootsetControlPlaneSnapshot = z.infer<
  typeof rootsetControlPlaneSnapshotSchema
>;

type VerifiedControlPlaneDocument =
  | {
      format: 'legacy-root';
      policy: ControlPlanePolicyEnvelope;
    }
  | {
      format: 'signed-keyset';
      policy: ControlPlanePolicyEnvelope;
      keyset: SignedModelFabricKeyset;
      signingKey: ModelFabricSigningKey;
    }
  | {
      format: 'cross-signed-rootset';
      policy: ControlPlanePolicyEnvelope;
      keyset: CrossSignedModelFabricKeyset;
      signingKey: ModelFabricSigningKey;
      rootset: SignedModelFabricRootset;
      rootSigningKey: ModelFabricRootKey;
      rootsetSigningKey: ModelFabricRootKey;
    };

interface VerifiedControlPlaneCache {
  urlHash: string;
  fetchedAt: number;
  etag: string | null;
  highestPolicyRevision: number;
  policyCanonicalHash: string;
  highestKeysetRevision: number | null;
  keysetCanonicalHash: string | null;
  highestRootsetRevision: number | null;
  rootsetCanonicalHash: string | null;
  document: VerifiedControlPlaneDocument;
  quarantined: boolean;
  usable: boolean;
}

class ControlPlanePolicyResponseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ControlPlanePolicyResponseError';
  }
}

function verifySignedPolicyEnvelope(
  raw: Buffer,
  publicKey: string,
  now: number,
  requireRevision: boolean,
  allowExpired = false,
): { ok: true; envelope: SignedPolicyEnvelope } | { ok: false; error: string } {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.toString('utf8'));
  } catch {
    return {
      ok: false,
      error: 'Managed signed policy JSON could not be parsed',
    };
  }
  const parsed = signedPolicyEnvelopeSchema.safeParse(parsedJson);
  if (
    !parsed.success ||
    (requireRevision && parsed.data.revision === undefined)
  ) {
    return {
      ok: false,
      error: 'Managed signed policy configuration failed validation',
    };
  }
  return verifyPolicyEnvelope(parsed.data, publicKey, now, allowExpired);
}

function verifyPolicyEnvelope<T extends SignedPolicyEnvelope>(
  envelope: T,
  publicKey: string,
  now: number,
  allowExpired: boolean,
): { ok: true; envelope: T } | { ok: false; error: string } {
  if (envelope.issuedAt > now + MAX_CLOCK_SKEW_MS) {
    return { ok: false, error: 'Managed signed policy is not valid yet' };
  }
  if (!allowExpired && envelope.expiresAt <= now) {
    return { ok: false, error: 'Managed signed policy has expired' };
  }
  if (envelope.expiresAt <= envelope.issuedAt) {
    return {
      ok: false,
      error: 'Managed signed policy validity window is invalid',
    };
  }
  const signature = decodeCanonicalBase64(envelope.signature);
  if (!signature) {
    return {
      ok: false,
      error: 'Managed signed policy signature is invalid',
    };
  }
  try {
    if (
      !verify(
        null,
        Buffer.from(canonicalizeSignedModelFabricPolicy(envelope)),
        publicKey,
        signature,
      )
    ) {
      return {
        ok: false,
        error: 'Managed signed policy signature verification failed',
      };
    }
  } catch {
    return {
      ok: false,
      error: 'Managed signed policy signature verification failed',
    };
  }
  return { ok: true, envelope };
}

function verifyControlPlaneDocument(
  raw: Buffer,
  rootPublicKey: string,
  now: number,
  allowExpired = false,
  previous: VerifiedControlPlaneCache | null = null,
  mode: 'remote' | 'cache' = 'remote',
):
  | { ok: true; document: VerifiedControlPlaneDocument }
  | { ok: false; error: string } {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.toString('utf8'));
  } catch {
    return {
      ok: false,
      error: 'Managed signed policy JSON could not be parsed',
    };
  }

  const rootsetSnapshot =
    rootsetControlPlaneSnapshotSchema.safeParse(parsedJson);
  if (rootsetSnapshot.success) {
    return verifyRootsetControlPlaneSnapshot(
      rootsetSnapshot.data,
      rootPublicKey,
      previous,
      now,
      allowExpired,
      mode,
    );
  }

  const keysetSnapshot = controlPlaneSnapshotSchema.safeParse(parsedJson);
  if (keysetSnapshot.success) {
    return verifyControlPlaneSnapshot(
      keysetSnapshot.data,
      rootPublicKey,
      now,
      allowExpired,
    );
  }
  if (
    parsedJson !== null &&
    typeof parsedJson === 'object' &&
    'schemaVersion' in parsedJson &&
    ((parsedJson as { schemaVersion?: unknown }).schemaVersion === 2 ||
      (parsedJson as { schemaVersion?: unknown }).schemaVersion === 3)
  ) {
    return {
      ok: false,
      error: 'Managed control-plane trust document failed validation',
    };
  }

  const legacy = controlPlanePolicyEnvelopeSchema.safeParse(parsedJson);
  if (!legacy.success) {
    return {
      ok: false,
      error: 'Managed signed policy configuration failed validation',
    };
  }
  const verified = verifyPolicyEnvelope(
    legacy.data,
    rootPublicKey,
    now,
    allowExpired,
  );
  return verified.ok
    ? {
        ok: true,
        document: { format: 'legacy-root', policy: verified.envelope },
      }
    : verified;
}

function verifyControlPlaneSnapshot(
  snapshot: ControlPlaneSnapshot,
  rootPublicKey: string,
  now: number,
  allowExpired: boolean,
):
  | { ok: true; document: VerifiedControlPlaneDocument }
  | { ok: false; error: string } {
  const verifiedKeyset = verifyModelFabricKeyset(
    snapshot.keyset,
    rootPublicKey,
    now,
    allowExpired,
  );
  if (!verifiedKeyset.ok) return verifiedKeyset;

  const delegated = verifyDelegatedPolicyEnvelope(
    snapshot.keyset,
    snapshot.policy,
    now,
    allowExpired,
  );
  if (!delegated.ok) return delegated;
  return {
    ok: true,
    document: {
      format: 'signed-keyset',
      policy: delegated.policy,
      keyset: verifiedKeyset.keyset,
      signingKey: delegated.signingKey,
    },
  };
}

function verifyRootsetControlPlaneSnapshot(
  snapshot: RootsetControlPlaneSnapshot,
  pinnedRootPublicKey: string,
  previous: VerifiedControlPlaneCache | null,
  now: number,
  allowExpired: boolean,
  mode: 'remote' | 'cache',
):
  | { ok: true; document: VerifiedControlPlaneDocument }
  | { ok: false; error: string } {
  const verifiedRootset = verifyModelFabricRootset(
    snapshot.rootset,
    pinnedRootPublicKey,
    previous,
    now,
    allowExpired,
    mode,
  );
  if (!verifiedRootset.ok) return verifiedRootset;

  const rootSigningKey = snapshot.rootset.roots.find(
    (root) => root.keyId === snapshot.keyset.rootKeyId,
  );
  if (!rootSigningKey) {
    return {
      ok: false,
      error: 'Managed control-plane keyset root signing key is not trusted',
    };
  }
  if (rootSigningKey.status === 'revoked') {
    return {
      ok: false,
      error: 'Managed control-plane keyset root signing key is revoked',
    };
  }
  if (
    snapshot.keyset.issuedAt < rootSigningKey.notBefore ||
    snapshot.keyset.expiresAt > rootSigningKey.notAfter ||
    snapshot.keyset.expiresAt > snapshot.rootset.expiresAt
  ) {
    return {
      ok: false,
      error: 'Managed control-plane keyset exceeds root trust validity',
    };
  }
  if (
    !allowExpired &&
    (rootSigningKey.notBefore > now + MAX_CLOCK_SKEW_MS ||
      rootSigningKey.notAfter <= now)
  ) {
    return {
      ok: false,
      error: 'Managed control-plane keyset root signing key is not active',
    };
  }

  const verifiedKeyset = verifyCrossSignedModelFabricKeyset(
    snapshot.keyset,
    rootSigningKey.publicKey,
    now,
    allowExpired,
  );
  if (!verifiedKeyset.ok) return verifiedKeyset;

  const delegated = verifyDelegatedPolicyEnvelope(
    snapshot.keyset,
    snapshot.policy,
    now,
    allowExpired,
  );
  if (!delegated.ok) return delegated;
  return {
    ok: true,
    document: {
      format: 'cross-signed-rootset',
      policy: delegated.policy,
      keyset: verifiedKeyset.keyset,
      signingKey: delegated.signingKey,
      rootset: verifiedRootset.rootset,
      rootSigningKey,
      rootsetSigningKey: verifiedRootset.signingKey,
    },
  };
}

function verifyDelegatedPolicyEnvelope(
  keyset: Pick<
    SignedModelFabricKeyset | CrossSignedModelFabricKeyset,
    'keys' | 'expiresAt'
  >,
  policy: ControlPlanePolicyEnvelope,
  now: number,
  allowExpired: boolean,
):
  | {
      ok: true;
      policy: ControlPlanePolicyEnvelope;
      signingKey: ModelFabricSigningKey;
    }
  | { ok: false; error: string } {
  const signingKey = keyset.keys.find((key) => key.keyId === policy.keyId);
  if (!signingKey) {
    return {
      ok: false,
      error: 'Managed control-plane policy signing key is not trusted',
    };
  }
  if (signingKey.status === 'revoked') {
    return {
      ok: false,
      error: 'Managed control-plane policy signing key is revoked',
    };
  }
  if (
    policy.issuedAt < signingKey.notBefore ||
    policy.expiresAt > signingKey.notAfter ||
    policy.expiresAt > keyset.expiresAt
  ) {
    return {
      ok: false,
      error: 'Managed control-plane policy exceeds signing trust validity',
    };
  }
  if (
    !allowExpired &&
    (signingKey.notBefore > now + MAX_CLOCK_SKEW_MS ||
      signingKey.notAfter <= now)
  ) {
    return {
      ok: false,
      error: 'Managed control-plane policy signing key is not active',
    };
  }
  const verifiedPolicy = verifyPolicyEnvelope(
    policy,
    signingKey.publicKey,
    now,
    allowExpired,
  );
  return verifiedPolicy.ok
    ? {
        ok: true,
        policy: verifiedPolicy.envelope,
        signingKey,
      }
    : verifiedPolicy;
}

function verifyModelFabricRootset(
  rootset: SignedModelFabricRootset,
  pinnedRootPublicKey: string,
  previous: VerifiedControlPlaneCache | null,
  now: number,
  allowExpired: boolean,
  mode: 'remote' | 'cache',
):
  | {
      ok: true;
      rootset: SignedModelFabricRootset;
      signingKey: ModelFabricRootKey;
    }
  | { ok: false; error: string } {
  if (rootset.issuedAt > now + MAX_CLOCK_SKEW_MS) {
    return {
      ok: false,
      error: 'Managed control-plane rootset is not valid yet',
    };
  }
  if (!allowExpired && rootset.expiresAt <= now) {
    return { ok: false, error: 'Managed control-plane rootset has expired' };
  }
  const pinnedFingerprint = getEd25519PublicKeyFingerprint(pinnedRootPublicKey);
  if (!pinnedFingerprint) {
    return {
      ok: false,
      error: 'Managed control-plane pinned root public key is invalid',
    };
  }
  const rootFingerprints = new Map<string, string>();
  for (const root of rootset.roots) {
    const fingerprint = getEd25519PublicKeyFingerprint(root.publicKey);
    if (!fingerprint) {
      return {
        ok: false,
        error:
          'Managed control-plane rootset contains an invalid Ed25519 public key',
      };
    }
    rootFingerprints.set(root.keyId, fingerprint);
  }

  const previousRootset =
    previous?.document.format === 'cross-signed-rootset'
      ? previous.document.rootset
      : null;
  const isExactReplay =
    previousRootset !== null &&
    rootset.revision === previousRootset.revision &&
    hashCanonicalRootset(rootset) === previous?.rootsetCanonicalHash;
  let signingKey: ModelFabricRootKey | undefined;

  if (mode === 'cache') {
    if (![...rootFingerprints.values()].includes(pinnedFingerprint)) {
      return {
        ok: false,
        error: 'Managed control-plane cached rootset lost its pinned anchor',
      };
    }
    signingKey = rootset.roots.find((root) => root.keyId === rootset.signedBy);
  } else if (previousRootset) {
    signingKey = previousRootset.roots.find(
      (root) => root.keyId === rootset.signedBy,
    );
    if (!signingKey || (!isExactReplay && signingKey.status !== 'active')) {
      return {
        ok: false,
        error:
          'Managed control-plane rootset signer was not active in the previous rootset',
      };
    }
    if (!isExactReplay && rootset.issuedAt > previousRootset.expiresAt) {
      return {
        ok: false,
        error: 'Managed control-plane rootset exceeded prior trust validity',
      };
    }
  } else {
    signingKey = rootset.roots.find((root) => root.keyId === rootset.signedBy);
    if (
      !signingKey ||
      rootFingerprints.get(signingKey.keyId) !== pinnedFingerprint
    ) {
      return {
        ok: false,
        error:
          'Managed control-plane initial rootset is not signed by the pinned root',
      };
    }
  }

  if (!signingKey) {
    return {
      ok: false,
      error: 'Managed control-plane rootset signing key is not trusted',
    };
  }
  if (
    rootset.issuedAt < signingKey.notBefore ||
    rootset.issuedAt >= signingKey.notAfter
  ) {
    return {
      ok: false,
      error: 'Managed control-plane rootset exceeds signer validity',
    };
  }
  const signature = decodeCanonicalBase64(rootset.signature);
  if (!signature) {
    return {
      ok: false,
      error: 'Managed control-plane rootset signature is invalid',
    };
  }
  try {
    if (
      !verify(
        null,
        Buffer.from(canonicalizeSignedModelFabricRootset(rootset)),
        signingKey.publicKey,
        signature,
      )
    ) {
      return {
        ok: false,
        error: 'Managed control-plane rootset signature verification failed',
      };
    }
  } catch {
    return {
      ok: false,
      error: 'Managed control-plane rootset signature verification failed',
    };
  }
  return { ok: true, rootset, signingKey };
}

function verifyModelFabricKeyset(
  keyset: SignedModelFabricKeyset,
  rootPublicKey: string,
  now: number,
  allowExpired: boolean,
):
  | { ok: true; keyset: SignedModelFabricKeyset }
  | { ok: false; error: string } {
  if (keyset.issuedAt > now + MAX_CLOCK_SKEW_MS) {
    return {
      ok: false,
      error: 'Managed control-plane signing keyset is not valid yet',
    };
  }
  if (!allowExpired && keyset.expiresAt <= now) {
    return {
      ok: false,
      error: 'Managed control-plane signing keyset has expired',
    };
  }
  if (!hasOnlyValidEd25519Keys(keyset.keys)) {
    return {
      ok: false,
      error:
        'Managed control-plane signing keyset contains an invalid Ed25519 public key',
    };
  }
  const signature = decodeCanonicalBase64(keyset.signature);
  if (!signature) {
    return {
      ok: false,
      error: 'Managed control-plane signing keyset signature is invalid',
    };
  }
  try {
    if (
      !verify(
        null,
        Buffer.from(canonicalizeSignedModelFabricKeyset(keyset)),
        rootPublicKey,
        signature,
      )
    ) {
      return {
        ok: false,
        error:
          'Managed control-plane signing keyset signature verification failed',
      };
    }
  } catch {
    return {
      ok: false,
      error:
        'Managed control-plane signing keyset signature verification failed',
    };
  }
  return { ok: true, keyset };
}

function verifyCrossSignedModelFabricKeyset(
  keyset: CrossSignedModelFabricKeyset,
  rootPublicKey: string,
  now: number,
  allowExpired: boolean,
):
  | { ok: true; keyset: CrossSignedModelFabricKeyset }
  | { ok: false; error: string } {
  if (keyset.issuedAt > now + MAX_CLOCK_SKEW_MS) {
    return {
      ok: false,
      error: 'Managed control-plane signing keyset is not valid yet',
    };
  }
  if (!allowExpired && keyset.expiresAt <= now) {
    return {
      ok: false,
      error: 'Managed control-plane signing keyset has expired',
    };
  }
  if (!hasOnlyValidEd25519Keys(keyset.keys)) {
    return {
      ok: false,
      error:
        'Managed control-plane signing keyset contains an invalid Ed25519 public key',
    };
  }
  const signature = decodeCanonicalBase64(keyset.signature);
  if (!signature) {
    return {
      ok: false,
      error: 'Managed control-plane signing keyset signature is invalid',
    };
  }
  try {
    if (
      !verify(
        null,
        Buffer.from(canonicalizeCrossSignedModelFabricKeyset(keyset)),
        rootPublicKey,
        signature,
      )
    ) {
      return {
        ok: false,
        error:
          'Managed control-plane signing keyset signature verification failed',
      };
    }
  } catch {
    return {
      ok: false,
      error:
        'Managed control-plane signing keyset signature verification failed',
    };
  }
  return { ok: true, keyset };
}

async function readVerifiedControlPlaneCache(
  readCache: (() => Promise<Buffer | null>) | undefined,
  rootPublicKey: string,
  urlHash: string,
  now: number,
): Promise<VerifiedControlPlaneCache | null> {
  if (!readCache) return null;
  try {
    const raw = await readCache();
    if (!raw || raw.byteLength > MAX_CONTROL_PLANE_CACHE_BYTES) return null;
    const parsedJson: unknown = JSON.parse(raw.toString('utf8'));

    const legacyV1 = legacyControlPlaneCacheSchema.safeParse(parsedJson);
    if (legacyV1.success && legacyV1.data.urlHash === urlHash) {
      const document = verifyControlPlaneDocument(
        Buffer.from(JSON.stringify(legacyV1.data.envelope)),
        rootPublicKey,
        now,
        true,
      );
      if (!document.ok || document.document.format !== 'legacy-root') {
        return null;
      }
      const policyHash = hashCanonicalPolicy(document.document.policy);
      if (
        document.document.policy.revision !== legacyV1.data.highestRevision ||
        policyHash !== legacyV1.data.canonicalHash
      ) {
        return null;
      }
      return createVerifiedCacheState({
        urlHash,
        fetchedAt: legacyV1.data.fetchedAt,
        etag: legacyV1.data.etag,
        highestPolicyRevision: legacyV1.data.highestRevision,
        policyCanonicalHash: policyHash,
        document: document.document,
        now,
      });
    }

    const legacyV2 = legacyControlPlaneCacheV2Schema.safeParse(parsedJson);
    if (legacyV2.success && legacyV2.data.urlHash === urlHash) {
      const document = verifyControlPlaneDocument(
        Buffer.from(JSON.stringify(legacyV2.data.envelope)),
        rootPublicKey,
        now,
        true,
      );
      if (!document.ok || document.document.format !== 'legacy-root') {
        return null;
      }
      const policyHash = hashCanonicalPolicy(document.document.policy);
      if (
        document.document.policy.revision !==
          legacyV2.data.highestPolicyRevision ||
        policyHash !== legacyV2.data.policyCanonicalHash
      ) {
        return null;
      }
      return createVerifiedCacheState({
        urlHash,
        fetchedAt: legacyV2.data.fetchedAt,
        etag: legacyV2.data.etag,
        highestPolicyRevision: legacyV2.data.highestPolicyRevision,
        policyCanonicalHash: policyHash,
        quarantined: legacyV2.data.quarantined,
        document: document.document,
        now,
      });
    }

    const rootsetV3 = rootsetControlPlaneCacheV3Schema.safeParse(parsedJson);
    if (rootsetV3.success && rootsetV3.data.urlHash === urlHash) {
      const document = verifyControlPlaneDocument(
        Buffer.from(JSON.stringify(rootsetV3.data.snapshot)),
        rootPublicKey,
        now,
        true,
        null,
        'cache',
      );
      if (!document.ok || document.document.format !== 'cross-signed-rootset') {
        return null;
      }
      const policyHash = hashCanonicalPolicy(document.document.policy);
      const keysetHash = hashCanonicalCrossSignedKeyset(
        document.document.keyset,
      );
      const rootsetHash = hashCanonicalRootset(document.document.rootset);
      if (
        document.document.policy.revision !==
          rootsetV3.data.highestPolicyRevision ||
        policyHash !== rootsetV3.data.policyCanonicalHash ||
        document.document.keyset.revision !==
          rootsetV3.data.highestKeysetRevision ||
        keysetHash !== rootsetV3.data.keysetCanonicalHash ||
        document.document.rootset.revision !==
          rootsetV3.data.highestRootsetRevision ||
        rootsetHash !== rootsetV3.data.rootsetCanonicalHash
      ) {
        return null;
      }
      return createVerifiedCacheState({
        urlHash,
        fetchedAt: rootsetV3.data.fetchedAt,
        etag: rootsetV3.data.etag,
        highestPolicyRevision: rootsetV3.data.highestPolicyRevision,
        policyCanonicalHash: policyHash,
        highestKeysetRevision: rootsetV3.data.highestKeysetRevision,
        keysetCanonicalHash: keysetHash,
        highestRootsetRevision: rootsetV3.data.highestRootsetRevision,
        rootsetCanonicalHash: rootsetHash,
        quarantined: rootsetV3.data.quarantined,
        document: document.document,
        now,
      });
    }

    const keysetV2 = keysetControlPlaneCacheV2Schema.safeParse(parsedJson);
    if (!keysetV2.success || keysetV2.data.urlHash !== urlHash) return null;
    const document = verifyControlPlaneDocument(
      Buffer.from(JSON.stringify(keysetV2.data.snapshot)),
      rootPublicKey,
      now,
      true,
    );
    if (!document.ok || document.document.format !== 'signed-keyset') {
      return null;
    }
    const policyHash = hashCanonicalPolicy(document.document.policy);
    const keysetHash = hashCanonicalKeyset(document.document.keyset);
    if (
      document.document.policy.revision !==
        keysetV2.data.highestPolicyRevision ||
      policyHash !== keysetV2.data.policyCanonicalHash ||
      document.document.keyset.revision !==
        keysetV2.data.highestKeysetRevision ||
      keysetHash !== keysetV2.data.keysetCanonicalHash
    ) {
      return null;
    }
    return createVerifiedCacheState({
      urlHash,
      fetchedAt: keysetV2.data.fetchedAt,
      etag: keysetV2.data.etag,
      highestPolicyRevision: keysetV2.data.highestPolicyRevision,
      policyCanonicalHash: policyHash,
      highestKeysetRevision: keysetV2.data.highestKeysetRevision,
      keysetCanonicalHash: keysetHash,
      quarantined: keysetV2.data.quarantined,
      document: document.document,
      now,
    });
  } catch {
    return null;
  }
}

function createVerifiedCacheState(input: {
  urlHash: string;
  fetchedAt: number;
  etag: string | null;
  highestPolicyRevision: number;
  policyCanonicalHash: string;
  highestKeysetRevision?: number;
  keysetCanonicalHash?: string;
  highestRootsetRevision?: number;
  rootsetCanonicalHash?: string;
  quarantined?: boolean;
  document: VerifiedControlPlaneDocument;
  now: number;
}): VerifiedControlPlaneCache {
  return {
    urlHash: input.urlHash,
    fetchedAt: input.fetchedAt,
    etag: input.etag,
    highestPolicyRevision: input.highestPolicyRevision,
    policyCanonicalHash: input.policyCanonicalHash,
    highestKeysetRevision: input.highestKeysetRevision ?? null,
    keysetCanonicalHash: input.keysetCanonicalHash ?? null,
    highestRootsetRevision: input.highestRootsetRevision ?? null,
    rootsetCanonicalHash: input.rootsetCanonicalHash ?? null,
    document: input.document,
    quarantined: input.quarantined ?? false,
    usable:
      !(input.quarantined ?? false) &&
      isControlPlaneDocumentUsable(input.document, input.now),
  };
}

function createStandaloneVerifiedControlPlaneCache(
  document: VerifiedControlPlaneDocument,
  now: number,
): VerifiedControlPlaneCache {
  const common = {
    urlHash: hashControlPlaneUrl('model-fabric-policy-publication'),
    fetchedAt: now,
    etag: null,
    highestPolicyRevision: document.policy.revision,
    policyCanonicalHash: hashCanonicalPolicy(document.policy),
    document,
    now,
  };
  if (document.format === 'cross-signed-rootset') {
    return createVerifiedCacheState({
      ...common,
      highestKeysetRevision: document.keyset.revision,
      keysetCanonicalHash: hashCanonicalCrossSignedKeyset(document.keyset),
      highestRootsetRevision: document.rootset.revision,
      rootsetCanonicalHash: hashCanonicalRootset(document.rootset),
    });
  }
  if (document.format === 'signed-keyset') {
    return createVerifiedCacheState({
      ...common,
      highestKeysetRevision: document.keyset.revision,
      keysetCanonicalHash: hashCanonicalKeyset(document.keyset),
    });
  }
  return createVerifiedCacheState(common);
}

function createControlPlaneCache(input: {
  document: VerifiedControlPlaneDocument;
  urlHash: string;
  fetchedAt: number;
  etag: string | null;
  quarantined: boolean;
}): unknown {
  const policyCanonicalHash = hashCanonicalPolicy(input.document.policy);
  if (input.document.format === 'legacy-root') {
    return legacyControlPlaneCacheV2Schema.parse({
      version: 2,
      trustMode: 'legacy-root',
      urlHash: input.urlHash,
      highestPolicyRevision: input.document.policy.revision,
      policyCanonicalHash,
      fetchedAt: input.fetchedAt,
      etag: input.etag,
      quarantined: input.quarantined,
      envelope: input.document.policy,
    });
  }
  if (input.document.format === 'cross-signed-rootset') {
    return rootsetControlPlaneCacheV3Schema.parse({
      version: 3,
      trustMode: 'cross-signed-rootset',
      urlHash: input.urlHash,
      highestPolicyRevision: input.document.policy.revision,
      policyCanonicalHash,
      highestKeysetRevision: input.document.keyset.revision,
      keysetCanonicalHash: hashCanonicalCrossSignedKeyset(
        input.document.keyset,
      ),
      highestRootsetRevision: input.document.rootset.revision,
      rootsetCanonicalHash: hashCanonicalRootset(input.document.rootset),
      fetchedAt: input.fetchedAt,
      etag: input.etag,
      quarantined: input.quarantined,
      snapshot: {
        schemaVersion: 3,
        rootset: input.document.rootset,
        keyset: input.document.keyset,
        policy: input.document.policy,
      },
    });
  }
  return keysetControlPlaneCacheV2Schema.parse({
    version: 2,
    trustMode: 'signed-keyset',
    urlHash: input.urlHash,
    highestPolicyRevision: input.document.policy.revision,
    policyCanonicalHash,
    highestKeysetRevision: input.document.keyset.revision,
    keysetCanonicalHash: hashCanonicalKeyset(input.document.keyset),
    fetchedAt: input.fetchedAt,
    etag: input.etag,
    quarantined: input.quarantined,
    snapshot: {
      schemaVersion: 2,
      keyset: input.document.keyset,
      policy: input.document.policy,
    },
  });
}

async function rejectAndQuarantineControlPlaneCache(
  error: string,
  cached: VerifiedControlPlaneCache | null,
  writeCache: ((content: Buffer) => Promise<void>) | undefined,
): Promise<ManagedModelFabricBudgetPolicies> {
  if (cached && writeCache) {
    try {
      const quarantined = createControlPlaneCache({
        document: cached.document,
        urlHash: cached.urlHash,
        fetchedAt: cached.fetchedAt,
        etag: cached.etag,
        quarantined: true,
      });
      await writeCache(Buffer.from(JSON.stringify(quarantined)));
    } catch {
      // The current process still fails closed. The live refresher also keeps
      // an in-memory quarantine latch when durable quarantine cannot be saved.
    }
  }
  return controlPlanePolicyError(error, 'security');
}

function validateControlPlaneTransition(
  previous: VerifiedControlPlaneCache | null,
  next: VerifiedControlPlaneDocument,
): string | null {
  if (!previous) return null;

  if (next.policy.revision < previous.highestPolicyRevision) {
    return 'Managed control-plane policy rollback was rejected';
  }
  const nextPolicyHash = hashCanonicalPolicy(next.policy);
  if (
    next.policy.revision === previous.highestPolicyRevision &&
    nextPolicyHash !== previous.policyCanonicalHash
  ) {
    return 'Managed control-plane policy revision conflict was rejected';
  }

  if (
    previous.document.format === 'cross-signed-rootset' &&
    next.format !== 'cross-signed-rootset'
  ) {
    return 'Managed control-plane trust downgrade was rejected';
  }
  if (
    previous.document.format === 'signed-keyset' &&
    next.format === 'legacy-root'
  ) {
    return 'Managed control-plane trust downgrade was rejected';
  }
  if (next.format === 'legacy-root') return null;

  if (next.format === 'signed-keyset') {
    if (previous.document.format === 'legacy-root') return null;
    if (next.keyset.revision < previous.highestKeysetRevision!) {
      return 'Managed control-plane signing keyset rollback was rejected';
    }
    const nextKeysetHash = hashCanonicalKeyset(next.keyset);
    if (
      next.keyset.revision === previous.highestKeysetRevision &&
      nextKeysetHash !== previous.keysetCanonicalHash
    ) {
      return 'Managed control-plane signing keyset revision conflict was rejected';
    }
    if (next.keyset.revision === previous.highestKeysetRevision) return null;
    return validateSigningKeyHistory(
      previous.document.keyset.keys,
      next.keyset.keys,
    );
  }

  if (previous.document.format === 'cross-signed-rootset') {
    if (next.rootset.revision < previous.highestRootsetRevision!) {
      return 'Managed control-plane rootset rollback was rejected';
    }
    const nextRootsetHash = hashCanonicalRootset(next.rootset);
    if (
      next.rootset.revision === previous.highestRootsetRevision &&
      nextRootsetHash !== previous.rootsetCanonicalHash
    ) {
      return 'Managed control-plane rootset revision conflict was rejected';
    }
    if (next.rootset.revision > previous.highestRootsetRevision!) {
      const rootHistoryError = validateRootKeyHistory(
        previous.document.rootset.roots,
        next.rootset.roots,
      );
      if (rootHistoryError) return rootHistoryError;
    }
  }

  if (previous.document.format === 'legacy-root') return null;
  if (
    previous.document.format === 'signed-keyset' &&
    next.keyset.revision <= previous.highestKeysetRevision!
  ) {
    return 'Managed control-plane rootset migration requires a signing keyset revision advance';
  }
  if (next.keyset.revision < previous.highestKeysetRevision!) {
    return 'Managed control-plane signing keyset rollback was rejected';
  }
  const nextKeysetHash = hashCanonicalCrossSignedKeyset(next.keyset);
  if (
    previous.document.format === 'cross-signed-rootset' &&
    next.keyset.revision === previous.highestKeysetRevision &&
    nextKeysetHash !== previous.keysetCanonicalHash
  ) {
    return 'Managed control-plane signing keyset revision conflict was rejected';
  }
  if (
    previous.document.format === 'cross-signed-rootset' &&
    next.keyset.revision === previous.highestKeysetRevision
  ) {
    return null;
  }
  return validateSigningKeyHistory(
    previous.document.keyset.keys,
    next.keyset.keys,
  );
}

function validateSigningKeyHistory(
  previous: readonly ModelFabricSigningKey[],
  next: readonly ModelFabricSigningKey[],
): string | null {
  const nextById = new Map(next.map((key) => [key.keyId, key]));
  for (const previousKey of previous) {
    const nextKey = nextById.get(previousKey.keyId);
    if (!nextKey) {
      return 'Managed control-plane signing key history truncation was rejected';
    }
    if (!hasSameTrustKeyIdentity(previousKey, nextKey)) {
      return 'Managed control-plane signing key identity conflict was rejected';
    }
    if (previousKey.status === 'revoked' && nextKey.status !== 'revoked') {
      return 'Managed control-plane signing key revocation rollback was rejected';
    }
  }
  return null;
}

function validateRootKeyHistory(
  previous: readonly ModelFabricRootKey[],
  next: readonly ModelFabricRootKey[],
): string | null {
  const nextById = new Map(next.map((key) => [key.keyId, key]));
  for (const previousKey of previous) {
    const nextKey = nextById.get(previousKey.keyId);
    if (!nextKey) {
      return 'Managed control-plane root key history truncation was rejected';
    }
    if (!hasSameTrustKeyIdentity(previousKey, nextKey)) {
      return 'Managed control-plane root key identity conflict was rejected';
    }
    if (previousKey.status === 'revoked' && nextKey.status !== 'revoked') {
      return 'Managed control-plane root key revocation rollback was rejected';
    }
  }
  return null;
}

function hasSameTrustKeyIdentity(
  previous: Pick<ModelFabricSigningKey, 'publicKey' | 'notBefore' | 'notAfter'>,
  next: Pick<ModelFabricSigningKey, 'publicKey' | 'notBefore' | 'notAfter'>,
): boolean {
  const previousFingerprint = getEd25519PublicKeyFingerprint(
    previous.publicKey,
  );
  const nextFingerprint = getEd25519PublicKeyFingerprint(next.publicKey);
  return (
    previousFingerprint !== null &&
    previousFingerprint === nextFingerprint &&
    previous.notBefore === next.notBefore &&
    previous.notAfter === next.notAfter
  );
}

function isControlPlaneDocumentUsable(
  document: VerifiedControlPlaneDocument,
  now: number,
): boolean {
  if (document.policy.expiresAt <= now) return false;
  if (document.format === 'legacy-root') return true;
  const delegatedTrustUsable =
    document.keyset.expiresAt > now &&
    document.signingKey.status === 'active' &&
    document.signingKey.notBefore <= now &&
    document.signingKey.notAfter > now;
  if (document.format === 'signed-keyset') return delegatedTrustUsable;
  return (
    delegatedTrustUsable &&
    document.rootset.expiresAt > now &&
    document.rootSigningKey.status === 'active' &&
    document.rootSigningKey.notBefore <= now &&
    document.rootSigningKey.notAfter > now
  );
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const result = Buffer.from(await response.arrayBuffer());
    if (result.byteLength > maximumBytes) {
      throw new ControlPlanePolicyResponseError(
        'Managed control-plane response is too large',
      );
    }
    return result;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ControlPlanePolicyResponseError(
          'Managed control-plane response is too large',
        );
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function normalizeControlPlaneUrl(value: string): string | null {
  if (value.length > 4_096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeControlPlaneTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 250 || value > 30_000) {
    return 5_000;
  }
  return value;
}

function normalizeRefreshInterval(value: number | undefined): number {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value < MIN_REFRESH_INTERVAL_MS ||
    value > MAX_REFRESH_INTERVAL_MS
  ) {
    return DEFAULT_REFRESH_INTERVAL_MS;
  }
  return value;
}

function normalizeMaxRefreshBackoff(
  value: number | undefined,
  refreshIntervalMs: number,
): number {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value < refreshIntervalMs ||
    value > MAX_REFRESH_INTERVAL_MS
  ) {
    return Math.max(refreshIntervalMs, DEFAULT_MAX_REFRESH_BACKOFF_MS);
  }
  return value;
}

function normalizeEtag(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 1_024 ? normalized : null;
}

function hashControlPlaneUrl(value: string): string {
  return createHash('sha256')
    .update(`model-fabric-control-plane\0${value}`)
    .digest('hex');
}

function hashCanonicalPolicy(envelope: SignedPolicyEnvelope): string {
  return createHash('sha256')
    .update(canonicalizeSignedModelFabricPolicy(envelope))
    .digest('hex');
}

function hashCanonicalKeyset(keyset: SignedModelFabricKeyset): string {
  return createHash('sha256')
    .update(canonicalizeSignedModelFabricKeyset(keyset))
    .digest('hex');
}

function hashCanonicalCrossSignedKeyset(
  keyset: CrossSignedModelFabricKeyset,
): string {
  return createHash('sha256')
    .update(canonicalizeCrossSignedModelFabricKeyset(keyset))
    .digest('hex');
}

function hashCanonicalRootset(rootset: SignedModelFabricRootset): string {
  return createHash('sha256')
    .update(canonicalizeSignedModelFabricRootset(rootset))
    .digest('hex');
}

function getEd25519PublicKeyFingerprint(publicKey: string): string | null {
  try {
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519') return null;
    return createHash('sha256')
      .update(key.export({ type: 'spki', format: 'der' }))
      .digest('hex');
  } catch {
    return null;
  }
}

function hasOnlyValidEd25519Keys(
  keys: readonly Pick<ModelFabricSigningKey, 'publicKey'>[],
): boolean {
  return keys.every(
    (key) => getEd25519PublicKeyFingerprint(key.publicKey) !== null,
  );
}

function controlPlanePolicySuccess(
  document: VerifiedControlPlaneDocument,
  cached: boolean,
): ManagedModelFabricBudgetPolicies {
  const expiresAt =
    document.format === 'signed-keyset'
      ? Math.min(
          document.policy.expiresAt,
          document.keyset.expiresAt,
          document.signingKey.notAfter,
        )
      : document.format === 'cross-signed-rootset'
        ? Math.min(
            document.policy.expiresAt,
            document.keyset.expiresAt,
            document.signingKey.notAfter,
            document.rootset.expiresAt,
            document.rootSigningKey.notAfter,
          )
        : document.policy.expiresAt;
  return {
    source: 'control-plane',
    policies: document.policy.policies.map((policy) => ({ ...policy })),
    error: null,
    cached,
    revision: document.policy.revision,
    ...(document.format !== 'legacy-root'
      ? { keysetRevision: document.keyset.revision }
      : {}),
    signingKeyId: document.policy.keyId,
    ...(document.format === 'cross-signed-rootset'
      ? {
          rootsetRevision: document.rootset.revision,
          rootSigningKeyId: document.rootSigningKey.keyId,
          activeRootCount: document.rootset.roots.filter(
            (root) => root.status === 'active',
          ).length,
          revokedRootCount: document.rootset.roots.filter(
            (root) => root.status === 'revoked',
          ).length,
        }
      : {}),
    expiresAt,
  };
}

function controlPlanePolicyError(
  error: string,
  failureClass: NonNullable<
    ManagedModelFabricBudgetPolicies['failureClass']
  > = 'security',
): ManagedModelFabricBudgetPolicies {
  const result: ManagedModelFabricBudgetPolicies = {
    source: 'control-plane',
    policies: [],
    error,
    cached: false,
  };
  Object.defineProperty(result, 'failureClass', {
    value: failureClass,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return result;
}

function decodeCanonicalBase64(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.byteLength === 0) return null;
    return decoded.toString('base64').replace(/=+$/, '') ===
      value.replace(/=+$/, '')
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function defaultSchedule(callback: () => void, delayMs: number): unknown {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return handle;
}

function defaultCancelScheduled(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function signedPolicyError(error: string): ManagedModelFabricBudgetPolicies {
  return {
    source: 'signed-file',
    policies: [],
    error,
  };
}
