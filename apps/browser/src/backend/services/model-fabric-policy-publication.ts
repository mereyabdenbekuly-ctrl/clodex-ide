import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { modelBudgetPoliciesSchema } from '@shared/model-fabric-inspector';
import { z } from 'zod';
import {
  canonicalizeCrossSignedModelFabricKeyset,
  canonicalizeSignedModelFabricPolicy,
  canonicalizeSignedModelFabricRootset,
  verifyAuthenticatedCachedControlPlaneModelFabricPolicySnapshot,
  verifyControlPlaneModelFabricPolicySnapshot,
} from './model-fabric-managed-policy';

const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60_000;
const MIN_APPROVAL_TTL_MS = 60_000;
const MAX_APPROVAL_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_USED_APPROVAL_NONCES = 100_000;

const publicationIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/);
const keyIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/);
const roleSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const signatureSchema = z.string().trim().min(1).max(16_384);
const rolloutStageSchema = z.enum(['canary', 'production']);

const trustKeyShape = {
  keyId: keyIdSchema,
  publicKey: z.string().trim().min(1).max(16_384),
  status: z.enum(['active', 'revoked']),
  notBefore: z.number().int().nonnegative(),
  notAfter: z.number().int().positive(),
};

const trustKeySchema = z.object(trustKeyShape).strict();
const approverSchema = z
  .object({
    ...trustKeyShape,
    roles: z.array(roleSchema).min(1).max(32),
  })
  .strict();

const stagePolicySchema = z
  .object({
    stage: rolloutStageSchema,
    requiredApprovals: z.number().int().min(1).max(64),
    requiredRoles: z.array(roleSchema).max(32),
    requiresPriorStage: rolloutStageSchema.optional(),
  })
  .strict();

const publicationAuthorityShape = {
  schemaVersion: z.literal(1),
  authorityId: publicationIdSchema,
  revision: z.number().int().nonnegative(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  signedBy: keyIdSchema,
  approvers: z.array(approverSchema).min(1).max(128),
  publishers: z.array(trustKeySchema).min(1).max(32),
  stages: z.array(stagePolicySchema).min(2).max(2),
};

const unsignedPublicationAuthoritySchema = z
  .object(publicationAuthorityShape)
  .strict();
const signedPublicationAuthoritySchema = z
  .object({
    ...publicationAuthorityShape,
    signature: signatureSchema,
  })
  .strict();

const signingKeyShape = {
  keyId: keyIdSchema,
  publicKey: z.string().trim().min(1).max(16_384),
  status: z.enum(['active', 'revoked']),
  notBefore: z.number().int().nonnegative(),
  notAfter: z.number().int().positive(),
};

const rootsetPayloadShape = {
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  signedBy: keyIdSchema,
  roots: z.array(z.object(signingKeyShape).strict()).min(1).max(32),
};
const keysetPayloadShape = {
  schemaVersion: z.literal(2),
  rootKeyId: keyIdSchema,
  revision: z.number().int().nonnegative(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  keys: z.array(z.object(signingKeyShape).strict()).min(1).max(64),
};
const policyPayloadShape = {
  schemaVersion: z.literal(1),
  keyId: keyIdSchema,
  revision: z.number().int().nonnegative(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  policies: modelBudgetPoliciesSchema,
};

const unsignedSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    rootset: z.object(rootsetPayloadShape).strict(),
    keyset: z.object(keysetPayloadShape).strict(),
    policy: z.object(policyPayloadShape).strict(),
  })
  .strict();

const signedSnapshotSchema = z
  .object({
    schemaVersion: z.literal(3),
    rootset: z
      .object({ ...rootsetPayloadShape, signature: signatureSchema })
      .strict(),
    keyset: z
      .object({ ...keysetPayloadShape, signature: signatureSchema })
      .strict(),
    policy: z
      .object({ ...policyPayloadShape, signature: signatureSchema })
      .strict(),
  })
  .strict();

const publicationApprovalShape = {
  schemaVersion: z.literal(1),
  authorityId: publicationIdSchema,
  authorityRevision: z.number().int().nonnegative(),
  authorityHash: hashSchema,
  snapshotHash: hashSchema,
  stage: rolloutStageSchema,
  approverId: keyIdSchema,
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  nonce: z.string().regex(/^[a-f0-9]{32,128}$/),
};
const signedPublicationApprovalSchema = z
  .object({
    ...publicationApprovalShape,
    signature: signatureSchema,
  })
  .strict();

const publicationReceiptShape = {
  schemaVersion: z.literal(1),
  publicationId: publicationIdSchema,
  authorityId: publicationIdSchema,
  authorityRevision: z.number().int().nonnegative(),
  authorityHash: hashSchema,
  snapshotHash: hashSchema,
  rootsetRevision: z.number().int().nonnegative(),
  rootsetHash: hashSchema,
  keysetRevision: z.number().int().nonnegative(),
  keysetHash: hashSchema,
  policyRevision: z.number().int().nonnegative(),
  policyHash: hashSchema,
  stage: rolloutStageSchema,
  publishedAt: z.number().int().nonnegative(),
  previousReceiptHash: hashSchema.nullable(),
  approvalSignerHashes: z.array(hashSchema).min(1).max(64),
  publisherKeyId: keyIdSchema,
};
const signedPublicationReceiptSchema = z
  .object({
    ...publicationReceiptShape,
    signature: signatureSchema,
  })
  .strict();

const publicationStatePayloadSchema = z
  .object({
    schemaVersion: z.literal(2),
    authorityId: publicationIdSchema,
    highestAuthorityRevision: z.number().int().nonnegative(),
    authorityCanonicalHash: hashSchema,
    authority: signedPublicationAuthoritySchema,
    lastReceipt: signedPublicationReceiptSchema,
    lastSnapshot: signedSnapshotSchema,
    usedApprovalNonceHashes: z.array(hashSchema).max(MAX_USED_APPROVAL_NONCES),
    publisherKeyId: keyIdSchema,
  })
  .strict();
const publicationStateSchema = z
  .object({
    ...publicationStatePayloadSchema.shape,
    signature: signatureSchema,
  })
  .strict();

export type ModelFabricRolloutStage = z.infer<typeof rolloutStageSchema>;
export type UnsignedModelFabricPublicationAuthority = z.infer<
  typeof unsignedPublicationAuthoritySchema
>;
export type SignedModelFabricPublicationAuthority = z.infer<
  typeof signedPublicationAuthoritySchema
>;
export type UnsignedModelFabricPolicySnapshot = z.infer<
  typeof unsignedSnapshotSchema
>;
export type SignedModelFabricPolicySnapshot = z.infer<
  typeof signedSnapshotSchema
>;
export type SignedModelFabricPublicationApproval = z.infer<
  typeof signedPublicationApprovalSchema
>;
export type SignedModelFabricPublicationReceipt = z.infer<
  typeof signedPublicationReceiptSchema
>;
export type ModelFabricPublicationState = z.infer<
  typeof publicationStateSchema
>;

export interface PrepareSignedModelFabricPolicySnapshotInput {
  payload: unknown;
  pinnedRootPublicKey: string;
  rootsetPrivateKey: string;
  keysetPrivateKey: string;
  policyPrivateKey: string;
  previousSnapshot?: unknown | null;
  now?: number;
}

export interface CreateModelFabricPublicationApprovalInput {
  authority: unknown;
  authorityRootPublicKey: string;
  snapshot: unknown;
  snapshotRootPublicKey: string;
  approverId: string;
  approverPrivateKey: string;
  stage: ModelFabricRolloutStage;
  previousState?: unknown | null;
  now?: number;
  ttlMs?: number;
  nonce?: string;
}

export interface AuthorizeModelFabricPolicyPublicationInput {
  authority: unknown;
  authorityRootPublicKey: string;
  snapshot: unknown;
  snapshotRootPublicKey: string;
  approvals: readonly unknown[];
  stage: ModelFabricRolloutStage;
  publisherKeyId: string;
  publisherPrivateKey: string;
  previousState?: unknown | null;
  allowBootstrap?: boolean;
  now?: number;
  publicationId?: string;
}

export interface AuthorizedModelFabricPolicyPublication {
  snapshot: SignedModelFabricPolicySnapshot;
  receipt: SignedModelFabricPublicationReceipt;
  state: ModelFabricPublicationState;
}

export function canonicalizeModelFabricPublicationAuthority(
  authority: UnsignedModelFabricPublicationAuthority,
): string {
  return JSON.stringify({
    schemaVersion: authority.schemaVersion,
    authorityId: authority.authorityId.trim(),
    revision: authority.revision,
    issuedAt: authority.issuedAt,
    expiresAt: authority.expiresAt,
    signedBy: authority.signedBy.trim(),
    approvers: [...authority.approvers]
      .sort((left, right) => left.keyId.localeCompare(right.keyId))
      .map((approver) => ({
        keyId: approver.keyId.trim(),
        publicKey: approver.publicKey.trim(),
        status: approver.status,
        notBefore: approver.notBefore,
        notAfter: approver.notAfter,
        roles: [...approver.roles].map((role) => role.trim()).sort(),
      })),
    publishers: [...authority.publishers]
      .sort((left, right) => left.keyId.localeCompare(right.keyId))
      .map((publisher) => ({
        keyId: publisher.keyId.trim(),
        publicKey: publisher.publicKey.trim(),
        status: publisher.status,
        notBefore: publisher.notBefore,
        notAfter: publisher.notAfter,
      })),
    stages: [...authority.stages]
      .sort((left, right) => stageRank(left.stage) - stageRank(right.stage))
      .map((stage) => ({
        stage: stage.stage,
        requiredApprovals: stage.requiredApprovals,
        requiredRoles: [...stage.requiredRoles]
          .map((role) => role.trim())
          .sort(),
        ...(stage.requiresPriorStage
          ? { requiresPriorStage: stage.requiresPriorStage }
          : {}),
      })),
  });
}

export function canonicalizeModelFabricPublicationApproval(
  approval: Omit<SignedModelFabricPublicationApproval, 'signature'>,
): string {
  return JSON.stringify({
    schemaVersion: approval.schemaVersion,
    authorityId: approval.authorityId.trim(),
    authorityRevision: approval.authorityRevision,
    authorityHash: approval.authorityHash,
    snapshotHash: approval.snapshotHash,
    stage: approval.stage,
    approverId: approval.approverId.trim(),
    issuedAt: approval.issuedAt,
    expiresAt: approval.expiresAt,
    nonce: approval.nonce,
  });
}

export function canonicalizeModelFabricPublicationReceipt(
  receipt: Omit<SignedModelFabricPublicationReceipt, 'signature'>,
): string {
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    publicationId: receipt.publicationId.trim(),
    authorityId: receipt.authorityId.trim(),
    authorityRevision: receipt.authorityRevision,
    authorityHash: receipt.authorityHash,
    snapshotHash: receipt.snapshotHash,
    rootsetRevision: receipt.rootsetRevision,
    rootsetHash: receipt.rootsetHash,
    keysetRevision: receipt.keysetRevision,
    keysetHash: receipt.keysetHash,
    policyRevision: receipt.policyRevision,
    policyHash: receipt.policyHash,
    stage: receipt.stage,
    publishedAt: receipt.publishedAt,
    previousReceiptHash: receipt.previousReceiptHash,
    approvalSignerHashes: [...receipt.approvalSignerHashes].sort(),
    publisherKeyId: receipt.publisherKeyId.trim(),
  });
}

export function canonicalizeModelFabricPublicationState(
  state: Omit<ModelFabricPublicationState, 'signature'>,
): string {
  const snapshotIdentity = getSnapshotIdentity(state.lastSnapshot);
  return JSON.stringify({
    schemaVersion: state.schemaVersion,
    authorityId: state.authorityId.trim(),
    highestAuthorityRevision: state.highestAuthorityRevision,
    authorityCanonicalHash: state.authorityCanonicalHash,
    lastReceiptHash: hashSignedReceipt(state.lastReceipt),
    lastSnapshotHash: snapshotIdentity.snapshotHash,
    lastRootsetHash: snapshotIdentity.rootsetHash,
    lastKeysetHash: snapshotIdentity.keysetHash,
    lastPolicyHash: snapshotIdentity.policyHash,
    usedApprovalNonceHashes: [...state.usedApprovalNonceHashes].sort(),
    publisherKeyId: state.publisherKeyId.trim(),
  });
}

export function signModelFabricPublicationAuthority(input: {
  authority: unknown;
  rootPrivateKey: string;
  rootPublicKey: string;
  now?: number;
}): SignedModelFabricPublicationAuthority {
  const authority = parseSchema(
    unsignedPublicationAuthoritySchema,
    input.authority,
    'Model Fabric publication authority failed validation',
  );
  validatePublicationAuthority(authority, input.now ?? Date.now(), false);
  assertPrivateKeyMatchesPublicKey(
    input.rootPrivateKey,
    input.rootPublicKey,
    'Publication authority root private key does not match its public key',
  );
  const signature = signCanonical(
    canonicalizeModelFabricPublicationAuthority(authority),
    input.rootPrivateKey,
    'Publication authority could not be signed',
  );
  const signedAuthority = signedPublicationAuthoritySchema.parse({
    ...authority,
    signature,
  });
  verifyModelFabricPublicationAuthority({
    authority: signedAuthority,
    rootPublicKey: input.rootPublicKey,
    now: input.now,
  });
  return signedAuthority;
}

export function verifyModelFabricPublicationAuthority(input: {
  authority: unknown;
  rootPublicKey: string;
  now?: number;
  allowExpired?: boolean;
}): SignedModelFabricPublicationAuthority {
  const authority = parseSchema(
    signedPublicationAuthoritySchema,
    input.authority,
    'Model Fabric publication authority failed validation',
  );
  validatePublicationAuthority(
    authority,
    input.now ?? Date.now(),
    input.allowExpired ?? false,
  );
  assertValidEd25519PublicKey(
    input.rootPublicKey,
    'Publication authority root public key is invalid',
  );
  verifyCanonicalSignature(
    canonicalizeModelFabricPublicationAuthority(authority),
    input.rootPublicKey,
    authority.signature,
    'Publication authority signature verification failed',
  );
  return authority;
}

export function prepareSignedModelFabricPolicySnapshot(
  input: PrepareSignedModelFabricPolicySnapshotInput,
): SignedModelFabricPolicySnapshot {
  const unsigned = parseSchema(
    unsignedSnapshotSchema,
    input.payload,
    'Unsigned Model Fabric snapshot failed validation',
  );
  validateUnsignedSnapshot(unsigned);

  const rootsetSigner = unsigned.rootset.roots.find(
    (root) => root.keyId === unsigned.rootset.signedBy,
  );
  if (!rootsetSigner) {
    throw new Error('Rootset signing key is not present in the rootset');
  }
  const keysetSigner = unsigned.rootset.roots.find(
    (root) => root.keyId === unsigned.keyset.rootKeyId,
  );
  if (!keysetSigner || keysetSigner.status !== 'active') {
    throw new Error('Keyset root signing key is not active in the rootset');
  }
  const policySigner = unsigned.keyset.keys.find(
    (key) => key.keyId === unsigned.policy.keyId,
  );
  if (!policySigner || policySigner.status !== 'active') {
    throw new Error('Policy signing key is not active in the delegated keyset');
  }

  assertPrivateKeyMatchesPublicKey(
    input.rootsetPrivateKey,
    rootsetSigner.publicKey,
    'Rootset private key does not match the declared signer',
  );
  assertPrivateKeyMatchesPublicKey(
    input.keysetPrivateKey,
    keysetSigner.publicKey,
    'Keyset private key does not match the declared root signer',
  );
  assertPrivateKeyMatchesPublicKey(
    input.policyPrivateKey,
    policySigner.publicKey,
    'Policy private key does not match the declared delegated signer',
  );

  const snapshot = signedSnapshotSchema.parse({
    schemaVersion: 3,
    rootset: {
      ...unsigned.rootset,
      signature: signCanonical(
        canonicalizeSignedModelFabricRootset(unsigned.rootset),
        input.rootsetPrivateKey,
        'Rootset could not be signed',
      ),
    },
    keyset: {
      ...unsigned.keyset,
      signature: signCanonical(
        canonicalizeCrossSignedModelFabricKeyset(unsigned.keyset),
        input.keysetPrivateKey,
        'Delegated keyset could not be signed',
      ),
    },
    policy: {
      ...unsigned.policy,
      signature: signCanonical(
        canonicalizeSignedModelFabricPolicy(unsigned.policy),
        input.policyPrivateKey,
        'Policy could not be signed',
      ),
    },
  });
  return verifyPreparedModelFabricPolicySnapshot({
    snapshot,
    rootPublicKey: input.pinnedRootPublicKey,
    previousSnapshot: input.previousSnapshot,
    now: input.now,
  });
}

export function verifyPreparedModelFabricPolicySnapshot(input: {
  snapshot: unknown;
  rootPublicKey: string;
  previousSnapshot?: unknown | null;
  now?: number;
}): SignedModelFabricPolicySnapshot {
  const snapshot = parseSchema(
    signedSnapshotSchema,
    input.snapshot,
    'Signed Model Fabric snapshot failed validation',
  );
  validateSignedSnapshotStructure(snapshot);
  const previousSnapshot =
    input.previousSnapshot === undefined || input.previousSnapshot === null
      ? null
      : parseSchema(
          signedSnapshotSchema,
          input.previousSnapshot,
          'Previous signed Model Fabric snapshot failed validation',
        );
  if (previousSnapshot) validateSignedSnapshotStructure(previousSnapshot);
  const runtimeResult = verifyControlPlaneModelFabricPolicySnapshot({
    content: Buffer.from(JSON.stringify(snapshot)),
    publicKey: input.rootPublicKey,
    authenticatedPreviousContent: previousSnapshot
      ? Buffer.from(JSON.stringify(previousSnapshot))
      : null,
    now: input.now,
  });
  if (runtimeResult.error) {
    throw new Error(
      `Signed Model Fabric snapshot failed runtime verification: ${runtimeResult.error}`,
    );
  }
  return snapshot;
}

function verifyAuthenticatedRetainedModelFabricPolicySnapshot(input: {
  snapshot: unknown;
  rootPublicKey: string;
  now?: number;
}): SignedModelFabricPolicySnapshot {
  const snapshot = parseSchema(
    signedSnapshotSchema,
    input.snapshot,
    'Signed Model Fabric snapshot failed validation',
  );
  validateSignedSnapshotStructure(snapshot);
  const runtimeResult =
    verifyAuthenticatedCachedControlPlaneModelFabricPolicySnapshot({
      content: Buffer.from(JSON.stringify(snapshot)),
      publicKey: input.rootPublicKey,
      now: input.now,
      allowExpired: true,
    });
  if (runtimeResult.error) {
    throw new Error(
      `Signed Model Fabric snapshot failed runtime verification: ${runtimeResult.error}`,
    );
  }
  return snapshot;
}

export function createModelFabricPublicationApproval(
  input: CreateModelFabricPublicationApprovalInput,
): SignedModelFabricPublicationApproval {
  const now = input.now ?? Date.now();
  const authority = verifyModelFabricPublicationAuthority({
    authority: input.authority,
    rootPublicKey: input.authorityRootPublicKey,
    now,
  });
  const stagePolicy = getStagePolicy(authority, input.stage);
  const previousState =
    input.previousState === undefined || input.previousState === null
      ? null
      : verifyModelFabricPublicationState({
          state: input.previousState,
          rootPublicKey: input.authorityRootPublicKey,
          snapshotRootPublicKey: input.snapshotRootPublicKey,
          now,
        });
  if (previousState) {
    validateAuthorityTransition(previousState.authority, authority);
  }
  const snapshot = verifyPreparedModelFabricPolicySnapshot({
    snapshot: input.snapshot,
    rootPublicKey: input.snapshotRootPublicKey,
    previousSnapshot: previousState?.lastSnapshot,
    now,
  });
  if (previousState) {
    validateRolloutTransition(
      previousState.lastReceipt,
      getSnapshotIdentity(snapshot),
      input.stage,
      stagePolicy.requiresPriorStage,
    );
  }
  const approver = authority.approvers.find(
    (candidate) => candidate.keyId === input.approverId,
  );
  if (!approver || approver.status !== 'active') {
    throw new Error('Publication approver is not active');
  }
  if (approver.notBefore > now || approver.notAfter <= now) {
    throw new Error('Publication approver is outside its validity window');
  }
  assertPrivateKeyMatchesPublicKey(
    input.approverPrivateKey,
    approver.publicKey,
    'Publication approver private key does not match the authority manifest',
  );
  const ttlMs = normalizeApprovalTtl(input.ttlMs);
  const expiresAt = Math.min(
    now + ttlMs,
    approver.notAfter,
    authority.expiresAt,
  );
  if (expiresAt <= now) {
    throw new Error('Publication approval would already be expired');
  }
  const approvalPayload = {
    schemaVersion: 1 as const,
    authorityId: authority.authorityId,
    authorityRevision: authority.revision,
    authorityHash: hashCanonicalAuthority(authority),
    snapshotHash: getSnapshotIdentity(snapshot).snapshotHash,
    stage: input.stage,
    approverId: approver.keyId,
    issuedAt: now,
    expiresAt,
    nonce: normalizeApprovalNonce(input.nonce),
  };
  return signedPublicationApprovalSchema.parse({
    ...approvalPayload,
    signature: signCanonical(
      canonicalizeModelFabricPublicationApproval(approvalPayload),
      input.approverPrivateKey,
      'Publication approval could not be signed',
    ),
  });
}

export function authorizeModelFabricPolicyPublication(
  input: AuthorizeModelFabricPolicyPublicationInput,
): AuthorizedModelFabricPolicyPublication {
  const now = input.now ?? Date.now();
  const authority = verifyModelFabricPublicationAuthority({
    authority: input.authority,
    rootPublicKey: input.authorityRootPublicKey,
    now,
  });
  const stagePolicy = getStagePolicy(authority, input.stage);
  const previousState =
    input.previousState === undefined || input.previousState === null
      ? null
      : verifyModelFabricPublicationState({
          state: input.previousState,
          rootPublicKey: input.authorityRootPublicKey,
          snapshotRootPublicKey: input.snapshotRootPublicKey,
          now,
        });
  const snapshot = verifyPreparedModelFabricPolicySnapshot({
    snapshot: input.snapshot,
    rootPublicKey: input.snapshotRootPublicKey,
    previousSnapshot: previousState?.lastSnapshot,
    now,
  });
  const snapshotIdentity = getSnapshotIdentity(snapshot);

  if (previousState) {
    validateAuthorityTransition(previousState.authority, authority);
    validateRolloutTransition(
      previousState.lastReceipt,
      snapshotIdentity,
      input.stage,
      stagePolicy.requiresPriorStage,
    );
  } else {
    if (!input.allowBootstrap) {
      throw new Error(
        'Initial publication requires explicit bootstrap authorization',
      );
    }
    if (stagePolicy.requiresPriorStage) {
      throw new Error(
        `Publication stage ${input.stage} requires a prior ${stagePolicy.requiresPriorStage} receipt`,
      );
    }
  }

  const usedNonceHashes = new Set(previousState?.usedApprovalNonceHashes ?? []);
  if (input.approvals.length > 64) {
    throw new Error('Too many publication approvals were supplied');
  }
  const verifiedApprovals = input.approvals.map((approval) =>
    verifyPublicationApproval({
      approval,
      authority,
      snapshotHash: snapshotIdentity.snapshotHash,
      stage: input.stage,
      now,
      usedNonceHashes,
    }),
  );
  const distinctApprovers = new Map(
    verifiedApprovals.map((approval) => [approval.approver.keyId, approval]),
  );
  if (distinctApprovers.size !== verifiedApprovals.length) {
    throw new Error('Publication approvals must come from distinct approvers');
  }
  if (distinctApprovers.size < stagePolicy.requiredApprovals) {
    throw new Error(
      `Publication stage ${input.stage} requires ${stagePolicy.requiredApprovals} distinct approvals`,
    );
  }
  const approvedRoles = new Set(
    [...distinctApprovers.values()].flatMap(({ approver }) => approver.roles),
  );
  const missingRoles = stagePolicy.requiredRoles.filter(
    (role) => !approvedRoles.has(role),
  );
  if (missingRoles.length > 0) {
    throw new Error(
      `Publication approvals are missing required roles: ${missingRoles.join(', ')}`,
    );
  }

  const publisher = authority.publishers.find(
    (candidate) => candidate.keyId === input.publisherKeyId,
  );
  if (!publisher || publisher.status !== 'active') {
    throw new Error('Publication signer is not active');
  }
  if (publisher.notBefore > now || publisher.notAfter <= now) {
    throw new Error('Publication signer is outside its validity window');
  }
  assertPrivateKeyMatchesPublicKey(
    input.publisherPrivateKey,
    publisher.publicKey,
    'Publication signer private key does not match the authority manifest',
  );

  const receiptPayload = {
    schemaVersion: 1 as const,
    publicationId:
      input.publicationId ?? `publication-${randomBytes(16).toString('hex')}`,
    authorityId: authority.authorityId,
    authorityRevision: authority.revision,
    authorityHash: hashCanonicalAuthority(authority),
    ...snapshotIdentity,
    stage: input.stage,
    publishedAt: now,
    previousReceiptHash: previousState
      ? hashSignedReceipt(previousState.lastReceipt)
      : null,
    approvalSignerHashes: [...distinctApprovers.keys()]
      .map(hashApproverIdentity)
      .sort(),
    publisherKeyId: publisher.keyId,
  };
  const receipt = signedPublicationReceiptSchema.parse({
    ...receiptPayload,
    signature: signCanonical(
      canonicalizeModelFabricPublicationReceipt(receiptPayload),
      input.publisherPrivateKey,
      'Publication receipt could not be signed',
    ),
  });
  verifyPublicationReceipt(receipt, authority, false, now);

  const nonceHashes = verifiedApprovals.map(({ nonceHash }) => nonceHash);
  if (usedNonceHashes.size + nonceHashes.length > MAX_USED_APPROVAL_NONCES) {
    throw new Error('Publication approval replay ledger is full');
  }
  const statePayload = publicationStatePayloadSchema.parse({
    schemaVersion: 2,
    authorityId: authority.authorityId,
    highestAuthorityRevision: authority.revision,
    authorityCanonicalHash: hashCanonicalAuthority(authority),
    authority,
    lastReceipt: receipt,
    lastSnapshot: snapshot,
    usedApprovalNonceHashes: [...usedNonceHashes, ...nonceHashes].sort(),
    publisherKeyId: publisher.keyId,
  });
  const state = publicationStateSchema.parse({
    ...statePayload,
    signature: signCanonical(
      canonicalizeModelFabricPublicationState(statePayload),
      input.publisherPrivateKey,
      'Publication state could not be signed',
    ),
  });
  return {
    snapshot,
    receipt,
    state: verifyModelFabricPublicationState({
      state,
      rootPublicKey: input.authorityRootPublicKey,
      snapshotRootPublicKey: input.snapshotRootPublicKey,
      now,
    }),
  };
}

export function verifyModelFabricPublicationState(input: {
  state: unknown;
  rootPublicKey: string;
  snapshotRootPublicKey?: string;
  now?: number;
}): ModelFabricPublicationState {
  const state = parseSchema(
    publicationStateSchema,
    input.state,
    'Model Fabric publication state failed validation',
  );
  const authority = verifyModelFabricPublicationAuthority({
    authority: state.authority,
    rootPublicKey: input.rootPublicKey,
    now: input.now,
    allowExpired: true,
  });
  const authorityHash = hashCanonicalAuthority(authority);
  if (
    state.authorityId !== authority.authorityId ||
    state.highestAuthorityRevision !== authority.revision ||
    state.authorityCanonicalHash !== authorityHash
  ) {
    throw new Error(
      'Model Fabric publication state authority watermark failed',
    );
  }
  if (
    new Set(state.usedApprovalNonceHashes).size !==
    state.usedApprovalNonceHashes.length
  ) {
    throw new Error('Model Fabric publication state contains duplicate nonces');
  }
  const sortedNonceHashes = [...state.usedApprovalNonceHashes].sort();
  if (
    sortedNonceHashes.some(
      (nonceHash, index) => nonceHash !== state.usedApprovalNonceHashes[index],
    )
  ) {
    throw new Error(
      'Model Fabric publication state nonce ledger is not canonical',
    );
  }
  if (state.publisherKeyId !== state.lastReceipt.publisherKeyId) {
    throw new Error('Model Fabric publication state publisher mismatch');
  }
  const publisher = authority.publishers.find(
    (candidate) => candidate.keyId === state.publisherKeyId,
  );
  if (!publisher) {
    throw new Error('Model Fabric publication state signer is not trusted');
  }
  verifyCanonicalSignature(
    canonicalizeModelFabricPublicationState(state),
    publisher.publicKey,
    state.signature,
    'Model Fabric publication state signature verification failed',
  );
  verifyPublicationReceipt(
    state.lastReceipt,
    authority,
    true,
    input.now ?? Date.now(),
  );
  if (
    state.lastReceipt.authorityId !== authority.authorityId ||
    state.lastReceipt.authorityRevision !== authority.revision ||
    state.lastReceipt.authorityHash !== authorityHash
  ) {
    throw new Error('Model Fabric publication receipt authority mismatch');
  }
  const snapshot = verifyAuthenticatedRetainedModelFabricPolicySnapshot({
    snapshot: state.lastSnapshot,
    rootPublicKey: input.snapshotRootPublicKey ?? input.rootPublicKey,
    now: input.now,
  });
  const snapshotIdentity = getSnapshotIdentity(snapshot);
  if (
    state.lastReceipt.snapshotHash !== snapshotIdentity.snapshotHash ||
    state.lastReceipt.rootsetRevision !== snapshotIdentity.rootsetRevision ||
    state.lastReceipt.rootsetHash !== snapshotIdentity.rootsetHash ||
    state.lastReceipt.keysetRevision !== snapshotIdentity.keysetRevision ||
    state.lastReceipt.keysetHash !== snapshotIdentity.keysetHash ||
    state.lastReceipt.policyRevision !== snapshotIdentity.policyRevision ||
    state.lastReceipt.policyHash !== snapshotIdentity.policyHash
  ) {
    throw new Error('Model Fabric publication state snapshot watermark failed');
  }
  return state;
}

export function getModelFabricPolicySnapshotHash(snapshot: unknown): string {
  return getSnapshotIdentity(
    parseSchema(
      signedSnapshotSchema,
      snapshot,
      'Signed Model Fabric snapshot failed validation',
    ),
  ).snapshotHash;
}

function validatePublicationAuthority(
  authority: UnsignedModelFabricPublicationAuthority,
  now: number,
  allowExpired: boolean,
): void {
  if (authority.expiresAt <= authority.issuedAt) {
    throw new Error('Publication authority validity window is invalid');
  }
  if (authority.issuedAt > now + MAX_CLOCK_SKEW_MS) {
    throw new Error('Publication authority is not valid yet');
  }
  if (!allowExpired && authority.expiresAt <= now) {
    throw new Error('Publication authority has expired');
  }
  assertUnique(authority.approvers, (item) => item.keyId, 'approver IDs');
  assertUnique(authority.publishers, (item) => item.keyId, 'publisher IDs');
  assertUnique(authority.stages, (item) => item.stage, 'rollout stages');
  for (const approver of authority.approvers) {
    validateTrustKey(approver, 'Publication approver');
    assertUnique(approver.roles, (role) => role, 'approver roles');
  }
  for (const publisher of authority.publishers) {
    validateTrustKey(publisher, 'Publication signer');
  }
  const canary = authority.stages.find((stage) => stage.stage === 'canary');
  const production = authority.stages.find(
    (stage) => stage.stage === 'production',
  );
  if (!canary || !production) {
    throw new Error('Publication authority must define canary and production');
  }
  if (canary.requiresPriorStage !== undefined) {
    throw new Error('Canary publication must not require a prior stage');
  }
  if (production.requiresPriorStage !== 'canary') {
    throw new Error('Production publication must require the canary stage');
  }
  const activeApprovers = authority.approvers.filter(
    (approver) => approver.status === 'active',
  );
  for (const stage of authority.stages) {
    assertUnique(stage.requiredRoles, (role) => role, 'required roles');
    if (stage.requiredApprovals > activeApprovers.length) {
      throw new Error(
        `Publication stage ${stage.stage} requires more active approvers than are configured`,
      );
    }
    const activeRoles = new Set(
      activeApprovers.flatMap((approver) => approver.roles),
    );
    const missingRoles = stage.requiredRoles.filter(
      (role) => !activeRoles.has(role),
    );
    if (missingRoles.length > 0) {
      throw new Error(
        `Publication stage ${stage.stage} references roles without active approvers`,
      );
    }
  }
}

function validateUnsignedSnapshot(
  snapshot: UnsignedModelFabricPolicySnapshot,
): void {
  validateTrustCollection(snapshot.rootset.roots, 'root keys');
  validateTrustCollection(snapshot.keyset.keys, 'delegated signing keys');
  if (snapshot.rootset.expiresAt <= snapshot.rootset.issuedAt) {
    throw new Error('Rootset validity window is invalid');
  }
  if (snapshot.keyset.expiresAt <= snapshot.keyset.issuedAt) {
    throw new Error('Delegated keyset validity window is invalid');
  }
  if (snapshot.policy.expiresAt <= snapshot.policy.issuedAt) {
    throw new Error('Policy validity window is invalid');
  }
}

function validateSignedSnapshotStructure(
  snapshot: SignedModelFabricPolicySnapshot,
): void {
  validateTrustCollection(snapshot.rootset.roots, 'root keys');
  validateTrustCollection(snapshot.keyset.keys, 'delegated signing keys');
}

function validateTrustCollection(
  keys: readonly z.infer<typeof trustKeySchema>[],
  label: string,
): void {
  assertUnique(keys, (key) => key.keyId, label);
  for (const key of keys) validateTrustKey(key, label);
}

function validateTrustKey(
  key: z.infer<typeof trustKeySchema>,
  label: string,
): void {
  if (key.notAfter <= key.notBefore) {
    throw new Error(`${label} validity window is invalid`);
  }
  assertValidEd25519PublicKey(
    key.publicKey,
    `${label} contains an invalid Ed25519 public key`,
  );
}

function verifyPublicationApproval(input: {
  approval: unknown;
  authority: SignedModelFabricPublicationAuthority;
  snapshotHash: string;
  stage: ModelFabricRolloutStage;
  now: number;
  usedNonceHashes: ReadonlySet<string>;
}): {
  approval: SignedModelFabricPublicationApproval;
  approver: SignedModelFabricPublicationAuthority['approvers'][number];
  nonceHash: string;
} {
  const approval = parseSchema(
    signedPublicationApprovalSchema,
    input.approval,
    'Model Fabric publication approval failed validation',
  );
  const authorityHash = hashCanonicalAuthority(input.authority);
  if (
    approval.authorityId !== input.authority.authorityId ||
    approval.authorityRevision !== input.authority.revision ||
    approval.authorityHash !== authorityHash ||
    approval.snapshotHash !== input.snapshotHash ||
    approval.stage !== input.stage
  ) {
    throw new Error('Publication approval is bound to a different release');
  }
  if (approval.issuedAt > input.now + MAX_CLOCK_SKEW_MS) {
    throw new Error('Publication approval is not valid yet');
  }
  if (
    approval.expiresAt <= input.now ||
    approval.expiresAt <= approval.issuedAt ||
    approval.expiresAt > input.authority.expiresAt
  ) {
    throw new Error('Publication approval has expired or is invalid');
  }
  const approver = input.authority.approvers.find(
    (candidate) => candidate.keyId === approval.approverId,
  );
  if (!approver || approver.status !== 'active') {
    throw new Error('Publication approval signer is not active');
  }
  if (
    approval.issuedAt < approver.notBefore ||
    approval.expiresAt > approver.notAfter
  ) {
    throw new Error('Publication approval exceeds signer validity');
  }
  verifyCanonicalSignature(
    canonicalizeModelFabricPublicationApproval(approval),
    approver.publicKey,
    approval.signature,
    'Publication approval signature verification failed',
  );
  const nonceHash = hashApprovalNonce(approval);
  if (input.usedNonceHashes.has(nonceHash)) {
    throw new Error('Publication approval replay was rejected');
  }
  return { approval, approver, nonceHash };
}

function verifyPublicationReceipt(
  receiptInput: unknown,
  authority: SignedModelFabricPublicationAuthority,
  historical: boolean,
  now: number,
): SignedModelFabricPublicationReceipt {
  const receipt = parseSchema(
    signedPublicationReceiptSchema,
    receiptInput,
    'Model Fabric publication receipt failed validation',
  );
  const publisher = authority.publishers.find(
    (candidate) => candidate.keyId === receipt.publisherKeyId,
  );
  if (!publisher || (!historical && publisher.status !== 'active')) {
    throw new Error('Publication receipt signer is not trusted');
  }
  if (
    receipt.publishedAt < publisher.notBefore ||
    receipt.publishedAt >= publisher.notAfter ||
    receipt.publishedAt < authority.issuedAt ||
    receipt.publishedAt >= authority.expiresAt ||
    receipt.publishedAt > now + MAX_CLOCK_SKEW_MS
  ) {
    throw new Error('Publication receipt exceeds signer validity');
  }
  if (
    new Set(receipt.approvalSignerHashes).size !==
    receipt.approvalSignerHashes.length
  ) {
    throw new Error('Publication receipt contains duplicate approvers');
  }
  verifyCanonicalSignature(
    canonicalizeModelFabricPublicationReceipt(receipt),
    publisher.publicKey,
    receipt.signature,
    'Publication receipt signature verification failed',
  );
  return receipt;
}

function validateAuthorityTransition(
  previous: SignedModelFabricPublicationAuthority,
  next: SignedModelFabricPublicationAuthority,
): void {
  if (previous.authorityId !== next.authorityId) {
    throw new Error('Publication authority identity change was rejected');
  }
  if (next.revision < previous.revision) {
    throw new Error('Publication authority rollback was rejected');
  }
  const previousHash = hashCanonicalAuthority(previous);
  const nextHash = hashCanonicalAuthority(next);
  if (next.revision === previous.revision) {
    if (nextHash !== previousHash) {
      throw new Error('Publication authority revision conflict was rejected');
    }
    return;
  }
  validateAuthorityKeyHistory(previous.approvers, next.approvers, 'approver');
  validateAuthorityKeyHistory(
    previous.publishers,
    next.publishers,
    'publisher',
  );
}

function validateAuthorityKeyHistory(
  previous: readonly z.infer<typeof trustKeySchema>[],
  next: readonly z.infer<typeof trustKeySchema>[],
  label: string,
): void {
  const nextById = new Map(next.map((key) => [key.keyId, key]));
  for (const previousKey of previous) {
    const nextKey = nextById.get(previousKey.keyId);
    if (!nextKey) {
      throw new Error(`Publication ${label} history truncation was rejected`);
    }
    if (!hasSameTrustKeyIdentity(previousKey, nextKey)) {
      throw new Error(`Publication ${label} identity conflict was rejected`);
    }
    if (previousKey.status === 'revoked' && nextKey.status !== 'revoked') {
      throw new Error(`Publication ${label} revocation rollback was rejected`);
    }
  }
}

function validateRolloutTransition(
  previous: SignedModelFabricPublicationReceipt,
  next: SnapshotIdentity,
  stage: ModelFabricRolloutStage,
  requiredPriorStage: ModelFabricRolloutStage | undefined,
): void {
  if (requiredPriorStage) {
    if (
      previous.stage !== requiredPriorStage ||
      previous.snapshotHash !== next.snapshotHash
    ) {
      throw new Error(
        `Publication stage ${stage} requires the exact previously published ${requiredPriorStage} snapshot`,
      );
    }
    return;
  }
  if (previous.snapshotHash === next.snapshotHash) {
    throw new Error('This Model Fabric snapshot stage was already published');
  }
  validateRevisionTransition(
    previous.rootsetRevision,
    previous.rootsetHash,
    next.rootsetRevision,
    next.rootsetHash,
    'rootset',
  );
  validateRevisionTransition(
    previous.keysetRevision,
    previous.keysetHash,
    next.keysetRevision,
    next.keysetHash,
    'keyset',
  );
  validateRevisionTransition(
    previous.policyRevision,
    previous.policyHash,
    next.policyRevision,
    next.policyHash,
    'policy',
  );
  if (
    next.rootsetRevision === previous.rootsetRevision &&
    next.keysetRevision === previous.keysetRevision &&
    next.policyRevision === previous.policyRevision
  ) {
    throw new Error('A new canary requires at least one revision advance');
  }
}

function validateRevisionTransition(
  previousRevision: number,
  previousHash: string,
  nextRevision: number,
  nextHash: string,
  label: string,
): void {
  if (nextRevision < previousRevision) {
    throw new Error(`Publication ${label} rollback was rejected`);
  }
  if (nextRevision === previousRevision && nextHash !== previousHash) {
    throw new Error(`Publication ${label} revision conflict was rejected`);
  }
}

interface SnapshotIdentity {
  snapshotHash: string;
  rootsetRevision: number;
  rootsetHash: string;
  keysetRevision: number;
  keysetHash: string;
  policyRevision: number;
  policyHash: string;
}

function getSnapshotIdentity(
  snapshot: SignedModelFabricPolicySnapshot,
): SnapshotIdentity {
  const rootsetHash = hashSignedComponent(
    canonicalizeSignedModelFabricRootset(snapshot.rootset),
    snapshot.rootset.signature,
  );
  const keysetHash = hashSignedComponent(
    canonicalizeCrossSignedModelFabricKeyset(snapshot.keyset),
    snapshot.keyset.signature,
  );
  const policyHash = hashSignedComponent(
    canonicalizeSignedModelFabricPolicy(snapshot.policy),
    snapshot.policy.signature,
  );
  return {
    snapshotHash: sha256(
      JSON.stringify({
        schemaVersion: snapshot.schemaVersion,
        rootsetHash,
        keysetHash,
        policyHash,
      }),
    ),
    rootsetRevision: snapshot.rootset.revision,
    rootsetHash,
    keysetRevision: snapshot.keyset.revision,
    keysetHash,
    policyRevision: snapshot.policy.revision,
    policyHash,
  };
}

function getStagePolicy(
  authority: SignedModelFabricPublicationAuthority,
  stage: ModelFabricRolloutStage,
): SignedModelFabricPublicationAuthority['stages'][number] {
  const policy = authority.stages.find(
    (candidate) => candidate.stage === stage,
  );
  if (!policy) throw new Error(`Publication stage ${stage} is not configured`);
  return policy;
}

function hashCanonicalAuthority(
  authority: UnsignedModelFabricPublicationAuthority,
): string {
  return sha256(canonicalizeModelFabricPublicationAuthority(authority));
}

function hashSignedComponent(canonical: string, signature: string): string {
  return sha256(JSON.stringify({ canonical, signature }));
}

function hashSignedReceipt(
  receipt: SignedModelFabricPublicationReceipt,
): string {
  return sha256(
    JSON.stringify({
      canonical: canonicalizeModelFabricPublicationReceipt(receipt),
      signature: receipt.signature,
    }),
  );
}

function hashApprovalNonce(
  approval: SignedModelFabricPublicationApproval,
): string {
  return sha256(
    `model-fabric-approval\0${approval.authorityId}\0${approval.approverId}\0${approval.nonce}`,
  );
}

function hashApproverIdentity(approverId: string): string {
  return sha256(`model-fabric-approver\0${approverId}`);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function signCanonical(
  canonical: string,
  privateKey: string,
  errorMessage: string,
): string {
  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
    return sign(null, Buffer.from(canonical), key).toString('base64');
  } catch {
    throw new Error(errorMessage);
  }
}

function verifyCanonicalSignature(
  canonical: string,
  publicKey: string,
  encodedSignature: string,
  errorMessage: string,
): void {
  const signature = decodeCanonicalBase64(encodedSignature);
  if (!signature) throw new Error(errorMessage);
  try {
    const key = createPublicKey(publicKey);
    if (
      key.asymmetricKeyType !== 'ed25519' ||
      !verify(null, Buffer.from(canonical), key, signature)
    ) {
      throw new Error('invalid signature');
    }
  } catch {
    throw new Error(errorMessage);
  }
}

function assertPrivateKeyMatchesPublicKey(
  privateKey: string,
  publicKey: string,
  errorMessage: string,
): void {
  try {
    const privateKeyObject = createPrivateKey(privateKey);
    const publicKeyObject = createPublicKey(publicKey);
    if (
      privateKeyObject.asymmetricKeyType !== 'ed25519' ||
      publicKeyObject.asymmetricKeyType !== 'ed25519' ||
      fingerprintPublicKey(createPublicKey(privateKeyObject)) !==
        fingerprintPublicKey(publicKeyObject)
    ) {
      throw new Error('key mismatch');
    }
  } catch {
    throw new Error(errorMessage);
  }
}

function assertValidEd25519PublicKey(
  publicKey: string,
  errorMessage: string,
): void {
  try {
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
  } catch {
    throw new Error(errorMessage);
  }
}

function hasSameTrustKeyIdentity(
  previous: z.infer<typeof trustKeySchema>,
  next: z.infer<typeof trustKeySchema>,
): boolean {
  try {
    return (
      fingerprintPublicKey(createPublicKey(previous.publicKey)) ===
        fingerprintPublicKey(createPublicKey(next.publicKey)) &&
      previous.notBefore === next.notBefore &&
      previous.notAfter === next.notAfter
    );
  } catch {
    return false;
  }
}

function fingerprintPublicKey(key: ReturnType<typeof createPublicKey>): string {
  return sha256(key.export({ type: 'spki', format: 'der' }));
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

function normalizeApprovalTtl(value: number | undefined): number {
  if (value === undefined) return DEFAULT_APPROVAL_TTL_MS;
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_APPROVAL_TTL_MS ||
    value > MAX_APPROVAL_TTL_MS
  ) {
    throw new Error('Publication approval TTL is outside the allowed range');
  }
  return value;
}

function normalizeApprovalNonce(value: string | undefined): string {
  const nonce = value ?? randomBytes(16).toString('hex');
  if (!/^[a-f0-9]{32,128}$/.test(nonce)) {
    throw new Error('Publication approval nonce is invalid');
  }
  return nonce;
}

function assertUnique<T>(
  values: readonly T[],
  select: (value: T) => string,
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = select(value);
    if (seen.has(key)) throw new Error(`Duplicate ${label} are not allowed`);
    seen.add(key);
  }
}

function stageRank(stage: ModelFabricRolloutStage): number {
  return stage === 'canary' ? 0 : 1;
}

function parseSchema<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown,
  errorMessage: string,
): z.infer<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(errorMessage);
  return result.data;
}
