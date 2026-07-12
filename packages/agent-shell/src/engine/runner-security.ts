import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { z } from 'zod';
import type { ResolutionReason, SessionCommandRequest } from './types';

export const RUNNER_JOB_VERSION = 1 as const;
export const EXECUTION_RECEIPT_VERSION = 3 as const;
const RUNNER_JOB_SIGNATURE_CONTEXT = 'clodex.runner-job.v1';
const RUNNER_RECEIPT_SIGNATURE_CONTEXT = 'clodex.runner-receipt.v1';
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const runnerOperationSchema = z.enum([
  'create-session',
  'execute-command',
  'kill-session',
]);
export type RunnerOperation = z.infer<typeof runnerOperationSchema>;

export const runnerJobSchema = z
  .object({
    version: z.literal(RUNNER_JOB_VERSION),
    jobId: z.string().uuid(),
    providerId: z.string().min(1).max(256),
    leaseId: z.string().min(1).max(256),
    snapshotHash: z.string().regex(SHA256),
    operation: runnerOperationSchema,
    payloadHash: z.string().regex(SHA256),
    nonce: z.string().min(16).max(128).regex(BASE64URL),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    environmentFingerprintHash: z.string().regex(SHA256),
    authorityKeyId: z.string().min(16).max(128).regex(BASE64URL),
  })
  .strict()
  .refine((job) => job.expiresAt > job.issuedAt, {
    message: 'Runner job expiry must be after issuance',
    path: ['expiresAt'],
  });
export type RunnerJob = z.infer<typeof runnerJobSchema>;

export const signedRunnerJobSchema = z
  .object({
    job: runnerJobSchema,
    publicKey: z.string().min(16).max(1024).regex(BASE64URL),
    signature: z.string().min(16).max(1024).regex(BASE64URL),
  })
  .strict();
export type SignedRunnerJob = z.infer<typeof signedRunnerJobSchema>;

export const executionReceiptSchema = z
  .object({
    version: z.literal(EXECUTION_RECEIPT_VERSION),
    receiptId: z.string().uuid(),
    jobId: z.string().uuid(),
    jobHash: z.string().regex(SHA256),
    providerId: z.string().min(1).max(256),
    leaseId: z.string().min(1).max(256),
    snapshotHash: z.string().regex(SHA256),
    operation: runnerOperationSchema,
    nonceHash: z.string().regex(SHA256),
    environmentFingerprintHash: z.string().regex(SHA256),
    startedAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative(),
    outcome: z.enum(['completed', 'failed']),
    exitCode: z.number().int().nullable(),
    resolvedBy: z
      .enum(['exit', 'pattern', 'idle', 'timeout', 'abort', 'session_exited'])
      .nullable(),
    outputHash: z.string().regex(SHA256).nullable(),
    artifactManifestHash: z.string().regex(SHA256).nullable(),
    workspacePreparationHash: z.string().regex(SHA256).nullable(),
    executionTimingHash: z.string().regex(SHA256).nullable(),
    remoteJobId: z
      .string()
      .regex(/^job-[a-f0-9]{32}$/)
      .nullable(),
    terminalState: z
      .enum(['completed', 'failed', 'cancelled', 'timed-out'])
      .nullable(),
    errorCode: z.string().min(1).max(128).nullable(),
    runnerKeyId: z.string().min(16).max(128).regex(BASE64URL),
  })
  .strict()
  .refine((receipt) => receipt.finishedAt >= receipt.startedAt, {
    message: 'Execution receipt finish must not precede start',
    path: ['finishedAt'],
  });
export type ExecutionReceipt = z.infer<typeof executionReceiptSchema>;

export const signedExecutionReceiptSchema = z
  .object({
    receipt: executionReceiptSchema,
    publicKey: z.string().min(16).max(1024).regex(BASE64URL),
    signature: z.string().min(16).max(1024).regex(BASE64URL),
  })
  .strict();
export type SignedExecutionReceipt = z.infer<
  typeof signedExecutionReceiptSchema
>;

export interface RunnerSigningAuthority {
  readonly publicKey: string;
  readonly keyId: string;
  signJob(job: RunnerJob): SignedRunnerJob;
  signReceipt(receipt: ExecutionReceipt): SignedExecutionReceipt;
}

export interface RunnerSecurityAuditEvent {
  type: 'job-issued' | 'job-admitted' | 'job-rejected' | 'receipt-issued';
  createdAt: number;
  jobId: string;
  providerId: string;
  leaseId: string;
  snapshotHash: string;
  operation: RunnerOperation;
  jobHash: string;
  receiptHash: string | null;
  outcome: ExecutionReceipt['outcome'] | null;
  reason: string | null;
}

export interface RunnerSecurityAuditSink {
  record(event: RunnerSecurityAuditEvent): Promise<void>;
}

export class P256RunnerSigningAuthority implements RunnerSigningAuthority {
  public readonly publicKey: string;
  public readonly keyId: string;
  private readonly privateKey: KeyObject;

  public constructor(identity: {
    privateKeyPem: string;
    publicKey: string;
  }) {
    this.privateKey = createPrivateKey(identity.privateKeyPem);
    const importedPublicKey = importP256PublicKey(identity.publicKey);
    if (!createPublicKey(this.privateKey).equals(importedPublicKey)) {
      throw new Error('Runner signing keypair does not match');
    }
    this.publicKey = identity.publicKey;
    this.keyId = hashBase64Url(decodeBase64Url(identity.publicKey));
  }

  public static generate(): {
    authority: P256RunnerSigningAuthority;
    privateKeyPem: string;
    publicKey: string;
  } {
    const pair = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { format: 'der', type: 'spki' },
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    });
    const publicKey = Buffer.from(pair.publicKey).toString('base64url');
    return {
      authority: new P256RunnerSigningAuthority({
        privateKeyPem: pair.privateKey,
        publicKey,
      }),
      privateKeyPem: pair.privateKey,
      publicKey,
    };
  }

  public signJob(job: RunnerJob): SignedRunnerJob {
    const parsed = runnerJobSchema.parse(job);
    if (parsed.authorityKeyId !== this.keyId) {
      throw new Error('Runner job authority key does not match signer');
    }
    return Object.freeze({
      job: Object.freeze({ ...parsed }),
      publicKey: this.publicKey,
      signature: this.sign(RUNNER_JOB_SIGNATURE_CONTEXT, parsed),
    });
  }

  public signReceipt(receipt: ExecutionReceipt): SignedExecutionReceipt {
    const parsed = executionReceiptSchema.parse(receipt);
    if (parsed.runnerKeyId !== this.keyId) {
      throw new Error('Execution receipt key does not match signer');
    }
    return Object.freeze({
      receipt: Object.freeze({ ...parsed }),
      publicKey: this.publicKey,
      signature: this.sign(RUNNER_RECEIPT_SIGNATURE_CONTEXT, parsed),
    });
  }

  private sign(context: string, payload: unknown): string {
    return sign(
      'sha256',
      Buffer.from(createSignaturePayload(context, payload), 'utf8'),
      { key: this.privateKey, dsaEncoding: 'ieee-p1363' },
    ).toString('base64url');
  }
}

export function createSignedRunnerJob(input: {
  providerId: string;
  leaseId: string;
  snapshotHash: string;
  operation: RunnerOperation;
  payloadHash: string;
  environmentFingerprintHash: string;
  authority: RunnerSigningAuthority;
  now?: number;
  ttlMs?: number;
  jobId?: string;
  nonce?: string;
}): SignedRunnerJob {
  const issuedAt = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('Runner job TTL must be a positive integer');
  }
  return input.authority.signJob({
    version: RUNNER_JOB_VERSION,
    jobId: input.jobId ?? randomUUID(),
    providerId: input.providerId,
    leaseId: input.leaseId,
    snapshotHash: input.snapshotHash,
    operation: input.operation,
    payloadHash: input.payloadHash,
    nonce: input.nonce ?? randomBytes(24).toString('base64url'),
    issuedAt,
    expiresAt: issuedAt + ttlMs,
    environmentFingerprintHash: input.environmentFingerprintHash,
    authorityKeyId: input.authority.keyId,
  });
}

export function verifySignedRunnerJob(
  signed: SignedRunnerJob,
  trustedPublicKey: string,
): boolean {
  const parsed = signedRunnerJobSchema.safeParse(signed);
  if (
    !parsed.success ||
    parsed.data.publicKey !== trustedPublicKey ||
    parsed.data.job.authorityKeyId !== getRunnerPublicKeyId(trustedPublicKey)
  )
    return false;
  return verifySignature(
    RUNNER_JOB_SIGNATURE_CONTEXT,
    parsed.data.job,
    parsed.data.signature,
    trustedPublicKey,
  );
}

export function verifySignedExecutionReceipt(
  signed: SignedExecutionReceipt,
  trustedPublicKey: string,
): boolean {
  const parsed = signedExecutionReceiptSchema.safeParse(signed);
  if (
    !parsed.success ||
    parsed.data.publicKey !== trustedPublicKey ||
    parsed.data.receipt.runnerKeyId !== getRunnerPublicKeyId(trustedPublicKey)
  )
    return false;
  return verifySignature(
    RUNNER_RECEIPT_SIGNATURE_CONTEXT,
    parsed.data.receipt,
    parsed.data.signature,
    trustedPublicKey,
  );
}

export function hashRunnerJob(job: RunnerJob): string {
  return hashCanonical(job);
}

export function hashExecutionReceipt(receipt: ExecutionReceipt): string {
  return hashCanonical(receipt);
}

export function getRunnerPublicKeyId(publicKey: string): string {
  return hashBase64Url(decodeBase64Url(publicKey));
}

export function hashRunnerPayload(
  operation: RunnerOperation,
  payload: unknown,
): string {
  return hashCanonical({ operation, payload });
}

export function commandPayloadForHash(request: SessionCommandRequest): unknown {
  return {
    command: request.command,
    cwd: request.cwd,
    sessionId: request.sessionId,
    rawInput: request.rawInput,
    waitUntil: request.waitUntil,
  };
}

export function createSignedExecutionReceipt(input: {
  signedJob: SignedRunnerJob;
  authority: RunnerSigningAuthority;
  startedAt: number;
  finishedAt: number;
  outcome: ExecutionReceipt['outcome'];
  exitCode?: number | null;
  resolvedBy?: ResolutionReason | null;
  output?: string | null;
  artifactManifestHash?: string | null;
  workspacePreparationHash?: string | null;
  executionTimingHash?: string | null;
  remoteJobId?: string | null;
  terminalState?: 'completed' | 'failed' | 'cancelled' | 'timed-out' | null;
  errorCode?: string | null;
  receiptId?: string;
}): SignedExecutionReceipt {
  const { job } = input.signedJob;
  return input.authority.signReceipt({
    version: EXECUTION_RECEIPT_VERSION,
    receiptId: input.receiptId ?? randomUUID(),
    jobId: job.jobId,
    jobHash: hashRunnerJob(job),
    providerId: job.providerId,
    leaseId: job.leaseId,
    snapshotHash: job.snapshotHash,
    operation: job.operation,
    nonceHash: hashText(job.nonce),
    environmentFingerprintHash: job.environmentFingerprintHash,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    outcome: input.outcome,
    exitCode: input.exitCode ?? null,
    resolvedBy: input.resolvedBy ?? null,
    outputHash:
      input.output === undefined || input.output === null
        ? null
        : hashText(input.output),
    artifactManifestHash: input.artifactManifestHash ?? null,
    workspacePreparationHash: input.workspacePreparationHash ?? null,
    executionTimingHash: input.executionTimingHash ?? null,
    remoteJobId: input.remoteJobId ?? null,
    terminalState: input.terminalState ?? null,
    errorCode: input.errorCode ?? null,
    runnerKeyId: input.authority.keyId,
  });
}

export function canonicalizeRunnerValue(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function createSignaturePayload(context: string, payload: unknown): string {
  return `${context}\n${canonicalizeRunnerValue(payload)}`;
}

function verifySignature(
  context: string,
  payload: unknown,
  signature: string,
  publicKey: string,
): boolean {
  try {
    return verify(
      'sha256',
      Buffer.from(createSignaturePayload(context, payload), 'utf8'),
      {
        key: importP256PublicKey(publicKey),
        dsaEncoding: 'ieee-p1363',
      },
      decodeBase64Url(signature),
    );
  } catch {
    return false;
  }
}

function importP256PublicKey(publicKey: string): KeyObject {
  const key = createPublicKey({
    key: decodeBase64Url(publicKey),
    format: 'der',
    type: 'spki',
  });
  if (
    key.asymmetricKeyType !== 'ec' ||
    key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  ) {
    throw new Error('Runner signing key must use P-256');
  }
  return key;
}

function decodeBase64Url(value: string): Buffer {
  if (!BASE64URL.test(value)) throw new Error('Invalid base64url value');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error('Non-canonical base64url value');
  }
  return decoded;
}

function hashCanonical(value: unknown): string {
  return createHash('sha256')
    .update(canonicalizeRunnerValue(value))
    .digest('hex');
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashBase64Url(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('base64url');
}

function sortCanonical(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Runner payload contains a non-finite number');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortCanonical(entry)]),
    );
  }
  throw new Error('Runner payload is not canonicalizable');
}
