import type { AgentStore } from '@clodex/agent-core';
import {
  createTrustedMcpApprovalAuthority,
  hashTrustedMcpFinalAuthorityEffect,
  type TrustedMcpDescriptorCommitment,
  type TrustedMcpFinalAuthority,
  type TrustedMcpFinalAuthorityEffect,
} from './trusted-dispatch-gateway';

const CLAIM_TTL_MS = 24 * 60 * 60_000;
const MAX_CLAIMS = 10_000;

export interface ClaimTrustedMcpApprovalInput {
  agentInstanceId: string;
  toolCallId: string;
  aiToolName: string;
  arguments: Record<string, unknown>;
  descriptor: TrustedMcpDescriptorCommitment;
  approvalContextDigest: string;
}

export type StageTrustedMcpApprovalInput = ClaimTrustedMcpApprovalInput;

interface PendingApprovalRecord {
  input: StageTrustedMcpApprovalInput;
  effectDigest: string;
  expiresAt: number;
}

/**
 * Claims authority only from canonical AgentStore history after the AI SDK has
 * recorded an affirmative approval response for the exact tool name/input.
 */
export class TrustedMcpApprovalBroker {
  private readonly claims = new Set<string>();
  private readonly pending = new Map<string, PendingApprovalRecord>();

  public constructor(private readonly agentStore: AgentStore) {}

  public stage(input: StageTrustedMcpApprovalInput): void {
    this.cleanupClaims();
    const key = claimKey(input.agentInstanceId, input.toolCallId);
    const effectDigest = approvalEffectDigest(input);
    const existing = this.pending.get(key);
    if (existing) {
      if (
        existing.input.aiToolName === input.aiToolName &&
        existing.input.descriptor.digest === input.descriptor.digest &&
        existing.input.approvalContextDigest === input.approvalContextDigest &&
        existing.effectDigest === effectDigest
      ) {
        return;
      }
      throw new Error('MCP pending approval cannot be replaced');
    }
    if (this.pending.size >= MAX_CLAIMS) {
      throw new Error('MCP pending approval capacity is exhausted');
    }
    this.pending.set(key, {
      input,
      effectDigest,
      expiresAt: Date.now() + CLAIM_TTL_MS,
    });
  }

  public claim(
    input: ClaimTrustedMcpApprovalInput,
  ): TrustedMcpFinalAuthority | null {
    this.cleanupClaims();
    const key = claimKey(input.agentInstanceId, input.toolCallId);
    if (this.claims.has(key)) {
      throw new Error('MCP approval was already claimed');
    }
    const pending = this.pending.get(key);
    if (!pending) return null;
    if (
      pending.input.aiToolName !== input.aiToolName ||
      pending.input.descriptor.digest !== input.descriptor.digest ||
      pending.input.approvalContextDigest !== input.approvalContextDigest ||
      pending.effectDigest !== approvalEffectDigest(input)
    ) {
      throw new Error('MCP staged approval does not match execution');
    }

    const matches = findApprovedToolParts(
      this.agentStore,
      input.agentInstanceId,
      input.toolCallId,
    );
    if (matches.length === 0) return null;
    if (matches.length !== 1)
      throw new Error('MCP approval evidence is ambiguous');
    const approved = matches[0]!;
    if (approved.toolName !== input.aiToolName) {
      throw new Error('MCP approved tool name does not match execution');
    }

    const effect: TrustedMcpFinalAuthorityEffect = {
      principalId: input.agentInstanceId,
      toolCallId: input.toolCallId,
      arguments: input.arguments,
    };
    const approvedEffect: TrustedMcpFinalAuthorityEffect = {
      ...effect,
      arguments: approved.input,
    };
    if (
      hashTrustedMcpFinalAuthorityEffect(input.descriptor, effect) !==
      hashTrustedMcpFinalAuthorityEffect(input.descriptor, approvedEffect)
    ) {
      throw new Error('MCP approved input does not match execution');
    }

    if (this.claims.size >= MAX_CLAIMS) {
      throw new Error('MCP approval claim capacity is exhausted');
    }
    this.pending.delete(key);
    this.claims.add(key);
    return createTrustedMcpApprovalAuthority({
      descriptor: input.descriptor,
      effect,
    });
  }

  private cleanupClaims(): void {
    const now = Date.now();
    for (const [key, record] of this.pending) {
      if (record.expiresAt < now) this.pending.delete(key);
    }
  }
}

function approvalEffectDigest(input: ClaimTrustedMcpApprovalInput): string {
  return hashTrustedMcpFinalAuthorityEffect(input.descriptor, {
    principalId: input.agentInstanceId,
    toolCallId: input.toolCallId,
    arguments: input.arguments,
  });
}

function findApprovedToolParts(
  store: AgentStore,
  agentInstanceId: string,
  toolCallId: string,
): Array<{ toolName: string; input: Record<string, unknown> }> {
  const history = store.get().agents.instances[agentInstanceId]?.state.history;
  if (!history) return [];
  const matches: Array<{ toolName: string; input: Record<string, unknown> }> =
    [];
  for (const message of history) {
    if (message.role !== 'assistant') continue;
    for (const rawPart of message.parts) {
      if (!rawPart || typeof rawPart !== 'object') continue;
      const part = rawPart as Record<string, unknown>;
      if (
        part.toolCallId !== toolCallId ||
        part.state !== 'approval-responded'
      ) {
        continue;
      }
      const approval = part.approval;
      if (
        !approval ||
        typeof approval !== 'object' ||
        (approval as Record<string, unknown>).approved !== true
      ) {
        continue;
      }
      const type = typeof part.type === 'string' ? part.type : '';
      const toolName =
        type === 'dynamic-tool' && typeof part.toolName === 'string'
          ? part.toolName
          : type.startsWith('tool-')
            ? type.slice('tool-'.length)
            : '';
      if (!toolName || !isRecord(part.input)) continue;
      matches.push({ toolName, input: part.input });
    }
  }
  return matches;
}

function claimKey(agentInstanceId: string, toolCallId: string): string {
  return JSON.stringify([agentInstanceId, toolCallId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
