import {
  createCipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import type {
  CloudTaskSnapshotCryptoProvider,
  CloudTaskSnapshotSignature,
  CloudTaskSnapshotWrappedKey,
} from './cloud-task-snapshot-packager';

const DEFAULT_MAX_CREDENTIAL_TTL_MS = 15 * 60 * 1000;
const MIN_CREDENTIAL_LIFETIME_MS = 15_000;
const AES_KEY_BYTES = 32;
const AES_NONCE_BYTES = 12;

export const cloudDataResidencies = ['us', 'eu', 'apac'] as const;
export type CloudDataResidency = (typeof cloudDataResidencies)[number];

export const cloudTaskCredentialScopes = [
  'task:start',
  'task:restore',
  'task:lease',
  'task:suspend',
  'task:resume',
  'task:stream',
  'task:memory',
  'task:status',
  'task:cancel',
  'artifact:read',
] as const;
export type CloudTaskCredentialScope =
  (typeof cloudTaskCredentialScopes)[number];

export interface CloudTaskExecutionPolicy {
  residency: CloudDataResidency;
  maxSnapshotBytes: number;
  maxSnapshotFiles: number;
  maxArtifactBytes: number;
  maxArtifactFiles: number;
  maxDurationMs: number;
  maxCostMicros: number;
}

export interface CloudTaskCredentialIssueRequest {
  taskId: string;
  audience: string;
  residency: CloudDataResidency;
  scopes: readonly CloudTaskCredentialScope[];
  maxTtlMs: number;
}

export interface CloudTaskCredentialIssueResponse {
  credentialId: string;
  taskId: string;
  audience: string;
  residency: CloudDataResidency;
  scopes: CloudTaskCredentialScope[];
  token: string;
  issuedAt: number;
  expiresAt: number;
}

export interface CloudTaskSecretBrokerTransport {
  issueCredential(
    request: CloudTaskCredentialIssueRequest,
    accountAccessToken: string,
    signal?: AbortSignal,
  ): Promise<CloudTaskCredentialIssueResponse>;
  revokeCredential(
    credentialId: string,
    accountAccessToken: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface CloudTaskCredentialLease {
  readonly credentialId: string;
  readonly token: string;
  readonly expiresAt: number;
  readonly scopes: readonly CloudTaskCredentialScope[];
  dispose(): Promise<void>;
}

export type CloudTaskSecretBrokerErrorReason =
  | 'auth-unavailable'
  | 'invalid-request'
  | 'invalid-response'
  | 'ttl-invalid'
  | 'scope-mismatch'
  | 'aborted';

export class CloudTaskSecretBrokerError extends Error {
  public constructor(
    public readonly reason: CloudTaskSecretBrokerErrorReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CloudTaskSecretBrokerError';
  }
}

export interface CloudTaskSecretBrokerOptions {
  transport: CloudTaskSecretBrokerTransport;
  getAccountAccessToken: () => string | undefined;
  audience: string;
  maxCredentialTtlMs?: number;
  now?: () => number;
}

/**
 * Exchanges the long-lived account session for one task-bound, in-memory-only
 * credential. The lease is never persisted and revocation is idempotent.
 */
export class CloudTaskSecretBroker {
  private readonly transport: CloudTaskSecretBrokerTransport;
  private readonly getAccountAccessToken: () => string | undefined;
  private readonly audience: string;
  private readonly maxCredentialTtlMs: number;
  private readonly now: () => number;

  public constructor(options: CloudTaskSecretBrokerOptions) {
    this.transport = options.transport;
    this.getAccountAccessToken = options.getAccountAccessToken;
    this.audience = validateAudience(options.audience);
    this.maxCredentialTtlMs = positiveSafeInteger(
      options.maxCredentialTtlMs ?? DEFAULT_MAX_CREDENTIAL_TTL_MS,
      'credential TTL',
    );
    this.now = options.now ?? Date.now;
  }

  public async acquire(input: {
    taskId: string;
    residency: CloudDataResidency;
    scopes: readonly CloudTaskCredentialScope[];
    signal?: AbortSignal;
  }): Promise<CloudTaskCredentialLease> {
    assertNotAborted(input.signal);
    const accountAccessToken = this.getAccountAccessToken();
    if (!accountAccessToken?.trim()) {
      throw new CloudTaskSecretBrokerError(
        'auth-unavailable',
        'Cloud task account authentication is unavailable',
      );
    }
    const taskId = validateOpaqueId(input.taskId, 'task id');
    const residency = validateResidency(input.residency);
    const scopes = normalizeScopes(input.scopes);
    if (scopes.length === 0) {
      throw new CloudTaskSecretBrokerError(
        'invalid-request',
        'Cloud task credential scopes are empty',
      );
    }

    let response: CloudTaskCredentialIssueResponse;
    try {
      response = await this.transport.issueCredential(
        {
          taskId,
          audience: this.audience,
          residency,
          scopes,
          maxTtlMs: this.maxCredentialTtlMs,
        },
        accountAccessToken,
        input.signal,
      );
    } catch (error) {
      if (isAbortError(error) || input.signal?.aborted) {
        throw new CloudTaskSecretBrokerError(
          'aborted',
          'Cloud task credential request was cancelled',
          { cause: error },
        );
      }
      throw error;
    }

    const validated = this.validateResponse(response, {
      taskId,
      residency,
      scopes,
    });
    let disposed = false;
    return {
      credentialId: validated.credentialId,
      token: validated.token,
      expiresAt: validated.expiresAt,
      scopes: validated.scopes,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        try {
          await this.transport.revokeCredential(
            validated.credentialId,
            accountAccessToken,
          );
        } catch {
          // The credential remains short-lived and task-bound. Revocation is
          // best effort so a teardown network failure cannot revive a task.
        }
      },
    };
  }

  private validateResponse(
    response: CloudTaskCredentialIssueResponse,
    expected: {
      taskId: string;
      residency: CloudDataResidency;
      scopes: CloudTaskCredentialScope[];
    },
  ): CloudTaskCredentialIssueResponse {
    const now = this.now();
    if (
      response.taskId !== expected.taskId ||
      response.audience !== this.audience ||
      response.residency !== expected.residency
    ) {
      throw new CloudTaskSecretBrokerError(
        'invalid-response',
        'Cloud task credential binding does not match the request',
      );
    }
    const credentialId = validateOpaqueId(
      response.credentialId,
      'credential id',
    );
    const token = response.token?.trim();
    if (!token || token.length > 16_384) {
      throw new CloudTaskSecretBrokerError(
        'invalid-response',
        'Cloud task credential token is invalid',
      );
    }
    if (
      !Number.isSafeInteger(response.issuedAt) ||
      !Number.isSafeInteger(response.expiresAt) ||
      response.issuedAt > now + 30_000 ||
      response.expiresAt <= now + MIN_CREDENTIAL_LIFETIME_MS ||
      response.expiresAt - now > this.maxCredentialTtlMs
    ) {
      throw new CloudTaskSecretBrokerError(
        'ttl-invalid',
        'Cloud task credential lifetime is invalid',
      );
    }
    const scopes = normalizeScopes(response.scopes);
    if (
      scopes.length !== expected.scopes.length ||
      scopes.some((scope, index) => scope !== expected.scopes[index])
    ) {
      throw new CloudTaskSecretBrokerError(
        'scope-mismatch',
        'Cloud task credential scopes do not match the request',
      );
    }
    return {
      ...response,
      credentialId,
      token,
      scopes,
    };
  }
}

export interface CloudTaskRecipientKey {
  algorithm: 'p256';
  keyId: string;
  publicKeySpki: string;
  expiresAt: number;
}

export type CloudTaskRecipientCryptoErrorReason =
  | 'key-invalid'
  | 'key-expired'
  | 'provider-disposed';

export class CloudTaskRecipientCryptoError extends Error {
  public constructor(
    public readonly reason: CloudTaskRecipientCryptoErrorReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CloudTaskRecipientCryptoError';
  }
}

export interface ServerRecipientSnapshotCryptoProvider
  extends CloudTaskSnapshotCryptoProvider {
  dispose(): void;
}

export function createServerRecipientSnapshotCryptoProvider(input: {
  taskId: string;
  recipient: CloudTaskRecipientKey;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}): ServerRecipientSnapshotCryptoProvider {
  const now = input.now ?? Date.now;
  if (input.recipient.expiresAt <= now()) {
    throw new CloudTaskRecipientCryptoError(
      'key-expired',
      'Cloud task recipient key has expired',
    );
  }
  const taskId = validateOpaqueId(input.taskId, 'task id');
  const keyId = validateOpaqueId(input.recipient.keyId, 'recipient key id');
  const recipientPublicKey = importRecipientPublicKey(
    input.recipient.publicKeySpki,
  );
  const ephemeral = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sharedSecret = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientPublicKey,
  });
  const salt = createHash('sha256')
    .update(`clodex.cloud-task.recipient.v1\0${taskId}\0${keyId}`, 'utf8')
    .digest();
  const keyMaterial = Buffer.from(
    hkdfSync(
      'sha256',
      sharedSecret,
      salt,
      Buffer.from('snapshot-wrap-and-sign', 'utf8'),
      64,
    ),
  );
  sharedSecret.fill(0);
  const wrappingKey = Buffer.from(keyMaterial.subarray(0, AES_KEY_BYTES));
  const signingKey = Buffer.from(
    keyMaterial.subarray(AES_KEY_BYTES, AES_KEY_BYTES * 2),
  );
  keyMaterial.fill(0);
  const ephemeralPublicKey = ephemeral.publicKey
    .export({ format: 'der', type: 'spki' })
    .toString('base64url');
  const random = input.randomBytes ?? randomBytes;
  let disposed = false;

  const assertUsable = (): void => {
    if (disposed) {
      throw new CloudTaskRecipientCryptoError(
        'provider-disposed',
        'Cloud task recipient crypto provider is disposed',
      );
    }
    if (input.recipient.expiresAt <= now()) {
      throw new CloudTaskRecipientCryptoError(
        'key-expired',
        'Cloud task recipient key has expired',
      );
    }
  };

  return {
    async wrapDataKey({ taskId: requestedTaskId, dataKey }) {
      assertUsable();
      if (requestedTaskId !== taskId || dataKey.byteLength !== AES_KEY_BYTES) {
        throw new CloudTaskRecipientCryptoError(
          'key-invalid',
          'Cloud task data-key wrapping context is invalid',
        );
      }
      const nonce = random(AES_NONCE_BYTES);
      if (nonce.byteLength !== AES_NONCE_BYTES) {
        throw new CloudTaskRecipientCryptoError(
          'key-invalid',
          'Cloud task wrapping nonce is invalid',
        );
      }
      const cipher = createCipheriv('aes-256-gcm', wrappingKey, nonce);
      cipher.setAAD(
        Buffer.from(`clodex.cloud-task.wrap.v1\0${taskId}\0${keyId}`, 'utf8'),
      );
      const ciphertext = Buffer.concat([
        cipher.update(dataKey),
        cipher.final(),
      ]);
      const envelope = {
        version: 1,
        ephemeralPublicKey,
        nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
      };
      return {
        algorithm: 'p256-ecdh-hkdf-sha256+a256gcm',
        keyId,
        value: Buffer.from(JSON.stringify(envelope), 'utf8').toString(
          'base64url',
        ),
      } satisfies CloudTaskSnapshotWrappedKey;
    },
    async signManifest({ taskId: requestedTaskId, canonicalManifest }) {
      assertUsable();
      if (requestedTaskId !== taskId) {
        throw new CloudTaskRecipientCryptoError(
          'key-invalid',
          'Cloud task manifest signing context is invalid',
        );
      }
      return {
        algorithm: 'hmac-sha256',
        keyId,
        value: createHmac('sha256', signingKey)
          .update(`clodex.cloud-task.manifest.v1\0${taskId}\0`, 'utf8')
          .update(canonicalManifest)
          .digest('base64url'),
      } satisfies CloudTaskSnapshotSignature;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      wrappingKey.fill(0);
      signingKey.fill(0);
    },
  };
}

export function validateCloudTaskExecutionPolicy(
  policy: CloudTaskExecutionPolicy,
): CloudTaskExecutionPolicy {
  return {
    residency: validateResidency(policy.residency),
    maxSnapshotBytes: positiveSafeInteger(
      policy.maxSnapshotBytes,
      'snapshot byte quota',
    ),
    maxSnapshotFiles: positiveSafeInteger(
      policy.maxSnapshotFiles,
      'snapshot file quota',
    ),
    maxArtifactBytes: positiveSafeInteger(
      policy.maxArtifactBytes,
      'artifact byte quota',
    ),
    maxArtifactFiles: positiveSafeInteger(
      policy.maxArtifactFiles,
      'artifact file quota',
    ),
    maxDurationMs: positiveSafeInteger(
      policy.maxDurationMs,
      'task duration quota',
    ),
    maxCostMicros: positiveSafeInteger(policy.maxCostMicros, 'task cost quota'),
  };
}

function importRecipientPublicKey(encoded: string): KeyObject {
  try {
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
      throw new Error('Recipient key is not canonical base64url');
    }
    const der = Buffer.from(encoded, 'base64url');
    if (der.toString('base64url') !== encoded) {
      throw new Error('Recipient key is not canonical base64url');
    }
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (
      key.asymmetricKeyType !== 'ec' ||
      key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    ) {
      throw new Error('Recipient key must be P-256');
    }
    return key;
  } catch (error) {
    throw new CloudTaskRecipientCryptoError(
      'key-invalid',
      'Cloud task recipient public key is invalid',
      { cause: error },
    );
  }
}

function normalizeScopes(
  scopes: readonly CloudTaskCredentialScope[],
): CloudTaskCredentialScope[] {
  const allowed = new Set<CloudTaskCredentialScope>(cloudTaskCredentialScopes);
  const unique = new Set<CloudTaskCredentialScope>();
  for (const scope of scopes) {
    if (!allowed.has(scope)) {
      throw new CloudTaskSecretBrokerError(
        'invalid-request',
        'Cloud task credential scope is invalid',
      );
    }
    unique.add(scope);
  }
  return Array.from(unique).sort(compareOrdinal);
}

function validateResidency(value: string): CloudDataResidency {
  if ((cloudDataResidencies as readonly string[]).includes(value)) {
    return value as CloudDataResidency;
  }
  throw new CloudTaskSecretBrokerError(
    'invalid-request',
    'Cloud task data residency is invalid',
  );
}

function validateAudience(value: string): string {
  const audience = value.trim();
  if (
    audience.length === 0 ||
    audience.length > 200 ||
    Array.from(audience).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error('Cloud task credential audience is invalid');
  }
  return audience;
}

function validateOpaqueId(value: string, label: string): string {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized.length > 200 ||
    !/^[A-Za-z0-9._:-]+$/.test(normalized)
  ) {
    throw new CloudTaskSecretBrokerError(
      'invalid-request',
      `Cloud task ${label} is invalid`,
    );
  }
  return normalized;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Cloud task ${label} must be a positive safe integer`);
  }
  return value;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new CloudTaskSecretBrokerError(
    'aborted',
    'Cloud task secret broker operation was cancelled',
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
