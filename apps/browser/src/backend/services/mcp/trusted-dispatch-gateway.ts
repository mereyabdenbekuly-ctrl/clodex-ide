import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  evaluateMcpToolPolicy,
  type McpEffectiveToolPolicy,
  type McpServerConfig,
  type McpToolDescriptor,
} from '@clodex/mcp-runtime';
import {
  guardianAssessmentSchema,
  type GuardianPolicyChecker,
} from '@shared/guardian';
import { createMcpGuardianRequest } from '../guardian/requests';

const COMMITMENT_VERSION = 1 as const;
const MAX_COMMITMENT_ID_LENGTH = 4_096;
const MAX_CANONICAL_DEPTH = 64;
const MAX_CANONICAL_NODES = 50_000;
const MAX_CANONICAL_BYTES = 2 * 1_024 * 1_024;
const DEFAULT_FINAL_AUTHORITY_TTL_MS = 5 * 60_000;
const TRUSTED_BUILTIN_READ_ONLY_MCP_TOOLS = new Set(['docs/search']);
const trustedMcpFinalAuthorityBrand: unique symbol = Symbol(
  'TrustedMcpFinalAuthority',
);

export type TrustedMcpDispatchDomain = 'registry-mcp' | 'clodex-cloud-mcp';

export interface TrustedMcpToolClassification {
  readOnly: boolean;
  destructive: boolean;
  requiresApproval: boolean;
}

export interface TrustedMcpDescriptorCommitment {
  version: typeof COMMITMENT_VERSION;
  domain: TrustedMcpDispatchDomain;
  authorityId: string;
  toolName: string;
  descriptorSha256: string;
  authorityBindingSha256: string;
  classification: Readonly<TrustedMcpToolClassification>;
  digest: string;
}

export interface TrustedMcpDispatchCommitment {
  version: typeof COMMITMENT_VERSION;
  descriptor: TrustedMcpDescriptorCommitment;
  runtimeBindingSha256: string;
  digest: string;
}

export interface CreateTrustedMcpDescriptorCommitmentInput {
  domain: TrustedMcpDispatchDomain;
  authorityId: string;
  toolName: string;
  descriptor: unknown;
  authorityBinding: unknown;
  classification: TrustedMcpToolClassification;
}

export interface TrustedMcpDispatchAuthorization {
  readonly commitment: TrustedMcpDispatchCommitment;
  prepareFinalCheck(): void;
  assertCurrent(current: TrustedMcpDispatchCommitment): void;
}

export interface TrustedMcpFinalAuthorityEffect {
  principalId: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
}

export interface TrustedMcpFinalAuthority {
  readonly [trustedMcpFinalAuthorityBrand]: true;
  prepareFinalCheck(): void;
  assertAndConsume(input: {
    descriptor: TrustedMcpDescriptorCommitment;
    effect: TrustedMcpFinalAuthorityEffect;
  }): void;
}

export interface TrustedRegistryMcpToolEvaluation {
  policy: McpEffectiveToolPolicy;
  classification: Readonly<TrustedMcpToolClassification>;
}

/**
 * MCP annotations are untrusted claims. A read-only claim becomes authority
 * only when the exact built-in tool is on the host-maintained allowlist;
 * destructive annotations may still raise risk and force approval.
 */
export function evaluateTrustedRegistryMcpTool(
  server: McpServerConfig,
  descriptor: McpToolDescriptor,
): TrustedRegistryMcpToolEvaluation {
  const trustedReadOnly =
    server.source.kind === 'builtin' &&
    TRUSTED_BUILTIN_READ_ONLY_MCP_TOOLS.has(
      `${server.source.builtinId}/${descriptor.name}`,
    );
  const destructive = descriptor.annotations?.destructiveHint === true;
  const policy = evaluateMcpToolPolicy(server, {
    name: descriptor.name,
    readOnlyHint: trustedReadOnly,
    destructiveHint: destructive,
  });
  const classification = Object.freeze({
    readOnly: trustedReadOnly && !destructive,
    destructive,
    requiresApproval: destructive || policy.decision === 'ask',
  });
  return { policy, classification };
}

export function createTrustedRegistryMcpDescriptorCommitment(
  server: McpServerConfig,
  descriptor: McpToolDescriptor,
): {
  evaluation: TrustedRegistryMcpToolEvaluation;
  descriptor: TrustedMcpDescriptorCommitment;
} {
  const evaluation = evaluateTrustedRegistryMcpTool(server, descriptor);
  return {
    evaluation,
    descriptor: createTrustedMcpDescriptorCommitment({
      domain: 'registry-mcp',
      authorityId: `registry:${server.id}`,
      toolName: descriptor.name,
      descriptor,
      authorityBinding: server,
      classification: { ...evaluation.classification },
    }),
  };
}

/**
 * Commits the complete normalized descriptor plus the trusted classification
 * and authority binding. Only bounded canonical JSON is accepted so a hostile
 * MCP descriptor cannot make the authorization object ambiguous or unbounded.
 */
export function createTrustedMcpDescriptorCommitment(
  input: CreateTrustedMcpDescriptorCommitmentInput,
): TrustedMcpDescriptorCommitment {
  const authorityId = requireBoundedId(input.authorityId, 'MCP authority');
  const toolName = requireBoundedId(input.toolName, 'MCP tool name');
  const classification = normalizeClassification(input.classification);
  const descriptorSha256 = hashCanonicalValue(
    input.descriptor,
    'MCP tool descriptor',
  );
  const authorityBindingSha256 = hashCanonicalValue(
    input.authorityBinding,
    'MCP authority binding',
  );
  const unsigned = {
    version: COMMITMENT_VERSION,
    domain: input.domain,
    authorityId,
    toolName,
    descriptorSha256,
    authorityBindingSha256,
    classification,
  } as const;

  return Object.freeze({
    ...unsigned,
    classification: Object.freeze({ ...classification }),
    digest: hashCanonicalValue(unsigned, 'MCP descriptor commitment'),
  });
}

/** Binds an already-reviewed descriptor to the current runtime generation. */
export function createTrustedMcpDispatchCommitment(
  descriptor: TrustedMcpDescriptorCommitment,
  runtimeBinding: unknown,
): TrustedMcpDispatchCommitment {
  const runtimeBindingSha256 = hashCanonicalValue(
    runtimeBinding,
    'MCP runtime binding',
  );
  const unsigned = {
    version: COMMITMENT_VERSION,
    descriptorDigest: descriptor.digest,
    runtimeBindingSha256,
  } as const;

  return Object.freeze({
    version: COMMITMENT_VERSION,
    descriptor,
    runtimeBindingSha256,
    digest: hashCanonicalValue(unsigned, 'MCP dispatch commitment'),
  });
}

/**
 * Creates a short-lived, one-shot authority after trusted approval. The
 * capability is bound to the reviewed descriptor, principal, tool call and
 * exact arguments; the agent never receives the capability object.
 */
export function createTrustedMcpApprovalAuthority(input: {
  descriptor: TrustedMcpDescriptorCommitment;
  effect: TrustedMcpFinalAuthorityEffect;
  ttlMs?: number;
  now?: () => number;
}): TrustedMcpFinalAuthority {
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? DEFAULT_FINAL_AUTHORITY_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('MCP final-authority TTL is invalid');
  }
  const expectedEffectDigest = hashTrustedMcpFinalAuthorityEffect(
    input.descriptor,
    input.effect,
  );
  const expiresAt = now() + ttlMs;
  let consumed = false;

  return Object.freeze({
    [trustedMcpFinalAuthorityBrand]: true as const,
    prepareFinalCheck(): void {},
    assertAndConsume(current): void {
      if (consumed) {
        throw new Error('MCP final authority was already consumed');
      }
      consumed = true;
      if (now() > expiresAt) {
        throw new Error('MCP final authority expired before dispatch');
      }
      if (
        hashTrustedMcpFinalAuthorityEffect(
          current.descriptor,
          current.effect,
        ) !== expectedEffectDigest
      ) {
        throw new Error('MCP approved effect changed before dispatch');
      }
    },
  });
}

/**
 * Wraps an existing trusted subsystem fence as a one-shot object-capability.
 * `onConsumed` is a notification, not a security check: it runs only after the
 * registry has matched its current dispatch commitment and consumed authority.
 */
export function createTrustedMcpFenceAuthority(
  fence: () => void,
  options: {
    ttlMs?: number;
    now?: () => number;
    onConsumed?: () => void;
  } = {},
): TrustedMcpFinalAuthority {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_FINAL_AUTHORITY_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('MCP final-authority TTL is invalid');
  }
  const expiresAt = now() + ttlMs;
  let consumed = false;
  let prepared = false;

  return Object.freeze({
    [trustedMcpFinalAuthorityBrand]: true as const,
    prepareFinalCheck(): void {
      if (consumed) {
        throw new Error('MCP final authority was already consumed');
      }
      if (prepared) {
        throw new Error('MCP final authority fence was already prepared');
      }
      if (now() > expiresAt) {
        throw new Error('MCP final authority expired before dispatch');
      }
      fence();
      prepared = true;
    },
    assertAndConsume(): void {
      if (consumed) {
        throw new Error('MCP final authority was already consumed');
      }
      if (!prepared) {
        throw new Error('MCP final authority fence was not checked');
      }
      if (now() > expiresAt) {
        throw new Error('MCP final authority expired before dispatch');
      }
      consumed = true;
      options.onConsumed?.();
    },
  });
}

export function assertTrustedMcpDescriptorCommitment(
  expected: TrustedMcpDescriptorCommitment,
  current: TrustedMcpDescriptorCommitment,
): void {
  if (expected.digest !== current.digest) {
    throw new Error(
      'MCP descriptor or authority changed after the tool was committed',
    );
  }
}

export function assertTrustedMcpDispatchCommitment(
  expected: TrustedMcpDispatchCommitment,
  current: TrustedMcpDispatchCommitment,
): void {
  if (expected.digest !== current.digest) {
    throw new Error('MCP runtime binding changed after the tool was exposed');
  }
}

/**
 * Runs the optional Guardian hook before returning a synchronous final fence.
 * A disabled Guardian is represented by `null`; a configured hook that throws
 * or returns malformed data fails closed. Escalation/irreversibility requires
 * a trusted approval authority, while an explicit deny is always a veto.
 */
export async function authorizeTrustedMcpDispatch(input: {
  commitment: TrustedMcpDispatchCommitment;
  assessGuardian?: GuardianPolicyChecker | null;
  finalAuthority?: TrustedMcpFinalAuthority | null;
  effect?: TrustedMcpFinalAuthorityEffect;
}): Promise<TrustedMcpDispatchAuthorization> {
  const { commitment } = input;
  const finalAuthority = input.finalAuthority;
  const effect = input.effect;
  if (
    commitment.descriptor.classification.requiresApproval &&
    !finalAuthority
  ) {
    throw new Error('MCP dispatch requires trusted final authority');
  }
  if (finalAuthority && !effect) {
    throw new Error('MCP final authority is missing its effect binding');
  }
  let guardianRequiresAuthority = false;
  const checker = input.assessGuardian;
  if (checker) {
    let rawAssessment: Awaited<ReturnType<GuardianPolicyChecker>>;
    try {
      rawAssessment = await checker(
        createMcpGuardianRequest({
          toolName: commitment.descriptor.toolName,
          readOnly: commitment.descriptor.classification.readOnly,
          destructive: commitment.descriptor.classification.destructive,
          requiresApproval:
            commitment.descriptor.classification.requiresApproval,
        }),
      );
    } catch {
      throw new Error('Guardian MCP authorization failed closed');
    }

    if (rawAssessment !== null) {
      const assessment = guardianAssessmentSchema.safeParse(rawAssessment);
      if (!assessment.success || assessment.data.kind !== 'mcp') {
        throw new Error('Guardian returned an invalid MCP assessment');
      }
      if (assessment.data.decision === 'deny') {
        throw new Error(
          `Guardian denied MCP dispatch: ${assessment.data.explanation}`,
        );
      }
      guardianRequiresAuthority =
        assessment.data.decision === 'escalate' || assessment.data.irreversible;
    }
  }

  if (guardianRequiresAuthority && !finalAuthority) {
    throw new Error('Guardian requires trusted MCP final authority');
  }

  return Object.freeze({
    commitment,
    prepareFinalCheck(): void {
      finalAuthority?.prepareFinalCheck();
    },
    assertCurrent(current: TrustedMcpDispatchCommitment): void {
      if (current.digest !== commitment.digest) {
        throw new Error('MCP dispatch commitment changed after authorization');
      }
      if (finalAuthority) {
        finalAuthority.assertAndConsume({
          descriptor: current.descriptor,
          effect: effect!,
        });
      }
    },
  });
}

function normalizeClassification(
  input: TrustedMcpToolClassification,
): TrustedMcpToolClassification {
  const classification = {
    readOnly: input.readOnly === true,
    destructive: input.destructive === true,
    requiresApproval: input.requiresApproval === true,
  };
  if (classification.readOnly && classification.destructive) {
    throw new Error('MCP tool cannot be both read-only and destructive');
  }
  if (classification.destructive && !classification.requiresApproval) {
    throw new Error('Destructive MCP tool dispatch requires approval');
  }
  return classification;
}

function requireBoundedId(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_COMMITMENT_ID_LENGTH ||
    normalized.includes('\0')
  ) {
    throw new Error(`${label} is not a bounded dispatch identifier`);
  }
  return normalized;
}

export function hashTrustedMcpFinalAuthorityEffect(
  descriptor: TrustedMcpDescriptorCommitment,
  effect: TrustedMcpFinalAuthorityEffect,
): string {
  return hashTrustedMcpFinalAuthorityEffectForDescriptorDigest(
    descriptor.digest,
    effect,
  );
}

/**
 * Recomputes an exact effect commitment when only the previously reviewed
 * descriptor digest remains available. This is used by durable approval
 * lifecycle recovery without persisting the raw descriptor or arguments.
 */
export function hashTrustedMcpFinalAuthorityEffectForDescriptorDigest(
  descriptorDigest: string,
  effect: TrustedMcpFinalAuthorityEffect,
): string {
  if (!/^[a-f0-9]{64}$/.test(descriptorDigest)) {
    throw new Error('MCP descriptor digest is invalid');
  }
  return hashCanonicalValue(
    {
      descriptorDigest,
      principalId: requireBoundedId(effect.principalId, 'MCP principal'),
      toolCallId: requireBoundedId(effect.toolCallId, 'MCP tool call'),
      arguments: effect.arguments,
    },
    'MCP final-authority effect',
  );
}

function hashCanonicalValue(value: unknown, label: string): string {
  const canonical = canonicalize(value, label);
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(value: unknown, label: string): string {
  const seen = new Set<object>();
  let nodes = 0;
  let canonicalBytes = 0;

  const charge = (fragment: string): string => {
    canonicalBytes += Buffer.byteLength(fragment, 'utf8');
    if (canonicalBytes > MAX_CANONICAL_BYTES) {
      throw new Error(`${label} exceeds the canonical byte limit`);
    }
    return fragment;
  };

  const visit = (candidate: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_CANONICAL_NODES) {
      throw new Error(`${label} exceeds the canonical node limit`);
    }
    if (depth > MAX_CANONICAL_DEPTH) {
      throw new Error(`${label} exceeds the canonical depth limit`);
    }

    if (candidate === null) return charge('null');
    switch (typeof candidate) {
      case 'boolean':
        return charge(candidate ? 'true' : 'false');
      case 'number':
        if (!Number.isFinite(candidate)) {
          throw new Error(`${label} contains a non-finite number`);
        }
        return charge(Object.is(candidate, -0) ? '0' : String(candidate));
      case 'string':
        return charge(encodeJsonString(candidate));
      case 'object':
        break;
      default:
        throw new Error(`${label} is outside the canonical JSON subset`);
    }

    if (seen.has(candidate)) {
      throw new Error(`${label} contains a cyclic value`);
    }
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const entries: string[] = [];
        charge('[');
        for (let index = 0; index < candidate.length; index += 1) {
          if (!Object.hasOwn(candidate, index)) {
            throw new Error(`${label} contains a sparse array`);
          }
          if (index > 0) charge(',');
          entries.push(visit(candidate[index], depth + 1));
        }
        charge(']');
        return `[${entries.join(',')}]`;
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${label} contains a non-plain object`);
      }
      if (Object.getOwnPropertySymbols(candidate).length > 0) {
        throw new Error(`${label} contains symbol properties`);
      }
      const record = candidate as Record<string, unknown>;
      const entries: string[] = [];
      charge('{');
      for (const [index, key] of Object.keys(record).sort().entries()) {
        const property = Object.getOwnPropertyDescriptor(record, key);
        if (!property || !('value' in property)) {
          throw new Error(`${label} contains an accessor property`);
        }
        if (index > 0) charge(',');
        const encodedKey = charge(encodeJsonString(key));
        charge(':');
        entries.push(`${encodedKey}:${visit(property.value, depth + 1)}`);
      }
      charge('}');
      return `{${entries.join(',')}}`;
    } finally {
      seen.delete(candidate);
    }
  };

  const canonical = visit(value, 0);
  if (Buffer.byteLength(canonical, 'utf8') !== canonicalBytes) {
    throw new Error(`${label} canonical byte accounting failed`);
  }
  return canonical;
}

function encodeJsonString(value: string): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error('Unable to encode canonical JSON string');
  }
  return encoded;
}
