/**
 * Barrel for `@clodex/agent-core/agents`.
 *
 * Ships the host-extensible agent registry, `BaseAgent`, concrete chat
 * agents, and shared helpers used by the agent loop.
 */
export {
  AgentTypeRegistry,
  type AgentTypeMap,
  type AgentCtor,
} from './agents-registry';
export type { AgentMessage, AgentToolUIPart } from '../types/agent';
export type {
  ToolApprovalDecisionCommit,
  ToolApprovalDecisionIntent,
  ToolApprovalInvalidationIntent,
  ToolApprovalInvalidationReason,
  ToolApprovalLifecycleHooks,
} from './tool-approval-lifecycle';
export type {
  AgentStatePersistMessageBinding,
  AgentStatePersistOptions,
  AgentStatePersistRequest,
} from './state-persistence';
export { type AgentsMap, toAgentsMap } from './agents-map';
export {
  BaseAgent,
  type AgentNotificationEvent,
  type BaseAgentConfig,
  type BaseAgentDependencies,
  type BaseAgentToolboxView,
  type BaseAgentCaches,
  type BaseAgentStatic,
  type AgentConfig,
  type MessageId,
  type SendUserMessageResult,
} from './base-agent';
export {
  LocalAgentStepExecutor,
  resolveAgentToolCapabilityScopes,
  TOOL_CAPABILITY_APPROVAL_ORIGIN_SCOPE_CONTEXT_KEY,
  TOOL_CAPABILITY_CURRENT_SCOPE_CONTEXT_KEY,
  localAgentStepExecutor,
  type AgentStepExecution,
  type AgentStepExecutionContext,
  type AgentStepExecutionRequest,
  type AgentStepExecutor,
} from './agent-step-executor';
export {
  agentExecutionTargets,
  agentExecutionTaskStatuses,
  createAgentExecutionTaskRecord,
  createAgentTaskSnapshotManifest,
  resolveAgentExecutionTargetFromMessages,
  resolveAgentTaskSnapshotSelectionFromMessages,
  transitionAgentExecutionTask,
  type AgentExecutionTarget,
  type AgentExecutionTaskRecord,
  type AgentExecutionTaskStatus,
  type AgentTaskSnapshotManifest,
  type AgentTaskSnapshotManifestEntry,
  type AgentTaskSnapshotSelection,
  type AgentTaskSnapshotSelectionEntry,
} from './execution-target';
export {
  WORKSPACE_SNAPSHOT_VERSION,
  createWorkspaceEnvironmentFingerprint,
  createWorkspaceSnapshot,
  hashWorkspaceDependencyFingerprint,
  hashWorkspaceDirtyPatch,
  hashWorkspaceIdentity,
  hashWorkspaceIgnorePolicy,
  normalizeWorkspaceDependencyFingerprintContent,
  workspaceEnvironmentFingerprintSchema,
  workspaceSnapshotEntrySchema,
  workspaceSnapshotMountSchema,
  workspaceSnapshotV1Schema,
  type CreateWorkspaceSnapshotInput,
  type WorkspaceEnvironmentFingerprint,
  type WorkspaceSnapshotEntry,
  type WorkspaceSnapshotMount,
  type WorkspaceSnapshotV1,
} from './workspace-snapshot';
export {
  SESSION_CHECKPOINT_VERSION,
  AgentSessionCheckpointSafePointError,
  agentSessionCheckpointSchema,
  assertAgentSessionCheckpointSafePoint,
  createAgentSessionCheckpoint,
  findCompressedHistoryReference,
  hashSessionCheckpointHistory,
  resolveAgentSessionCheckpointFromMessages,
  type AgentSessionCheckpoint,
  type CreateAgentSessionCheckpointInput,
  type AgentSessionCheckpointSafePointReason,
} from './session-checkpoint';
export { ChatAgent } from './chat/chat';
export {
  WorkspaceMdAgent,
  type WorkspaceMdInstanceConfig,
} from './workspace-md/workspace-md';

// Shared helpers used across agent classes. Migrated from
// `apps/browser/src/backend/agents/shared/base-agent/` in Phase 10 task 7.
export { default as specialTokens } from './shared/special-tokens';
export {
  extractSlashIdsFromText,
  redactSlashIdsForTelemetry,
  inlineSlashLinksAsText,
  resolveSlashSkill,
  renderSlashCommandXml,
  type ResolvedSlashCommand,
} from './shared/metadata-converter/slash-items';
export { stripStrictFromToolSet } from './shared/strip-strict-from-tools';
export { reasoningSourcesMatch } from './shared/reasoning-signatures';
export { clearPendingApproval } from './shared/pending-approvals-cleanup';
export {
  repairToolCall,
  type RepairToolCallArgs,
} from './shared/repair-tool-call';
export {
  deepMergeProviderOptions,
  type ProviderOptions,
} from './shared/provider-options';
export { MessageCacheAnalyzer } from './shared/message-cache-analyzer';
export { generateSimpleTitle } from './shared/title-generation';
export {
  generateSimpleCompressedHistory,
  convertAgentMessagesToCompactMessageHistoryString,
  estimateMessageTokens,
  COMPRESSION_SYSTEM_PROMPT,
  COMPRESSION_TARGET_CHARS,
  buildCompressionUserMessage,
  defineToolPartSerializers,
  type TypedToolPartSerializers,
} from './shared/history-compression';
export {
  convertAgentMessagesToModelMessages,
  stripUnderscoreProperties,
  capitalizeFirstLetter,
  type BlobReader,
  type ContentLimits,
  type ConvertibleMessageMetadata,
  type ConvertAgentMessagesOptions,
  type ExtraMentionRenderer,
} from './shared/message-conversion';
