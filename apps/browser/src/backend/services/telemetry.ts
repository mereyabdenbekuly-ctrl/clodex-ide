import { z } from 'zod';
import { createHash } from 'node:crypto';
import { PostHog } from 'posthog-node';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { withTracing } from '@posthog/ai';
import type { IdentifierService } from './identifier';
import type { PreferencesService } from './preferences';
import {
  modelProviderSchema,
  personalizationThemeIdSchema,
  socialAuthProviderSchema,
  type ModelProvider,
  type PersonalizationThemeId,
  type SocialAuthProvider,
  type TelemetryLevel,
  type ToolApprovalMode,
} from '@shared/karton-contracts/ui/shared-types';
import type { CodingPlanId } from '@shared/coding-plans';
import type {
  AgentHostProcessTelemetryEvents,
  AgentStepRuntimeTelemetryEvents,
  IsolatedAgentRuntimeRolloutTelemetryEvents,
} from '@shared/agent-runtime-telemetry';
import type { Logger } from './logger';
import { DisposableService } from './disposable';
import { captureProcessSnapshot } from './telemetry/process-snapshot';

type OnboardingAuthMethod = 'clodex' | 'api-keys' | 'coding-plan' | 'local';
type OnboardingAuthCompletionMethod = OnboardingAuthMethod | 'unknown';
type OnboardingAuthFailureKind =
  | 'validation-error'
  | 'backend-error'
  | 'network-error'
  | 'unknown-error';
type OnboardingOtpFailureKind =
  | 'backend-error'
  | 'network-error'
  | 'turnstile-not-ready';

const onboardingAuthMethodSchema = z.enum([
  'clodex',
  'api-keys',
  'coding-plan',
]);
const codingPlanIdSchema = z.enum([
  'glm-coding-plan',
  'kimi-plan',
  'qwen-plan',
  'minimax-plan',
  'mimo-plan',
]);
const onboardingAuthFailureKindSchema = z.enum([
  'validation-error',
  'backend-error',
  'network-error',
  'unknown-error',
]);
const onboardingOtpFailureKindSchema = z.enum([
  'backend-error',
  'network-error',
  'turnstile-not-ready',
]);

export interface EventProperties
  extends AgentStepRuntimeTelemetryEvents,
    AgentHostProcessTelemetryEvents,
    IsolatedAgentRuntimeRolloutTelemetryEvents {
  // Lifecycle
  'app-launched': {
    matched_process_counts: Record<string, number>;
    total_matched_processes: number;
  };
  'app-closed': {
    matched_process_counts: Record<string, number>;
    total_matched_processes: number;
  };
  'telemetry-level-changed': { from: TelemetryLevel; to: TelemetryLevel };
  'plugin-marketplace-operation': {
    operation: 'refresh' | 'install' | 'update' | 'uninstall' | 'rollback';
    success: boolean;
    duration_ms: number;
    plugin_id?: string;
    version?: string;
    permission_count?: number;
    catalog_size?: number;
    key_id?: string;
  };
  'cloud-task-execution-event': {
    operation: 'selected' | 'transition' | 'rejected';
    target: 'local' | 'cloud';
    status:
      | 'queued'
      | 'preparing'
      | 'running'
      | 'suspended'
      | 'completed'
      | 'failed'
      | 'cancelled';
    reason?:
      | 'gate-disabled'
      | 'adapter-unavailable'
      | 'snapshot-unavailable'
      | 'snapshot-invalid'
      | 'snapshot-error'
      | 'lease-conflict'
      | 'execution-error'
      | 'aborted'
      | 'timeout';
    duration_ms?: number;
  };
  'cloud-task-control-plane-event': {
    operation:
      | 'upload'
      | 'start'
      | 'restore-handshake'
      | 'lease-acquire'
      | 'lease-renew'
      | 'lease-release'
      | 'handoff-suspend'
      | 'handoff-resume'
      | 'stream'
      | 'cancel'
      | 'artifact'
      | 'resume'
      | 'usage'
      | 'reconcile'
      | 'retention'
      | 'artifact-open'
      | 'artifact-reveal'
      | 'artifact-export';
    success: boolean;
    residency: 'us' | 'eu' | 'apac';
    reason?:
      | 'auth'
      | 'policy'
      | 'network'
      | 'integrity'
      | 'aborted'
      | 'execution'
      | 'restore'
      | 'handoff'
      | 'lease';
    duration_ms?: number;
    snapshot_bytes?: number;
    snapshot_files?: number;
    artifact_bytes?: number;
    resumed_bytes?: number;
    resume_sequence?: number;
    cost_micros?: number;
    usage_duration_ms?: number;
    limit?: 'duration' | 'cost' | 'artifact-bytes' | 'artifact-files';
    inspected_executions?: number;
    cancelled_executions?: number;
    cleared_checkpoints?: number;
    retained_checkpoints?: number;
    removed_artifacts?: number;
    removed_bytes?: number;
  };
  'cloud-task-rollout-observed': {
    rollout_stage: 'dogfood';
    gate_enabled: boolean;
    gate_source: 'unavailable' | 'default' | 'override';
    control_plane_configured: boolean;
    adapter_available: boolean;
    kill_switch_active: boolean;
    residency?: 'us' | 'eu' | 'apac';
  };
  'remote-control-security-event': {
    operation:
      | 'pair'
      | 'revoke'
      | 'session'
      | 'replay-blocked'
      | 'command-assessed'
      | 'command-completed'
      | 'attestation'
      | 'client-attestation';
    success: boolean;
    protocol_version: number;
    command?:
      | 'sendMessage'
      | 'pushToTalkStart'
      | 'pushToTalkStop'
      | 'approveTool'
      | 'rejectTool'
      | 'stopAgent'
      | 'newAgent'
      | 'openThread';
    decision?:
      | 'approve'
      | 'deny'
      | 'escalate'
      | 'human-approved'
      | 'human-denied';
    risk_level?: 'low' | 'medium' | 'high' | 'critical';
    irreversible?: boolean;
    latency_ms?: number;
    reason?: 'invalid' | 'expired' | 'revoked' | 'rate-limited' | 'denied';
    trust_level?: 'software' | 'hardware-backed';
    attestation_provider?:
      | 'apple-app-attest'
      | 'apple-secure-enclave'
      | 'android-play-integrity'
      | 'tpm';
    attestation_reason?:
      | 'required'
      | 'provider-mismatch'
      | 'challenge-mismatch'
      | 'unsupported-provider'
      | 'verifier-unavailable'
      | 'invalid'
      | 'expired'
      | 'replayed'
      | 'software-only'
      | 'verified';
  };
  'desktop-automation-security-event': {
    operation:
      | 'permission-check'
      | 'permission-request'
      | 'session-start'
      | 'session-stop'
      | 'kill-switch'
      | 'policy-decision'
      | 'capture'
      | 'inspect'
      | 'press';
    success: boolean;
    bundle_id?: string;
    risk?: 'normal' | 'system' | 'irreversible';
    decision?: 'allow' | 'block' | 'ask' | 'human-allow' | 'human-block';
    reason?:
      | 'feature-disabled'
      | 'unsupported'
      | 'permission-missing'
      | 'kill-switch'
      | 'session-inactive'
      | 'app-blocked'
      | 'approval-expired'
      | 'invalid-target'
      | 'provider-error';
    element_role?:
      | 'AXButton'
      | 'AXCheckBox'
      | 'AXRadioButton'
      | 'AXPopUpButton'
      | 'AXMenuButton'
      | 'AXLink'
      | 'AXDisclosureTriangle';
    latency_ms?: number;
  };
  'onboarding-completed': {
    skipped: boolean;
    suggestion_id?: string;
    telemetry_level: TelemetryLevel;
    auth_method?: OnboardingAuthCompletionMethod;
    provider?: ModelProvider;
    plan_id?: CodingPlanId;
  };
  'onboarding-demo-slide-clicked': {
    slide_name: string;
  };
  'onboarding-auth-mode-switched': {
    from: OnboardingAuthMethod;
    to: OnboardingAuthMethod;
  };
  'onboarding-auth-providers-expanded': {
    expanded: boolean;
  };
  'onboarding-auth-api-key-input-focused': {
    provider: ModelProvider;
  };
  'onboarding-auth-coding-plan-opened': {
    plan_id: CodingPlanId;
    provider: ModelProvider;
  };
  'onboarding-auth-social-requested': { provider: SocialAuthProvider };
  'onboarding-auth-social-verified': { provider: SocialAuthProvider };
  'onboarding-auth-otp-requested': undefined;
  'onboarding-auth-otp-verified': undefined;
  'onboarding-auth-otp-failed': {
    error_kind: OnboardingOtpFailureKind;
  };
  'onboarding-auth-method-completed': {
    auth_method: OnboardingAuthMethod;
    provider?: ModelProvider;
    plan_id?: CodingPlanId;
  };
  'onboarding-auth-method-failed': {
    auth_method: OnboardingAuthMethod;
    provider?: ModelProvider | SocialAuthProvider;
    plan_id?: CodingPlanId;
    error_kind: OnboardingAuthFailureKind;
  };
  'onboarding-auth-provider-disconnected': {
    auth_method: 'api-keys' | 'coding-plan';
    provider: ModelProvider;
    plan_id?: CodingPlanId;
  };
  'account-auth-social-requested': { provider: SocialAuthProvider };
  'account-auth-social-verified': { provider: SocialAuthProvider };
  'account-auth-otp-requested': undefined;
  'account-auth-otp-verified': undefined;
  'account-auth-otp-failed': {
    error_kind: OnboardingOtpFailureKind;
  };
  'account-auth-method-failed': {
    auth_method: 'clodex';
    provider?: SocialAuthProvider;
    error_kind: OnboardingAuthFailureKind;
  };
  'chat-auth-social-requested': { provider: SocialAuthProvider };
  'chat-auth-social-verified': { provider: SocialAuthProvider };
  'chat-auth-otp-requested': undefined;
  'chat-auth-otp-verified': undefined;
  'chat-auth-otp-failed': {
    error_kind: OnboardingOtpFailureKind;
  };
  'chat-auth-method-failed': {
    auth_method: 'clodex';
    provider?: SocialAuthProvider;
    error_kind: OnboardingAuthFailureKind;
  };

  // Workspace
  'workspace-mounted': { agent_type: string; agent_instance_id: string };
  'workspace-unmounted': { agent_type: string; agent_instance_id: string };

  // Agent
  'agent-created': {
    agent_type: string;
    agent_instance_id: string;
    model_id: string;
  };
  'agent-message-sent': {
    agent_type: string;
    agent_instance_id: string;
    model_id: string;
    /**
     * Provider routing mode from the most recent completed step.
     * Empty string on the first message in a new chat (no prior step).
     * `'clodex'` = clodex backend, `'official'` = own key or coding
     * plan, `'custom'` = custom endpoint.
     */
    provider_mode: string;
    /**
     * Connected coding plan ID when `provider_mode === 'official'` and the
     * user connected via a coding plan (e.g. `'glm-coding-plan'`).
     * Undefined for clodex/custom routes or plain BYOK keys.
     */
    coding_plan_id?: string;
    has_attachments: boolean;
    attachment_count: number;
    slash_command_ids: string[];
    slash_command_count: number;
    connected_workspace_count: number;
    /**
     * True if this is the first user message in the chat (no prior user
     * messages existed before this one was sent).
     */
    is_new_chat: boolean;
    /**
     * Milliseconds since the most recent message (user or agent) in history,
     * measured at the moment this message is dispatched. Undefined when this
     * is the first message in the chat.
     */
    ms_since_last_message?: number;
    /**
     * Tool approval mode configured on the agent at the moment this message
     * is sent. `'alwaysAsk'` = prompt user for each tool call,
     * `'alwaysAllow'` = auto-approve every tool call, `'smart'` = defer to
     * the classifier per call.
     */
    tool_approval_mode: ToolApprovalMode;
  };
  'agent-message-queued': {
    agent_type: string;
    agent_instance_id: string;
    model_id: string;
    queue_length_after: number;
  };
  'agent-queue-flushed': {
    agent_type: string;
    agent_instance_id: string;
    flushed_message_count: number;
  };
  'agent-step-completed': {
    agent_type: string;
    agent_instance_id: string;
    model_id: string;
    provider_mode: string;
    coding_plan_id?: string;
    input_tokens: number;
    output_tokens: number;
    tool_call_count: number;
    finish_reason: string;
    duration_ms: number;
  };
  'agent-stopped': {
    agent_type: string;
    agent_instance_id: string;
    ms_since_last_user_message?: number;
    ms_since_last_agent_message?: number;
  };
  'agent-resumed': { agent_type: string; agent_instance_id: string };
  'agent-archived': { agent_type: string; agent_instance_id: string };
  'agent-deleted': { agent_type: string; agent_instance_id: string };
  /**
   * Fires when a user manually renames an agent via the `agents.setTitle`
   * RPC. Does NOT fire for auto-generated titles (those go through a
   * separate path in `BaseAgent._performTitleGeneration` and don't touch
   * this handler).
   *
   * `was_active` distinguishes renaming a currently loaded / open chat
   * (live agent path) from renaming one in history (direct DB update).
   * `new_title_length` lets us understand naming habits without
   * transmitting the title itself.
   *
   * `agent_type` is only present on the active path — the inactive path
   * doesn't hydrate the agent and so can't cheaply look up the type
   * without an extra DB query.
   *
   * `new_title` is only attached when the user has opted into `full`
   * telemetry. Length is always present so `basic` sessions still
   * contribute a useful non-PII signal.
   */
  'agent-renamed': {
    agent_instance_id: string;
    was_active: boolean;
    new_title_length: number;
    agent_type?: string;
    new_title?: string;
  };
  'agent-model-changed': {
    agent_type: string;
    agent_instance_id: string;
    from_model: string;
    to_model: string;
  };

  // Tools
  //
  // All three lifecycle events carry `tool_call_id` (the approval's unique
  // identifier, equal to the tool-call id) so the request, response, and
  // any "always allow" shortcut can be linked downstream.
  'tool-approval-requested': {
    tool_name: string;
    agent_instance_id: string;
    tool_call_id: string;
  };
  'tool-approved': {
    tool_name: string;
    agent_instance_id: string;
    tool_call_id: string;
  };
  'tool-denied': {
    tool_name: string;
    reason?: string;
    agent_instance_id: string;
    tool_call_id: string;
  };
  /**
   * Fires whenever an agent's tool-approval mode actually changes.
   * Emitted from the backend (`AgentManager.setToolApprovalMode`) so the
   * single source of truth covers every UI surface. Skipped when the new
   * mode equals the current mode (no-op calls are not logged).
   *
   * `source` identifies the UI entry point:
   *   - `panel-combobox`: the persistent mode selector in the chat panel
   *     (`ToolApprovalSelect`). Deliberate, typically preemptive.
   *   - `inline-approval-button`: the "Always allow" button shown on an
   *     active approval request card. Impulsive, reactive to a specific
   *     tool call.
   * `unknown` is used when a caller didn't specify a source (e.g.
   *  programmatic agent-side updates, future call sites).
   */
  'tool-approval-mode-changed': {
    agent_instance_id: string;
    previous_mode: ToolApprovalMode;
    new_mode: ToolApprovalMode;
    source: 'panel-combobox' | 'inline-approval-button' | 'unknown';
    /**
     * When `source === 'inline-approval-button'`, the approval ID of the
     * request the user was responding to. Lets us correlate the mode
     * change with a specific `tool-approval-requested` event.
     */
    tool_call_id?: string;
    /** Tool name for `inline-approval-button`; absent otherwise. */
    tool_name?: string;
  };
  'tool-call-executed': {
    tool_name: string;
    agent_type: string;
    agent_instance_id: string;
    model_id: string;
    success: boolean;
    error_message?: string;
    input_keys?: string[];
    input_summary?: string;
    duration_ms?: number;
  };

  // Edits
  'edits-accepted': { hunk_count: number };
  'edits-rejected': { hunk_count: number };
  'diff-history-fanout-cap-hit': {
    tool_call_id: string;
    agent_instance_id: string;
    /**
     * Category bucket of the first dropped path. Derived from path
     * segments — deliberately coarse so the telemetry event cannot
     * leak usernames, repo names, or directory structure.
     */
    path_category:
      | 'node_modules'
      | 'build-output'
      | 'tooling-cache'
      | 'dotfile'
      | 'other';
    cap: number;
  };

  // Suggestions
  'suggestion-clicked': {
    suggestion_id: string;
    context: 'onboarding' | 'empty-chat';
  };
  'suggestion-dismissed': {
    suggestion_id: string;
    context: 'onboarding' | 'empty-chat';
  };

  // Usage limits
  'usage-limit-reached': {
    agent_type: string;
    model_id: string;
    provider_mode: string;
    plan: string;
    window_types: string[];
    first_window_resets_at: string;
    exceeded_window_count: number;
  };
  'usage-warning-shown': {
    agent_type: string;
    model_id: string;
    provider_mode: string;
    window_type: string;
    used_percent: number;
    resets_at: string;
  };
  'upstream-overload': {
    agent_type: string;
    model_id: string;
    provider_mode: string;
    provider_name?: string;
    status_code?: number;
  };

  // UI actions (routed via karton RPC from the renderer)
  'devtools-opened': {
    tab_id?: string;
    /** True when the tab's hostname is `localhost` or `127.0.0.1`. */
    is_local?: boolean;
    /** True when the tab's URL uses the `https:` protocol. */
    is_https?: boolean;
  };
  'devtools-closed': {
    tab_id?: string;
    /** True when the tab's hostname is `localhost` or `127.0.0.1`. */
    is_local?: boolean;
    /** True when the tab's URL uses the `https:` protocol. */
    is_https?: boolean;
  };
  'tab-created': { tab_count_after: number };
  'tab-destroyed': { tab_count_after: number };
  'tabs-cleaned': { closed_count: number };
  'tab-color-scheme-changed': { new_value: 'system' | 'light' | 'dark' };
  'settings-opened': undefined;
  'account-page-viewed': undefined;
  'chat-sidebar-toggled': { new_value: 'open' | 'closed' };
  'closed-lid-sleep-toggled': { enabled: boolean };
  'chat-new-agent-clicked': {
    source: 'sidebar-top' | 'sidebar-active-agents' | 'hotkey';
  };
  'element-selection-started': undefined;
  'element-selection-stopped': { element_selected: boolean };
  'custom-model-add-started': undefined;
  'custom-model-add-finished': undefined;
  'custom-model-add-aborted': {
    had_validation_errors: boolean;
    any_field_touched: boolean;
  };
  'custom-provider-add-started': undefined;
  'custom-provider-add-finished': {
    api_spec: string;
    /**
     * True when the configured `baseUrl` hostname is `localhost` or
     * `127.0.0.1`. Absent when the spec does not use a base URL
     * (e.g. `amazon-bedrock`) or the field is empty.
     */
    is_local?: boolean;
    /**
     * Raw `baseUrl` as entered by the user. Only forwarded when the
     * user has opted into `full` telemetry; omitted for `basic` and
     * dropped entirely for `off`.
     */
    base_url?: string;
    /**
     * Coarse AWS auth mode for Bedrock endpoints. Emitted regardless of
     * telemetry level so we can track feature adoption. The profile
     * *name* is deliberately NEVER reported — it can reveal internal
     * account structure (e.g. `my-company-prod`) and is treated as
     * PII-adjacent.
     */
    aws_auth_mode?: 'access-keys' | 'profile' | 'default-chain';
  };
  'custom-provider-add-aborted': {
    had_validation_errors: boolean;
    any_field_touched: boolean;
    api_spec: string;
    /** See `custom-provider-add-finished` — same semantics. */
    is_local?: boolean;
    /** See `custom-provider-add-finished` — same semantics. */
    base_url?: string;
    /** See `custom-provider-add-finished` — same semantics. */
    aws_auth_mode?: 'access-keys' | 'profile' | 'default-chain';
  };
  'workspace-connect-started': undefined;
  'workspace-connect-finished': undefined;
  'workspace-connect-aborted': {
    reason: 'picker-closed' | 'suggestions-dismissed';
  };
  'workspace-connect-failed': {
    source: 'picker' | 'recent-workspace';
  };

  // Smart approval
  'smart-approval-classified': {
    needs_approval: boolean;
    latency_ms: number;
    /** Model id that produced the decision, or `'failed'` when all models errored. */
    model_id: string;
    /** 0–2 for primary/fallback models; N for all-fail. */
    fallback_index: number;
    /** Mount prefix only (e.g. `'weba9'`) — never a full path. */
    cwd_prefix: string;
    /** Truncated error message when `model_id === 'failed'`. */
    error?: string;
  };
  'guardian-assessed': {
    policy_version: number;
    action_kind: 'shell' | 'network' | 'mcp' | 'sandbox';
    risk_level: 'low' | 'medium' | 'high' | 'critical';
    decision: 'approve' | 'deny' | 'escalate';
    irreversible: boolean;
    read_only: boolean;
    user_authorization: 'unknown' | 'low' | 'medium' | 'high';
    narrowly_scoped: boolean;
    resource_scope: 'agent' | 'workspace' | 'host' | 'remote' | 'unknown';
    evidence_count: number;
    capability_count: number;
    latency_ms: number;
    valid_context: boolean;
  };
  'guardian-shadow-classified': {
    policy_version: number;
    action_kind: 'shell' | 'network' | 'mcp' | 'sandbox';
    deterministic_risk: 'low' | 'medium' | 'high' | 'critical';
    deterministic_decision: 'approve' | 'deny' | 'escalate';
    shadow_risk: 'low' | 'medium' | 'high' | 'critical' | null;
    shadow_decision: 'approve' | 'deny' | 'escalate' | null;
    risk_agreement: boolean;
    decision_agreement: boolean;
    success: boolean;
    latency_ms: number;
  };
  'guardian-feedback-submitted': {
    policy_version: number;
    action_kind: 'shell' | 'network' | 'mcp' | 'sandbox';
    risk_level: 'low' | 'medium' | 'high' | 'critical';
    decision: 'approve' | 'deny' | 'escalate';
    feedback: 'correct' | 'false-positive' | 'false-negative';
    previous_feedback: 'correct' | 'false-positive' | 'false-negative' | null;
    irreversible: boolean;
    assessment_age_ms: number;
    readiness_status: 'collecting' | 'needs-tuning' | 'candidate';
    local_assessment_count: number;
    local_labeled_count: number;
    local_approved_labeled_count: number;
    local_restricted_labeled_count: number;
    local_false_positive_count: number;
    local_false_negative_count: number;
  };

  // Personalization
  'changed-theme': { theme: PersonalizationThemeId };
  'changed-notification-sound-loudness': {
    loudness: 'off' | 'subtle' | 'loud';
  };
  'changed-notification-sound-theme': {
    theme: string;
  };

  // Experience survey
  'experience-survey-answered': {
    answer: 'yes' | 'no';
  };
  'experience-survey-feedback-submitted': {
    feedback: string;
    feedback_length: number;
  };
  'experience-founder-call-survey-opened': undefined;
  'experience-founder-call-survey-dismissed': undefined;
}

export const UI_TELEMETRY_EVENT_NAMES = [
  'account-page-viewed',
  'chat-new-agent-clicked',
  'chat-sidebar-toggled',
  'closed-lid-sleep-toggled',
  'custom-model-add-aborted',
  'custom-model-add-finished',
  'custom-model-add-started',
  'custom-provider-add-aborted',
  'custom-provider-add-finished',
  'custom-provider-add-started',
  'element-selection-started',
  'element-selection-stopped',
  'onboarding-auth-api-key-input-focused',
  'onboarding-auth-coding-plan-opened',
  'onboarding-auth-method-completed',
  'onboarding-auth-method-failed',
  'onboarding-auth-mode-switched',
  'onboarding-auth-social-requested',
  'onboarding-auth-social-verified',
  'onboarding-auth-otp-failed',
  'onboarding-auth-otp-requested',
  'onboarding-auth-otp-verified',
  'onboarding-auth-provider-disconnected',
  'onboarding-auth-providers-expanded',
  'account-auth-method-failed',
  'account-auth-otp-failed',
  'account-auth-otp-requested',
  'account-auth-otp-verified',
  'account-auth-social-requested',
  'account-auth-social-verified',
  'chat-auth-method-failed',
  'chat-auth-otp-failed',
  'chat-auth-otp-requested',
  'chat-auth-otp-verified',
  'chat-auth-social-requested',
  'chat-auth-social-verified',
  'onboarding-demo-slide-clicked',
  'settings-opened',
  'suggestion-clicked',
  'suggestion-dismissed',
  'tabs-cleaned',
  'workspace-connect-aborted',
  'workspace-connect-failed',
  'workspace-connect-finished',
  'workspace-connect-started',
  'changed-theme',
  'changed-notification-sound-loudness',
  'changed-notification-sound-theme',
  'experience-survey-answered',
  'experience-survey-feedback-submitted',
  'experience-founder-call-survey-opened',
  'experience-founder-call-survey-dismissed',
] as const satisfies ReadonlyArray<keyof EventProperties>;

export type UIEventName = (typeof UI_TELEMETRY_EVENT_NAMES)[number];
export type UIEventProperties = Pick<EventProperties, UIEventName>;

const UI_TELEMETRY_EVENT_SCHEMAS = {
  'account-page-viewed': z.undefined().optional(),
  'chat-new-agent-clicked': z.object({
    source: z.enum(['sidebar-top', 'sidebar-active-agents', 'hotkey']),
  }),
  'chat-sidebar-toggled': z.object({
    new_value: z.enum(['open', 'closed']),
  }),
  'closed-lid-sleep-toggled': z.object({
    enabled: z.boolean(),
  }),
  'custom-model-add-aborted': z.object({
    had_validation_errors: z.boolean(),
    any_field_touched: z.boolean(),
  }),
  'custom-model-add-finished': z.undefined().optional(),
  'custom-model-add-started': z.undefined().optional(),
  'custom-provider-add-aborted': z.object({
    had_validation_errors: z.boolean(),
    any_field_touched: z.boolean(),
    api_spec: z.string(),
    is_local: z.boolean().optional(),
    base_url: z.string().optional(),
    aws_auth_mode: z
      .enum(['access-keys', 'profile', 'default-chain'])
      .optional(),
  }),
  'custom-provider-add-finished': z.object({
    api_spec: z.string(),
    is_local: z.boolean().optional(),
    base_url: z.string().optional(),
    aws_auth_mode: z
      .enum(['access-keys', 'profile', 'default-chain'])
      .optional(),
  }),
  'custom-provider-add-started': z.undefined().optional(),
  'element-selection-started': z.undefined().optional(),
  'element-selection-stopped': z.object({
    element_selected: z.boolean(),
  }),
  'onboarding-auth-api-key-input-focused': z.object({
    provider: modelProviderSchema,
  }),
  'onboarding-auth-coding-plan-opened': z.object({
    plan_id: codingPlanIdSchema,
    provider: modelProviderSchema,
  }),
  'onboarding-auth-method-completed': z.object({
    auth_method: onboardingAuthMethodSchema,
    provider: modelProviderSchema.optional(),
    plan_id: codingPlanIdSchema.optional(),
  }),
  'onboarding-auth-method-failed': z.object({
    auth_method: onboardingAuthMethodSchema,
    provider: z
      .union([modelProviderSchema, socialAuthProviderSchema])
      .optional(),
    plan_id: codingPlanIdSchema.optional(),
    error_kind: onboardingAuthFailureKindSchema,
  }),
  'onboarding-auth-mode-switched': z.object({
    from: onboardingAuthMethodSchema,
    to: onboardingAuthMethodSchema,
  }),
  'onboarding-auth-social-requested': z.object({
    provider: socialAuthProviderSchema,
  }),
  'onboarding-auth-social-verified': z.object({
    provider: socialAuthProviderSchema,
  }),
  'onboarding-auth-otp-failed': z.object({
    error_kind: onboardingOtpFailureKindSchema,
  }),
  'onboarding-auth-otp-requested': z.undefined().optional(),
  'onboarding-auth-otp-verified': z.undefined().optional(),
  'onboarding-auth-provider-disconnected': z.object({
    auth_method: z.enum(['api-keys', 'coding-plan']),
    provider: modelProviderSchema,
    plan_id: codingPlanIdSchema.optional(),
  }),
  'onboarding-auth-providers-expanded': z.object({
    expanded: z.boolean(),
  }),
  'account-auth-social-requested': z.object({
    provider: socialAuthProviderSchema,
  }),
  'account-auth-social-verified': z.object({
    provider: socialAuthProviderSchema,
  }),
  'account-auth-otp-failed': z.object({
    error_kind: onboardingOtpFailureKindSchema,
  }),
  'account-auth-otp-requested': z.undefined().optional(),
  'account-auth-otp-verified': z.undefined().optional(),
  'account-auth-method-failed': z.object({
    auth_method: z.literal('clodex'),
    provider: socialAuthProviderSchema.optional(),
    error_kind: onboardingAuthFailureKindSchema,
  }),
  'chat-auth-social-requested': z.object({
    provider: socialAuthProviderSchema,
  }),
  'chat-auth-social-verified': z.object({
    provider: socialAuthProviderSchema,
  }),
  'chat-auth-otp-failed': z.object({
    error_kind: onboardingOtpFailureKindSchema,
  }),
  'chat-auth-otp-requested': z.undefined().optional(),
  'chat-auth-otp-verified': z.undefined().optional(),
  'chat-auth-method-failed': z.object({
    auth_method: z.literal('clodex'),
    provider: socialAuthProviderSchema.optional(),
    error_kind: onboardingAuthFailureKindSchema,
  }),
  'onboarding-demo-slide-clicked': z.object({
    slide_name: z.string(),
  }),
  'settings-opened': z.undefined().optional(),
  'suggestion-clicked': z.object({
    suggestion_id: z.string(),
    context: z.enum(['onboarding', 'empty-chat']),
  }),
  'suggestion-dismissed': z.object({
    suggestion_id: z.string(),
    context: z.enum(['onboarding', 'empty-chat']),
  }),
  'tabs-cleaned': z.object({
    closed_count: z.number(),
  }),
  'workspace-connect-aborted': z.object({
    reason: z.enum(['picker-closed', 'suggestions-dismissed']),
  }),
  'workspace-connect-failed': z.object({
    source: z.enum(['picker', 'recent-workspace']),
  }),
  'workspace-connect-finished': z.undefined().optional(),
  'workspace-connect-started': z.undefined().optional(),
  'changed-theme': z.object({
    theme: personalizationThemeIdSchema,
  }),
  'changed-notification-sound-loudness': z.object({
    loudness: z.enum(['off', 'subtle', 'loud']),
  }),
  'changed-notification-sound-theme': z.object({
    theme: z.string(),
  }),
  'experience-survey-answered': z.object({
    answer: z.enum(['yes', 'no']),
  }),
  'experience-survey-feedback-submitted': z.object({
    feedback: z.string(),
    feedback_length: z.number(),
  }),
  'experience-founder-call-survey-opened': z.undefined().optional(),
  'experience-founder-call-survey-dismissed': z.undefined().optional(),
} satisfies {
  [K in UIEventName]: z.ZodType<UIEventProperties[K]>;
};

export function isUIEventName(eventName: string): eventName is UIEventName {
  return (UI_TELEMETRY_EVENT_NAMES as readonly string[]).includes(eventName);
}

export function parseUIEventProperties<T extends UIEventName>(
  eventName: T,
  properties: unknown,
): UIEventProperties[T] | null {
  const result = UI_TELEMETRY_EVENT_SCHEMAS[eventName].safeParse(properties);
  return result.success ? (result.data as UIEventProperties[T]) : null;
}

export interface UserProperties {
  user_id?: string;
  user_email?: string;
}

export type ExceptionProperties = {
  service?: string;
} & Record<string, unknown>;

export const COMMUNITY_OBSERVED_TELEMETRY_CONTRACT =
  'clodex-community-observed-backend-anonymous-v1';
export const COMMUNITY_OBSERVED_TELEMETRY_ARTIFACT_ASSERTION =
  'clodex-community-observed-contract:{"allowedTelemetryLevel":"anonymous","contentPolicy":"event-field-allowlist-v1","disableGeoip":true,"exceptions":"disabled","modelTracing":"disabled","optIn":"explicit","privacyMode":true,"renderer":"noop"}';

type CommunityObservedEventPolicy = {
  booleans?: readonly string[];
  numbers?: Readonly<Record<string, number>>;
  strings?: Readonly<Record<string, readonly string[]>>;
};

const COMMUNITY_OBSERVED_EVENT_POLICY: Readonly<
  Record<string, CommunityObservedEventPolicy>
> = Object.freeze({
  'app-launched': {
    numbers: { total_matched_processes: 10_000 },
  },
  'app-closed': {
    numbers: { total_matched_processes: 10_000 },
  },
  'telemetry-level-changed': {
    strings: {
      from: ['off', 'anonymous', 'full'],
      to: ['off', 'anonymous', 'full'],
    },
  },
  'plugin-marketplace-operation': {
    booleans: ['success'],
    numbers: {
      catalog_size: 1_000_000,
      duration_ms: 31_536_000_000,
      permission_count: 1_000_000,
    },
    strings: {
      operation: ['refresh', 'install', 'update', 'uninstall', 'rollback'],
    },
  },
  'agent-step-completed': {
    numbers: {
      duration_ms: 31_536_000_000,
      input_tokens: 1_000_000_000,
      output_tokens: 1_000_000_000,
      tool_call_count: 1_000_000,
    },
    strings: {
      finish_reason: [
        'stop',
        'length',
        'tool-calls',
        'content-filter',
        'error',
        'other',
        'unknown',
      ],
      provider_mode: ['clodex', 'official', 'custom'],
    },
  },
  'tool-call-executed': {
    booleans: ['success'],
    numbers: { duration_ms: 31_536_000_000 },
  },
  'edits-accepted': { numbers: { hunk_count: 1_000_000 } },
  'edits-rejected': { numbers: { hunk_count: 1_000_000 } },
  'tab-created': { numbers: { tab_count_after: 100_000 } },
  'tab-destroyed': { numbers: { tab_count_after: 100_000 } },
  'tabs-cleaned': { numbers: { closed_count: 100_000 } },
  'closed-lid-sleep-toggled': { booleans: ['enabled'] },
  'guardian-assessed': {
    booleans: ['irreversible', 'narrowly_scoped', 'read_only', 'valid_context'],
    numbers: {
      capability_count: 1_000_000,
      evidence_count: 1_000_000,
      latency_ms: 31_536_000_000,
      policy_version: 1_000_000,
    },
    strings: {
      action_kind: ['shell', 'network', 'mcp', 'sandbox'],
      decision: ['approve', 'deny', 'escalate'],
      resource_scope: ['agent', 'workspace', 'host', 'remote', 'unknown'],
      risk_level: ['low', 'medium', 'high', 'critical'],
      user_authorization: ['unknown', 'low', 'medium', 'high'],
    },
  },
  'settings-opened': {},
  'account-page-viewed': {},
  'custom-model-add-started': {},
  'custom-model-add-finished': {},
  'custom-provider-add-started': {},
  'workspace-connect-started': {},
  'workspace-connect-finished': {},
});

/**
 * Community-observed telemetry is deliberately lossy. Numeric counters and
 * booleans are retained, while string properties require an explicit bounded
 * enum-style allowlist. Arrays and nested objects are dropped. This makes raw
 * prompts, source, tool arguments, commands, paths, URLs, errors, titles and
 * feedback unavailable even if a future caller accidentally adds them to an
 * existing event.
 */
export function sanitizeCommunityObservedProperties(
  eventName: string,
  properties: unknown,
): Record<string, boolean | number | string> | null {
  const policy = COMMUNITY_OBSERVED_EVENT_POLICY[eventName];
  if (!policy) return null;
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  )
    return {};

  const sanitized: Record<string, boolean | number | string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === 'boolean' && policy.booleans?.includes(key)) {
      sanitized[key] = value;
      continue;
    }
    const maximum = policy.numbers?.[key];
    if (
      typeof value === 'number' &&
      maximum !== undefined &&
      Number.isFinite(value) &&
      value >= 0
    ) {
      sanitized[key] = Math.min(value, maximum);
      continue;
    }
    const allowedValues = policy.strings?.[key];
    if (typeof value === 'string' && allowedValues?.includes(value)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export class TelemetryService extends DisposableService {
  private readonly identifierService: IdentifierService;
  private readonly preferencesService: PreferencesService;
  private readonly logger: Logger;
  private readonly distributionMode: string;
  private readonly telemetryEnabled: boolean;
  private readonly telemetryMode: string;
  private readonly telemetryPrivacyMode: boolean;
  private readonly exceptionTelemetryEnabled: boolean;
  private readonly modelTracingEnabled: boolean;
  private readonly posthogApiKey: string;
  private userProperties: UserProperties = {};
  private pendingAppLaunchedCapture: Promise<void> | null = null;
  private missingApiKeyLogged = false;
  public posthogClient: PostHog | null = null;

  public constructor(
    identifierService: IdentifierService,
    preferencesService: PreferencesService,
    logger: Logger,
  ) {
    super();
    this.identifierService = identifierService;
    this.preferencesService = preferencesService;
    this.logger = logger;
    this.telemetryEnabled =
      typeof __APP_TELEMETRY_ENABLED__ === 'boolean'
        ? __APP_TELEMETRY_ENABLED__
        : true;
    this.distributionMode =
      typeof __APP_DISTRIBUTION_MODE__ === 'string'
        ? __APP_DISTRIBUTION_MODE__
        : 'official';
    this.telemetryMode =
      typeof __APP_TELEMETRY_MODE__ === 'string'
        ? __APP_TELEMETRY_MODE__
        : this.distributionMode === 'community-observed'
          ? 'anonymous-backend-only'
          : this.telemetryEnabled
            ? 'standard'
            : 'disabled';
    this.telemetryPrivacyMode =
      typeof __APP_TELEMETRY_PRIVACY_MODE__ === 'boolean'
        ? __APP_TELEMETRY_PRIVACY_MODE__
        : this.distributionMode !== 'official';
    this.exceptionTelemetryEnabled =
      typeof __APP_EXCEPTION_TELEMETRY_ENABLED__ === 'boolean'
        ? __APP_EXCEPTION_TELEMETRY_ENABLED__
        : this.distributionMode === 'official';
    this.modelTracingEnabled =
      typeof __APP_MODEL_TRACING_ENABLED__ === 'boolean'
        ? __APP_MODEL_TRACING_ENABLED__
        : this.distributionMode === 'official';
    this.posthogApiKey = this.telemetryEnabled
      ? (process.env.POSTHOG_API_KEY?.trim() ?? '')
      : '';

    // The observed lane creates no network client until the persisted
    // preference proves an explicit anonymous opt-in. Official builds retain
    // the existing eager client behavior.
    if (
      this.telemetryMode !== 'anonymous-backend-only' ||
      this.getTelemetryLevel() === 'anonymous'
    ) {
      this.ensurePostHogClient();
    }
    if (this.telemetryMode === 'anonymous-backend-only') {
      this.logger.debug(COMMUNITY_OBSERVED_TELEMETRY_ARTIFACT_ASSERTION);
    }

    this.identifyUser();

    this.preferencesService.addListener((newPrefs, oldPrefs) => {
      if (newPrefs.privacy.telemetryLevel !== oldPrefs.privacy.telemetryLevel) {
        if (
          this.telemetryMode === 'anonymous-backend-only' &&
          newPrefs.privacy.telemetryLevel !== 'anonymous'
        ) {
          void this.shutdownObservedClient();
        }
        this.capture('telemetry-level-changed', {
          from: oldPrefs.privacy.telemetryLevel,
          to: newPrefs.privacy.telemetryLevel,
        });
      }
    });

    logger.debug('[TelemetryService] Telemetry initialized');
  }

  /**
   * Get the current telemetry level from preferences.
   */
  public get telemetryLevel(): TelemetryLevel {
    const configured = this.preferencesService.get().privacy.telemetryLevel;
    if (this.telemetryMode === 'anonymous-backend-only') {
      return configured === 'anonymous' ? 'anonymous' : 'off';
    }
    return configured;
  }

  private getTelemetryLevel(): TelemetryLevel {
    return this.telemetryLevel;
  }

  setUserProperties(properties: UserProperties): void {
    if (this.telemetryMode === 'anonymous-backend-only') return;
    this.userProperties = { ...this.userProperties, ...properties };
  }

  private getDistinctId(): string {
    if (this.telemetryMode === 'anonymous-backend-only') {
      const anonymousId = createHash('sha256')
        .update('clodex-community-observed-v1\0')
        .update(this.identifierService.getMachineId())
        .digest('hex')
        .slice(0, 32);
      return `community-observed-${anonymousId}`;
    }
    return this.getTelemetryLevel() === 'full' && this.userProperties.user_id
      ? this.userProperties.user_id
      : this.identifierService.getMachineId();
  }

  private ensurePostHogClient(): PostHog | null {
    if (this.posthogClient) return this.posthogClient;
    if (!this.telemetryEnabled) return null;
    if (
      this.telemetryMode === 'anonymous-backend-only' &&
      this.getTelemetryLevel() !== 'anonymous'
    ) {
      return null;
    }
    if (!this.posthogApiKey) {
      if (!this.missingApiKeyLogged) {
        this.logger.debug('PostHog API key missing; telemetry is disabled.');
        this.missingApiKeyLogged = true;
      }
      return null;
    }

    this.posthogClient = new PostHog(this.posthogApiKey, {
      host: process.env.POSTHOG_HOST || 'https://eu.i.posthog.com',
      flushAt: 1,
      flushInterval: 0,
      ...(this.telemetryMode === 'anonymous-backend-only'
        ? {
            defaultOptIn: true,
            disableGeoip: true,
            disableRemoteConfig: true,
            disableSurveys: true,
            enableExceptionAutocapture: false,
            preloadFeatureFlags: false,
            privacyMode: true,
            sendFeatureFlagEvent: false,
          }
        : { privacyMode: this.telemetryPrivacyMode }),
    });
    return this.posthogClient;
  }

  private async shutdownObservedClient(): Promise<void> {
    if (this.telemetryMode !== 'anonymous-backend-only') return;
    const client = this.posthogClient;
    this.posthogClient = null;
    if (!client) return;
    try {
      await client.optOut();
      await client.shutdown();
    } catch (error) {
      this.logger.debug(`Failed to stop observed PostHog client: ${error}`);
    }
  }

  identifyUser() {
    if (this.telemetryMode === 'anonymous-backend-only') return;
    if (!this.posthogClient) return;

    if (
      this.userProperties.user_id &&
      this.userProperties.user_email &&
      this.getTelemetryLevel() === 'full'
    ) {
      this.logger.debug('[TelemetryService] Identifying user...');
      this.posthogClient.identify({
        distinctId: this.userProperties.user_id,
        properties: {
          email: this.userProperties.user_email,
        },
      });
      this.posthogClient.alias({
        alias: this.userProperties.user_id,
        distinctId: this.identifierService.getMachineId(),
      });
    } else {
      this.logger.debug(
        '[TelemetryService] Not identifying user, missing user properties or telemetry level is not "full"',
      );
    }
  }

  public withTracing(
    model: LanguageModelV3,
    properties?: Parameters<typeof withTracing>[2],
  ): LanguageModelV3 {
    if (!this.modelTracingEnabled) return model;
    const telemetryLevel = this.getTelemetryLevel();
    if (telemetryLevel !== 'full' || !this.posthogClient) return model;

    const distinctId = this.getDistinctId();

    const wrappedModel = withTracing(model, this.posthogClient, {
      posthogDistinctId: distinctId,
      ...properties,
      posthogProperties: {
        product: 'clodex-browser',
        telemetry_level: telemetryLevel,
        app_version: __APP_VERSION__,
        app_release_channel: __APP_RELEASE_CHANNEL__,
        app_platform: __APP_PLATFORM__,
        app_arch: __APP_ARCH__,
        ...properties?.posthogProperties,
      },
    });

    // Fix for AI SDK v6: PostHog's withTracing uses spread which doesn't copy
    // prototype getters like 'supportedUrls'. This property is required by the
    // AI SDK to determine which URL schemes the model supports for file uploads.
    // Without it, Object.entries(undefined) throws during asset download.
    if ('supportedUrls' in model && !('supportedUrls' in wrappedModel)) {
      Object.defineProperty(wrappedModel, 'supportedUrls', {
        get: () => model.supportedUrls,
        enumerable: true,
        configurable: true,
      });
    }

    return wrappedModel;
  }

  public captureAppLaunched(): void {
    if (this.getTelemetryLevel() === 'off') return;
    this.pendingAppLaunchedCapture = captureProcessSnapshot()
      .then((launchProcessSnapshot) => {
        this.captureSync('app-launched', {
          matched_process_counts: launchProcessSnapshot.matched_process_counts,
          total_matched_processes: launchProcessSnapshot.total_matched,
        });
      })
      .finally(() => {
        this.pendingAppLaunchedCapture = null;
      });
  }

  public capture<T extends keyof EventProperties>(
    eventName: T,
    properties?: EventProperties[T],
  ): void {
    this.captureSync(eventName, properties);
  }

  private captureSync<T extends keyof EventProperties>(
    eventName: T,
    properties?: EventProperties[T],
  ): void {
    try {
      const observedProperties =
        this.telemetryMode === 'anonymous-backend-only'
          ? sanitizeCommunityObservedProperties(eventName as string, properties)
          : properties;
      if (observedProperties === null) return;
      // Guard the stringify — `capture` runs on every tracked event
      // (including high-volume ones like tool-call-executed) and
      // JSON.stringify is not free. Skip it when debug is disabled.
      if (this.logger.isDebugEnabled) {
        this.logger.debug(
          this.telemetryMode === 'anonymous-backend-only'
            ? `[TelemetryService] Capturing observed event: ${eventName} with property keys: ${Object.keys(observedProperties ?? {}).join(',')}`
            : `[TelemetryService] Capturing event: ${eventName} with properties: ${JSON.stringify(properties)}`,
        );
      }
      const telemetryLevel = this.getTelemetryLevel();

      // "Off" is a hard opt-out: no analytics event, including lifecycle and
      // onboarding events, may leave the device.
      if (telemetryLevel === 'off') return;

      const posthogClient = this.ensurePostHogClient();
      if (!posthogClient) return;

      const distinctId = this.getDistinctId();

      const finalProperties = {
        ...(typeof observedProperties === 'object' ? observedProperties : {}),
        product: 'clodex-browser',
        telemetry_level: telemetryLevel,
        app_distribution_mode: this.distributionMode,
        app_version: __APP_VERSION__,
        app_release_channel: __APP_RELEASE_CHANNEL__,
        app_platform: __APP_PLATFORM__,
        app_arch: __APP_ARCH__,
        ...(this.telemetryMode === 'anonymous-backend-only'
          ? { telemetry_contract: COMMUNITY_OBSERVED_TELEMETRY_CONTRACT }
          : {}),
      };

      posthogClient.capture({
        disableGeoip: this.telemetryMode === 'anonymous-backend-only',
        distinctId,
        event: eventName as string,
        properties: finalProperties,
        sendFeatureFlags: false,
      });
    } catch (error) {
      this.logger.error(
        `[TELEMETRY] Failed to capture analytics event: ${error}`,
      );
    }
  }

  public captureException(
    error: Error,
    properties?: ExceptionProperties,
  ): void {
    this.captureExceptionSync(error, properties);
  }

  private captureExceptionSync(
    error: Error,
    properties?: ExceptionProperties,
  ): void {
    try {
      if (!this.exceptionTelemetryEnabled) return;
      const telemetryLevel = this.getTelemetryLevel();
      if (telemetryLevel === 'off') return;

      this.logger.debug(
        `[TelemetryService] Capturing exception: ${error.message}`,
      );

      if (!this.posthogClient) return;

      const distinctId = this.getDistinctId();
      this.posthogClient.captureException(error, distinctId, {
        properties: {
          ...properties,
          product: 'clodex-browser',
          telemetry_level: telemetryLevel,
          app_version: __APP_VERSION__,
          app_release_channel: __APP_RELEASE_CHANNEL__,
          app_platform: __APP_PLATFORM__,
          app_arch: __APP_ARCH__,
        },
      });
    } catch (err) {
      this.logger.error(`[TELEMETRY] Failed to capture exception: ${err}`);
    }
  }

  protected report(error: Error): void {
    this.captureException(error, {
      service: this.constructor.name,
    });
  }

  protected async onTeardown(): Promise<void> {
    this.logger.debug('[TelemetryService] Tearing down...');
    if (this.posthogClient) {
      try {
        // Let the launch capture finish if it was about to, but never wait
        // more than 250 ms. The launch snapshot itself already has a 1.5 s
        // timeout, so an unbounded await here can push shutdown past the
        // Electron close budget and prevent PostHog from flushing.
        if (this.pendingAppLaunchedCapture) {
          await Promise.race([
            this.pendingAppLaunchedCapture,
            new Promise<void>((resolve) => setTimeout(resolve, 250)),
          ]);
        }

        // Use a short timeout on close — we would rather lose the snapshot
        // than add up to 1.5 s to window-close latency.
        const snapshot = await captureProcessSnapshot(500);
        // Bypass the microtask hop used by `capture()` so the event is
        // enqueued into the PostHog client BEFORE `shutdown()` starts
        // draining. Going through `queueMicrotask` here races shutdown and
        // can drop `app-closed` entirely.
        this.captureSync('app-closed', {
          matched_process_counts: snapshot.matched_process_counts,
          total_matched_processes: snapshot.total_matched,
        });
        await this.posthogClient.shutdown();
      } catch (error) {
        this.logger.debug(`Failed to shutdown PostHog: ${error}`);
      }
    }
    this.logger.debug('[TelemetryService] Teardown complete');
  }
}
