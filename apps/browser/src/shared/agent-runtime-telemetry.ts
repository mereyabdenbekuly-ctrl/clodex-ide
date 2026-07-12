export const isolatedAgentRuntimeObservationEventNames = [
  'isolated-agent-runtime-rollout-observed',
  'agent-step-runtime-finished',
  'agent-host-process-lifecycle',
  'agent-step-runtime-circuit-breaker',
] as const;

export const agentStepRuntimeSelectionReasons = [
  'compatible',
  'kill-switch-active',
  'gate-disabled',
  'worker-unavailable',
  'circuit-breaker-open',
  'approval-continuation',
  'unsupported-prompt-shape',
  'unsupported-structured-output',
  'unsupported-callback',
  'unsupported-multimodal-content',
  'unsupported-provider-options',
  'unsupported-message-content',
  'unsupported-tool-content',
  'unsupported-tool-type',
  'tool-without-executor',
  'schema-serialization-failed',
  'metadata-serialization-failed',
  'preparation-error',
] as const;

export type AgentStepRuntimeSelectionReason =
  (typeof agentStepRuntimeSelectionReasons)[number];

export interface AgentStepRuntimeTelemetryEvents {
  /**
   * Content-free routing decision for one BaseAgent step.
   *
   * This event deliberately excludes prompts, message contents, tool names,
   * tool inputs/outputs, system prompts, trace ids, and agent instance ids.
   */
  'agent-step-runtime-selected': {
    agent_type: string;
    model_id: string;
    runtime: 'local' | 'isolated';
    reason: AgentStepRuntimeSelectionReason;
    preparation_duration_ms: number;
  };
  /**
   * Terminal outcome for a step that entered the isolated execution lane.
   */
  'agent-step-runtime-finished': {
    agent_type: string;
    model_id: string;
    runtime: 'isolated';
    outcome: 'completed' | 'aborted' | 'failed';
    duration_ms: number;
  };
  /**
   * Content-free state transition for the isolated-lane circuit breaker.
   */
  'agent-step-runtime-circuit-breaker': {
    state: 'open' | 'half-open' | 'closed';
    trigger:
      | 'failure-threshold'
      | 'cooldown-elapsed'
      | 'probe-succeeded'
      | 'probe-failed'
      | 'probe-aborted'
      | 'success-reset';
    consecutive_failures: number;
    failure_threshold: number;
    cooldown_ms: number;
  };
}

export interface AgentStepRuntimeTelemetrySink {
  capture<T extends keyof AgentStepRuntimeTelemetryEvents>(
    eventName: T,
    properties: AgentStepRuntimeTelemetryEvents[T],
  ): void;
}

export interface AgentHostProcessTelemetryEvents {
  /**
   * Content-free lifecycle signal for the supervised utility process.
   */
  'agent-host-process-lifecycle': {
    phase:
      | 'worker-crashed'
      | 'restart-scheduled'
      | 'restart-succeeded'
      | 'restart-spawn-failed'
      | 'restart-budget-exhausted';
    restart_attempt: number;
    exit_code?: number;
    delay_ms?: number;
    recovery_duration_ms?: number;
    pending_execution_count?: number;
    pending_turn_count?: number;
  };
}

export interface AgentHostProcessTelemetrySink {
  capture<T extends keyof AgentHostProcessTelemetryEvents>(
    eventName: T,
    properties: AgentHostProcessTelemetryEvents[T],
  ): void;
}

export interface IsolatedAgentRuntimeRolloutTelemetryEvents {
  /**
   * Content-free launch snapshot used to measure rollout exposure.
   *
   * Release channel, app version, platform, and architecture are added by the
   * central TelemetryService.
   */
  'isolated-agent-runtime-rollout-observed': {
    rollout_stage: 'canary' | 'next' | 'hold';
    policy_default_enabled: boolean;
    gate_enabled: boolean;
    gate_source: 'unavailable' | 'default' | 'override';
    kill_switch_active: boolean;
    worker_available: boolean;
    effective_enabled: boolean;
    failure_threshold: number;
    cooldown_ms: number;
  };
}
