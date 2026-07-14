/**
 * Host-neutral snapshot of one explicit tool-approval response.
 *
 * The core captures this binding before mutating AgentStore so a host can
 * durably prepare its own authorization lifecycle without depending on any
 * host-specific broker or tool implementation.
 */
export interface ToolApprovalDecisionIntent {
  readonly agentInstanceId: string;
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly approved: boolean;
}

/**
 * Opaque host-owned token returned by the prepare phase and handed back only
 * after the matching AgentStore response has reached durable persistence.
 */
export interface ToolApprovalDecisionCommit {
  readonly token: unknown;
}

export type ToolApprovalInvalidationReason =
  | 'new-user-message'
  | 'queue-flush'
  | 'user-stop'
  | 'system-interrupted';

/** Host-neutral request to invalidate approvals displaced by agent lifecycle. */
export interface ToolApprovalInvalidationIntent {
  readonly agentInstanceId: string;
  readonly toolCallIds: readonly string[];
  readonly reason: ToolApprovalInvalidationReason;
}

/**
 * Optional host lifecycle around explicit approval responses.
 *
 * `prepareResponse` may return `null` when the approval is not managed by the
 * host. A non-null token must not be committed until the exact AgentStore
 * response has been durably persisted. Preparing alone never authorizes tool
 * execution.
 */
export interface ToolApprovalLifecycleHooks {
  prepareResponse(
    intent: ToolApprovalDecisionIntent,
  ): Promise<ToolApprovalDecisionCommit | null>;
  commitResponse(commit: ToolApprovalDecisionCommit): Promise<void>;
  /** Returns the number of host-managed open records durably invalidated. */
  invalidateOpen(intent: ToolApprovalInvalidationIntent): Promise<number>;
}
