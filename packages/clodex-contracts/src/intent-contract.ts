import {
  assertCanonicalString,
  canonicalizeJson,
  decodeUtf8,
  encodeUtf8,
  parseCanonicalJson,
} from './canonical-json.js';

export const INTENT_CONTRACT_KIND = 'clodex.intent-contract' as const;
export const INTENT_CONTRACT_SPEC_VERSION = '1.0.0' as const;
export const INTENT_CONTRACT_PAYLOAD_TYPE =
  'application/vnd.clodex.intent-contract.v1+jcs' as const;
export const EXECUTION_TICKET_PAYLOAD_TYPE =
  'application/vnd.clodex.execution-ticket.v1+jcs' as const;
export const EFFECT_ATTESTATION_PAYLOAD_TYPE =
  'application/vnd.clodex.effect-attestation.v1+jcs' as const;
export const INTENT_CONTRACT_HASH_DOMAIN = 'clodex.intent-contract.v1' as const;
export const SAFE_CODING_ACTION_HASH_DOMAIN =
  'clodex.safe-coding-action.v1' as const;
export const SIGNATURE_ALGORITHM = 'P-256-SHA256-P1363' as const;

export const EXECUTION_TICKET_KIND = 'clodex.execution-ticket' as const;
export const EFFECT_ATTESTATION_KIND = 'clodex.effect-attestation' as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const MAX_FILESYSTEM_PERMISSIONS = 1_024;
const MAX_GIT_PERMISSIONS = 2;
const MAX_TEST_PROFILES = 256;
const MAX_EFFECT_CLASSES = 3;
const MAX_CONTRACT_NOTES = 64;
const MAX_ENVELOPE_SIGNATURES = 16;
const MAX_ENVELOPE_PAYLOAD_BYTES = 12 * 1024 * 1024;
const MIN_TICKET_NONCE_BYTES = 16;
const MAX_TICKET_NONCE_BYTES = 96;
const P256_P1363_SIGNATURE_BYTES = 64;

export type ResourceSelector =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'tree'; readonly path: string };

export type SafeCodingFilesystemActionKind =
  | 'filesystem.stat'
  | 'filesystem.list'
  | 'filesystem.read'
  | 'filesystem.create'
  | 'filesystem.replace'
  | 'filesystem.mkdir';

export type SafeCodingGitActionKind = 'git.status' | 'git.diff';

export interface SafeCodingFilesystemPermission {
  readonly action: SafeCodingFilesystemActionKind;
  readonly selector: ResourceSelector;
}

export interface SafeCodingGitPermission {
  readonly action: SafeCodingGitActionKind;
}

export type SafeCodingEffectClass =
  | 'local.observation'
  | 'local.reversible'
  | 'sandbox.ephemeral';

export interface SafeCodingAuthority {
  readonly filesystem: readonly SafeCodingFilesystemPermission[];
  readonly git: readonly SafeCodingGitPermission[];
  readonly testProfiles: readonly string[];
  readonly allowedEffectClasses: readonly SafeCodingEffectClass[];
  readonly limits: {
    readonly maxUniqueModifiedFiles: number;
    readonly maxMutationBytes: number;
    readonly maxTestRuns: number;
  };
  /** Initial safe-coding profile: these capabilities are hard denied. */
  readonly ambientAuthority: {
    readonly network: false;
    readonly secrets: false;
    readonly shell: false;
    readonly delete: false;
    readonly gitCommit: false;
    readonly gitPush: false;
  };
  readonly delegation: {
    readonly allowed: boolean;
    readonly maxDepth: number;
  };
}

export interface SafeCodingSubject {
  readonly principalId: string;
  readonly instanceId: string;
}

export interface SafeCodingAudience {
  readonly guardianId: string;
  readonly executorId: string;
  readonly runtimeEpoch: number;
  readonly taskId: string;
  readonly workspaceId: string;
}

export interface SafeCodingIntentContract {
  readonly kind: typeof INTENT_CONTRACT_KIND;
  readonly specVersion: typeof INTENT_CONTRACT_SPEC_VERSION;
  readonly contractId: string;
  readonly revision: number;
  readonly previousRevisionHash: string | null;
  readonly issuedAt: string;
  readonly validity: {
    readonly notBefore: string;
    readonly expiresAt: string;
  };
  readonly subject: SafeCodingSubject;
  readonly audience: SafeCodingAudience;
  readonly bindings: {
    readonly policyDigest: string;
    readonly adapterRegistryDigest: string;
    readonly runnerRegistryDigest: string;
    readonly effectRegistryDigest: string;
    readonly approvalRendererVersion: string;
  };
  readonly authority: SafeCodingAuthority;
  readonly nonAuthoritative: {
    readonly goalLabel: string;
    readonly notes: readonly string[];
  };
}

interface SafeCodingActionBase {
  readonly requestId: string;
}

export type SafeCodingAction =
  | (SafeCodingActionBase & {
      readonly action: 'filesystem.stat';
      readonly selector: ResourceSelector;
    })
  | (SafeCodingActionBase & {
      readonly action: 'filesystem.list';
      readonly selector: { readonly kind: 'tree'; readonly path: string };
    })
  | (SafeCodingActionBase & {
      readonly action: 'filesystem.read';
      readonly selector: { readonly kind: 'file'; readonly path: string };
    })
  | (SafeCodingActionBase & {
      readonly action: 'filesystem.create';
      readonly selector: { readonly kind: 'file'; readonly path: string };
      readonly contentSha256: string;
      readonly contentBytes: number;
    })
  | (SafeCodingActionBase & {
      readonly action: 'filesystem.replace';
      readonly selector: { readonly kind: 'file'; readonly path: string };
      readonly beforeSha256: string;
      readonly contentSha256: string;
      readonly contentBytes: number;
    })
  | (SafeCodingActionBase & {
      readonly action: 'filesystem.mkdir';
      readonly selector: { readonly kind: 'tree'; readonly path: string };
    })
  | (SafeCodingActionBase & {
      readonly action: 'git.status';
    })
  | (SafeCodingActionBase & {
      readonly action: 'git.diff';
      readonly scope: 'worktree' | 'staged';
    })
  | (SafeCodingActionBase & {
      readonly action: 'test.run';
      readonly profileId: string;
    });

export interface SafeCodingExecutionTicket {
  readonly kind: typeof EXECUTION_TICKET_KIND;
  readonly specVersion: typeof INTENT_CONTRACT_SPEC_VERSION;
  readonly ticketId: string;
  readonly requestId: string;
  readonly contractHash: string;
  readonly contractRevision: number;
  readonly subject: SafeCodingSubject;
  readonly audience: SafeCodingAudience;
  readonly actionHash: string;
  readonly argumentsHash: string;
  readonly resolvedObjectId: string;
  readonly stateCommitmentHash: string;
  readonly adapterId: string;
  readonly adapterDigest: string;
  readonly policyDigest: string;
  readonly registryDigest: string;
  readonly runnerRegistryDigest: string;
  readonly effectRegistryDigest: string;
  readonly effectClass: SafeCodingEffectClass;
  readonly revocationEpoch: number;
  readonly budgetReservationId: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export type SafeCodingAttestationStatus =
  | 'denied'
  | 'noop'
  | 'committed'
  | 'failed_no_effect'
  | 'rolled_back'
  | 'uncertain'
  | 'committed_result_unavailable';

export type SafeCodingEvidenceLevel =
  | 'attempt_only'
  | 'adapter_observed'
  | 'local_state_reconciled'
  | 'remote_provider_attested'
  | 'independently_reconciled';

export interface SafeCodingEffectAttestation {
  readonly kind: typeof EFFECT_ATTESTATION_KIND;
  readonly specVersion: typeof INTENT_CONTRACT_SPEC_VERSION;
  readonly attestationId: string;
  readonly requestId: string;
  readonly ticketId: string;
  readonly contractHash: string;
  readonly contractRevision: number;
  readonly actionHash: string;
  readonly delegationLineageHash: string;
  readonly adapterId: string;
  readonly adapterDigest: string;
  readonly runnerId: string;
  readonly runnerDigest: string;
  readonly executorId: string;
  readonly observerId: string;
  readonly effectClass: SafeCodingEffectClass;
  readonly registryDigest: string;
  readonly revocationEpoch: number;
  readonly preStateHash: string | null;
  readonly postStateHash: string | null;
  readonly idempotencyKey: string | null;
  readonly resultHash: string | null;
  readonly budgetCharges: {
    readonly uniqueModifiedFiles: number;
    readonly mutationBytes: number;
    readonly testRuns: number;
  };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: SafeCodingAttestationStatus;
  readonly evidenceLevel: SafeCodingEvidenceLevel;
  readonly reconciliationRef: string | null;
}

export interface EnvelopeSignature {
  readonly keyId: string;
  readonly algorithm: typeof SIGNATURE_ALGORITHM;
  readonly signature: string;
}

export interface SignedEnvelope {
  readonly payloadType: string;
  /** Exact canonical payload bytes encoded as unpadded base64url. */
  readonly payload: string;
  readonly signatures: readonly EnvelopeSignature[];
}

export type TrustedSignerRole =
  | 'human-authorizer'
  | 'policy-authorizer'
  | 'delegation-authority'
  | 'guardian'
  | 'executor'
  | 'observer'
  | 'model';

export type RootAuthorizerRole = 'human-authorizer' | 'policy-authorizer';

export interface HashPort {
  sha256(input: Uint8Array): string | Promise<string>;
}

export interface SignatureVerificationInput {
  readonly algorithm: typeof SIGNATURE_ALGORITHM;
  readonly keyId: string;
  readonly signature: string;
  readonly message: Uint8Array;
}

/**
 * Immutable view of one key in a protected trust registry.
 *
 * `trustEpoch` is a globally monotonic registry epoch. `registryDigest` binds
 * the complete registry contents at that epoch, including key material,
 * revocation state, and role assignment. A verifier must use this exact
 * snapshot for cryptographic verification rather than resolving `keyId`
 * again against mutable current state.
 */
export interface TrustedSignerSnapshot {
  readonly keyId: string;
  readonly role: TrustedSignerRole;
  readonly trustEpoch: number;
  readonly registryDigest: string;
}

export interface IntentContractSignatureVerificationInput
  extends SignatureVerificationInput {
  readonly trustedSigner: TrustedSignerSnapshot;
}

export interface SignatureVerifier {
  /** Resolve key, role, and registry binding in one immutable read. */
  resolveTrustedSigner(
    keyId: string,
  ): TrustedSignerSnapshot | null | Promise<TrustedSignerSnapshot | null>;
  verify(
    input: IntentContractSignatureVerificationInput,
  ): boolean | Promise<boolean>;
  /**
   * Synchronous final fence against revocation, role, epoch, registry, or key
   * drift. It must compare every snapshot field with protected current state
   * and throw on any mismatch. Async implementations are rejected at runtime.
   */
  assertTrusted(snapshot: TrustedSignerSnapshot): void;
}

export interface VerifiedIntentContract {
  readonly contract: SafeCodingIntentContract;
  readonly canonicalPayload: string;
  readonly contractHash: string;
  readonly signerKeyId: string;
  readonly signerRole: RootAuthorizerRole;
  readonly signer: TrustedSignerSnapshot & {
    readonly role: RootAuthorizerRole;
  };
}

export class IntentContractValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IntentContractValidationError';
  }
}

export function validateResourceSelector(value: unknown): ResourceSelector {
  const record = requireRecord(value, 'Resource selector');
  requireExactKeys(record, ['kind', 'path'], 'Resource selector');
  const kind = requireEnum(
    record.kind,
    ['file', 'tree'] as const,
    'Selector kind',
  );
  const selectorPath = requireString(record.path, 'Selector path', 4_096);
  validateSelectorPath(selectorPath, kind);
  return Object.freeze({ kind, path: selectorPath }) as ResourceSelector;
}

export function resourceSelectorCovers(
  parent: ResourceSelector,
  child: ResourceSelector,
): boolean {
  const validatedParent = validateResourceSelector(parent);
  const validatedChild = validateResourceSelector(child);
  if (validatedParent.kind === 'file') {
    return (
      validatedChild.kind === 'file' &&
      validatedParent.path === validatedChild.path
    );
  }
  if (validatedChild.kind === 'tree') {
    return pathEqualsOrDescends(validatedParent.path, validatedChild.path);
  }
  return pathEqualsOrDescends(validatedParent.path, validatedChild.path);
}

export function validateSafeCodingIntentContract(
  value: unknown,
): SafeCodingIntentContract {
  const record = requireRecord(value, 'Intent Contract');
  requireExactKeys(
    record,
    [
      'kind',
      'specVersion',
      'contractId',
      'revision',
      'previousRevisionHash',
      'issuedAt',
      'validity',
      'subject',
      'audience',
      'bindings',
      'authority',
      'nonAuthoritative',
    ],
    'Intent Contract',
  );
  requireLiteral(record.kind, INTENT_CONTRACT_KIND, 'Intent Contract kind');
  requireLiteral(
    record.specVersion,
    INTENT_CONTRACT_SPEC_VERSION,
    'Intent Contract specVersion',
  );
  const contractId = requireUuid(record.contractId, 'Contract ID');
  const revision = requirePositiveInteger(record.revision, 'Contract revision');
  const previousRevisionHash = requireNullableDigest(
    record.previousRevisionHash,
    'Previous revision hash',
  );
  if ((revision === 1) !== (previousRevisionHash === null)) {
    throw new IntentContractValidationError(
      'Revision 1 must have no previous hash and later revisions must bind one',
    );
  }
  const issuedAt = requireTimestamp(record.issuedAt, 'Contract issuedAt');
  const validity = validateValidity(record.validity);
  const issuedAtMs = timestampMilliseconds(issuedAt);
  const notBeforeMs = timestampMilliseconds(validity.notBefore);
  const expiresAtMs = timestampMilliseconds(validity.expiresAt);
  if (issuedAtMs > notBeforeMs || notBeforeMs >= expiresAtMs) {
    throw new IntentContractValidationError(
      'Contract validity must satisfy issuedAt <= notBefore < expiresAt',
    );
  }

  const contract: SafeCodingIntentContract = {
    kind: INTENT_CONTRACT_KIND,
    specVersion: INTENT_CONTRACT_SPEC_VERSION,
    contractId,
    revision,
    previousRevisionHash,
    issuedAt,
    validity,
    subject: validateSubject(record.subject),
    audience: validateAudience(record.audience),
    bindings: validateBindings(record.bindings),
    authority: validateAuthority(record.authority),
    nonAuthoritative: validateNonAuthoritative(record.nonAuthoritative),
  };
  canonicalizeJson(contract);
  return deepFreeze(contract);
}

export function parseCanonicalSafeCodingIntentContract(
  input: string,
): SafeCodingIntentContract {
  return validateSafeCodingIntentContract(parseCanonicalJson(input));
}

export function validateSafeCodingAction(value: unknown): SafeCodingAction {
  const record = requireRecord(value, 'Safe Coding action');
  const requestId = requireIdentifier(record.requestId, 'Action request ID');
  const action = requireEnum(
    record.action,
    [
      'filesystem.stat',
      'filesystem.list',
      'filesystem.read',
      'filesystem.create',
      'filesystem.replace',
      'filesystem.mkdir',
      'git.status',
      'git.diff',
      'test.run',
    ] as const,
    'Safe Coding action kind',
  );

  switch (action) {
    case 'filesystem.stat': {
      requireExactKeys(record, ['requestId', 'action', 'selector'], action);
      return deepFreeze({
        requestId,
        action,
        selector: validateResourceSelector(record.selector),
      });
    }
    case 'filesystem.list':
    case 'filesystem.mkdir': {
      requireExactKeys(record, ['requestId', 'action', 'selector'], action);
      const selector = validateResourceSelector(record.selector);
      if (selector.kind !== 'tree') {
        throw new IntentContractValidationError(
          `${action} requires a tree selector`,
        );
      }
      return deepFreeze({ requestId, action, selector });
    }
    case 'filesystem.read': {
      requireExactKeys(record, ['requestId', 'action', 'selector'], action);
      const selector = validateResourceSelector(record.selector);
      if (selector.kind !== 'file') {
        throw new IntentContractValidationError(
          'filesystem.read requires a file selector',
        );
      }
      return deepFreeze({ requestId, action, selector });
    }
    case 'filesystem.create': {
      requireExactKeys(
        record,
        ['requestId', 'action', 'selector', 'contentSha256', 'contentBytes'],
        action,
      );
      const selector = requireFileSelector(record.selector, action);
      return deepFreeze({
        requestId,
        action,
        selector,
        contentSha256: requireDigest(record.contentSha256, 'Content digest'),
        contentBytes: requireNonNegativeInteger(
          record.contentBytes,
          'Content byte count',
        ),
      });
    }
    case 'filesystem.replace': {
      requireExactKeys(
        record,
        [
          'requestId',
          'action',
          'selector',
          'beforeSha256',
          'contentSha256',
          'contentBytes',
        ],
        action,
      );
      const selector = requireFileSelector(record.selector, action);
      return deepFreeze({
        requestId,
        action,
        selector,
        beforeSha256: requireDigest(record.beforeSha256, 'Before-state digest'),
        contentSha256: requireDigest(record.contentSha256, 'Content digest'),
        contentBytes: requireNonNegativeInteger(
          record.contentBytes,
          'Content byte count',
        ),
      });
    }
    case 'git.status':
      requireExactKeys(record, ['requestId', 'action'], action);
      return Object.freeze({ requestId, action });
    case 'git.diff':
      requireExactKeys(record, ['requestId', 'action', 'scope'], action);
      return Object.freeze({
        requestId,
        action,
        scope: requireEnum(
          record.scope,
          ['worktree', 'staged'] as const,
          'Git diff scope',
        ),
      });
    case 'test.run':
      requireExactKeys(record, ['requestId', 'action', 'profileId'], action);
      return Object.freeze({
        requestId,
        action,
        profileId: requireProfileId(record.profileId, 'Test profile ID'),
      });
  }
}

export function validateSafeCodingExecutionTicket(
  value: unknown,
): SafeCodingExecutionTicket {
  const record = requireRecord(value, 'Execution Ticket');
  requireExactKeys(
    record,
    [
      'kind',
      'specVersion',
      'ticketId',
      'requestId',
      'contractHash',
      'contractRevision',
      'subject',
      'audience',
      'actionHash',
      'argumentsHash',
      'resolvedObjectId',
      'stateCommitmentHash',
      'adapterId',
      'adapterDigest',
      'policyDigest',
      'registryDigest',
      'runnerRegistryDigest',
      'effectRegistryDigest',
      'effectClass',
      'revocationEpoch',
      'budgetReservationId',
      'nonce',
      'issuedAt',
      'expiresAt',
    ],
    'Execution Ticket',
  );
  requireLiteral(record.kind, EXECUTION_TICKET_KIND, 'Execution Ticket kind');
  requireLiteral(
    record.specVersion,
    INTENT_CONTRACT_SPEC_VERSION,
    'Execution Ticket specVersion',
  );
  const issuedAt = requireTimestamp(record.issuedAt, 'Ticket issuedAt');
  const expiresAt = requireTimestamp(record.expiresAt, 'Ticket expiresAt');
  if (timestampMilliseconds(issuedAt) >= timestampMilliseconds(expiresAt)) {
    throw new IntentContractValidationError(
      'Execution Ticket expiry must be after issuance',
    );
  }
  const ticket: SafeCodingExecutionTicket = {
    kind: EXECUTION_TICKET_KIND,
    specVersion: INTENT_CONTRACT_SPEC_VERSION,
    ticketId: requireUuid(record.ticketId, 'Ticket ID'),
    requestId: requireIdentifier(record.requestId, 'Ticket request ID'),
    contractHash: requireDigest(record.contractHash, 'Ticket contract hash'),
    contractRevision: requirePositiveInteger(
      record.contractRevision,
      'Ticket contract revision',
    ),
    subject: validateSubject(record.subject),
    audience: validateAudience(record.audience),
    actionHash: requireDigest(record.actionHash, 'Ticket action hash'),
    argumentsHash: requireDigest(record.argumentsHash, 'Ticket arguments hash'),
    resolvedObjectId: requireIdentifier(
      record.resolvedObjectId,
      'Resolved object ID',
    ),
    stateCommitmentHash: requireDigest(
      record.stateCommitmentHash,
      'State commitment hash',
    ),
    adapterId: requireIdentifier(record.adapterId, 'Adapter ID'),
    adapterDigest: requireDigest(record.adapterDigest, 'Adapter digest'),
    policyDigest: requireDigest(record.policyDigest, 'Ticket policy digest'),
    registryDigest: requireDigest(record.registryDigest, 'Registry digest'),
    runnerRegistryDigest: requireDigest(
      record.runnerRegistryDigest,
      'Ticket runner registry digest',
    ),
    effectRegistryDigest: requireDigest(
      record.effectRegistryDigest,
      'Ticket effect registry digest',
    ),
    effectClass: requireEffectClass(record.effectClass, 'Ticket effect class'),
    revocationEpoch: requireNonNegativeInteger(
      record.revocationEpoch,
      'Revocation epoch',
    ),
    budgetReservationId: requireIdentifier(
      record.budgetReservationId,
      'Budget reservation ID',
    ),
    nonce: requireCanonicalBase64Url(
      record.nonce,
      'Ticket nonce',
      MIN_TICKET_NONCE_BYTES,
      MAX_TICKET_NONCE_BYTES,
    ),
    issuedAt,
    expiresAt,
  };
  canonicalizeJson(ticket);
  return deepFreeze(ticket);
}

export function validateSafeCodingEffectAttestation(
  value: unknown,
): SafeCodingEffectAttestation {
  const record = requireRecord(value, 'Effect Attestation');
  requireExactKeys(
    record,
    [
      'kind',
      'specVersion',
      'attestationId',
      'requestId',
      'ticketId',
      'contractHash',
      'contractRevision',
      'actionHash',
      'delegationLineageHash',
      'adapterId',
      'adapterDigest',
      'runnerId',
      'runnerDigest',
      'executorId',
      'observerId',
      'effectClass',
      'registryDigest',
      'revocationEpoch',
      'preStateHash',
      'postStateHash',
      'idempotencyKey',
      'resultHash',
      'budgetCharges',
      'startedAt',
      'finishedAt',
      'status',
      'evidenceLevel',
      'reconciliationRef',
    ],
    'Effect Attestation',
  );
  requireLiteral(
    record.kind,
    EFFECT_ATTESTATION_KIND,
    'Effect Attestation kind',
  );
  requireLiteral(
    record.specVersion,
    INTENT_CONTRACT_SPEC_VERSION,
    'Effect Attestation specVersion',
  );
  const startedAt = requireTimestamp(record.startedAt, 'Attestation startedAt');
  const finishedAt = requireTimestamp(
    record.finishedAt,
    'Attestation finishedAt',
  );
  if (timestampMilliseconds(finishedAt) < timestampMilliseconds(startedAt)) {
    throw new IntentContractValidationError(
      'Effect Attestation cannot finish before it starts',
    );
  }
  const attestation: SafeCodingEffectAttestation = {
    kind: EFFECT_ATTESTATION_KIND,
    specVersion: INTENT_CONTRACT_SPEC_VERSION,
    attestationId: requireUuid(record.attestationId, 'Attestation ID'),
    requestId: requireIdentifier(record.requestId, 'Attestation request ID'),
    ticketId: requireUuid(record.ticketId, 'Attestation ticket ID'),
    contractHash: requireDigest(
      record.contractHash,
      'Attestation contract hash',
    ),
    contractRevision: requirePositiveInteger(
      record.contractRevision,
      'Attestation contract revision',
    ),
    actionHash: requireDigest(record.actionHash, 'Attestation action hash'),
    delegationLineageHash: requireDigest(
      record.delegationLineageHash,
      'Delegation lineage hash',
    ),
    adapterId: requireIdentifier(record.adapterId, 'Attestation adapter ID'),
    adapterDigest: requireDigest(
      record.adapterDigest,
      'Attestation adapter digest',
    ),
    runnerId: requireIdentifier(record.runnerId, 'Attestation runner ID'),
    runnerDigest: requireDigest(
      record.runnerDigest,
      'Attestation runner digest',
    ),
    executorId: requireIdentifier(record.executorId, 'Attestation executor ID'),
    observerId: requireIdentifier(record.observerId, 'Attestation observer ID'),
    effectClass: requireEffectClass(
      record.effectClass,
      'Attestation effect class',
    ),
    registryDigest: requireDigest(
      record.registryDigest,
      'Attestation registry digest',
    ),
    revocationEpoch: requireNonNegativeInteger(
      record.revocationEpoch,
      'Attestation revocation epoch',
    ),
    preStateHash: requireNullableDigest(
      record.preStateHash,
      'Attestation pre-state hash',
    ),
    postStateHash: requireNullableDigest(
      record.postStateHash,
      'Attestation post-state hash',
    ),
    idempotencyKey: requireNullableIdentifier(
      record.idempotencyKey,
      'Attestation idempotency key',
    ),
    resultHash: requireNullableDigest(
      record.resultHash,
      'Attestation result hash',
    ),
    budgetCharges: validateBudgetCharges(record.budgetCharges),
    startedAt,
    finishedAt,
    status: requireEnum(
      record.status,
      [
        'denied',
        'noop',
        'committed',
        'failed_no_effect',
        'rolled_back',
        'uncertain',
        'committed_result_unavailable',
      ] as const,
      'Attestation status',
    ),
    evidenceLevel: requireEnum(
      record.evidenceLevel,
      [
        'attempt_only',
        'adapter_observed',
        'local_state_reconciled',
        'remote_provider_attested',
        'independently_reconciled',
      ] as const,
      'Attestation evidence level',
    ),
    reconciliationRef: requireNullableIdentifier(
      record.reconciliationRef,
      'Attestation reconciliation reference',
    ),
  };
  validateAttestationSemantics(attestation);
  canonicalizeJson(attestation);
  return deepFreeze(attestation);
}

export async function hashIntentContract(
  contract: SafeCodingIntentContract,
  hashPort: HashPort,
): Promise<string> {
  const validated = validateSafeCodingIntentContract(contract);
  return await hashDomainSeparatedWith(
    INTENT_CONTRACT_HASH_DOMAIN,
    canonicalizeJson(validated),
    pinHashMethod(hashPort),
  );
}

export async function hashSafeCodingAction(
  action: SafeCodingAction,
  hashPort: HashPort,
): Promise<string> {
  const validated = validateSafeCodingAction(action);
  return await hashDomainSeparatedWith(
    SAFE_CODING_ACTION_HASH_DOMAIN,
    canonicalizeJson(validated),
    pinHashMethod(hashPort),
  );
}

export function createEnvelopePreAuthenticationEncoding(
  payloadType: string,
  canonicalPayload: string,
): Uint8Array {
  const type = requireAsciiToken(payloadType, 'Envelope payload type', 256);
  parseCanonicalJson(canonicalPayload);
  const typeBytes = encodeUtf8(type);
  const payloadBytes = encodeUtf8(canonicalPayload);
  const prefix = encodeUtf8(
    `DSSEv1 ${typeBytes.length} ${type} ${payloadBytes.length} `,
  );
  return concatenateBytes(prefix, payloadBytes);
}

export async function verifySignedIntentContract(
  envelopeValue: unknown,
  dependencies: {
    readonly hash: HashPort;
    readonly signatures: SignatureVerifier;
    readonly acceptedRootRoles?: readonly RootAuthorizerRole[];
  },
): Promise<VerifiedIntentContract> {
  const { ports, acceptedRoles } =
    snapshotIntentVerificationDependencies(dependencies);
  const envelope = validateSignedEnvelope(envelopeValue);
  if (envelope.payloadType !== INTENT_CONTRACT_PAYLOAD_TYPE) {
    throw new IntentContractValidationError(
      'Signed envelope has the wrong Intent Contract payload type',
    );
  }
  const canonicalPayload = decodeUtf8(decodeBase64Url(envelope.payload));
  const contract = parseCanonicalSafeCodingIntentContract(canonicalPayload);
  const message = createEnvelopePreAuthenticationEncoding(
    envelope.payloadType,
    canonicalPayload,
  );
  let registryBinding: Pick<
    TrustedSignerSnapshot,
    'trustEpoch' | 'registryDigest'
  > | null = null;

  for (const signature of envelope.signatures) {
    const resolved = await ports.resolveTrustedSigner(signature.keyId);
    if (resolved === null) continue;
    const signer = validateTrustedSignerSnapshot(resolved, signature.keyId);
    if (registryBinding === null) {
      registryBinding = Object.freeze({
        trustEpoch: signer.trustEpoch,
        registryDigest: signer.registryDigest,
      });
    } else if (
      registryBinding.trustEpoch !== signer.trustEpoch ||
      registryBinding.registryDigest !== signer.registryDigest
    ) {
      throw new IntentContractValidationError(
        'Trust registry changed while scanning envelope signatures',
      );
    }
    if (!isRootAuthorizerSnapshot(signer) || !acceptedRoles.has(signer.role)) {
      continue;
    }
    const verified = await ports.verify({
      algorithm: signature.algorithm,
      keyId: signature.keyId,
      signature: signature.signature,
      message: message.slice(),
      trustedSigner: signer,
    });
    if (verified !== true) continue;
    const result = Object.freeze({
      contract,
      canonicalPayload,
      contractHash: await hashDomainSeparatedWith(
        INTENT_CONTRACT_HASH_DOMAIN,
        canonicalPayload,
        ports.sha256,
      ),
      signerKeyId: signature.keyId,
      signerRole: signer.role,
      signer,
    });
    const assertionResult = ports.assertTrusted(signer);
    if (assertionResult !== undefined) {
      throw new IntentContractValidationError(
        'Signature assertTrusted must complete synchronously',
      );
    }
    return result;
  }
  throw new IntentContractValidationError(
    'Intent Contract has no valid trusted root-authorizer signature',
  );
}

export function encodeBase64Url(input: Uint8Array): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = '';
  for (let index = 0; index < input.length; index += 3) {
    const first = input[index]!;
    const hasSecond = index + 1 < input.length;
    const hasThird = index + 2 < input.length;
    const second = hasSecond ? input[index + 1]! : 0;
    const third = hasThird ? input[index + 2]! : 0;
    result += alphabet[first >> 2]!;
    result += alphabet[((first & 0x03) << 4) | (second >> 4)]!;
    if (hasSecond) {
      result += alphabet[((second & 0x0f) << 2) | (third >> 6)]!;
    }
    if (hasThird) result += alphabet[third & 0x3f]!;
  }
  return result;
}

export function decodeBase64Url(value: string): Uint8Array {
  requireBase64UrlSyntax(value, 'Base64url value', 1, Number.MAX_SAFE_INTEGER);
  if (value.length % 4 === 1) {
    throw new IntentContractValidationError(
      'Base64url value has invalid length',
    );
  }
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const values = new Map<string, number>(
    [...alphabet].map((character, index) => [character, index]),
  );
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const remaining = value.length - index;
    const first = values.get(value[index]!)!;
    const second = values.get(value[index + 1]!)!;
    const third = remaining > 2 ? values.get(value[index + 2]!)! : 0;
    const fourth = remaining > 3 ? values.get(value[index + 3]!)! : 0;
    bytes.push((first << 2) | (second >> 4));
    if (remaining > 2) bytes.push(((second & 0x0f) << 4) | (third >> 2));
    if (remaining > 3) bytes.push(((third & 0x03) << 6) | fourth);
    if (
      (remaining === 2 && (second & 0x0f) !== 0) ||
      (remaining === 3 && (third & 0x03) !== 0)
    ) {
      throw new IntentContractValidationError(
        'Base64url value has non-canonical trailing bits',
      );
    }
  }
  const decoded = Uint8Array.from(bytes);
  if (encodeBase64Url(decoded) !== value) {
    throw new IntentContractValidationError('Base64url value is not canonical');
  }
  return decoded;
}

function validateSignedEnvelope(value: unknown): SignedEnvelope {
  const record = requireRecord(value, 'Signed envelope');
  requireExactKeys(
    record,
    ['payloadType', 'payload', 'signatures'],
    'Signed envelope',
  );
  const payloadType = requireAsciiToken(
    record.payloadType,
    'Envelope payload type',
    256,
  );
  const payload = requireBase64UrlSyntax(
    record.payload,
    'Envelope payload',
    1,
    encodedBase64UrlLength(MAX_ENVELOPE_PAYLOAD_BYTES),
  );
  const signaturesRaw = requireArray(
    record.signatures,
    'Envelope signatures',
    MAX_ENVELOPE_SIGNATURES,
  );
  if (signaturesRaw.length === 0) {
    throw new IntentContractValidationError(
      `Signed envelope must contain between 1 and ${MAX_ENVELOPE_SIGNATURES} signatures`,
    );
  }
  const signatures = signaturesRaw.map((entry) => {
    const signature = requireRecord(entry, 'Envelope signature');
    requireExactKeys(
      signature,
      ['keyId', 'algorithm', 'signature'],
      'Envelope signature',
    );
    requireLiteral(
      signature.algorithm,
      SIGNATURE_ALGORITHM,
      'Envelope signature algorithm',
    );
    const encoded = requireCanonicalBase64Url(
      signature.signature,
      'Envelope signature bytes',
      P256_P1363_SIGNATURE_BYTES,
      P256_P1363_SIGNATURE_BYTES,
    );
    return Object.freeze({
      keyId: requireIdentifier(signature.keyId, 'Envelope signature key ID'),
      algorithm: SIGNATURE_ALGORITHM,
      signature: encoded,
    });
  });
  assertSortedUnique(signatures, (entry) => entry.keyId, 'Envelope signatures');
  return deepFreeze({ payloadType, payload, signatures });
}

function validateValidity(
  value: unknown,
): SafeCodingIntentContract['validity'] {
  const record = requireRecord(value, 'Contract validity');
  requireExactKeys(record, ['notBefore', 'expiresAt'], 'Contract validity');
  return Object.freeze({
    notBefore: requireTimestamp(record.notBefore, 'Contract notBefore'),
    expiresAt: requireTimestamp(record.expiresAt, 'Contract expiresAt'),
  });
}

function validateSubject(value: unknown): SafeCodingSubject {
  const record = requireRecord(value, 'Contract subject');
  requireExactKeys(record, ['principalId', 'instanceId'], 'Contract subject');
  return Object.freeze({
    principalId: requireIdentifier(record.principalId, 'Subject principal ID'),
    instanceId: requireIdentifier(record.instanceId, 'Subject instance ID'),
  });
}

function validateAudience(value: unknown): SafeCodingAudience {
  const record = requireRecord(value, 'Contract audience');
  requireExactKeys(
    record,
    ['guardianId', 'executorId', 'runtimeEpoch', 'taskId', 'workspaceId'],
    'Contract audience',
  );
  return Object.freeze({
    guardianId: requireIdentifier(record.guardianId, 'Audience Guardian ID'),
    executorId: requireIdentifier(record.executorId, 'Audience executor ID'),
    runtimeEpoch: requireNonNegativeInteger(
      record.runtimeEpoch,
      'Audience runtime epoch',
    ),
    taskId: requireIdentifier(record.taskId, 'Audience task ID'),
    workspaceId: requireIdentifier(record.workspaceId, 'Audience workspace ID'),
  });
}

function validateBindings(
  value: unknown,
): SafeCodingIntentContract['bindings'] {
  const record = requireRecord(value, 'Contract bindings');
  requireExactKeys(
    record,
    [
      'policyDigest',
      'adapterRegistryDigest',
      'runnerRegistryDigest',
      'effectRegistryDigest',
      'approvalRendererVersion',
    ],
    'Contract bindings',
  );
  return Object.freeze({
    policyDigest: requireDigest(record.policyDigest, 'Policy digest'),
    adapterRegistryDigest: requireDigest(
      record.adapterRegistryDigest,
      'Adapter registry digest',
    ),
    runnerRegistryDigest: requireDigest(
      record.runnerRegistryDigest,
      'Runner registry digest',
    ),
    effectRegistryDigest: requireDigest(
      record.effectRegistryDigest,
      'Effect registry digest',
    ),
    approvalRendererVersion: requireAsciiToken(
      record.approvalRendererVersion,
      'Approval renderer version',
      128,
    ),
  });
}

function validateAuthority(value: unknown): SafeCodingAuthority {
  const record = requireRecord(value, 'Safe Coding authority');
  requireExactKeys(
    record,
    [
      'filesystem',
      'git',
      'testProfiles',
      'allowedEffectClasses',
      'limits',
      'ambientAuthority',
      'delegation',
    ],
    'Safe Coding authority',
  );
  const filesystem = requireArray(
    record.filesystem,
    'Filesystem permissions',
    MAX_FILESYSTEM_PERMISSIONS,
  ).map(validateFilesystemPermission);
  assertSortedUnique(
    filesystem,
    (permission) => canonicalizeJson(permission),
    'Filesystem permissions',
  );
  const git = requireArray(
    record.git,
    'Git permissions',
    MAX_GIT_PERMISSIONS,
  ).map(validateGitPermission);
  assertSortedUnique(
    git,
    (permission) => canonicalizeJson(permission),
    'Git permissions',
  );
  const testProfiles = requireArray(
    record.testProfiles,
    'Test profiles',
    MAX_TEST_PROFILES,
  ).map((entry) => requireProfileId(entry, 'Test profile ID'));
  assertSortedUnique(testProfiles, (entry) => entry, 'Test profiles');
  const allowedEffectClasses = requireArray(
    record.allowedEffectClasses,
    'Allowed effect classes',
    MAX_EFFECT_CLASSES,
  ).map((entry) => requireEffectClass(entry, 'Allowed effect class'));
  assertSortedUnique(
    allowedEffectClasses,
    (entry) => entry,
    'Allowed effect classes',
  );
  return deepFreeze({
    filesystem,
    git,
    testProfiles,
    allowedEffectClasses,
    limits: validateLimits(record.limits),
    ambientAuthority: validateAmbientAuthority(record.ambientAuthority),
    delegation: validateDelegation(record.delegation),
  });
}

function validateFilesystemPermission(
  value: unknown,
): SafeCodingFilesystemPermission {
  const record = requireRecord(value, 'Filesystem permission');
  requireExactKeys(record, ['action', 'selector'], 'Filesystem permission');
  const action = requireEnum(
    record.action,
    [
      'filesystem.stat',
      'filesystem.list',
      'filesystem.read',
      'filesystem.create',
      'filesystem.replace',
      'filesystem.mkdir',
    ] as const,
    'Filesystem permission action',
  );
  const selector = validateResourceSelector(record.selector);
  if (
    (action === 'filesystem.list' ||
      action === 'filesystem.create' ||
      action === 'filesystem.mkdir') &&
    selector.kind !== 'tree'
  ) {
    throw new IntentContractValidationError(
      `${action} authority requires a tree selector`,
    );
  }
  if (action === 'filesystem.replace' && selector.kind !== 'file') {
    throw new IntentContractValidationError(
      'filesystem.replace authority requires a file selector',
    );
  }
  return deepFreeze({ action, selector });
}

function validateGitPermission(value: unknown): SafeCodingGitPermission {
  const record = requireRecord(value, 'Git permission');
  requireExactKeys(record, ['action'], 'Git permission');
  return Object.freeze({
    action: requireEnum(
      record.action,
      ['git.status', 'git.diff'] as const,
      'Git permission action',
    ),
  });
}

function validateLimits(value: unknown): SafeCodingAuthority['limits'] {
  const record = requireRecord(value, 'Safe Coding limits');
  requireExactKeys(
    record,
    ['maxUniqueModifiedFiles', 'maxMutationBytes', 'maxTestRuns'],
    'Safe Coding limits',
  );
  return Object.freeze({
    maxUniqueModifiedFiles: requireNonNegativeInteger(
      record.maxUniqueModifiedFiles,
      'Maximum unique modified files',
    ),
    maxMutationBytes: requireNonNegativeInteger(
      record.maxMutationBytes,
      'Maximum mutation bytes',
    ),
    maxTestRuns: requireNonNegativeInteger(
      record.maxTestRuns,
      'Maximum test runs',
    ),
  });
}

function validateAmbientAuthority(
  value: unknown,
): SafeCodingAuthority['ambientAuthority'] {
  const record = requireRecord(value, 'Ambient authority');
  requireExactKeys(
    record,
    ['network', 'secrets', 'shell', 'delete', 'gitCommit', 'gitPush'],
    'Ambient authority',
  );
  for (const key of [
    'network',
    'secrets',
    'shell',
    'delete',
    'gitCommit',
    'gitPush',
  ] as const) {
    requireLiteral(record[key], false, `Ambient authority ${key}`);
  }
  return Object.freeze({
    network: false,
    secrets: false,
    shell: false,
    delete: false,
    gitCommit: false,
    gitPush: false,
  });
}

function validateDelegation(value: unknown): SafeCodingAuthority['delegation'] {
  const record = requireRecord(value, 'Delegation authority');
  requireExactKeys(record, ['allowed', 'maxDepth'], 'Delegation authority');
  if (typeof record.allowed !== 'boolean') {
    throw new IntentContractValidationError(
      'Delegation allowed must be a boolean',
    );
  }
  const maxDepth = requireNonNegativeInteger(
    record.maxDepth,
    'Delegation maximum depth',
  );
  if (
    (!record.allowed && maxDepth !== 0) ||
    (record.allowed && maxDepth === 0)
  ) {
    throw new IntentContractValidationError(
      'Delegation maxDepth must be zero exactly when delegation is disabled',
    );
  }
  return Object.freeze({ allowed: record.allowed, maxDepth });
}

function validateNonAuthoritative(
  value: unknown,
): SafeCodingIntentContract['nonAuthoritative'] {
  const record = requireRecord(value, 'Non-authoritative contract metadata');
  requireExactKeys(
    record,
    ['goalLabel', 'notes'],
    'Non-authoritative contract metadata',
  );
  const notes = requireArray(
    record.notes,
    'Contract notes',
    MAX_CONTRACT_NOTES,
  ).map((entry) => requireString(entry, 'Contract note', 4_096));
  return deepFreeze({
    goalLabel: requireString(record.goalLabel, 'Contract goal label', 512),
    notes,
  });
}

function validateBudgetCharges(
  value: unknown,
): SafeCodingEffectAttestation['budgetCharges'] {
  const record = requireRecord(value, 'Attestation budget charges');
  requireExactKeys(
    record,
    ['uniqueModifiedFiles', 'mutationBytes', 'testRuns'],
    'Attestation budget charges',
  );
  return Object.freeze({
    uniqueModifiedFiles: requireNonNegativeInteger(
      record.uniqueModifiedFiles,
      'Charged unique modified files',
    ),
    mutationBytes: requireNonNegativeInteger(
      record.mutationBytes,
      'Charged mutation bytes',
    ),
    testRuns: requireNonNegativeInteger(record.testRuns, 'Charged test runs'),
  });
}

function validateAttestationSemantics(
  attestation: SafeCodingEffectAttestation,
): void {
  const hasPreState = attestation.preStateHash !== null;
  const hasPostState = attestation.postStateHash !== null;
  const hasResult = attestation.resultHash !== null;

  if (
    (attestation.status === 'denied' ||
      attestation.status === 'failed_no_effect') &&
    (hasPostState || hasResult)
  ) {
    throw new IntentContractValidationError(
      `${attestation.status} attestations cannot claim post-state or result evidence`,
    );
  }
  if (
    attestation.status === 'denied' &&
    hasAnyBudgetCharge(attestation.budgetCharges)
  ) {
    throw new IntentContractValidationError(
      'denied attestations cannot claim budget charges',
    );
  }
  if (
    attestation.status === 'failed_no_effect' &&
    (attestation.budgetCharges.uniqueModifiedFiles !== 0 ||
      attestation.budgetCharges.mutationBytes !== 0)
  ) {
    throw new IntentContractValidationError(
      'failed_no_effect attestations cannot claim mutation charges',
    );
  }
  if (
    attestation.status === 'committed_result_unavailable' &&
    (hasResult || !hasPostState)
  ) {
    throw new IntentContractValidationError(
      'committed_result_unavailable requires post-state and forbids a result hash',
    );
  }
  if (
    attestation.evidenceLevel === 'attempt_only' &&
    (hasPostState || hasResult || attestation.reconciliationRef !== null)
  ) {
    throw new IntentContractValidationError(
      'attempt_only evidence cannot claim post-state, result, or reconciliation',
    );
  }
  if (
    (attestation.status === 'noop' ||
      attestation.status === 'committed' ||
      attestation.status === 'rolled_back' ||
      attestation.status === 'committed_result_unavailable') &&
    attestation.evidenceLevel === 'attempt_only'
  ) {
    throw new IntentContractValidationError(
      `${attestation.status} requires observed evidence`,
    );
  }
  if (attestation.status === 'committed' && !hasPostState && !hasResult) {
    throw new IntentContractValidationError(
      'committed attestations require post-state or result evidence',
    );
  }
  if (
    attestation.status === 'noop' &&
    (!hasPreState ||
      !hasPostState ||
      attestation.preStateHash !== attestation.postStateHash ||
      hasAnyBudgetCharge(attestation.budgetCharges))
  ) {
    throw new IntentContractValidationError(
      'noop attestations require equal pre/post state and zero budget charges',
    );
  }
  if (
    attestation.status === 'rolled_back' &&
    (!hasPreState ||
      !hasPostState ||
      attestation.preStateHash !== attestation.postStateHash)
  ) {
    throw new IntentContractValidationError(
      'rolled_back attestations require equal reconciled pre/post state',
    );
  }

  switch (attestation.evidenceLevel) {
    case 'attempt_only':
      break;
    case 'adapter_observed':
      if (!hasPreState && !hasPostState && !hasResult) {
        throw new IntentContractValidationError(
          'adapter_observed evidence requires observed state or result evidence',
        );
      }
      break;
    case 'local_state_reconciled':
      if (!hasPreState || !hasPostState) {
        throw new IntentContractValidationError(
          'local_state_reconciled evidence requires pre-state and post-state',
        );
      }
      break;
    case 'remote_provider_attested':
      if (!hasPostState && !hasResult) {
        throw new IntentContractValidationError(
          'remote_provider_attested evidence requires post-state or result evidence',
        );
      }
      break;
    case 'independently_reconciled':
      if (
        !hasPreState ||
        !hasPostState ||
        attestation.reconciliationRef === null
      ) {
        throw new IntentContractValidationError(
          'independently_reconciled evidence requires pre-state, post-state, and reconciliationRef',
        );
      }
      break;
  }

  if (
    attestation.evidenceLevel !== 'independently_reconciled' &&
    attestation.reconciliationRef !== null
  ) {
    throw new IntentContractValidationError(
      'Only independently_reconciled evidence may carry reconciliationRef',
    );
  }
}

function hasAnyBudgetCharge(
  charges: SafeCodingEffectAttestation['budgetCharges'],
): boolean {
  return (
    charges.uniqueModifiedFiles !== 0 ||
    charges.mutationBytes !== 0 ||
    charges.testRuns !== 0
  );
}

function requireFileSelector(
  value: unknown,
  action: string,
): { readonly kind: 'file'; readonly path: string } {
  const selector = validateResourceSelector(value);
  if (selector.kind !== 'file') {
    throw new IntentContractValidationError(
      `${action} requires a file selector`,
    );
  }
  return selector;
}

function validateSelectorPath(
  value: string,
  kind: ResourceSelector['kind'],
): void {
  if (encodeUtf8(value).length > 16 * 1024) {
    throw new IntentContractValidationError(
      'Selector path exceeds the byte limit',
    );
  }
  if (value === '') {
    if (kind !== 'tree') {
      throw new IntentContractValidationError(
        'Only a tree selector may name the workspace root',
      );
    }
    return;
  }
  if (
    value.startsWith('/') ||
    /^[A-Za-z]:\//.test(value) ||
    value.endsWith('/') ||
    value.includes('\\') ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: selectors must reject every ASCII control byte
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new IntentContractValidationError(
      'Selector path is not relative and safe',
    );
  }
  const components = value.split('/');
  if (
    components.some(
      (component) =>
        component === '' || component === '.' || component === '..',
    )
  ) {
    throw new IntentContractValidationError(
      'Selector path contains an unsafe component',
    );
  }
}

function pathEqualsOrDescends(parent: string, child: string): boolean {
  return parent === '' || child === parent || child.startsWith(`${parent}/`);
}

function snapshotIntentVerificationDependencies(dependencies: {
  readonly hash: HashPort;
  readonly signatures: SignatureVerifier;
  readonly acceptedRootRoles?: readonly RootAuthorizerRole[];
}): Readonly<{
  ports: Readonly<{
    sha256: HashPort['sha256'];
    resolveTrustedSigner: SignatureVerifier['resolveTrustedSigner'];
    verify: SignatureVerifier['verify'];
    assertTrusted: SignatureVerifier['assertTrusted'];
  }>;
  acceptedRoles: ReadonlySet<RootAuthorizerRole>;
}> {
  if (dependencies === null || typeof dependencies !== 'object') {
    throw new IntentContractValidationError(
      'Intent Contract verification dependencies are required',
    );
  }
  const hash = readOwnDataProperty<HashPort>(
    dependencies,
    'hash',
    'Intent Contract hash dependency',
  );
  const signatures = readOwnDataProperty<SignatureVerifier>(
    dependencies,
    'signatures',
    'Intent Contract signature dependency',
  );
  const acceptedRootRoles = readOptionalOwnDataProperty<
    readonly RootAuthorizerRole[]
  >(dependencies, 'acceptedRootRoles', 'Accepted root authorizer roles');
  if (signatures === null || typeof signatures !== 'object') {
    throw new IntentContractValidationError(
      'A trusted signature verification port is required',
    );
  }
  return Object.freeze({
    ports: Object.freeze({
      sha256: pinHashMethod(hash),
      resolveTrustedSigner: pinPortMethod(
        signatures,
        'resolveTrustedSigner',
        'Signature verifier',
      ),
      verify: pinPortMethod(signatures, 'verify', 'Signature verifier'),
      assertTrusted: pinPortMethod(
        signatures,
        'assertTrusted',
        'Signature verifier',
      ),
    }),
    acceptedRoles: validateAcceptedRootRoles(acceptedRootRoles),
  });
}

function pinHashMethod(hashPort: HashPort): HashPort['sha256'] {
  return pinPortMethod(hashPort, 'sha256', 'SHA-256 HashPort');
}

function pinPortMethod<Port extends object, Name extends keyof Port>(
  port: Port,
  name: Name,
  label: string,
): Port[Name] {
  if (
    port === null ||
    (typeof port !== 'object' && typeof port !== 'function')
  ) {
    throw new IntentContractValidationError(`${label} is required`);
  }
  let target: object | null = port;
  while (target !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw new IntentContractValidationError(
          `${label} ${String(name)} must be a data method`,
        );
      }
      return descriptor.value.bind(port) as Port[Name];
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  throw new IntentContractValidationError(
    `${label} must provide ${String(name)}()`,
  );
}

function readOwnDataProperty<T>(value: object, name: string, label: string): T {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !('value' in descriptor)) {
    throw new IntentContractValidationError(
      `${label} must be an own data field`,
    );
  }
  return descriptor.value as T;
}

function readOptionalOwnDataProperty<T>(
  value: object,
  name: string,
  label: string,
): T | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) {
    throw new IntentContractValidationError(
      `${label} must be an own data field`,
    );
  }
  return descriptor.value as T | undefined;
}

function validateAcceptedRootRoles(
  value: readonly RootAuthorizerRole[] | undefined,
): ReadonlySet<RootAuthorizerRole> {
  const roles =
    value === undefined
      ? (['human-authorizer', 'policy-authorizer'] as const)
      : requireArray(value, 'Accepted root authorizer roles', 2).map((role) =>
          requireEnum(
            role,
            ['human-authorizer', 'policy-authorizer'] as const,
            'Accepted root authorizer role',
          ),
        );
  const accepted = new Set<RootAuthorizerRole>(roles);
  if (accepted.size === 0) {
    throw new IntentContractValidationError(
      'At least one trusted root authorizer role is required',
    );
  }
  if (accepted.size !== roles.length) {
    throw new IntentContractValidationError(
      'Accepted root authorizer roles must be unique',
    );
  }
  return accepted;
}

function validateTrustedSignerSnapshot(
  value: unknown,
  expectedKeyId: string,
): TrustedSignerSnapshot {
  const record = requireRecord(value, 'Trusted signer snapshot');
  requireExactKeys(
    record,
    ['keyId', 'role', 'trustEpoch', 'registryDigest'],
    'Trusted signer snapshot',
  );
  const keyId = requireIdentifier(record.keyId, 'Trusted signer key ID');
  if (keyId !== expectedKeyId) {
    throw new IntentContractValidationError(
      'Trusted signer snapshot does not bind the requested key ID',
    );
  }
  return Object.freeze({
    keyId,
    role: requireEnum(
      record.role,
      [
        'human-authorizer',
        'policy-authorizer',
        'delegation-authority',
        'guardian',
        'executor',
        'observer',
        'model',
      ] as const,
      'Trusted signer role',
    ),
    trustEpoch: requireNonNegativeInteger(
      record.trustEpoch,
      'Trusted signer trust epoch',
    ),
    registryDigest: requireDigest(
      record.registryDigest,
      'Trusted signer registry digest',
    ),
  });
}

async function hashDomainSeparatedWith(
  domain: string,
  canonicalPayload: string,
  sha256: HashPort['sha256'],
): Promise<string> {
  const digest = await sha256(
    concatenateBytes(
      encodeUtf8(domain),
      Uint8Array.of(0),
      encodeUtf8(canonicalPayload),
    ),
  );
  return requireDigest(digest, 'HashPort SHA-256 result');
}

function concatenateBytes(...values: readonly Uint8Array[]): Uint8Array {
  const length = values.reduce((total, value) => total + value.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new IntentContractValidationError(`${label} must be a plain object`);
  }
  if (
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.getOwnPropertyNames(value).length !== Object.keys(value).length ||
    Object.getOwnPropertyNames(value).some((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return !descriptor || !('value' in descriptor);
    })
  ) {
    throw new IntentContractValidationError(
      `${label} must contain only enumerable data fields`,
    );
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new IntentContractValidationError(
      `${label} has unknown or missing fields`,
    );
  }
}

function requireArray(
  value: unknown,
  label: string,
  maxLength: number,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new IntentContractValidationError(`${label} must be an array`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new IntentContractValidationError(
      `${label} must use the ordinary Array prototype`,
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new IntentContractValidationError(
      `${label} cannot contain symbol keys`,
    );
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    !lengthDescriptor ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new IntentContractValidationError(
      `${label} must have an ordinary array length`,
    );
  }
  const length = lengthDescriptor.value as number;
  if (length > maxLength) {
    throw new IntentContractValidationError(
      `${label} exceeds the maximum of ${maxLength} entries`,
    );
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== length + 1 || !names.includes('length')) {
    throw new IntentContractValidationError(
      `${label} must be dense and contain no extra or hidden fields`,
    );
  }
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new IntentContractValidationError(
        `${label} cannot contain accessors or hidden entries`,
      );
    }
    entries.push(descriptor.value);
  }
  return Object.freeze(entries);
}

function requireString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new IntentContractValidationError(
      `${label} must be a bounded string`,
    );
  }
  try {
    assertCanonicalString(value, label);
  } catch (error) {
    throw new IntentContractValidationError(
      error instanceof Error ? error.message : `${label} is invalid`,
    );
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  const identifier = requireString(value, label, 256);
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new IntentContractValidationError(
      `${label} is not a canonical identifier`,
    );
  }
  return identifier;
}

function requireNullableIdentifier(
  value: unknown,
  label: string,
): string | null {
  return value === null ? null : requireIdentifier(value, label);
}

function requireProfileId(value: unknown, label: string): string {
  const profileId = requireString(value, label, 128);
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new IntentContractValidationError(`${label} is not canonical`);
  }
  return profileId;
}

function requireAsciiToken(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  const token = requireString(value, label, maxLength);
  if (!/^[\u0021-\u007e]+$/.test(token)) {
    throw new IntentContractValidationError(`${label} must be printable ASCII`);
  }
  return token;
}

function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new IntentContractValidationError(
      `${label} must be a lowercase SHA-256 hex digest`,
    );
  }
  return value;
}

function requireNullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : requireDigest(value, label);
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new IntentContractValidationError(
      `${label} must be a lowercase UUID`,
    );
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label, 32);
  const match = TIMESTAMP_PATTERN.exec(timestamp);
  if (!match) {
    throw new IntentContractValidationError(`${label} must be canonical UTC`);
  }
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) {
    throw new IntentContractValidationError(`${label} is not a real timestamp`);
  }
  const iso = new Date(milliseconds).toISOString();
  const canonical = iso.endsWith('.000Z') ? iso.replace('.000Z', 'Z') : iso;
  if (canonical !== timestamp) {
    throw new IntentContractValidationError(`${label} is not canonical UTC`);
  }
  return timestamp;
}

function timestampMilliseconds(value: string): number {
  return Date.parse(value);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new IntentContractValidationError(
      `${label} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const number = requireNonNegativeInteger(value, label);
  if (number === 0) {
    throw new IntentContractValidationError(`${label} must be positive`);
  }
  return number;
}

function requireLiteral<T extends boolean | string>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) {
    throw new IntentContractValidationError(
      `${label} must equal ${String(expected)}`,
    );
  }
  return expected;
}

function requireEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new IntentContractValidationError(`${label} is unsupported`);
  }
  return value as Values[number];
}

function requireEffectClass(
  value: unknown,
  label: string,
): SafeCodingEffectClass {
  return requireEnum(
    value,
    ['local.observation', 'local.reversible', 'sandbox.ephemeral'] as const,
    label,
  );
}

function requireBase64UrlSyntax(
  value: unknown,
  label: string,
  minLength: number,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < minLength ||
    value.length > maxLength ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw new IntentContractValidationError(
      `${label} must be canonical base64url`,
    );
  }
  return value;
}

function requireCanonicalBase64Url(
  value: unknown,
  label: string,
  minBytes: number,
  maxBytes: number,
): string {
  const encoded = requireBase64UrlSyntax(
    value,
    label,
    minBytes === 0 ? 0 : 1,
    encodedBase64UrlLength(maxBytes),
  );
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64Url(encoded);
  } catch (error) {
    throw new IntentContractValidationError(
      error instanceof Error
        ? `${label}: ${error.message}`
        : `${label} is invalid`,
    );
  }
  if (decoded.length < minBytes || decoded.length > maxBytes) {
    const expectation =
      minBytes === maxBytes
        ? `exactly ${minBytes}`
        : `between ${minBytes} and ${maxBytes}`;
    throw new IntentContractValidationError(
      `${label} must decode to ${expectation} bytes`,
    );
  }
  if (encodeBase64Url(decoded) !== encoded) {
    throw new IntentContractValidationError(
      `${label} must use canonical base64url encoding`,
    );
  }
  return encoded;
}

function encodedBase64UrlLength(byteLength: number): number {
  const completeTriples = Math.floor(byteLength / 3);
  const remainder = byteLength % 3;
  return completeTriples * 4 + (remainder === 0 ? 0 : remainder + 1);
}

function assertSortedUnique<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): void {
  let previous: string | null = null;
  for (const value of values) {
    const current = key(value);
    if (previous !== null && current <= previous) {
      throw new IntentContractValidationError(
        `${label} must be sorted and unique`,
      );
    }
    previous = current;
  }
}

function isRootAuthorizerRole(
  role: TrustedSignerRole | null,
): role is RootAuthorizerRole {
  return role === 'human-authorizer' || role === 'policy-authorizer';
}

function isRootAuthorizerSnapshot(
  snapshot: TrustedSignerSnapshot,
): snapshot is TrustedSignerSnapshot & { readonly role: RootAuthorizerRole } {
  return isRootAuthorizerRole(snapshot.role);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
