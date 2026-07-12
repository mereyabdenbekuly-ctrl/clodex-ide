import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ShellCapabilityAction,
  ShellCapabilityAuthorization,
  ShellCapabilitySecurityDeps,
} from '@clodex/agent-shell';

const DEFAULT_TTL_MS = 5 * 60_000;
const AUDIT_SCHEMA_VERSION = 1;

interface ShellCapabilityGrant {
  capabilityId: string;
  agentInstanceId: string;
  toolCallId: string;
  actionHash: string;
  authorization: ShellCapabilityAuthorization;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

export type ShellCapabilityAuditEventType =
  | 'staged'
  | 'human-authorized'
  | 'consumed'
  | 'rejected';

export interface ShellCapabilityAuditEvent {
  schemaVersion: number;
  sequence: number;
  eventId: string;
  eventType: ShellCapabilityAuditEventType;
  createdAt: number;
  capabilityId: string | null;
  agentInstanceId: string;
  toolCallId: string;
  actionHash: string;
  authorization: ShellCapabilityAuthorization | 'human-approved' | null;
  reason: string | null;
  previousHash: string;
  eventHash: string;
}

export interface ShellCapabilityBrokerOptions {
  auditPath: string;
  ttlMs?: number;
  now?: () => number;
}

/**
 * Trusted one-time capability broker for shell effects.
 *
 * The agent never receives the capability ID. A grant is bound to the agent,
 * tool call, canonical action hash and a short expiry. `execute` is reachable
 * only after the AI SDK's approval gate, so consuming a human-required grant
 * is also the trusted signal that the user approved that exact tool call.
 */
export class ShellCapabilityBroker implements ShellCapabilitySecurityDeps {
  private readonly grants = new Map<string, ShellCapabilityGrant>();
  private readonly audit: ShellCapabilityAuditLedger;
  private readonly ttlMs: number;
  private readonly now: () => number;

  private constructor(
    options: ShellCapabilityBrokerOptions,
    audit: ShellCapabilityAuditLedger,
  ) {
    this.audit = audit;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  public static async create(
    options: ShellCapabilityBrokerOptions,
  ): Promise<ShellCapabilityBroker> {
    const audit = await ShellCapabilityAuditLedger.create(options.auditPath);
    return new ShellCapabilityBroker(options, audit);
  }

  public async stage(input: {
    agentInstanceId: string;
    toolCallId: string;
    action: ShellCapabilityAction;
    authorization: ShellCapabilityAuthorization;
  }): Promise<void> {
    this.cleanupExpired();
    const createdAt = this.now();
    const actionHash = hashShellCapabilityAction(input.action);
    const key = grantKey(input.toolCallId);
    const existing = this.grants.get(key);
    if (existing) {
      if (
        existing.usedAt === null &&
        existing.actionHash === actionHash &&
        existing.authorization === input.authorization
      ) {
        return;
      }
      await this.auditRejection(
        input,
        actionHash,
        existing,
        existing.usedAt === null
          ? 'capability-restage-mismatch'
          : 'capability-restage-after-consumption',
      );
      throw new Error('Shell capability cannot be replaced after staging');
    }
    const grant: ShellCapabilityGrant = {
      capabilityId: randomUUID(),
      agentInstanceId: input.agentInstanceId,
      toolCallId: input.toolCallId,
      actionHash,
      authorization: input.authorization,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      usedAt: null,
    };
    this.grants.set(key, grant);
    await this.audit.append({
      eventType: 'staged',
      createdAt,
      capabilityId: grant.capabilityId,
      agentInstanceId: grant.agentInstanceId,
      toolCallId: grant.toolCallId,
      actionHash: grant.actionHash,
      authorization: grant.authorization,
      reason: null,
    });
  }

  public async consume(input: {
    agentInstanceId: string;
    toolCallId: string;
    action: ShellCapabilityAction;
  }): Promise<void> {
    const now = this.now();
    const actionHash = hashShellCapabilityAction(input.action);
    const grant = this.grants.get(grantKey(input.toolCallId));

    if (!grant) {
      await this.auditRejection(input, actionHash, null, 'missing-capability');
      throw new Error('Shell capability is missing; execution blocked');
    }
    if (grant.agentInstanceId !== input.agentInstanceId) {
      await this.auditRejection(
        input,
        actionHash,
        grant,
        'agent-binding-mismatch',
      );
      throw new Error('Shell capability belongs to a different agent');
    }
    if (grant.usedAt !== null) {
      await this.auditRejection(input, actionHash, grant, 'capability-replay');
      throw new Error('Shell capability was already consumed');
    }
    if (now > grant.expiresAt) {
      await this.auditRejection(input, actionHash, grant, 'capability-expired');
      throw new Error('Shell capability expired before execution');
    }
    if (grant.actionHash !== actionHash) {
      await this.auditRejection(
        input,
        actionHash,
        grant,
        'action-hash-mismatch',
      );
      throw new Error('Shell action changed after authorization');
    }

    if (grant.authorization === 'human-required') {
      await this.audit.append({
        eventType: 'human-authorized',
        createdAt: now,
        capabilityId: grant.capabilityId,
        agentInstanceId: grant.agentInstanceId,
        toolCallId: grant.toolCallId,
        actionHash: grant.actionHash,
        authorization: 'human-approved',
        reason: null,
      });
    }

    grant.usedAt = now;
    await this.audit.append({
      eventType: 'consumed',
      createdAt: now,
      capabilityId: grant.capabilityId,
      agentInstanceId: grant.agentInstanceId,
      toolCallId: grant.toolCallId,
      actionHash: grant.actionHash,
      authorization:
        grant.authorization === 'human-required'
          ? 'human-approved'
          : grant.authorization,
      reason: null,
    });
  }

  private cleanupExpired(): void {
    const now = this.now();
    for (const [key, grant] of this.grants) {
      if (now > grant.expiresAt) {
        this.grants.delete(key);
      }
    }
  }

  private async auditRejection(
    input: {
      agentInstanceId: string;
      toolCallId: string;
    },
    actionHash: string,
    grant: ShellCapabilityGrant | null,
    reason: string,
  ): Promise<void> {
    await this.audit.append({
      eventType: 'rejected',
      createdAt: this.now(),
      capabilityId: grant?.capabilityId ?? null,
      agentInstanceId: input.agentInstanceId,
      toolCallId: input.toolCallId,
      actionHash,
      authorization: grant?.authorization ?? null,
      reason,
    });
  }
}

function grantKey(toolCallId: string): string {
  return toolCallId;
}

export function hashShellCapabilityAction(
  action: ShellCapabilityAction,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(action)))
    .digest('hex');
}

class ShellCapabilityAuditLedger {
  private sequence = 0;
  private previousHash = '';
  private queue = Promise.resolve();

  private constructor(private readonly auditPath: string) {}

  public static async create(
    auditPath: string,
  ): Promise<ShellCapabilityAuditLedger> {
    const ledger = new ShellCapabilityAuditLedger(auditPath);
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    try {
      const content = await fs.readFile(auditPath, 'utf8');
      const events = parseAuditEvents(content);
      verifyShellCapabilityAuditChain(events);
      const last = events.at(-1);
      ledger.sequence = last?.sequence ?? 0;
      ledger.previousHash = last?.eventHash ?? '';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return ledger;
  }

  public append(
    input: Omit<
      ShellCapabilityAuditEvent,
      'schemaVersion' | 'sequence' | 'eventId' | 'previousHash' | 'eventHash'
    >,
  ): Promise<void> {
    this.queue = this.queue.then(async () => {
      const eventWithoutHash = {
        schemaVersion: AUDIT_SCHEMA_VERSION,
        sequence: this.sequence + 1,
        eventId: randomUUID(),
        ...input,
        previousHash: this.previousHash,
      };
      const event: ShellCapabilityAuditEvent = {
        ...eventWithoutHash,
        eventHash: hashAuditEvent(eventWithoutHash),
      };
      await fs.appendFile(this.auditPath, `${JSON.stringify(event)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      this.sequence = event.sequence;
      this.previousHash = event.eventHash;
    });
    return this.queue;
  }
}

export function parseAuditEvents(content: string): ShellCapabilityAuditEvent[] {
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ShellCapabilityAuditEvent);
}

export function verifyShellCapabilityAuditChain(
  events: readonly ShellCapabilityAuditEvent[],
): void {
  let previousHash = '';
  let sequence = 0;
  for (const event of events) {
    if (event.schemaVersion !== AUDIT_SCHEMA_VERSION) {
      throw new Error('Unsupported shell capability audit schema');
    }
    if (event.sequence !== sequence + 1) {
      throw new Error('Shell capability audit sequence is invalid');
    }
    if (event.previousHash !== previousHash) {
      throw new Error('Shell capability audit chain is broken');
    }
    const { eventHash, ...withoutHash } = event;
    if (hashAuditEvent(withoutHash) !== eventHash) {
      throw new Error('Shell capability audit event was modified');
    }
    sequence = event.sequence;
    previousHash = event.eventHash;
  }
}

function hashAuditEvent(
  event: Omit<ShellCapabilityAuditEvent, 'eventHash'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(event)))
    .digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}
