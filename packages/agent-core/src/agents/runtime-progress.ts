/** Logical phase currently owned by one live agent run. */
export type AgentRuntimePhase =
  | 'idle'
  | 'preparing'
  | 'resolving-model'
  | 'generating-context'
  | 'waiting-model'
  | 'streaming-model'
  | 'policy-check'
  | 'tool-running'
  | 'awaiting-approval'
  | 'post-step'
  | 'persisting'
  | 'compressing';

/**
 * Whether the current visible user turn may already have crossed an
 * executable or durable effect boundary (tool execution, transcript
 * persistence, compaction write, or another non-replay-safe transition).
 *
 * The value is monotonic within a visible user turn. It resets to
 * `pre-effect` only when a different user message becomes the latest visible
 * user message; autonomous steps and approval continuations retain it.
 */
export type AgentRuntimeEffectBoundary =
  | 'pre-effect'
  | 'post-effect'
  | 'uncertain';

/** Immutable host-facing snapshot used by logical-inactivity watchdogs. */
export type AgentRuntimeProgress = {
  readonly phase: AgentRuntimePhase;
  /** Epoch milliseconds of the latest generation-safe logical heartbeat. */
  readonly lastProgressAt: number;
  /** Monotonic BaseAgent step generation owning this snapshot. */
  readonly stepGeneration: number;
  readonly effectBoundary: AgentRuntimeEffectBoundary;
};

/** Result of one generation-fenced logical-inactivity recovery attempt. */
export type AgentLogicalInactivityRecoveryResult =
  | 'ignored'
  | 'retried'
  | 'failed-closed';

export function agentRuntimeProgressMatches(
  current: AgentRuntimeProgress,
  expected: AgentRuntimeProgress,
): boolean {
  return (
    current.phase === expected.phase &&
    current.lastProgressAt === expected.lastProgressAt &&
    current.stepGeneration === expected.stepGeneration &&
    current.effectBoundary === expected.effectBoundary
  );
}
