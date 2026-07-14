import superjson from 'superjson';

/** Exact history identity expected by a security-sensitive persistence call. */
export interface AgentStatePersistMessageBinding {
  readonly messageIndex: number;
  readonly messageId: string;
}

/** Options for persisting the current immutable AgentStore snapshot. */
export interface AgentStatePersistOptions {
  /** Exact history rows mutated in place and therefore requiring an update. */
  readonly dirtyMessageIndices?: readonly number[];
  /** Fail if a queued save no longer observes these exact history identities. */
  readonly expectedMessageBindings?: readonly AgentStatePersistMessageBinding[];
  /** Propagate the storage error instead of retaining best-effort behavior. */
  readonly throwOnError?: boolean;
}

/**
 * Legacy array requests remain accepted while callers migrate to the explicit
 * options object used by strict approval persistence.
 */
export type AgentStatePersistRequest =
  | AgentStatePersistOptions
  | readonly number[];

/**
 * Stable byte-level representation of the exact message payload written to an
 * `agentMessages` row. Metadata is normalized to `null` because that is the
 * persistence schema's representation for an absent value.
 */
export function serializeAgentStatePersistMessage(message: {
  readonly id: string;
  readonly role: string;
  readonly parts: unknown;
  readonly metadata?: unknown;
}): string {
  return superjson.stringify({
    messageId: message.id,
    role: message.role,
    parts: message.parts,
    metadata: message.metadata ?? null,
  });
}
