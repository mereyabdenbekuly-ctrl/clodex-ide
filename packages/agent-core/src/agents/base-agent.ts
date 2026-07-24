import {
  type ModelMessage,
  type Tool,
  type ToolApprovalResponse,
  smoothStream,
  type StepResult,
  type AsyncIterableStream,
  type InferUIMessageChunk,
  readUIMessageStream,
  tool,
  type DynamicToolUIPart,
  type ToolSet,
} from 'ai';
import type { z } from 'zod';
import nodePath from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile as fsReadFile } from '../fs';
import type {
  AgentMessage,
  AgentRuntimeError,
  AgentState,
  AgentToolUIPart,
} from '../types/agent';
import type { AgentTypes } from '../types/agent';
import type { ModelCapabilities } from '../types/models';
import type { AgentStateMutations } from '../services/agent-manager/state-mutations';
import { ApprovalResolutionMutationError } from '../services/agent-manager/state-mutations/approvals';
import type { AgentHost } from '../host/host';
import {
  MODEL_REQUEST_PURPOSE_METADATA_KEY,
  MODEL_TASK_ROLE_METADATA_KEY,
  type ModelWithOptions,
  type ModelTaskRole,
} from '../host/models';
import type { AgentCtor, AgentTypeRegistry } from './agents-registry';
import {
  localAgentStepExecutor,
  resolveAgentToolCapabilityScopes,
  TOOL_CAPABILITY_APPROVAL_ORIGIN_SCOPE_CONTEXT_KEY,
  TOOL_CAPABILITY_CURRENT_SCOPE_CONTEXT_KEY,
  type AgentStepExecutor,
} from './agent-step-executor';
import {
  resolveAgentExecutionTargetFromMessages,
  resolveAgentTaskSnapshotSelectionFromMessages,
  type AgentExecutionTarget,
} from './execution-target';
import {
  serializeAgentStatePersistMessage,
  type AgentStatePersistRequest,
} from './state-persistence';
import type {
  ToolApprovalInvalidationReason,
  ToolApprovalLifecycleHooks,
} from './tool-approval-lifecycle';

import {
  AgentSessionCheckpointSafePointError,
  assertAgentSessionCheckpointSafePoint,
  resolveAgentSessionCheckpointFromMessages,
} from './session-checkpoint';

type ProviderApiError = {
  message?: string;
  statusCode?: number;
  providerCode?: string;
};

function getMessageText(message: AgentMessage): string {
  return message.parts
    .filter(
      (
        part,
      ): part is Extract<(typeof message.parts)[number], { type: 'text' }> =>
        part.type === 'text',
    )
    .map((part) => part.text)
    .join('\n');
}

function findLatestCompressedHistory(
  history: readonly AgentMessage[],
): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const compressedHistory = history[index]?.metadata?.compressedHistory;
    if (typeof compressedHistory === 'string' && compressedHistory.length > 0) {
      return compressedHistory;
    }
  }
  return null;
}

/**
 * Helper type — extracts the `instanceConfig` field from an agent
 * constructor type registered in `AgentTypeMap`. Wrapped in tuple
 * brackets to suppress distributive conditional behaviour so that
 * `never` (the default in core when the host has not augmented
 * `AgentTypeMap`) collapses to `unknown` instead of cascading.
 */
type AgentInstanceConfigOf<T> = [T] extends [
  abstract new (...args: any[]) => infer R,
]
  ? [R] extends [{ instanceConfig: infer C }]
    ? C
    : unknown
  : unknown;

/**
 * Helper type — extracts the static `config.finishToolOutputSchema`
 * field from an agent constructor type registered in `AgentTypeMap`.
 * Falls back to `z.ZodType | null` when the host has not augmented
 * the map.
 */
type AgentFinishOutputSchemaOf<T> = [T] extends [
  { config: { finishToolOutputSchema: infer S } },
]
  ? S
  : z.ZodType | null;
import {
  convertAgentMessagesToModelMessages,
  capitalizeFirstLetter,
  type ContentLimits,
  type ExtraMentionRenderer,
} from './shared/message-conversion';
import { generateSimpleTitle } from './shared/title-generation';
import { repairToolCall } from './shared/repair-tool-call';
import {
  generateSimpleCompressedHistory,
  estimateMessageTokens,
} from './shared/history-compression';
import { AgentMemoryWriter, type MemoryWriteReason } from './shared/memory';
import type { AttachmentsService } from '../services/attachments';
import { capToolOutput } from '../services/toolbox';
import type { ProcessedImageCacheService } from '../services/processed-image-cache';
import type { FileReadCacheService } from '../services/file-read-cache';
import type {
  EvidenceMemoryCodeEvidenceProvider,
  EvidenceMemoryEventType,
  EvidenceMemoryJson,
} from '../services/evidence-memory';
import {
  DEFAULT_EVIDENCE_MEMORY_INJECTION_MAX_CLAIMS,
  renderEvidenceMemoryContext,
  resolveEvidenceMemoryIncrementalTokenBudget,
} from '../services/evidence-memory';
import {
  populatePathReferences,
  extractReadFilePathsFromAssistantMessage,
  resolveMountedPath,
  hashPath,
  deriveMaxReadChars,
} from '../file-read-transformer';
import { hashProtectedMountedFile, readProtectedMountedFile } from '../host';
import { type DomainAdapterRegistry, resolveEffectiveEnvStates } from '../env';
import { MessageCacheAnalyzer } from './shared/message-cache-analyzer';
import { stripStrictFromToolSet } from './shared/strip-strict-from-tools';
import { reasoningSourcesMatch } from './shared/reasoning-signatures';
import type { SkillDefinition } from '../types/skills';
import type {
  AttachmentMetadata,
  MountPermission,
  ReasoningSignatureSource,
} from '../types/metadata';

/**
 * Narrow projection of the toolbox surface that `BaseAgent` consumes.
 *
 * The host's full toolbox implementation may carry many more methods
 * (browser tools, mention search, watcher hooks, …) — `BaseAgent` only
 * touches the calls listed here, so the constructor accepts any object
 * that structurally satisfies this view. Hosts pass their concrete
 * `ToolboxService` (or a wrapping adapter) directly.
 */
export interface BaseAgentToolboxView {
  undoToolCalls(toolCallIds: string[], agentInstanceId: string): Promise<void>;
  /**
   * Drain any attachments produced by host-side tool calls during the
   * current step (e.g. files written by a sandbox/runtime side-channel).
   * Returns them as a flat array; the host clears its internal buffers
   * as a side effect. Returns `[]` when no host-side attachment
   * producer is wired.
   */
  drainPendingAttachments(agentInstanceId: string): AttachmentMetadata[];
  /**
   * Cancel any pending host-side user-facing dialogs (currently:
   * `askUserQuestions`-style question UI) for the given agent.
   * Called when an agent is stopped or torn down. Hosts that do not
   * expose dialog UIs may implement as a no-op.
   */
  cancelPendingAgentDialogs(agentInstanceId: string): void;
  cancelPendingEdits?(agentInstanceId: string): void;
  clearAgentTracking(agentInstanceId: string): void | Promise<void>;
  getSkillsList(agentInstanceId: string): Promise<SkillDefinition[]>;
  getMountedPathsForAgent(agentInstanceId: string): Map<string, string>;
  /**
   * Returns a revision only when the host can prove that the current workspace
   * is a single, clean repository snapshot. Evidence injection fails closed
   * when this capability is absent or returns `null`.
   */
  getEvidenceMemoryRepositoryRevision?(
    agentInstanceId: string,
  ): Promise<string | null>;
  getEvidenceMemoryCodeEvidenceProvider?(
    agentInstanceId: string,
    repositoryRevision: string | null,
  ):
    | Promise<EvidenceMemoryCodeEvidenceProvider | undefined>
    | EvidenceMemoryCodeEvidenceProvider
    | undefined;
  getTool(toolName: string, agentInstanceId: string): Promise<Tool | null>;
  handleMountWorkspace(
    agentInstanceId: string,
    workspacePath: string,
    permissions?: MountPermission[],
  ): Promise<void>;
  getWorkspaceMd(
    agentInstanceId: string,
  ): Promise<Array<{ mountPrefix: string; path: string; content: string }>>;
}

/**
 * Optional caches injected from the host. `processedImageCache` is
 * used for adapting images to model constraints; `fileReadCache` is
 * shared across agents to dedupe repeat reads of the same file.
 */
export interface BaseAgentCaches {
  fileReadCache: FileReadCacheService;
  processedImageCache?: ProcessedImageCacheService;
}

/**
 * User-facing agent lifecycle milestones a host may want to surface
 * (e.g. as a sound or OS notification):
 *
 * - `done` — the agent finished a turn without requesting approval.
 * - `question` — the agent paused awaiting a tool-approval decision.
 * - `error` — the agent's step failed.
 */
export type AgentNotificationEvent = 'done' | 'question' | 'error';

/**
 * Constructor dependencies for {@link BaseAgent}.
 *
 * Hosts assemble this object once at agent-creation time. The {@link
 * AgentHost} captures all platform-specific capabilities (paths,
 * models, logger, telemetry); peer services (toolbox, caches) are
 * injected directly so cross-agent state (mounts, file-read cache)
 * can be shared without going through the host seam.
 */
export interface BaseAgentDependencies<
  TFinishToolOutputSchema extends z.ZodType | null,
  TInstanceConfig,
  TToolbox extends BaseAgentToolboxView = BaseAgentToolboxView,
> {
  instanceId: string;
  state: {
    get: () => AgentState;
    commands: AgentStateMutations;
    persist: (request?: AgentStatePersistRequest) => Promise<void>;
  };
  host: AgentHost;
  /** Optional host-owned durable lifecycle for explicit tool responses. */
  toolApprovalLifecycle?: ToolApprovalLifecycleHooks;
  toolbox: TToolbox;
  caches: BaseAgentCaches;
  /**
   * Per-agent attachment blob store. Owned by `AgentCorePersistence`
   * and shared across every agent the manager spawns.
   */
  attachments: AttachmentsService;
  /**
   * Registry of {@link DomainAdapter}s used to capture per-domain env state
   * at step start and to render env context during message conversion.
   * Owned by `AgentManager` and shared across every agent it spawns.
   */
  domainAdapterRegistry: DomainAdapterRegistry;
  instanceConfig: TInstanceConfig;
  spawnChildAgentHandler: <TAgentType extends AgentTypes>(
    childAgentType: TAgentType,
    instanceConfig: AgentInstanceConfigOf<AgentCtor<TAgentType>>,
    onFinish: (
      finishOutput: AgentFinishOutputSchemaOf<
        AgentCtor<TAgentType>
      > extends z.ZodType
        ? z.infer<AgentFinishOutputSchemaOf<AgentCtor<TAgentType>>>
        : never,
    ) => void | Promise<void>,
    onError: (error: Error) => void | Promise<void>,
  ) => Promise<
    BaseAgent<
      AgentFinishOutputSchemaOf<AgentCtor<TAgentType>> extends z.ZodType
        ? AgentFinishOutputSchemaOf<AgentCtor<TAgentType>>
        : never,
      AgentInstanceConfigOf<AgentCtor<TAgentType>>
    >
  >;
  finishToolHandler?: (
    finishOutput: TFinishToolOutputSchema extends z.ZodType
      ? z.infer<TFinishToolOutputSchema>
      : never,
  ) => void | Promise<void>;
  finishToolErrorHandler?: (error: Error) => void | Promise<void>;
  /**
   * Optional registry used by {@link BaseAgent.getSpawnChildAgentTool}
   * to look up a child agent's `finishToolOutputSchema` at runtime.
   * Required only for agents that expose spawn tools to the model.
   */
  agentTypeRegistry?: AgentTypeRegistry;
  initialState?: Partial<AgentState>;
  /**
   * Renderer for host-only mention kinds (e.g. browser tab mentions).
   * Optional; core mentions (`file`, `workspace`) are handled
   * internally by the conversion pipeline.
   */
  renderExtraMention?: ExtraMentionRenderer;
  /**
   * Optional host hook invoked when the agent reaches a user-facing
   * lifecycle milestone (see {@link AgentNotificationEvent}). Hosts use
   * this to surface notifications (e.g. play a sound) without coupling
   * core to any host UI. Errors thrown by the handler are swallowed.
   */
  notificationEventHandler?: (
    event: AgentNotificationEvent,
    agentId: string,
  ) => void | Promise<void>;
  /**
   * Host-provided execution seam for one model/tool step. Defaults to a
   * direct in-process `streamText()` call.
   */
  stepExecutor?: AgentStepExecutor;
}

/**
 * The base configuration for an agent. Should be defined by the inheriting class.
 */
export type BaseAgentConfig<TFinishToolOutputSchema extends z.ZodType | null> =
  {
    /**
     * Whether the agents state (including Messages) should be persisted to the database.
     */
    persistent: boolean;

    /**
     * The default suggested model ID to use for the agent.
     */
    defaultModelId: string;

    /**
     * If user is allowed to select a different model than the default one.
     *
     * @note If set to `false`, the default model ID will be used and the UI should not show any model selection options.
     *        If a madel change call is made anyway, it get's ignored.
     */
    allowModelSelection: boolean;

    /**
     * The required capabilities for the model to be usable by the agent.
     *
     * @note The agent will not immediately crash when running a step with a different model (ai-sdk might crash though), but the UI can use the info to filter the available models etc.
     */
    requiredCapabilities: ModelCapabilities;

    /**
     * Configures, if the user can input content directly into the agent.
     *
     * @note If set to `false`, the UI should not show any input field for the agent.
     *
     * @note If set to `false`, the agent will include a `finish` tool that will be used to send response data to the parent agent. This tools output MUST be configured with the `finishToolOutput` property in this config.
     */
    allowUserInput: boolean;

    /**
     * Allows to configure the output format of a finish tool that can be used by the agentto send response data to the parent agent (if one exists).
     * @note If set to undefined, the agent will not include a finish tool.
     */
    finishToolOutputSchema: TFinishToolOutputSchema | undefined;

    /**
     * Whether the agent should generate titles for it's instance.
     *
     * @note The base agent provides a default implementation for generating titles, which can be modified by overriding the `generateTitle` method.
     */
    generateTitles: boolean;

    /**
     * The threshold of max context window size after which the chat history should be summarized.
     *
     * @note Accepts a value between 0 (0%) and 1 (100%).
     *
     * @note You can disable summarization by setting the value to -1.
     *
     * @note You can always trigger manual summarization while the agent is in idle by calling the `summarizeChatHistory` method.
     *
     * @note You can customize summarization logic by overriding the `summarizeChatHistory` method.
     *
     * @default 0.65
     */
    historyCompressionThreshold?: number;

    /**
     * Preferred number of recent messages to keep uncompacted after
     * history compression. The actual count may be lower if the kept
     * messages would exceed 30% of the model's context window (token
     * budget). In that case, the floor is reduced adaptively to fit.
     *
     * @note The minimum value is 5, any lower value will be clamped.
     *
     * @default 10
     */
    minUncompressedMessages?: number;

    /**
     * A configurable uinterval of user messages after which the title should be updated.
     *
     * @note If not set, the title will not be updated automatically and only be generated on the first user message.
     *
     * @note Only used if `generateTitles` is set to `true`.
     */
    updateTitlesEveryNUserMessages?: number;

    /**
     * A customizable reason text for the LLM in case a running tool call was aborted due to the user flushing the message queue.
     */
    flushQueueToolCallAbortReason?: string;

    /**
     * A customizable reason text for the LLM in case a open tool call approval request was denied due to the user sending a new message instead of waiting for the tool call to finish.
     */
    flushQueueToolCallRequestApprovalReason?: string;

    /**
     * A customizable reason text for the LLM in case a running tool call was aborted due to the user stopping the agent.
     */
    stopToolCallAbortReason?: string;

    /**
     * A customizable reason text for the LLM in case a open tool call approval request was denied due to the user stopping the agent.
     */
    stopToolCallRequestApprovalReason?: string;

    /**
     * A configurable amount of maximum steps to take before new step execution is force-stopped and a new user message is needed to resume the agents operation.
     *
     * @default infinite
     */
    maxSteps?: number;

    /**
     * A configurable amount of maximum retries the generation can take within one agent step.
     *
     * @default 1
     */
    maxRetries?: number;

    /**
     * A configurable amount of maximum time (ms) to spend before new step execution is force-stopped and a new user message is needed to resume the agents operation.
     *
     * @default infinite
     */
    maxTime?: number;

    /**
     * A configurable amount of maximum output tokens per step.
     */
    maxOutputTokens?: number;

    /**
     * Temperature setting.
     *
     * The value is passed through to the provider. The range depends on the provider and model.
     *
     * @note It is recommended to set either `temperature` or `topP`, but not both.
     */
    temperature?: number;

    /**
     * Nucleus sampling.
     *
     * The value is passed through to the provider. The range depends on the provider and model.
     *
     * @note It is recommended to set either `temperature` or `topP`, but not both.
     */
    topP?: number;

    /**
     * Only sample from the top K options for each subsequent token.
     *
     * Used to remove "long tail" low probability responses.
     *
     * @note Recommended for advanced use cases only. You usually only need to use temperature.
     */
    topK?: number;

    /**
     * Presence penalty setting.
     *
     * It affects the likelihood of the model to repeat information that is already in the prompt.
     * The value is passed through to the provider. The range depends on the provider and model
     */
    presencePenalty?: number;

    /**
     * Frequency penalty setting.
     *
     * It affects the likelihood of the model to repeatedly use the same words or phrases.
     * The value is passed through to the provider. The range depends on the provider and model.
     */
    frequencyPenalty?: number;

    /**
     * Sequences that will stop the generation of the text.
     *
     * If the model generates any of these sequences, it will stop generating further text.
     */
    stopSequences?: string[];

    /**
     * The seed (integer) to use for random sampling.
     *
     * If set and supported by the model, calls will generate deterministic results.
     */
    seed?: number;
  };

export type MessageId = string;

export type SendUserMessageResult = {
  messageId: MessageId;
  disposition: 'admitted' | 'queued';
};

/**
 * Interface for the static (class) side of any agent.
 * This enables type-safe access to static properties like `config` and `agentType`
 * on agent classes (not instances).
 *
 * @example
 * ```ts
 * const AgentsMap = {
 *   [AgentTypes.CHAT]: ChatAgent,
 * } as const satisfies Record<AgentTypes, BaseAgentStatic>;
 *
 * // Type-safe access:
 * AgentsMap[AgentTypes.CHAT].config.defaultModelId
 * ```
 */
export interface BaseAgentStatic<
  TFinishToolOutputSchema extends z.ZodType | null,
> {
  readonly config: BaseAgentConfig<TFinishToolOutputSchema>;
  readonly agentType: AgentTypes;
}

/**
 * Utility type to extract the config type from an agent class.
 */
export type AgentConfig<T extends BaseAgentStatic<any>> = T['config'];

/**
 * A reusable base class for all agents.
 *
 * Implements a standard API for all agents, including capabilities to invoke sub-agents,
 * update state with patch functions (convenient to integrate into Karton etc.)
 * and support for clodex custom formatting of attachments etc.
 *
 * Agents should simply extend this base class and implement the abstract methods as well as pass in a configuration.
 *
 * It's highly recommended that all agents define the BaseAgentConfig themselves isntead of receiving it from the outside.
 *
 * @note Subclasses MUST define `static readonly config` and `static readonly agentType`.
 *       TypeScript cannot enforce `abstract static`, so this is enforced by the `BaseAgentClass` interface.
 */
export abstract class BaseAgent<
  TFinishToolOutputSchema extends z.ZodType | null,
  TInstanceConfig,
  TToolbox extends BaseAgentToolboxView = BaseAgentToolboxView,
> {
  public readonly instanceId: string;

  /**
   * Access the static config from the subclass.
   * This getter bridges the static config to instance access.
   */
  protected get config(): BaseAgentConfig<TFinishToolOutputSchema> {
    return (
      this.constructor as unknown as BaseAgentStatic<TFinishToolOutputSchema>
    ).config;
  }

  /**
   * Access the static agentType from the subclass.
   */
  public get agentType(): AgentTypes {
    return (
      this.constructor as unknown as BaseAgentStatic<TFinishToolOutputSchema>
    ).agentType;
  }

  /**
   * Provider routing mode from the most recent completed step.
   * Empty string before the first step runs. Used for telemetry at
   * message-sent time (before the next step resolves routing).
   */
  public get lastProviderMode(): string {
    return this._stepProviderMode;
  }

  /**
   * Connected coding plan ID from the most recent completed step, if
   * any. Undefined for non-plan routes or before the first step.
   */
  public get lastCodingPlanId(): string | undefined {
    return this._stepCodingPlanId;
  }

  /**
   * The state of the agent is stored in a central store (the agent manager owns that store and manages it efficiently)
   * and is accessed by the agent through the getter and setter.
   */
  private readonly state: {
    get: () => AgentState;
    commands: AgentStateMutations;
    persist: (request?: AgentStatePersistRequest) => Promise<void>;
  };

  /**
   * The configuration of the agent instance.
   * Depends on the agent type.
   *
   * @note Must be serializable since this get's recovered when resuming the agent.
   */
  public readonly instanceConfig: TInstanceConfig;

  // External dependencies — host-supplied capability seam.
  protected readonly host: AgentHost;
  private readonly toolApprovalLifecycle?: ToolApprovalLifecycleHooks;
  protected readonly toolbox: TToolbox;
  protected readonly domainAdapterRegistry: DomainAdapterRegistry;

  protected readonly processedImageCacheService?: ProcessedImageCacheService;
  /**
   * App-wide `FileReadCacheService` injected at construction time. A single
   * instance is shared across all agent instances so repeated reads of the
   * same file across agents benefit from a common cache.
   */
  protected readonly fileReadCacheService: FileReadCacheService;

  /**
   * Per-agent attachment blob store. Used by the `blobReader` plumbed
   * into `convertAgentMessagesToModelMessages` to load `att/<key>`
   * paths off disk.
   */
  protected readonly attachments: AttachmentsService;

  /**
   * Optional renderer for host-only mention kinds (e.g. browser tab
   * mentions). Threaded through the message-conversion pipeline. Core
   * mentions (`file`, `workspace`) are handled internally.
   */
  protected readonly renderExtraMention?: ExtraMentionRenderer;

  // Internal state
  private stepAbortController: AbortController | null = null;

  /**
   * Guard flag to prevent concurrent history compression runs.
   * Set to `true` when `compressHistoryInternal` starts and reset
   * when it finishes (success or failure). Subsequent calls bail
   * out immediately while a compression is in progress.
   */
  private _isCompressingHistory = false;

  /** Debug utility: tracks model messages per step to report cache stability. */
  private readonly _cacheAnalyzer: MessageCacheAnalyzer;

  /**
   * Monotonically increasing counter that identifies the "current" step.
   * Stream callbacks (onAbort, onFinish, onError) capture this value when
   * the step starts and compare before modifying `isWorking`. This prevents
   * stale callbacks from a previous (aborted) step from resetting isWorking
   * after a new step has already started.
   */
  private _stepGeneration = 0;
  /** Host-only effect scope retained while an approval chain is paused. */
  private _pendingToolCapabilityScopeId: string | null = null;
  private _stepStartTime = 0;
  private _stepProviderMode = '';
  private _stepCodingPlanId: string | undefined;
  private _stepRequestedModelId = '';
  private _stepResolvedModelId = '';
  private _stepTaskRole: ModelTaskRole = 'analysis';
  private _toolCallDurations = new Map<string, number>();
  private _memoryWriter: AgentMemoryWriter | null = null;
  private _memoryWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingMemoryWriteReason: MemoryWriteReason | null = null;
  private _lastMemoryWriteAt = 0;
  private _recoveredReplayExecutionId: string | null = null;
  private _recoveredReplayStepGeneration: number | null = null;
  private readonly _closedRecoveredReplayExecutionIds = new Set<string>();

  /** Number of explicit approval responses crossing durable barriers. */
  private _approvalDurabilityInFlight = 0;
  /** Sticky fail-closed bit used when an exact rollback cannot be proven. */
  private _approvalAdmissionFailedClosed = false;
  /** Blocks execution until a failed automatic sweep is durably retried. */
  private _approvalSweepPersistenceBlocked = false;
  /** A changed sweep must remain retryable even when the next sweep is a no-op. */
  private _approvalSweepPersistencePending = false;
  /** Non-tail history rows still owed to persistence by a failed sweep. */
  private readonly _pendingApprovalSweepDirtyMessageIndices = new Set<number>();
  /** Serializes sweep mutation + retry ownership for the shared pending set. */
  private _approvalSweepTail: Promise<void> = Promise.resolve();
  /** Counts queued/running sweep transactions before they publish receipts. */
  private _approvalSweepOperationsInFlight = 0;
  /** Invalidates an in-flight response when a newer lifecycle action wins. */
  private _approvalLifecycleGeneration = 0;
  /** Rejects response ingress while a newer lifecycle invalidation is open. */
  private _approvalInvalidationInFlight = 0;
  /** Serializes host lifecycle invalidations so stale success cannot clear failure. */
  private _approvalInvalidationTail: Promise<void> = Promise.resolve();
  /** Blocks execution after a durable host invalidation failure until retry. */
  private _approvalLifecycleInvalidationFailedClosed = false;
  /** Tool calls whose explicit response is currently crossing barriers. */
  private readonly _approvalResponsesInFlight = new Set<string>();
  /** Serializes exact full-message approval mutations within this agent. */
  private _approvalResponseTail: Promise<void> = Promise.resolve();
  /** Waiters used by stop/new-message paths before they sweep AgentStore. */
  private readonly _approvalDurabilitySettledWaiters = new Set<() => void>();
  /** Serializes user-message ingress and destructive history rewrites. */
  private _historyLifecycleTail: Promise<void> = Promise.resolve();
  /** Blocks step/replay/approval admission while an undo-backed rewrite yields. */
  private _historyRewriteInFlight = 0;
  /** Cancels an older queued/running history operation before its next write. */
  private _historyPreemptionGeneration = 0;
  /** Keeps execution fail-closed until priority stop/recovery work is durable. */
  private _historyPreemptionInFlight = 0;

  /**
   * Settlement barrier for the currently admitted step. The controller is
   * cleared from inside the SDK's `onFinish` callback, before the teed UI
   * stream and the final persistence pass have necessarily drained. Keeping a
   * separate barrier prevents an approval response from starting its
   * continuation against that half-settled history.
   */
  private _activeStepRun: {
    readonly generation: number;
    readonly settled: Promise<'completed' | 'failed' | 'superseded'>;
    readonly resolve: (outcome: 'completed' | 'failed' | 'superseded') => void;
  } | null = null;

  /**
   * Set by `onFinish` once `handlePostStep` has decided whether another
   * step should run. Consumed in the tail of `runStep` (after
   * `populatePathReferencesOnAssistantMessage` + `saveState` have
   * finished). This indirection exists to close two races introduced
   * by the UI-stream restructuring:
   *   1. Scheduling the next step via `setTimeout` inside `onFinish`
   *      could fire before fs-hashing in populate finished, causing
   *      the next step to read history without pathReferences.
   *   2. Calling `onIdle()` inside `onFinish` on the terminal branch
   *      flipped the UI to idle before populate finished, creating
   *      the same window for user-initiated follow-up runSteps.
   * `null` means `onFinish` has not set a decision (e.g. error path,
   * aborted, or step superseded by a newer one) — the tail then no-ops.
   */
  private _pendingContinue: boolean | null = null;

  /**
   * Set only for runtime recovery after a suspend/resume or event-loop stall.
   * It appends a transient model-only `continue` user message for the next
   * step without writing anything to visible/persisted chat history.
   */
  private _pendingSyntheticContinuation: {
    reason: 'system-resumed' | 'event-loop-stalled';
  } | null = null;

  /**
   * Tracks approval IDs for which we have already emitted a
   * `tool-approval-requested` telemetry event. The stream merge loop runs
   * per chunk, so the same `approval-requested` state is observed many
   * times — without this dedupe we would over-count requests by 10×+.
   */
  private _seenApprovalRequestIds = new Set<string>();

  // Handler that get's called when the agent wants to spawn a child agent.
  private readonly spawnChildAgentHandler: <TAgentType extends AgentTypes>(
    // The type of the child agent to spawn.
    childAgentType: TAgentType,

    // The config with which the agent should be spawned
    instanceConfig: AgentInstanceConfigOf<AgentCtor<TAgentType>>,

    // The handler that should be called when the child agent calls the finish tool.
    onFinish: (
      finishOutput: AgentFinishOutputSchemaOf<
        AgentCtor<TAgentType>
      > extends z.ZodType
        ? z.infer<AgentFinishOutputSchemaOf<AgentCtor<TAgentType>>>
        : never,
    ) => void | Promise<void>,

    onError: (error: Error) => void | Promise<void>,
  ) => Promise<
    BaseAgent<
      AgentFinishOutputSchemaOf<AgentCtor<TAgentType>> extends z.ZodType
        ? AgentFinishOutputSchemaOf<AgentCtor<TAgentType>>
        : never,
      AgentInstanceConfigOf<AgentCtor<TAgentType>>
    >
  >;

  // Handler that get's called when the agent calls the finish tool (notify the parent).
  // The finish tool should be added to the list of tools when calling `streamText` on every step (if it's configured).
  private readonly finishToolHandler?: (
    finishOutput: TFinishToolOutputSchema extends z.ZodType
      ? z.infer<TFinishToolOutputSchema>
      : never,
  ) => void | Promise<void>;
  private readonly finishToolErrorHandler?: (
    error: Error,
  ) => void | Promise<void>;

  /**
   * Optional registry used by {@link BaseAgent.getSpawnChildAgentTool}
   * to look up a child agent's `finishToolOutputSchema` at runtime.
   * Required only for agents that expose spawn tools to the model.
   */
  private readonly agentTypeRegistry?: AgentTypeRegistry;

  private readonly notificationEventHandler?: (
    event: AgentNotificationEvent,
    agentId: string,
  ) => void | Promise<void>;
  private readonly stepExecutor: AgentStepExecutor;

  private messages: AgentMessage[] = [];

  public constructor(
    deps: BaseAgentDependencies<
      TFinishToolOutputSchema,
      TInstanceConfig,
      TToolbox
    >,
  ) {
    this.instanceId = deps.instanceId;
    this.state = deps.state;
    this.host = deps.host;
    this.toolApprovalLifecycle = deps.toolApprovalLifecycle;
    this.toolbox = deps.toolbox;
    this.domainAdapterRegistry = deps.domainAdapterRegistry;
    this.instanceConfig = deps.instanceConfig;
    this.spawnChildAgentHandler = deps.spawnChildAgentHandler;
    this.finishToolHandler = deps.finishToolHandler;
    this.finishToolErrorHandler = deps.finishToolErrorHandler;
    this.agentTypeRegistry = deps.agentTypeRegistry;
    this.notificationEventHandler = deps.notificationEventHandler;
    this.stepExecutor = deps.stepExecutor ?? localAgentStepExecutor;
    this.processedImageCacheService = deps.caches?.processedImageCache;
    this.renderExtraMention = deps.renderExtraMention;
    if (!deps.caches?.fileReadCache) {
      throw new Error(
        '[BaseAgent] caches.fileReadCache must be provided — check bootstrap wiring',
      );
    }
    this.fileReadCacheService = deps.caches.fileReadCache;
    this.attachments = deps.attachments;
    this._cacheAnalyzer = new MessageCacheAnalyzer(
      deps.instanceId,
      deps.host.logger,
    );
    const initialState = deps.initialState;

    // Seed the full agent state from the constructor's `initialState` arg.
    // The default title is computed here so the command dispatcher stays
    // environment-agnostic.
    const defaultTitle = `New ${capitalizeFirstLetter(
      this.agentType.toLowerCase(),
    )} Agent - ${new Date().toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })}`;
    this.state.commands.hydrateInitialState({
      defaultTitle,
      initialState,
      defaultModelId: this.config.defaultModelId,
    });

    this.onCreated();
  }

  /**
   * =======================================================
   * PUBLIC METHODS (STRANDARD API ACROSS ALL AGENTS)
   * =======================================================
   */

  private enqueueHistoryLifecycleOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const queued = this._historyLifecycleTail
      .catch(() => undefined)
      .then(operation);
    this._historyLifecycleTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private captureHistoryPreemptionGeneration(operation: string): number {
    if (this._historyPreemptionInFlight > 0) {
      throw new Error(
        `${operation} cannot start while a priority agent lifecycle action is pending`,
      );
    }
    return this._historyPreemptionGeneration;
  }

  private assertHistoryNotPreempted(
    expectedGeneration: number,
    operation: string,
  ): void {
    if (this._historyPreemptionGeneration !== expectedGeneration) {
      throw new Error(
        `${operation} was superseded by a newer priority agent lifecycle action`,
      );
    }
  }

  private enqueuePriorityHistoryLifecycleOperation<T>(
    operation: () => Promise<T>,
    afterSuccess?: (result: T) => void,
  ): Promise<T> {
    this._historyPreemptionInFlight += 1;
    this._historyPreemptionGeneration += 1;
    this._approvalLifecycleGeneration += 1;
    this.supersedeCurrentStep();

    return this.enqueueHistoryLifecycleOperation(async () => {
      let result: T;
      try {
        result = await operation();
      } catch (error) {
        this._historyPreemptionInFlight -= 1;
        throw error;
      }
      this._historyPreemptionInFlight -= 1;
      afterSuccess?.(result);
      return result;
    });
  }

  /**
   * Send a message to the agent. If the agent is busy, the message will be queued.
   * @param message - The message to send to the agent
   *
   * @note If the agent is waiting for one or more tool approvals or not every tool call has been finished, the message will be queued and sent once the current step is finished.
   *
   * @note On send, the chat history is converted into model context with the following pipeline:
   *        `transformMessagesBeforeStep` -> `getSystemPrompt` -> `transformMessagesToModelMessages` -> `transformModelMessagesBeforeStep`.
   *
   * @note DO NOT OVERRIDE
   */
  public async sendUserMessage(
    message: AgentMessage & { role: 'user' },
  ): Promise<MessageId> {
    const result = await this.sendUserMessageWithDisposition(message);
    return result.messageId;
  }

  /**
   * Host-facing variant that reports whether the message entered history or
   * the follow-up queue. The legacy `sendUserMessage()` return shape
   * remains a message id for extension compatibility.
   */
  public async sendUserMessageWithDisposition(
    message: AgentMessage & { role: 'user' },
  ): Promise<SendUserMessageResult> {
    const detachedMessage = structuredClone(message);
    return await this.enqueueHistoryLifecycleOperation(() =>
      this.sendUserMessageSerialized(detachedMessage),
    );
  }

  private async sendUserMessageSerialized(
    message: AgentMessage & { role: 'user' },
    deferRunStep = false,
  ): Promise<SendUserMessageResult> {
    const preemptionGeneration =
      this.captureHistoryPreemptionGeneration('User message');
    // We override the message id with a random UUID to ensure it's unique.
    const id = crypto.randomUUID();

    const msg = { ...message, id: id };
    this.recordEvidenceEvent(
      'user_message',
      {
        role: 'user',
        text: getMessageText(msg),
        partTypes: msg.parts.map((part) => part.type),
        queued: this.state.get().isWorking,
      },
      {
        id: `user:${this.instanceId}:${id}`,
        messageId: id,
        source: 'agent_message',
        sourceId: id,
      },
    );

    // Invalidate host-managed records before deciding whether a busy message
    // can be queued. This closes the interval where the broker has already
    // staged an approval but AgentStore/UI has not published it yet.
    const hadLocalApproval = this.hasLocalOpenToolApproval();
    const hadLifecycleInvalidationFailure =
      this._approvalLifecycleInvalidationFailedClosed;
    const invalidation =
      await this.invalidateOpenToolApprovals('new-user-message');
    try {
      this.assertHistoryNotPreempted(preemptionGeneration, 'User message');
      const displacedApproval =
        hadLocalApproval ||
        this.hasLocalOpenToolApproval() ||
        invalidation.invalidatedCount > 0 ||
        this._approvalSweepPersistencePending ||
        this._approvalSweepOperationsInFlight > 0 ||
        hadLifecycleInvalidationFailure;

      // Busy agents without a displaced approval keep the existing queue
      // semantics.
      const originatingStep = this._activeStepRun;
      const isBusy = this.state.get().isWorking || originatingStep !== null;
      if (isBusy && !displacedApproval) {
        const { queuedModelId, queueLengthAfter } =
          this.state.commands.enqueueUserMessage({ message: msg });

        this.host.logger.debug(`[BaseAgent:${this.instanceId}] Queued message`);

        this.host.telemetry?.capture('agent-message-queued', {
          agent_type: this.agentType,
          agent_instance_id: this.instanceId,
          model_id: queuedModelId,
          queue_length_after: queueLengthAfter,
        });

        // Always request a post-settlement wake from the exact step that made
        // this message busy. This closes the race where the step already made
        // its continuation decision before the queue mutation became visible.
        this.scheduleQueuedMessageWake(originatingStep);

        return { messageId: id, disposition: 'queued' };
      }

      this.host.logger.debug(
        `[BaseAgent:${this.instanceId}] Sending user message`,
      );

      if (this.state.get().isWorking || this._activeStepRun !== null) {
        // Keep the outer invalidation gate held across abort, AgentStore
        // sweep, and strict persistence so a response cannot re-enter between
        // those phases.
        await this.internalStop('user-flushed-queue');
        this.assertHistoryNotPreempted(preemptionGeneration, 'User message');
      }

      // Auto-deny any pending approval requests and force-terminate any
      // non-terminal tool parts before the user message enters history.
      // Without this, stale tool states (approval-requested, input-streaming,
      // input-available) would cause canRunStep() to block indefinitely.
      await this.applyAndPersistApprovalSweep(() =>
        this.state.commands.denyAllNonTerminalToolPartsInHistory({
          approvalDenyReason:
            this.config.flushQueueToolCallRequestApprovalReason ??
            'User sent new message before tool call approval was granted.',
          forceErrorText:
            'Tool execution interrupted — agent session ended before tool call finished.',
        }),
      );
      this.assertHistoryNotPreempted(preemptionGeneration, 'User message');

      // If the agent is not running, add the message to history and
      // immediately send it to the model after releasing the invalidation
      // gate below.
      this.state.commands.appendHistoryMessage({ message: msg });
      this.scheduleMemorySnapshotWrite('user-message');
    } finally {
      invalidation.release();
    }

    if (!deferRunStep) void this.runStep();

    return { messageId: id, disposition: 'admitted' };
  }

  /**
   * Sends a tool approval response to the agent.
   *
   * @param toolCallResponse - The tool call response to send to the agent
   *
   * @note If the agent is busy, the response will be queued and sent once the current step is finished.
   *
   * @note If not all open approval requests have been responded to, the agent will not be triggered again until all requests have been responded with either deny or accept.
   *
   * @note DO NOT OVERRIDE
   */
  public async sendToolApprovalResponse(
    toolCallResponse: ToolApprovalResponse,
  ): Promise<void> {
    const detachedResponse = structuredClone(toolCallResponse);
    const operation = this._approvalResponseTail
      .catch(() => undefined)
      .then(() => this.sendToolApprovalResponseSerialized(detachedResponse));
    this._approvalResponseTail = operation.catch(() => undefined);
    return await operation;
  }

  private async sendToolApprovalResponseSerialized(
    toolCallResponse: ToolApprovalResponse,
  ): Promise<void> {
    if (this._approvalInvalidationInFlight > 0) {
      throw new Error(
        'Tool approval response cannot start during agent lifecycle invalidation',
      );
    }
    if (
      this._approvalAdmissionFailedClosed ||
      this._approvalSweepPersistenceBlocked ||
      this._approvalSweepOperationsInFlight > 0 ||
      this._historyRewriteInFlight > 0 ||
      this._historyPreemptionInFlight > 0 ||
      this._approvalLifecycleInvalidationFailedClosed
    ) {
      throw new Error(
        'Tool approval response cannot start while approval persistence is fail-closed',
      );
    }
    if (this._recoveredReplayExecutionId !== null) {
      throw new Error(
        'Tool approval response cannot start while recovered UI replay is still open',
      );
    }
    const approvalId = toolCallResponse.approvalId;
    const approved = toolCallResponse.approved;
    const reason = toolCallResponse.reason;

    const request = this.state.commands.snapshotApprovalRequest({
      approvalId,
    });
    if (this._approvalResponsesInFlight.has(request.toolCallId)) {
      throw new Error(
        `Tool approval response is already being committed for '${approvalId}'`,
      );
    }

    const lifecycleGeneration = this._approvalLifecycleGeneration;
    const originatingStep = this._activeStepRun;
    const originatingStepGeneration = this._stepGeneration;
    this._approvalResponsesInFlight.add(request.toolCallId);
    let durabilityAdmitted = false;

    const approvalLifecycle = this.toolApprovalLifecycle;
    let resolution:
      | ReturnType<AgentStateMutations['resolveApproval']>
      | undefined;
    try {
      if (originatingStep) {
        const settlementOutcome = await originatingStep.settled;
        if (settlementOutcome !== 'completed') {
          throw new Error(
            `Tool approval response '${approvalId}' cannot commit because its originating step ${settlementOutcome}`,
          );
        }
      }
      this.assertApprovalLifecycleGeneration(lifecycleGeneration, approvalId);
      if (this._stepGeneration !== originatingStepGeneration) {
        throw new Error(
          `Tool approval response '${approvalId}' was superseded before durable commit`,
        );
      }
      this._approvalDurabilityInFlight += 1;
      durabilityAdmitted = true;

      const prepared =
        (await approvalLifecycle?.prepareResponse({
          agentInstanceId: this.instanceId,
          approvalId: request.approvalId,
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          input: structuredClone(request.input),
          approved,
        })) ?? null;

      this.assertApprovalLifecycleGeneration(lifecycleGeneration, approvalId);
      if (prepared && !this.config.persistent) {
        throw new Error(
          'Host-managed tool approval requires a persistent agent history',
        );
      }
      resolution = this.state.commands.resolveApproval({
        approvalId,
        approved,
        reason,
        expected: request,
      });

      if (this.config.persistent) {
        await this.state.persist({
          dirtyMessageIndices: [resolution.messageIndex],
          expectedMessageBindings: [
            {
              messageIndex: resolution.messageIndex,
              messageId: resolution.messageId,
            },
          ],
          throwOnError: true,
        });
      }
      this.assertApprovalLifecycleGeneration(lifecycleGeneration, approvalId);

      if (prepared) {
        if (!approvalLifecycle) {
          throw new Error('Tool approval lifecycle disappeared before commit');
        }
        await approvalLifecycle.commitResponse(prepared);
      }
      this.assertApprovalLifecycleGeneration(lifecycleGeneration, approvalId);
    } catch (error) {
      let failure = error;
      if (!resolution && error instanceof ApprovalResolutionMutationError) {
        resolution = error.receipt;
      }
      if (resolution) {
        let rolledBack = false;
        try {
          rolledBack = this.state.commands.rollbackApprovalResolution({
            receipt: resolution,
          });
        } catch (rollbackMutationError) {
          this._approvalAdmissionFailedClosed = true;
          failure = new AggregateError(
            [error, rollbackMutationError],
            'Tool approval response failed and its in-memory rollback could not be proven',
          );
        }
        if (!rolledBack) {
          this._approvalAdmissionFailedClosed = true;
        } else if (this.config.persistent) {
          try {
            await this.state.persist({
              dirtyMessageIndices: [resolution.messageIndex],
              expectedMessageBindings: [
                {
                  messageIndex: resolution.messageIndex,
                  messageId: resolution.messageId,
                },
              ],
              throwOnError: true,
            });
          } catch (rollbackError) {
            this._approvalAdmissionFailedClosed = true;
            failure = new AggregateError(
              [error, rollbackError],
              'Tool approval response failed and its durable rollback could not be proven',
            );
          }
        }
      }
      throw failure;
    } finally {
      if (durabilityAdmitted) this._approvalDurabilityInFlight -= 1;
      this._approvalResponsesInFlight.delete(request.toolCallId);
      if (this._approvalDurabilityInFlight === 0) {
        for (const resolve of this._approvalDurabilitySettledWaiters) resolve();
        this._approvalDurabilitySettledWaiters.clear();
      }
    }

    try {
      if (approved) {
        this.host.telemetry?.capture('tool-approved', {
          tool_name: request.toolName,
          agent_instance_id: this.instanceId,
          tool_call_id: request.toolCallId,
        });
      } else {
        this.host.telemetry?.capture('tool-denied', {
          tool_name: request.toolName,
          reason,
          agent_instance_id: this.instanceId,
          tool_call_id: request.toolCallId,
        });
      }
    } catch (error) {
      this.host.logger.debug(
        `[BaseAgent:${this.instanceId}] Tool approval telemetry failed: ${(error as Error).message}`,
      );
    }

    void this.continueAfterToolApprovalResponse({
      lifecycleGeneration,
      originatingStepGeneration,
      originatingStepSettlement: originatingStep?.settled,
    }).catch((error) => {
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));
      this.host.logger.error(
        `[BaseAgent:${this.instanceId}] Failed to schedule tool approval continuation: ${this.formatError(normalizedError)}`,
      );
      this.report(normalizedError, 'continueAfterToolApprovalResponse');
    });

    return;
  }

  /**
   * Delete a queued message from the agent.
   * @param messageId - The id of the message to delete
   *
   * @note DO NOT OVERRIDE
   */
  public async deleteQueuedMessage(messageId: string): Promise<void> {
    return await this.enqueueHistoryLifecycleOperation(async () => {
      this.state.commands.removeQueuedMessage({ messageId });
    });
  }

  /**
   * Clears/Empties the queue of the agent without sending any of the queued messages.
   */
  public async clearQueue(): Promise<void> {
    return await this.enqueueHistoryLifecycleOperation(async () => {
      this.state.commands.clearQueuedMessages();
    });
  }

  /**
   * Flushes the durable task and memory state used by Session Teleport.
   *
   * This deliberately does not stop or suspend the local agent. A caller may
   * only checkpoint an already-idle step, and any state change observed while
   * persistence is settling rejects the handoff so local execution remains
   * authoritative.
   */
  public async prepareSessionCheckpoint(): Promise<{
    agentStateFlushedAt: string;
    memoryFlushedAt: string;
  }> {
    const assertSafePoint = () => {
      const state = this.state.get();
      assertAgentSessionCheckpointSafePoint({
        isWorking: state.isWorking,
        hasRunningToolTransaction: Boolean(
          this._activeStepRun !== null ||
            this._recoveredReplayExecutionId !== null ||
            this._approvalDurabilityInFlight > 0 ||
            this._approvalInvalidationInFlight > 0 ||
            this._approvalResponsesInFlight.size > 0 ||
            this._approvalAdmissionFailedClosed ||
            this._approvalSweepPersistenceBlocked ||
            this._approvalSweepPersistencePending ||
            this._approvalSweepOperationsInFlight > 0 ||
            this._historyRewriteInFlight > 0 ||
            this._historyPreemptionInFlight > 0 ||
            this._approvalLifecycleInvalidationFailedClosed ||
            (this.stepAbortController &&
              !this.stepAbortController.signal.aborted),
        ),
        pendingApprovalCount: Object.keys(state.pendingApprovals).length,
      });
    };
    const fingerprint = () => {
      const state = this.state.get();
      return JSON.stringify({
        title: state.title,
        activeModelId: state.activeModelId,
        toolApprovalMode: state.toolApprovalMode,
        goal: state.goal ?? null,
        usedTokens: state.usedTokens,
        history: state.history.map(serializeAgentStatePersistMessage),
        queuedMessages: state.queuedMessages.map(
          serializeAgentStatePersistMessage,
        ),
      });
    };

    assertSafePoint();
    const before = fingerprint();

    await this.saveState();
    const agentStateFlushedAt = new Date().toISOString();

    if (this._memoryWriteTimer) {
      clearTimeout(this._memoryWriteTimer);
      this._memoryWriteTimer = null;
    }
    this._pendingMemoryWriteReason = null;
    if (this.config.persistent) {
      await this.flushMemorySnapshotWrite('post-step');
    }
    const memoryFlushedAt = new Date().toISOString();

    assertSafePoint();
    if (fingerprint() !== before) {
      throw new AgentSessionCheckpointSafePointError(
        'state-changed-during-flush',
      );
    }
    return { agentStateFlushedAt, memoryFlushedAt };
  }

  /**
   * Reattaches a cloud UI stream that survived a host-process restart.
   *
   * The agent must be locally idle. Chunks are merged into the last assistant
   * message so replay continues the same visible response rather than creating
   * a duplicate turn.
   */
  public async replayRecoveredUiChunk(input: {
    executionId: string;
    sequence: number;
    chunk: InferUIMessageChunk<AgentMessage>;
  }): Promise<'applied' | 'duplicate'> {
    if (this._historyPreemptionInFlight > 0) {
      this.rememberClosedRecoveredReplayExecution(input.executionId);
      return 'duplicate';
    }
    const detachedInput = structuredClone(input);
    return await this.enqueueHistoryLifecycleOperation(() =>
      this.replayRecoveredUiChunkSerialized(detachedInput),
    );
  }

  private async replayRecoveredUiChunkSerialized(input: {
    executionId: string;
    sequence: number;
    chunk: InferUIMessageChunk<AgentMessage>;
  }): Promise<'applied' | 'duplicate'> {
    if (this._closedRecoveredReplayExecutionIds.has(input.executionId)) {
      return 'duplicate';
    }
    if (this._historyPreemptionInFlight > 0) {
      this.rememberClosedRecoveredReplayExecution(input.executionId);
      return 'duplicate';
    }
    const current = this.state.get();
    const lastAssistantMessage = [...current.history]
      .reverse()
      .find((message) => message.role === 'assistant');
    const replay = lastAssistantMessage?.metadata?.cloudReplay;
    if (
      replay?.executionId === input.executionId &&
      replay.lastSequence >= input.sequence
    ) {
      return 'duplicate';
    }
    let replayStepGeneration: number;
    if (this._recoveredReplayExecutionId === null) {
      const replayPreemptionGeneration = this._historyPreemptionGeneration;
      assertAgentSessionCheckpointSafePoint({
        isWorking: current.isWorking,
        hasRunningToolTransaction: Boolean(
          this._activeStepRun !== null ||
            this._approvalDurabilityInFlight > 0 ||
            this._approvalInvalidationInFlight > 0 ||
            this._approvalResponsesInFlight.size > 0 ||
            this._approvalAdmissionFailedClosed ||
            this._approvalSweepPersistenceBlocked ||
            this._approvalSweepPersistencePending ||
            this._approvalSweepOperationsInFlight > 0 ||
            this._historyRewriteInFlight > 0 ||
            this._historyPreemptionInFlight > 0 ||
            this._approvalLifecycleInvalidationFailedClosed ||
            (this.stepAbortController &&
              !this.stepAbortController.signal.aborted),
        ),
        pendingApprovalCount: Object.keys(current.pendingApprovals).length,
      });
      let replayWasPreempted = false;
      try {
        this.state.commands.beginStep({ flushQueue: false });
      } finally {
        // AgentStore subscribers run synchronously. A subscriber may enqueue a
        // priority stop/recovery while observing beginStep(), before this replay
        // has published its session identity. In that case the priority action
        // has already won: tombstone the execution even if that subscriber also
        // throws, and never let a later chunk reopen it.
        replayWasPreempted =
          this._historyPreemptionGeneration !== replayPreemptionGeneration ||
          this._historyPreemptionInFlight > 0;
        if (replayWasPreempted) {
          this.rememberClosedRecoveredReplayExecution(input.executionId);
        }
      }
      if (replayWasPreempted) return 'duplicate';
      replayStepGeneration = ++this._stepGeneration;
      this._recoveredReplayExecutionId = input.executionId;
      this._recoveredReplayStepGeneration = replayStepGeneration;
    } else if (this._recoveredReplayExecutionId !== input.executionId) {
      throw new AgentSessionCheckpointSafePointError('agent-step-running');
    } else {
      const existingGeneration = this._recoveredReplayStepGeneration;
      if (
        existingGeneration === null ||
        this._stepGeneration !== existingGeneration
      ) {
        return 'duplicate';
      }
      replayStepGeneration = existingGeneration;
    }
    try {
      await this.handleUiStream(
        singleChunkUiStream(input.chunk),
        lastAssistantMessage,
        replayStepGeneration,
      );
      if (
        this._recoveredReplayExecutionId !== input.executionId ||
        this._recoveredReplayStepGeneration !== replayStepGeneration ||
        this._stepGeneration !== replayStepGeneration
      ) {
        return 'duplicate';
      }
      const mergedAssistant = [...this.state.get().history]
        .reverse()
        .find((message) => message.role === 'assistant');
      if (!mergedAssistant) {
        throw new Error('Recovered cloud chunk produced no assistant message');
      }
      this.state.commands.markRecoveredCloudSequence({
        messageId: mergedAssistant.id,
        executionId: input.executionId,
        sequence: input.sequence,
        recoveredAt: new Date().toISOString(),
      });
      await this.saveState();
      if (
        this._recoveredReplayExecutionId !== input.executionId ||
        this._recoveredReplayStepGeneration !== replayStepGeneration ||
        this._stepGeneration !== replayStepGeneration
      ) {
        return 'duplicate';
      }
      return 'applied';
    } catch (error) {
      await this.finishRecoveredUiReplaySerialized({
        executionId: input.executionId,
        outcome: 'failed',
        error,
      });
      throw error;
    }
  }

  public async finishRecoveredUiReplay(input: {
    executionId: string;
    outcome: 'completed' | 'cancelled' | 'failed';
    error?: unknown;
  }): Promise<void> {
    return await this.enqueueHistoryLifecycleOperation(() =>
      this.finishRecoveredUiReplaySerialized(input),
    );
  }

  private async finishRecoveredUiReplaySerialized(input: {
    executionId: string;
    outcome: 'completed' | 'cancelled' | 'failed';
    error?: unknown;
  }): Promise<void> {
    if (this._recoveredReplayExecutionId !== input.executionId) return;
    const replayStepGeneration = this._recoveredReplayStepGeneration;
    if (replayStepGeneration === null) return;
    if (input.outcome === 'failed') {
      this.state.commands.recordStepError({
        error: {
          message:
            input.error instanceof Error
              ? input.error.message
              : 'Recovered cloud execution failed',
        },
        markUnread: 'mark-unread',
      });
    } else {
      this.state.commands.recordStepError({
        error: undefined,
        markUnread: 'if-assistant-history',
      });
    }
    await this.saveState();
    if (
      this._recoveredReplayExecutionId !== input.executionId ||
      this._recoveredReplayStepGeneration !== replayStepGeneration ||
      this._stepGeneration !== replayStepGeneration
    ) {
      return;
    }
    this.scheduleMemorySnapshotWrite('post-step');
    await this.onIdle();
    if (
      this._recoveredReplayExecutionId === input.executionId &&
      this._recoveredReplayStepGeneration === replayStepGeneration
    ) {
      this.rememberClosedRecoveredReplayExecution(input.executionId);
      this._recoveredReplayExecutionId = null;
      this._recoveredReplayStepGeneration = null;
      if (this.state.get().queuedMessages.length > 0) {
        this.scheduleQueuedMessageWake(null);
      }
    }
  }

  /**
   * Immediately flushes the queue by stopping the agent (aborts any ongoing streams)
   * and sending all of the queued messages at once.
   *
   * @note Pending tool approvals will be denied with reason "User sent new message instead. Retry if necessary." or configurable response.
   * @note Pending tool calls will be aborted with reason "User sent new message instead. Retry if necessary." or configurable response.
   *
   * @note DO NOT OVERRIDE
   */
  public async flushQueue(): Promise<void> {
    return await this.enqueuePriorityHistoryLifecycleOperation(
      () => this.flushQueueSerialized(),
      () => {
        void this.runStep();
      },
    );
  }

  private async flushQueueSerialized(): Promise<void> {
    const flushedCount = this.state.get().queuedMessages.length;

    await this.internalStop('user-flushed-queue');

    // Send all queued messages into the chat
    this.state.commands.flushQueueIntoHistory();
    if (flushedCount > 0) {
      this.scheduleMemorySnapshotWrite('queued-messages');
    }

    if (flushedCount > 0) {
      this.host.telemetry?.capture('agent-queue-flushed', {
        agent_type: this.agentType,
        agent_instance_id: this.instanceId,
        flushed_message_count: flushedCount,
      });
    }

    return;
  }

  /**
   * Immediately stops the agent, including aborting any ongoing streams.
   *
   * @note Unfinished messages will be persisted, unless the only include a "thinking" part and nothing else.
   *
   * @note DO NOT OVERRIDE
   */
  public async stop(): Promise<void> {
    return await this.enqueuePriorityHistoryLifecycleOperation(() =>
      this.stopSerialized(),
    );
  }

  private async stopSerialized(): Promise<void> {
    await this.internalStop('user-stopped');
    this.state.commands.setIsWorkingFalse();
  }

  /**
   * Stops a potentially stale in-flight step and asks the model to continue.
   * Used after system suspend/resume or event-loop stalls where sockets and
   * provider streams may have been torn down without a clean SDK error.
   *
   * @note DO NOT OVERRIDE
   */
  public async recoverInterruptedRun(
    reason: 'system-resumed' | 'event-loop-stalled',
  ): Promise<void> {
    return await this.enqueuePriorityHistoryLifecycleOperation(
      () => this.recoverInterruptedRunSerialized(reason),
      () => {
        void this.runStep();
      },
    );
  }

  private async recoverInterruptedRunSerialized(
    reason: 'system-resumed' | 'event-loop-stalled',
  ): Promise<void> {
    const historyLengthBefore = this.state.get().history.length;

    this.host.logger.info(
      `[BaseAgent:${this.instanceId}] Recovering interrupted run with synthetic continuation. reason=${reason}, historyLength=${historyLengthBefore}`,
    );

    await this.internalStop('system-interrupted');
    this.state.commands.setIsWorkingFalse();

    this._pendingSyntheticContinuation = { reason };
  }

  /**
   * Reports an error to the agents parent. Can be used to notify the parent if the agent is permanently stopped.
   *
   * @param error - The error to report to the parent.
   *
   * @note DO NOT OVERRIDE
   */
  public async reportErrorToParent(error: Error): Promise<void> {
    // TODO
    await this.finishToolErrorHandler?.(error);
  }

  /**
   * Replaces the given user message ID with a new message (replacing the old message in the history)
   *
   * @param userMessageId The ID of the user message to replace.
   * @param newUserMessage The new user message to replace the old message with.
   *
   * @returns The ID of the new user message.
   *
   * @note Permanently removes all messages that were happened after the given user message ID.
   *        Clears the queue of the agent as well.
   *
   * @note Automatically sends the new message to the model.
   *
   * @note DO NOT OVERRIDE
   */
  public async replaceUserMessage(
    userMessageId: string,
    newUserMessage: AgentMessage & { role: 'user' },
    undoToolCalls: boolean,
  ): Promise<string> {
    const detachedMessage = structuredClone(newUserMessage);
    return await this.enqueueHistoryLifecycleOperation(() =>
      this.replaceUserMessageSerialized(
        userMessageId,
        detachedMessage,
        undoToolCalls,
      ),
    );
  }

  private async replaceUserMessageSerialized(
    userMessageId: string,
    newUserMessage: AgentMessage & { role: 'user' },
    undoToolCalls: boolean,
  ): Promise<string> {
    const preemptionGeneration = this.captureHistoryPreemptionGeneration(
      'User message replacement',
    );
    this._historyRewriteInFlight += 1;
    let shouldRunStep = false;
    try {
      if (this._recoveredReplayExecutionId !== null) {
        throw new Error(
          'Cannot replace a user message while recovered UI replay is still open',
        );
      }

      // Fence stale stream/context callbacks before the first await below can
      // yield. The rewrite gate remains held across host undo so no approval,
      // replay, or new step can publish into the history being replaced.
      await this.internalStop('user-flushed-queue');
      this.assertHistoryNotPreempted(
        preemptionGeneration,
        'User message replacement',
      );
      this.state.commands.setIsWorkingFalse();

      const history = this.state.get().history;
      const replaceMessageIndex = history.findIndex(
        (message) => message.id === userMessageId,
      );
      if (replaceMessageIndex === -1) {
        throw new Error('User message not found in history');
      }
      const undoneMessages = history.slice(replaceMessageIndex);

      const undoneToolCallIds = undoneMessages
        .filter((msg) => msg.role === 'assistant')
        .flatMap(
          (msg) =>
            msg.parts.filter(
              (part) =>
                part.type.startsWith('tool-') || part.type === 'dynamic-tool',
            ) as (AgentToolUIPart | DynamicToolUIPart)[],
        )
        .map(
          (part) => (part as AgentToolUIPart | DynamicToolUIPart).toolCallId,
        );

      if (undoneToolCallIds.length > 0 && undoToolCalls) {
        await this.toolbox.undoToolCalls(undoneToolCallIds, this.instanceId);
      }

      // Once host undo has completed, the matching history rewrite must
      // commit even if a newer priority stop arrived during that await. The
      // generation assertion then prevents the replacement message/step from
      // reviving after the newer stop.
      this.state.commands.replaceUserMessage({ userMessageId });
      this.assertHistoryNotPreempted(
        preemptionGeneration,
        'User message replacement',
      );
      const { messageId: newMessageId } = await this.sendUserMessageSerialized(
        newUserMessage,
        true,
      );
      shouldRunStep = true;
      return newMessageId;
    } finally {
      this._historyRewriteInFlight -= 1;
      if (shouldRunStep) void this.runStep();
    }
  }

  /**
   * Retries the last user message that resulted in an error.
   *
   * @note Only works if there is an error in the state and the last message is a user message.
   *
   * @note DO NOT OVERRIDE
   */
  public async retryLastUserMessage(): Promise<void> {
    return await this.enqueueHistoryLifecycleOperation(() =>
      this.retryLastUserMessageSerialized(),
    );
  }

  private async retryLastUserMessageSerialized(): Promise<void> {
    const currentState = this.state.get();

    // Check if there's an error
    if (!currentState.error) {
      throw new Error('No error to retry');
    }

    // Find the last user message
    const history = currentState.history;
    let lastUserMessage: (AgentMessage & { role: 'user' }) | null = null;

    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (entry?.role === 'user') {
        lastUserMessage = structuredClone(
          entry as AgentMessage & { role: 'user' },
        );
        break;
      }
    }

    if (!lastUserMessage) {
      throw new Error('No user message found to retry');
    }

    // Revert to the last user message and resend it
    await this.revertToUserMessageSerialized(lastUserMessage.id, false);
    await this.sendUserMessageSerialized(lastUserMessage);
  }

  /**
   * Retrieves the current message history of the agent (including streaming messages).
   *
   * @note DO NOT OVERRIDE
   */
  public getMessages(): AgentMessage[] {
    return this.state.get().history;
  }

  /**
   * Reverts the agent to the state before the given user message ID.
   *
   * @param userMessageId - The ID of the user message to revert to.
   * @param undoToolCalls - Whether to undo the tool calls that were executed since the given user message ID.
   *
   * @note DO NOT OVERRIDE
   */
  public async revertToUserMessage(
    userMessageId: string,
    undoToolCalls: boolean,
  ): Promise<void> {
    return await this.enqueueHistoryLifecycleOperation(() =>
      this.revertToUserMessageSerialized(userMessageId, undoToolCalls),
    );
  }

  private async revertToUserMessageSerialized(
    userMessageId: string,
    undoToolCalls: boolean,
  ): Promise<void> {
    const preemptionGeneration = this.captureHistoryPreemptionGeneration(
      'User message revert',
    );
    this._historyRewriteInFlight += 1;
    try {
      if (
        this.state.get().isWorking ||
        this._activeStepRun !== null ||
        this._recoveredReplayExecutionId !== null ||
        this._approvalResponsesInFlight.size > 0 ||
        this._approvalDurabilityInFlight > 0 ||
        this._approvalInvalidationInFlight > 0 ||
        this._approvalSweepOperationsInFlight > 0
      ) {
        throw new Error(
          'Cannot revert to user message while agent is still running',
        );
      }

      const history = this.state.get().history;
      const msgIndex = history.findIndex((msg) => msg.id === userMessageId);
      if (msgIndex === -1) {
        throw new Error('User message not found in history');
      }
      const undoneMessages = history.slice(msgIndex);

      // Even an idle history can contain an open host approval. Close it
      // durably and advance the step generation before undo can yield and
      // before the history is truncated. The rewrite gate stays held until
      // the exact synchronous truncate below has committed.
      await this.internalStop('user-flushed-queue');
      this.assertHistoryNotPreempted(
        preemptionGeneration,
        'User message revert',
      );
      this.state.commands.setIsWorkingFalse();

      const undoneToolCallIds = undoneMessages
        .filter((msg) => msg.role === 'assistant')
        .flatMap(
          (msg) =>
            msg.parts.filter(
              (part) =>
                part.type.startsWith('tool-') || part.type === 'dynamic-tool',
            ) as (AgentToolUIPart | DynamicToolUIPart)[],
        )
        .map(
          (part) => (part as AgentToolUIPart | DynamicToolUIPart).toolCallId,
        );

      if (undoneToolCallIds.length > 0 && undoToolCalls) {
        await this.toolbox.undoToolCalls(undoneToolCallIds, this.instanceId);
      }

      this.state.commands.truncateHistoryAt({ messageIndex: msgIndex });
      this.scheduleMemorySnapshotWrite('user-message');
      this.assertHistoryNotPreempted(
        preemptionGeneration,
        'User message revert',
      );
    } finally {
      this._historyRewriteInFlight -= 1;
    }
  }

  public async updateInputState(newInputState: string): Promise<void> {
    this.state.commands.setInputState({ inputState: newInputState });
    return;
  }

  public async updateActiveModelId(modelId: string): Promise<void> {
    // We accept model updates at all times, and the UI has to make enforce that model changes aren't allowed
    this.state.commands.setActiveModel({ modelId });
    return;
  }

  public async setTitle(newTitle: string): Promise<void> {
    this.host.logger.debug(
      `[BaseAgent:${this.instanceId}] User set title: ${newTitle}`,
    );
    this.state.commands.setUserTitle({ title: newTitle });
    await this.saveState();
    this.scheduleMemorySnapshotWrite('title');
  }

  /**
   * =======================================================
   * EXTENDABLE METHODS (CONFIGURABLE BEHAVIOR BY THE INHERITING CLASS)
   * =======================================================
   */

  /**
   * Generates a title for a message. Override to customize the title generation.
   *
   * @param messages - The chat history for which the title should be generated.
   *
   * @returns The title for the message
   *
   * @note Will only be called if `generateTitles` in agent config is set to `true`.
   */
  protected async generateTitle(messages: AgentMessage[]): Promise<string> {
    try {
      return await generateSimpleTitle(
        messages,
        this.host.models,
        this.instanceId,
      );
    } catch (e) {
      const error = e as Error;
      this.host.logger.error(
        `[BaseAgent:${this.instanceId}] Failed to generate title. Error: ${error.message}, Stack: ${error.stack}`,
      );
      this.report(error, 'generateTitle');
      return this.state.get().title;
    }
  }

  /**
   * Compresses the agent history. Override to customize the comapction logic.
   *
   * @param history - The agent history for which the compaction should be generated
   *
   * @returns A compoacted text that represents the given agent history.
   *
   * @note Will only be called automatically, if `summarizeChatHistoryThreshold` in agent config is set to a value greater than 0.
   */
  protected async compressHistory(history: AgentMessage[]): Promise<string> {
    // The standard compaction logic is very simple. We can make this more sophisticated later on.
    return await generateSimpleCompressedHistory(
      history,
      this.host.models,
      this.instanceId,
      this.state.get().activeModelId,
      this.host,
    );
  }

  /**
   * Transforms/Updates the list of messages before a step is started.
   *
   * @param messages - The messages to transform
   *
   * @returns The transformed messages
   *
   * @note Does nothing by default (returns the messages as is).
   *
   * @note Can be overridden by the inheriting class to add additional logic before a step is started.
   *
   * @note Receives message history that may potentially be compacted already.
   *
   * @note If the transform to Model messages should be customized, override the `transformMessagesToModelMessages` instead.
   */
  protected transformMessagesBeforeStep(
    messages: AgentMessage[],
  ): AgentMessage[] | Promise<AgentMessage[]> {
    return messages;
  }

  /**
   * Transforms/Updates the list of messages before a step is started.
   *
   * @note Called when the agent is created.
   *
   * @note Can be overridden by the inheriting class to add additional logic when the agent is created.
   *
   * @note TODO: Think about race-conditions when multiple consumers trigger user messages.
   */
  protected onCreated(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Transforms/Updates UI messages into model messages that are sent to the model.
   *
   * @param messages - The UI messages to transform
   *
   * @param systemPrompt - The system prompt to use for the transformation (configured via `getSystemPrompt`)
   *
   * @returns An array of model messages for the given UI messages.
   *
   * @note By default converts all UI message to model messages with default clodex conventions and standard system prompt.
   *
   * @note Also applies compacted conversation
   */

  /**
   * @note Can be overriden by the inheriting class to transform the messages differently.
   *
   * @note If transformed model messages should simply be customized, override `transformModelMessagesBeforeStep` instead.
   *
   * @note The added system prompt is configured via the method `getSystemPrompt`.
   */
  protected async transformMessagesToModelMessages(
    messages: AgentMessage[],
    systemPrompt: string,
    reasoningSignatureSource?: ReasoningSignatureSource,
    allowedEnvDomainIds?: readonly string[],
  ): Promise<ModelMessage[]> {
    const activeModelId = this.state.get().activeModelId;
    const fileReadCache = this.fileReadCacheService;
    const capabilities = this.host.models.getCapabilities(activeModelId);

    // Derive per-request content limits from the model's context window
    // so the transformer pipeline uses explicit values instead of
    // module-level globals.
    let contentLimits: ContentLimits | undefined;
    try {
      const { contextWindowSize } = await this.host.models.getWithOptions(
        activeModelId,
        '',
      );
      contentLimits = {
        maxReadChars: deriveMaxReadChars(contextWindowSize),
        maxPreviewLines: 30,
      };
    } catch {
      // Model lookup can fail when the provider is misconfigured.
      // Fall through — undefined contentLimits lets transformers use
      // their built-in defaults.
    }

    const skills = await this.toolbox.getSkillsList(this.instanceId);

    return convertAgentMessagesToModelMessages(
      messages,
      systemPrompt,
      (await this.getToolsForStep()) as ToolSet,
      this.instanceId,
      {
        host: this.host.paths,
        blobReader: async (agentId: string, path: string) => {
          // path is always a full mount-prefixed path:
          //   "att/<key>"          — agent data-attachment blob
          //   "w{prefix}/<rel>"    — file inside an open workspace mount
          const protectedContent = await readProtectedMountedFile(
            this.host.protectedFiles,
            this.host.paths,
            agentId,
            path,
          );
          if (protectedContent) return protectedContent;
          // Workspace path — resolve prefix via mount registry.
          const slashIdx = path.indexOf('/');
          if (slashIdx <= 0)
            throw new Error(`Unrecognised attachment path format: "${path}"`);
          const prefix = path.slice(0, slashIdx);
          const relative = path.slice(slashIdx + 1);
          const mountPaths = this.toolbox.getMountedPathsForAgent(agentId);
          const mountRoot = mountPaths.get(prefix);
          if (!mountRoot)
            throw new Error(`Mount "${prefix}" not found for agent ${agentId}`);
          const resolved = nodePath.resolve(nodePath.join(mountRoot, relative));
          const mountRootNormalized = nodePath.resolve(mountRoot);
          if (
            resolved !== mountRootNormalized &&
            !resolved.startsWith(mountRootNormalized + nodePath.sep)
          ) {
            throw new Error('Path traversal outside mount root');
          }
          return fsReadFile(resolved);
        },
        modelCapabilities: capabilities,
        logger: this.host.logger,
        imageCache: this.processedImageCacheService,
        skills,
        fileReadCache,
        mountPaths: this.toolbox.getMountedPathsForAgent(this.instanceId),
        contentLimits,
        renderExtraMention: this.renderExtraMention,
        domainAdapterRegistry: this.domainAdapterRegistry,
        fileReadTransformers: this.host.getFileReadTransformers(),
        reasoningSignatureSource,
        allowedEnvDomainIds,
      },
    );
  }

  /**
   * Transforms/Updates model messages before a step is started.
   *
   * @param modelMessages - The model messages to transform
   *
   * @returns The transformed model messages
   *
   * @note Does nothing by default (returns the model messages as is).
   *
   * @note Can be overriden by the inheriting class to customize the model message transformation.
   *
   * @note For most cases, the transformation of UI messages (`transformMessagesBeforeStep`) is a better place to do context compaction etc.
   *
   * @note If the transformation from UI to model messages should be customized, override `transformMessagesToModelMessages` instead.
   */
  protected transformModelMessagesBeforeStep(
    modelMessages: ModelMessage[],
  ): ModelMessage[] | Promise<ModelMessage[]> {
    return modelMessages;
  }

  /**
   * Retrieves the system prompt for the agent.
   *
   * @returns The system prompt for the agent.
   *
   * @note Can be overridden by the inheriting class to return a different system prompt.
   */
  protected abstract getSystemPrompt(): string | Promise<string>;

  protected getActiveModelId(): AgentState['activeModelId'] {
    return this.state.get().activeModelId;
  }

  protected getCurrentStepModelId(): AgentState['activeModelId'] {
    return this._stepResolvedModelId || this.state.get().activeModelId;
  }

  /**
   * Retrieves the tools that the agent can use.
   *
   * @param messages - The current message history before the next step is started.
   *
   * @returns The tools that the agent can use.
   *
   * @note Can be overridden by the inheriting class to return a different list of tools.
   */
  protected abstract getTools(
    messages: AgentMessage[],
  ): Partial<ToolSet> | Promise<Partial<ToolSet>>;

  /**
   * Allowed to configure the settings that are passed to the model when running a step.
   *
   * @returns A partial config that shallow merges with the default config of the agent.
   */
  protected getModelSettings(
    _messages: AgentMessage[],
  ):
    | Partial<BaseAgentConfig<TFinishToolOutputSchema>>
    | Promise<Partial<BaseAgentConfig<TFinishToolOutputSchema>>> {
    return {};
  }

  /**
   * Configurable handler that is called after a step is finished.
   * @param result - The result of the step
   * @returns Whether to continue the step or to stop the agent. Returns true by default.
   *
   * @note The agent may still not continue with another step if there are still open approval requests, tool calls that need to be finished or the agent only returned text in the last step.
   */
  protected onStepFinished(
    _result: StepResult<ToolSet>,
  ): boolean | Promise<boolean> {
    return true;
  }

  /**
   * Configurable handler that is called when the agent goes into idle (ran step without no new step following).
   */
  protected onIdle(): void | Promise<void> {
    return Promise.resolve();
  }

  /**
   * Fire-and-forget dispatch of a {@link AgentNotificationEvent} to the
   * optional host handler. Never throws — handler rejections are logged
   * at debug level so notification failures can't break a step.
   */
  private emitNotificationEvent(event: AgentNotificationEvent): void {
    void Promise.resolve(
      this.notificationEventHandler?.(event, this.instanceId),
    ).catch((error) => {
      this.host.logger.debug(
        `[BaseAgent:${this.instanceId}] Notification event handler failed: ${
          (error as Error).message
        }`,
      );
    });
  }

  /**
   * =======================================================
   * INTERNAL METHODS (SHOULD ONLY BE USED BY AGENT IMPLEMENTATIONS)
   * =======================================================
   */

  /**
   * Returns a tool that the agent can insert into it's tool list to spawn a child agent.
   *
   * @param description - The description of the tool
   * @param inputSchema - The input schema of the tool
   * @param agentType - The type of the agent to spawn
   * @param configGetter - A function that returns the configuration for the child agent
   * @param mode - The mode in which the child agent should be spawned (synchronous agents will block the parent agent until the child agent is finished, asynchronous agents will not block the parent agent)
   *
   * @returns A tool that the agent can insert into it's tool list to spawn a child agent.
   */
  protected getSpawnChildAgentTool<
    AT extends AgentTypes,
    SpawnToolInputSchema extends z.ZodType,
  >(
    description: string,
    inputSchema: SpawnToolInputSchema,
    agentType: AT,
    configGetter: (
      input: z.infer<SpawnToolInputSchema>,
    ) => AgentInstanceConfigOf<AgentCtor<AT>>,
    mode: 'synchronous' | 'asynchronous' = 'synchronous',
  ): Tool | null {
    if (!this.agentTypeRegistry) {
      throw new Error(
        `[BaseAgent] Cannot create spawn tool for ${agentType}: no agentTypeRegistry was injected. Pass agentTypeRegistry through BaseAgentDependencies when constructing the agent.`,
      );
    }
    const ctor = this.agentTypeRegistry.get(agentType) as
      | { config: { finishToolOutputSchema: z.ZodType | null } }
      | undefined;
    if (!ctor) {
      throw new Error(
        `[BaseAgent] Cannot create spawn tool for ${agentType}: no constructor registered for this agent type.`,
      );
    }
    const finishToolOutputSchema = ctor.config.finishToolOutputSchema;
    if (finishToolOutputSchema === null) {
      return null;
    }

    return {
      description: description,
      inputSchema: inputSchema,
      outputSchema: finishToolOutputSchema,
      // Use any for input/output to avoid "Type instantiation is excessively deep" errors
      execute: async (input: any) => {
        const config = configGetter(input);
        // Use any for Promise type to avoid deep type instantiation
        if (mode === 'asynchronous') {
          this.spawnChildAgentHandler<AT>(
            agentType,
            config,
            (_finishOutput) => {},
            (error) => {
              this.report(error, 'spawnChildAgent');
              this.host.logger.error(
                `[${this.agentType}] Async child agent ${agentType} failed during execution`,
                { error },
              );
            },
          ).catch((error: unknown) => {
            this.report(error as Error, 'spawnChildAgent');
            this.host.logger.error(
              `[${this.agentType}] Failed to spawn async child agent ${agentType}`,
              { error },
            );
          });
          return { message: `Agent ${agentType} spawned asynchronously` };
        }

        const childAgentPromise = new Promise<any>((resolve, reject) => {
          try {
            this.spawnChildAgentHandler<AT>(
              agentType,
              config,
              (finishOutput) => {
                resolve(finishOutput);
              },
              (error) => {
                reject(error);
              },
            );
          } catch (error) {
            reject(error);
          }
        });
        return await childAgentPromise;
      },
    };
  }

  /**
   * =======================================================
   * PRIVATE METHODS (INTERNAL USE ONLY)
   * =======================================================
   */

  /**
   * Execute once there's a good reason to update the title.
   */
  private async updateTitle(expectedStepGeneration?: number): Promise<void> {
    try {
      if (
        expectedStepGeneration !== undefined &&
        this._stepGeneration !== expectedStepGeneration
      ) {
        return;
      }
      // Check if a title update is needed
      if (!this.config.generateTitles) {
        return;
      }

      // Skip if the user has manually set a title
      if (this.state.get().titleLockedByUser) {
        return;
      }

      // We only update whenever the last message is a user message (prevent repeated title updates when the assistant is running in loops)
      const lastMessage =
        this.state.get().history[this.state.get().history.length - 1];
      if (!lastMessage || lastMessage.role !== 'user') {
        return;
      }

      const modulo = Math.max(
        0,
        this.config.updateTitlesEveryNUserMessages ?? 0,
      );
      const userMsgCount = this.state
        .get()
        .history.filter((message) => message.role === 'user').length;
      if (userMsgCount !== 1 && userMsgCount % modulo !== 0) {
        return;
      }

      this.host.logger.debug(
        `[BaseAgent:${this.instanceId}] Updating title for agent.`,
      );

      const newTitle = await this.generateTitle(this.state.get().history);

      if (
        expectedStepGeneration !== undefined &&
        this._stepGeneration !== expectedStepGeneration
      ) {
        return;
      }

      // Re-check: user may have manually set a title while generation was in-flight
      if (this.state.get().titleLockedByUser) {
        return;
      }

      this.host.logger.debug(
        `[BaseAgent:${this.instanceId}] New title generated: ${newTitle}`,
      );
      this.state.commands.setTitle({ title: newTitle });
      // We don't do persistence here, since that happens after a step is finished
    } catch (e) {
      const error = e as Error;
      this.host.logger.error(
        `[BaseAgent:${this.instanceId}] Title update failed silently: ${error.message}`,
      );
      this.report(error, 'updateTitle');
    }
  }

  /**
   * Should be executed after a user or tool approval message was added to the agent
   */
  private async runStep(isApprovalContinuation = false): Promise<void> {
    // Check canRunStep BEFORE setting isWorking to avoid deadlock
    if (!this.canRunStep()) {
      if (this._pendingSyntheticContinuation) {
        this.host.logger.warn(
          `[BaseAgent:${this.instanceId}] Dropping synthetic continuation because the agent cannot run a new step. reason=${this._pendingSyntheticContinuation.reason}`,
        );
        this._pendingSyntheticContinuation = null;
      }
      return;
    }

    // Increment step generation so stale callbacks from previous steps are
    // ignored. Capture it in a local const for the closures below.
    const stepGen = ++this._stepGeneration;
    let resolveStepSettlement!: (
      outcome: 'completed' | 'failed' | 'superseded',
    ) => void;
    const stepSettlement = new Promise<'completed' | 'failed' | 'superseded'>(
      (resolve) => {
        resolveStepSettlement = resolve;
      },
    );
    const activeStepRun = {
      generation: stepGen,
      settled: stepSettlement,
      resolve: resolveStepSettlement,
    };
    this._activeStepRun = activeStepRun;

    let outcome: 'completed' | 'failed' | 'superseded' = 'failed';
    try {
      outcome = await this.runAdmittedStep(isApprovalContinuation, stepGen);
    } catch (rawError) {
      if (this._stepGeneration !== stepGen) {
        outcome = 'superseded';
      } else {
        const error =
          rawError instanceof Error
            ? rawError
            : new Error(
                typeof rawError === 'string'
                  ? rawError
                  : 'Unexpected agent step failure',
              );
        this.host.logger.error(
          `[BaseAgent:${this.instanceId}] Unexpected runStep failure: ${this.formatError(error)}`,
        );
        this.report(error, 'runStepUnexpected');
        this._stepGeneration++;
        this._pendingContinue = null;
        this._pendingSyntheticContinuation = null;
        this._pendingToolCapabilityScopeId = null;
        try {
          this.stepAbortController?.abort();
        } catch {}
        this.stepAbortController = null;
        this.state.commands.recordStepError({
          error: {
            message: `Internal error: ${error.message}`,
            stack: error.stack,
          },
          markUnread: 'mark-unread',
        });
        this.emitNotificationEvent('error');
        outcome = 'failed';
      }
    } finally {
      if (this._activeStepRun === activeStepRun) {
        this._activeStepRun = null;
      }
      activeStepRun.resolve(outcome);
    }
  }

  /**
   * Settles the continuation decision after the current step has fully drained.
   *
   * `handlePostStep()` decides whether to continue before the UI stream,
   * path-reference work, and final persistence have completed. A user message
   * can be queued during that tail after the earlier decision was `false`.
   * Re-read the queue here so that late follow-up is not stranded when the
   * current step transitions to idle.
   */
  private settleStepContinuation(
    stepGen: number,
    stepHasApprovalRequest: boolean,
  ): boolean {
    if (this._stepGeneration !== stepGen) return false;

    const pending = this._pendingContinue;
    this._pendingContinue = null;
    const hasLateQueuedFollowUp =
      pending === false && this.state.get().queuedMessages.length > 0;
    const shouldScheduleContinuation =
      (pending === true || hasLateQueuedFollowUp) && !stepHasApprovalRequest;

    if (shouldScheduleContinuation) {
      // setTimeout to keep the call stack clean (unbounded recursion).
      setTimeout(() => {
        if (this._stepGeneration === stepGen) void this.runStep();
      }, 0);
    } else if (pending !== null) {
      // An approval request deliberately remains an explicit pause. The
      // queued follow-up stays visible until the user answers the approval or
      // chooses the queue's "Send now" interrupt action.
      // Mark unread only if history contains at least one assistant
      // message (covers fresh-session edge case).
      const hasAssistantMessage = this.state
        .get()
        .history.some((m) => m.role === 'assistant');
      this.state.commands.recordStepError({
        error: undefined,
        markUnread: 'if-assistant-history',
      });
      this.onIdle();
      // Only notify "done" for a genuine turn completion: there must
      // be an assistant message and the agent must not be paused on an
      // open approval request (that's a `question`, emitted elsewhere).
      if (hasAssistantMessage && !stepHasApprovalRequest) {
        this.emitNotificationEvent('done');
      }
    }

    return true;
  }

  /**
   * Wake a queued user follow-up after the step that caused it to queue has
   * fully settled. The step tail also re-checks the queue, but this wake closes
   * the inverse race where enqueue happens just after that final re-check.
   */
  private scheduleQueuedMessageWake(
    originatingStep: {
      readonly settled: Promise<'completed' | 'failed' | 'superseded'>;
    } | null,
  ): void {
    const wake = () => {
      if (this.state.get().queuedMessages.length > 0) void this.runStep();
    };

    if (!originatingStep) {
      setTimeout(wake, 0);
      return;
    }

    void originatingStep.settled.then((outcome) => {
      // A priority lifecycle action (notably Stop) owns a superseded step.
      // It must not be undone by an older queued-message wake.
      if (outcome !== 'superseded') wake();
    });
  }

  private async runAdmittedStep(
    isApprovalContinuation: boolean,
    stepGen: number,
  ): Promise<'completed' | 'failed' | 'superseded'> {
    this._stepStartTime = Date.now();
    // Reset continuation flag at the start of every step so a leftover
    // value from a prior aborted step cannot leak into the tail.
    this._pendingContinue = null;

    // Tracks whether the just-finished step ended on an open tool-approval
    // request. Used by the idle tail to suppress the `done` notification
    // when the agent is actually paused awaiting the user's decision.
    let stepHasApprovalRequest = false;

    // Holds the `onFinish` step result for use in the tail AFTER the UI
    // stream has drained. Reasoning-details capture must run at a point
    // where the assistant message is guaranteed to exist in
    // `state.history` — see `populateReasoningDetailsOnAssistantMessage`.
    let finishedResult: StepResult<ToolSet> | null = null;
    let stepCallbackFailed = false;

    // Skip flush on approval continuations — the approval step must
    // complete in isolation first. Queued messages will be picked up
    // by the follow-up runStep() triggered via shouldRunNewStep().
    const { queueFlushIndex: flushedIndex } = this.state.commands.beginStep({
      flushQueue: !isApprovalContinuation,
    });
    if (flushedIndex !== undefined) {
      this.scheduleMemorySnapshotWrite('queued-messages');
    }
    const queueFlushIndex = flushedIndex ?? -1;
    const toolCapabilityScopes = resolveAgentToolCapabilityScopes({
      agentInstanceId: this.instanceId,
      stepGeneration: stepGen,
      historyMessageIds: this.state.get().history.map((message) => message.id),
      isApprovalContinuation,
      pendingApprovalScopeId: this._pendingToolCapabilityScopeId,
    });
    // Publish before streaming begins so an approval clicked immediately after
    // rendering can still resume in the exact originating host scope.
    this._pendingToolCapabilityScopeId = toolCapabilityScopes.currentScopeId;

    // Snapshot the user-selected model id for THIS step. `updateActiveModelId` accepts
    // writes even while a step is running, so any later read of
    // `state.activeModelId` from async callbacks (telemetry, onError) could
    // attribute the outcome to a model the user switched to mid-flight.
    const requestedModelId = this.state.get().activeModelId;
    const stepTaskRole = this.getModelTaskRoleForNextStep();
    let stepModelId = requestedModelId;
    try {
      const routedModelId = await this.host.models.selectModelForTask?.({
        currentModelId: requestedModelId,
        taskRole: stepTaskRole,
        agentType: this.agentType,
        traceId: this.instanceId,
      });
      if (routedModelId) stepModelId = routedModelId;
    } catch (error) {
      this.host.logger.warn(
        `[BaseAgent:${this.instanceId}] Model task routing failed for role "${stepTaskRole}", falling back to "${requestedModelId}": ${this.formatError(
          error as Error,
        )}`,
      );
    }
    if (this._stepGeneration !== stepGen) return 'superseded';
    this._stepRequestedModelId = requestedModelId;
    this._stepResolvedModelId = stepModelId;
    this._stepTaskRole = stepTaskRole;

    // Get the current model — wrapped in try-catch so a deleted custom model
    // or endpoint doesn't wedge the agent with isWorking=true and no error.
    let modelWithOptions: ModelWithOptions;
    try {
      modelWithOptions = await this.host.models.getWithOptions(
        stepModelId,
        this.instanceId,
        {
          $ai_span_name: `${this.agentType}-history`,
          $ai_parent_id: this.instanceId,
          [MODEL_REQUEST_PURPOSE_METADATA_KEY]: 'agent-step',
          [MODEL_TASK_ROLE_METADATA_KEY]: stepTaskRole,
          task_role: stepTaskRole,
          requested_model_id: requestedModelId,
          routed_model_id: stepModelId,
        },
      );
      this._stepProviderMode = modelWithOptions.providerMode;
      this._stepCodingPlanId = modelWithOptions.connectedCodingPlanId;
    } catch (error) {
      if (this._stepGeneration !== stepGen) return 'superseded';
      const err = error as Error;
      this.host.logger.error(
        `[BaseAgent:${this.instanceId}] Failed to resolve model "${stepModelId}" for role "${stepTaskRole}" (selected "${requestedModelId}"): ${err.message}`,
      );
      this._pendingSyntheticContinuation = null;
      this.report(err, 'resolveModel');
      this.state.commands.recordStepError({
        error: {
          message: `Model error: ${err.message}`,
          stack: err.stack,
        },
        markUnread: 'always',
      });
      this.emitNotificationEvent('error');
      return 'failed';
    }
    if (this._stepGeneration !== stepGen) return 'superseded';

    let modelMessages: Awaited<
      ReturnType<typeof this.generateContextForNewStep>
    >;
    let tools: Awaited<ReturnType<typeof this.getToolsForStep>>;
    let resolvedConfig: BaseAgentConfig<TFinishToolOutputSchema>;
    try {
      modelMessages = await this.generateContextForNewStep(
        queueFlushIndex >= 0 ? queueFlushIndex : undefined,
        modelWithOptions.reasoningSignatureSource,
        stepGen,
      );
      if (this._stepGeneration !== stepGen) return 'superseded';
      tools = await this.getToolsForStep();
      if (this._stepGeneration !== stepGen) return 'superseded';
      this._toolCallDurations.clear();
      tools = this.wrapToolsWithTiming(tools);
      tools = this.wrapToolsWithOutputBudget(tools);
      if (modelWithOptions.stripStrictFromTools) {
        tools = this.stripStrictFromTools(tools);
      }
      resolvedConfig = {
        ...this.config,
        ...(await this.getModelSettings(this.messages)),
      };
    } catch (e) {
      if (this._stepGeneration !== stepGen) return 'superseded';
      const error = e as Error;
      this.host.logger.error(
        `[BaseAgent:${this.instanceId}] Failed to prepare step context: ${this.formatError(error)}`,
      );
      this._pendingSyntheticContinuation = null;
      this.report(error, 'prepareStepContext');
      this.state.commands.recordStepError({
        error: {
          message: `Internal error: ${error.message}`,
          stack: error.stack,
        },
        markUnread: 'always',
      });
      this.emitNotificationEvent('error');
      return 'failed';
    }
    if (this._stepGeneration !== stepGen) return 'superseded';

    if (isApprovalContinuation)
      modelMessages = this.ensureToolApprovalResponseIsLast(modelMessages);

    // Debug: analyse cache stability of the final model messages before the LLM call.
    this._cacheAnalyzer.trackStep(modelMessages);

    this.host.logger.debug(`[BaseAgent:${this.instanceId}] Running step`);

    this.stepAbortController = new AbortController();

    let stream: Awaited<ReturnType<AgentStepExecutor['execute']>>;
    try {
      stream = await this.stepExecutor.execute({
        context: {
          agentInstanceId: this.instanceId,
          agentType: this.agentType,
          traceId: this.instanceId,
          requestedModelId,
          resolvedModelId: stepModelId,
          isApprovalContinuation,
          executionTarget: this.getExecutionTargetForCurrentTurn(),
          snapshotSelection: resolveAgentTaskSnapshotSelectionFromMessages(
            this.state.get().history,
          ),
          metadata: {
            $ai_span_name: `${this.agentType}-history`,
            $ai_parent_id: this.instanceId,
            [MODEL_REQUEST_PURPOSE_METADATA_KEY]: 'agent-step',
            [MODEL_TASK_ROLE_METADATA_KEY]: stepTaskRole,
            task_role: stepTaskRole,
            requested_model_id: requestedModelId,
            routed_model_id: stepModelId,
            session_checkpoint: resolveAgentSessionCheckpointFromMessages(
              this.state.get().history,
            ),
          },
        },
        options: {
          model: modelWithOptions.model,
          providerOptions: modelWithOptions.providerOptions,
          headers: modelWithOptions.headers,
          messages: modelMessages,
          tools: tools as ToolSet,
          timeout: resolvedConfig.maxTime
            ? {
                totalMs: resolvedConfig.maxTime,
              }
            : undefined,
          maxRetries: resolvedConfig.maxRetries ?? 1,
          maxOutputTokens: resolvedConfig.maxOutputTokens,
          abortSignal: this.stepAbortController.signal,
          experimental_context: {
            [TOOL_CAPABILITY_CURRENT_SCOPE_CONTEXT_KEY]:
              toolCapabilityScopes.currentScopeId,
            [TOOL_CAPABILITY_APPROVAL_ORIGIN_SCOPE_CONTEXT_KEY]:
              toolCapabilityScopes.approvalOriginScopeId,
          },
          onAbort: () => {
            // Guard: ignore if a newer step has started (e.g. queue flush)
            if (this._stepGeneration !== stepGen) return;
            stepCallbackFailed = true;
            if (
              this._pendingToolCapabilityScopeId ===
              toolCapabilityScopes.currentScopeId
            ) {
              this._pendingToolCapabilityScopeId = null;
            }
            this.state.commands.setIsWorkingFalse();
          },
          onFinish: async (result) => {
            // Guard: ignore if a newer step has started (e.g. queue flush)
            if (this._stepGeneration !== stepGen) return;

            stepHasApprovalRequest = result.content.some(
              (part) => part.type === 'tool-approval-request',
            );
            if (
              !stepHasApprovalRequest &&
              this._pendingToolCapabilityScopeId ===
                toolCapabilityScopes.currentScopeId
            ) {
              this._pendingToolCapabilityScopeId = null;
            }
            finishedResult = result;

            // Log step completion details
            this.host.logger.debug(
              `[BaseAgent:${this.instanceId}] Step finished | finishReason=${result.finishReason} | outputTokens=${result.usage.outputTokens} | inputTokens=${result.usage.inputTokens} | cacheRead=${result.usage.inputTokenDetails.cacheReadTokens} | cacheWrite=${result.usage.inputTokenDetails.cacheWriteTokens} | totalTokens=${result.usage.totalTokens} | toolCalls=${result.toolCalls.length}`,
            );

            if (result.finishReason === 'length') {
              this.host.logger.warn(
                `[BaseAgent:${this.instanceId}] Output truncated (finishReason=length). ` +
                  `outputTokens=${result.usage.outputTokens}, toolCalls=${result.toolCalls.length}. ` +
                  `The model hit maxOutputTokens and its response was cut off. ` +
                  `Tool calls in this step may have been incomplete/dropped.`,
              );
            }

            try {
              const shouldContinue = await this.handlePostStep(result, stepGen);
              // Re-check after async work — internalStop may have been called
              if (shouldContinue === null || this._stepGeneration !== stepGen) {
                return;
              }
              this.stepAbortController = null;

              // Defer both scheduling the next step and flipping to idle
              // until `runStep`'s tail — AFTER populatePathReferences +
              // saveState — so the next step (or any user-initiated
              // follow-up) cannot read a half-populated history.
              // See `_pendingContinue` for the full rationale.
              this._pendingContinue = shouldContinue;
            } catch (err) {
              stepCallbackFailed = true;
              const error = err as Error;
              this.host.logger.error(
                `[BaseAgent:${this.instanceId}] Error in onFinish: ${this.formatError(error)}`,
              );
              this.report(error, 'onFinish');
              // Guard: only reset if this step is still current
              if (this._stepGeneration === stepGen) {
                this.stepAbortController = null;
                this.state.commands.recordStepError({
                  error: {
                    message: `Internal error: ${error.message ?? 'Unknown error'}`,
                    stack: error.stack,
                  },
                  markUnread: 'mark-unread',
                });
                this.emitNotificationEvent('error');
              }
            }
          },
          onError: (ev) => {
            // Guard: ignore if a newer step has started (e.g. queue flush)
            if (this._stepGeneration !== stepGen) return;
            stepCallbackFailed = true;
            if (
              this._pendingToolCapabilityScopeId ===
              toolCapabilityScopes.currentScopeId
            ) {
              this._pendingToolCapabilityScopeId = null;
            }
            // ev.error may not be a real Error instance (e.g. network abort
            // events, plain objects from the AI SDK). Normalize so every
            // downstream consumer (logger, PostHog, UI state) gets a proper Error.
            const raw = ev.error;
            const error =
              raw instanceof Error
                ? raw
                : new Error(
                    typeof raw === 'string'
                      ? raw
                      : (raw as Record<string, unknown>)?.message
                        ? String((raw as Record<string, unknown>).message)
                        : 'Unknown error',
                  );
            this.host.logger.error(
              `[BaseAgent:${this.instanceId}] Error in 'streamText': ${this.formatError(error)}`,
            );
            this.report(error, 'streamText');

            const parsedPlanLimit = this.parsePlanLimitError(error);
            if (parsedPlanLimit?.kind === 'plan-limit-exceeded') {
              const sortedWindows = [...parsedPlanLimit.exceededWindows].sort(
                (a, b) =>
                  new Date(a.resetsAt).getTime() -
                  new Date(b.resetsAt).getTime(),
              );
              this.host.telemetry?.capture('usage-limit-reached', {
                agent_type: this.agentType,
                model_id: stepModelId,
                provider_mode: this._stepProviderMode,
                plan: parsedPlanLimit.plan ?? 'unknown',
                window_types: sortedWindows.map((w) => w.type),
                first_window_resets_at: sortedWindows[0]?.resetsAt ?? '',
                exceeded_window_count: sortedWindows.length,
              });
            }
            const parsedModelRestricted = this.parseModelRestrictedError(error);
            if (parsedModelRestricted?.kind === 'model-restricted') {
              this.host.telemetry?.capture('model-restricted', {
                agent_type: this.agentType,
                model_id: stepModelId,
                provider_mode: this._stepProviderMode,
                plan: parsedModelRestricted.plan ?? 'unknown',
              });
            }
            const parsedProviderError = this.parseProviderError(error);
            const parsedOverloadBase =
              parsedPlanLimit ||
              parsedModelRestricted ||
              this.isZaiBillingOrQuotaError(
                parsedProviderError,
                modelWithOptions.reasoningSignatureSource,
              )
                ? null
                : this.parseUpstreamOverloadError(error);
            const parsedOverload: Extract<
              AgentRuntimeError,
              { kind: 'upstream-overload' }
            > | null =
              parsedOverloadBase?.kind === 'upstream-overload'
                ? {
                    ...parsedOverloadBase,
                    modelId: stepModelId,
                  }
                : null;
            if (parsedOverload?.kind === 'upstream-overload') {
              this.host.telemetry?.capture('upstream-overload', {
                agent_type: this.agentType,
                model_id: stepModelId,
                provider_mode: this._stepProviderMode,
                provider_name: parsedOverload.providerName,
                status_code: parsedOverload.statusCode,
              });
            }
            this.state.commands.recordStepError({
              error: parsedPlanLimit ??
                parsedModelRestricted ??
                parsedOverload ?? {
                  message: `LLM provider error: ${parsedProviderError?.message ?? error.message}`,
                  stack: error.stack,
                },
              markUnread: 'mark-unread',
            });
            // Plan-limit and model-restricted errors surface their own dedicated
            // UI affordance, so we suppress the generic error notification in
            // those cases (matches the browser host's pre-extraction behavior).
            if (!parsedPlanLimit && !parsedModelRestricted) {
              this.emitNotificationEvent('error');
            }
            this.host.logger.debug(
              `[BaseAgent:${this.instanceId}] Wrote error to public state`,
            );
            // Drop any deferred continuation decision from a previous
            // successful step so the error cannot be followed by a stale
            // next-step scheduling in runStep's tail.
            this._pendingContinue = null;
            try {
              this.stepAbortController?.abort();
            } catch {}
            this.stepAbortController = null;
          },
          experimental_repairToolCall: repairToolCall,
          experimental_transform: smoothStream({
            delayInMs: 10,
            chunking: 'word',
          }),
          temperature: resolvedConfig.temperature,
          stopWhen: () => true, // We always stop immediately and handle the execution of the next step manually
          topP: resolvedConfig.topP,
          topK: resolvedConfig.topK,
          presencePenalty: resolvedConfig.presencePenalty,
          frequencyPenalty: resolvedConfig.frequencyPenalty,
          stopSequences: resolvedConfig.stopSequences,
          seed: resolvedConfig.seed,
        },
      });
    } catch (rawError) {
      if (this._stepGeneration !== stepGen) return 'superseded';
      if (
        this._pendingToolCapabilityScopeId ===
        toolCapabilityScopes.currentScopeId
      ) {
        this._pendingToolCapabilityScopeId = null;
      }
      const error =
        rawError instanceof Error
          ? rawError
          : new Error(
              typeof rawError === 'string'
                ? rawError
                : 'Agent step executor failed before returning a stream',
            );
      this.host.logger.error(
        `[BaseAgent:${this.instanceId}] Step executor failed: ${this.formatError(error)}`,
      );
      this.report(error, 'executeStep');
      this._stepGeneration++;
      this._pendingContinue = null;
      this._pendingSyntheticContinuation = null;
      try {
        this.stepAbortController?.abort();
      } catch {}
      this.stepAbortController = null;
      this.state.commands.recordStepError({
        error: {
          message: `Internal error: ${error.message}`,
          stack: error.stack,
        },
        markUnread: 'mark-unread',
      });
      this.emitNotificationEvent('error');
      return 'failed';
    }
    if (this._stepGeneration !== stepGen) return 'superseded';

    // Trigger an title update asynchronously once the user started sending a message
    void this.updateTitle(stepGen);

    try {
      const lastAssistantMessage = [...this.state.get().history]
        .reverse()
        .find((m) => m.role === 'assistant');

      // When resuming after a tool-approval response, pass originalMessages
      // so toUIMessageStream correlates the new stream's tool-result parts
      // with the existing assistant message (avoids duplicate tool parts).
      // On normal steps, omit it to prevent the SDK from appending parts
      // from prior turns into the new message.
      // Important: this decision is driven by the explicit `isApprovalContinuation`
      // flag from the call site — NOT by scanning history for part states.
      // Auto-denied approvals (e.g. from sendUserMessage) set parts to
      // output-denied but must use the normal (non-bridging) stream path.
      const uiStream = stream.toUIMessageStream<AgentMessage>({
        generateMessageId: randomUUID,
        originalMessages: isApprovalContinuation
          ? this.state.get().history
          : undefined,
      });

      // Both branches must drain concurrently: toUIMessageStream() and
      // consumeStream() read from the same teed stream and share
      // back-pressure — awaiting them sequentially would deadlock.
      await Promise.all([
        this.handleUiStream(
          uiStream,
          isApprovalContinuation ? lastAssistantMessage : undefined,
          stepGen,
        ),
        stream.consumeStream(),
      ]);

      if (this._stepGeneration !== stepGen) return 'superseded';

      // ─── Populate pathReferences on the assistant message ───────────
      // MUST run AFTER Promise.all resolves so the UI stream has fully
      // drained and every tool part has reached its terminal state
      // (output-available / output-error / output-denied). Running this
      // earlier (e.g. inside onFinish/handlePostStep) hits a race where
      // tool parts are still in "input-streaming", causing
      // extractReadFilePathsFromAssistantMessage() to return no paths
      // and silently skipping the file-content injection on the next
      // step — which makes the LLM receive an orphaned tool-result and
      // return an empty "stop" response.
      await this.populatePathReferencesOnAssistantMessage(stepGen);
      if (this._stepGeneration !== stepGen) return 'superseded';

      // ─── Capture signed reasoning_details onto the assistant message ──
      // MUST run here (after the UI stream drained) and only when the host
      // route carries a `reasoningSignatureSource`. Guarded by stepGen so a
      // superseded step never tags a stale message.
      if (
        finishedResult &&
        this._stepGeneration === stepGen &&
        modelWithOptions.reasoningSignatureSource
      ) {
        try {
          this.populateReasoningDetailsOnAssistantMessage(
            finishedResult,
            modelWithOptions.reasoningSignatureSource,
          );
        } catch (err) {
          this.host.logger.debug(
            `[BaseAgent:${this.instanceId}] Failed to populate reasoningDetails: ${this.formatError(
              err as Error,
            )}`,
          );
        }
      }

      // Re-persist so the DB row carries the just-populated references.
      // The initial saveState() in handlePostStep ran before the refs
      // were known, so this second save is required for crash safety.
      await this.saveState();
      if (this._stepGeneration !== stepGen) return 'superseded';
      this.scheduleMemorySnapshotWrite('post-step');
      const latestAssistantMessage = [...this.state.get().history]
        .reverse()
        .find((message) => message.role === 'assistant');
      if (latestAssistantMessage) {
        this.recordEvidenceEvent(
          'assistant_message',
          {
            role: 'assistant',
            text: getMessageText(latestAssistantMessage),
            partTypes: latestAssistantMessage.parts.map((part) => part.type),
            toolStates: latestAssistantMessage.parts
              .filter((part) => part.type.startsWith('tool-'))
              .map((part) => ({
                type: part.type,
                state:
                  'state' in part && typeof part.state === 'string'
                    ? part.state
                    : null,
              })),
          },
          {
            id: `assistant:${this.instanceId}:${latestAssistantMessage.id}`,
            messageId: latestAssistantMessage.id,
            source: 'agent_message',
            sourceId: latestAssistantMessage.id,
          },
        );
      }

      // ─── Tail: consume the deferred continuation decision ──────────
      // `onFinish` set `_pendingContinue` before returning; now that
      // populate + saveState have settled we can either schedule the
      // next step or transition to idle. Guard against a stepGen
      // mismatch in case `internalStop` bumped the generation while we
      // were awaiting fs I/O above.
      if (!this.settleStepContinuation(stepGen, stepHasApprovalRequest)) {
        // Superseded — a newer generation owns the shared continuation slot.
        return 'superseded';
      }
      // pending === null → onFinish never set a decision (error path,
      // aborted, or superseded step). Nothing to do; the onError /
      // onAbort / catch handlers own state cleanup.
      return stepCallbackFailed || finishedResult === null
        ? 'failed'
        : 'completed';
    } catch (err) {
      if (this._stepGeneration !== stepGen) {
        return 'superseded';
      }
      if (
        this._pendingToolCapabilityScopeId ===
        toolCapabilityScopes.currentScopeId
      ) {
        this._pendingToolCapabilityScopeId = null;
      }
      const raw = err;
      const error =
        raw instanceof Error
          ? raw
          : new Error(
              typeof raw === 'string'
                ? raw
                : (raw as Record<string, unknown>)?.message
                  ? String((raw as Record<string, unknown>).message)
                  : 'Unknown error',
            );
      this.host.logger.error(
        `[BaseAgent:${this.instanceId}] Error in 'runStep': ${this.formatError(error)}`,
      );
      this.report(error, 'runStep');
      // Invalidate step generation so any pending onFinish callback won't
      // start a new step after this error.
      this._stepGeneration++;
      // Drop any deferred continuation decision — we must not schedule
      // the next step or fire onIdle after an error here.
      this._pendingContinue = null;
      this._pendingSyntheticContinuation = null;
      try {
        this.stepAbortController?.abort();
      } catch {}
      this.stepAbortController = null;
      this.state.commands.recordStepError({
        error: {
          message: `Internal error: ${error.message}`,
          stack: error.stack,
        },
        markUnread: 'mark-unread',
      });
      this.emitNotificationEvent('error');
      return 'failed';
    }
  }

  /**
   * Fraction of the model's context window that kept (uncompressed)
   * messages may occupy after compression. Kept intentionally low so
   * the agent restarts with ample headroom.
   */
  private static readonly KEPT_BUDGET_FRACTION = 0.2;

  /**
   * Absolute maximum (in tokens) for the compression trigger threshold.
   * Used via `Math.min(fraction * contextWindowSize, HARD_CAP)` so
   * large-context models (e.g. 1M) compress at the same absolute token
   * count as the 200k-model sweet spot. Calibrated to `0.5 × 200_000`
   * matching the chat agent's `historyCompressionThreshold = 0.5`.
   */
  private static readonly HISTORY_COMPRESSION_HARD_CAP_TOKENS = 100_000;

  /**
   * Absolute maximum (in tokens) for the kept-uncompressed budget after
   * compression. Calibrated to `0.2 × 200_000` so the "recent messages"
   * budget after compression stays bounded regardless of model context
   * size. Keeps the invariant: kept budget < compression trigger.
   */
  private static readonly KEPT_BUDGET_HARD_CAP_TOKENS = 40_000;

  private async compressHistoryInternal(
    expectedStepGeneration?: number,
  ): Promise<void> {
    // Prevent concurrent compression runs — a second trigger while
    // compression is in-flight would see stale history and produce
    // a redundant (or conflicting) summary.
    if (this._isCompressingHistory) {
      this.host.logger.debug(
        `[BaseAgent:${this.instanceId}] Skipping history compression — already in progress.`,
      );
      return;
    }
    this._isCompressingHistory = true;
    try {
      const state = this.state.get();
      const { history } = state;

      // ── Compute token budget for kept messages ────────────────────
      let contextWindowSize: number;
      try {
        contextWindowSize = (
          await this.host.models.getWithOptions(state.activeModelId, '')
        ).contextWindowSize;
      } catch {
        // Model may have been deleted — fall back to a conservative size
        contextWindowSize = 100_000;
      }
      if (
        expectedStepGeneration !== undefined &&
        this._stepGeneration !== expectedStepGeneration
      ) {
        return;
      }
      const keptBudget = Math.min(
        Math.floor(contextWindowSize * BaseAgent.KEPT_BUDGET_FRACTION),
        BaseAgent.KEPT_BUDGET_HARD_CAP_TOKENS,
      );
      const preferredFloor = Math.max(
        5,
        this.config.minUncompressedMessages ?? 10,
      );

      // ── Adaptive boundary: walk backward, respect token budget ────
      let boundaryIndex = history.length; // start past the end
      let accumulatedTokens = 0;

      for (let i = history.length - 1; i >= 0; i--) {
        const histEntry = history[i];
        if (!histEntry) continue;
        const msgTokens = estimateMessageTokens(histEntry);

        if (accumulatedTokens + msgTokens > keptBudget) {
          // This message would bust the budget — stop here
          boundaryIndex = i + 1;
          break;
        }

        accumulatedTokens += msgTokens;
        const keptCount = history.length - i;

        if (keptCount >= preferredFloor) {
          // Reached preferred floor and still within budget
          boundaryIndex = i;
          break;
        }

        // Scanned everything, it all fits — nothing to compress
        if (i === 0) return;
      }

      // Edge case: even the last message alone exceeds the budget
      if (boundaryIndex >= history.length) {
        boundaryIndex = history.length - 1;
        this.host.logger.warn(
          `[BaseAgent:${this.instanceId}] Single message exceeds kept-token budget (${keptBudget} tokens). Keeping 1 message.`,
        );
      }

      if (boundaryIndex < 1) return; // nothing meaningful to compress

      const actualKept = history.length - boundaryIndex;
      if (actualKept < preferredFloor) {
        this.host.logger.debug(
          `[BaseAgent:${this.instanceId}] Adaptive compression: keeping ${actualKept} messages (preferred ${preferredFloor}) to stay within token budget.`,
        );
      }

      const boundaryMessageId = history[boundaryIndex]?.id;
      if (!boundaryMessageId) return;

      // If the boundary message already has compressed history, the
      // previous summary is included in messagesToCompact and will be
      // folded into the new summary by the LLM.
      const messagesToCompact = history.slice(0, boundaryIndex);

      this.host.logger.debug(
        `[BaseAgent:${this.instanceId}] Compressing history (${messagesToCompact.length} messages, keeping ${actualKept})...`,
      );

      const compressedHistory = await this.compressHistory(messagesToCompact);
      if (
        expectedStepGeneration !== undefined &&
        this._stepGeneration !== expectedStepGeneration
      ) {
        return;
      }

      // Re-fetch by id inside the command — user could've undone/
      // manipulated messages while we were busy compressing.
      const writeResult = this.state.commands.storeCompressedHistory({
        boundaryMessageId,
        compressedHistory,
      });
      if (writeResult === 'missing') {
        this.host.logger.warn(
          `[BaseAgent:${this.instanceId}] Boundary message not found in history after compression. The user may have undone or manipulated messages.`,
        );
      } else {
        this.host.logger.debug(
          `[BaseAgent:${this.instanceId}] Stored compressed history in message ${boundaryMessageId}`,
        );
      }

      const boundarySeq = this.state
        .get()
        .history.findIndex((m) => m.id === boundaryMessageId);
      await this.saveState(boundarySeq >= 0 ? [boundarySeq] : undefined);
      if (
        expectedStepGeneration !== undefined &&
        this._stepGeneration !== expectedStepGeneration
      ) {
        return;
      }
      this.scheduleMemorySnapshotWrite('compression');
      this.recordEvidenceEvent(
        'compression_completed',
        {
          boundaryMessageId,
          compactedMessageCount: messagesToCompact.length,
          keptMessageCount: actualKept,
          compressedCharacters: compressedHistory.length,
        },
        {
          messageId: boundaryMessageId,
          source: 'history_compression',
          sourceId: boundaryMessageId,
          ingestionKey: `compression:${boundaryMessageId}`,
        },
      );
    } catch (e) {
      // Fail silently — compression is best-effort. The agent continues
      // without compression until the context window is exhausted, at which
      // point the normal model error handling will show an error in the chat.
      const error = e as Error;
      this.host.logger.error(
        `[BaseAgent:${this.instanceId}] History compression failed silently: ${error.message}`,
      );
      this.report(error, 'compressHistory');
    } finally {
      this._isCompressingHistory = false;
    }
  }

  private getMemoryWriter(): AgentMemoryWriter {
    this._memoryWriter ??= new AgentMemoryWriter({
      host: this.host,
      agentInstanceId: this.instanceId,
    });
    return this._memoryWriter;
  }

  private recordEvidenceEvent(
    type: EvidenceMemoryEventType,
    payload: EvidenceMemoryJson,
    options: {
      id?: string;
      messageId?: string;
      source?: string;
      sourceId?: string;
      ingestionKey?: string;
      timestamp?: number;
      contentHash?: string;
    } = {},
  ): void {
    const service = this.host.evidenceMemory;
    if (!service || !this.config.persistent) return;
    void service
      .record({
        id: options.id,
        taskId: this.instanceId,
        type,
        timestamp: options.timestamp,
        messageId: options.messageId ?? null,
        source: options.source ?? null,
        sourceId: options.sourceId ?? null,
        ingestionKey: options.ingestionKey ?? null,
        contentHash: options.contentHash ?? null,
        payload,
      })
      .catch((error) => {
        this.host.logger.warn(
          `[BaseAgent:${this.instanceId}] Evidence memory event write failed`,
          {
            type,
            error: error instanceof Error ? error : new Error(String(error)),
          },
        );
      });
  }

  private async injectEvidenceContextIfEnabled(
    modelMessages: ModelMessage[],
  ): Promise<ModelMessage[]> {
    const service = this.host.evidenceMemory;
    if (!service || !this.config.persistent || modelMessages.length === 0) {
      return modelMessages;
    }
    const baselineStartedAt = performance.now();
    const compressedHistory = findLatestCompressedHistory(
      this.state.get().history,
    );
    const compressedHistoryLatencyMs = Math.max(
      0,
      performance.now() - baselineStartedAt,
    );
    const promptInjectionEnabled = service.isPromptInjectionEnabledForTask(
      this.instanceId,
    );
    if (!promptInjectionEnabled && compressedHistory === null) {
      return modelMessages;
    }
    const query = [...this.state.get().history]
      .reverse()
      .filter(
        (message) => message.role === 'user' || message.role === 'assistant',
      )
      .slice(0, 3)
      .reverse()
      .map(getMessageText)
      .filter(Boolean)
      .join('\n')
      .slice(0, 16_384);
    if (!query) return modelMessages;
    try {
      const guardedStartedAt = performance.now();
      const evidenceTokenBudget =
        resolveEvidenceMemoryIncrementalTokenBudget(compressedHistory);
      const repositoryRevision =
        this.toolbox.getEvidenceMemoryRepositoryRevision === undefined
          ? await service.getLatestRepositoryRevision(this.instanceId)
          : await this.toolbox.getEvidenceMemoryRepositoryRevision(
              this.instanceId,
            );
      const pack = await service.buildContextPack({
        taskId: this.instanceId,
        query,
        repositoryRevision,
        codeEvidenceProvider:
          await this.toolbox.getEvidenceMemoryCodeEvidenceProvider?.(
            this.instanceId,
            repositoryRevision,
          ),
        tokenBudget: evidenceTokenBudget,
        maxClaims: DEFAULT_EVIDENCE_MEMORY_INJECTION_MAX_CLAIMS,
      });
      const admissionInput = {
        pack,
        repositoryRevision,
        tokenBudget: evidenceTokenBudget,
        maxClaims: DEFAULT_EVIDENCE_MEMORY_INJECTION_MAX_CLAIMS,
        baselineContext: compressedHistory ?? undefined,
      };
      const admission = promptInjectionEnabled
        ? await service.admitContextPack(admissionInput)
        : await service.evaluateContextPackForDogfood(admissionInput);
      const guardedMemoryLatencyMs = Math.max(
        0,
        performance.now() - guardedStartedAt,
      );
      if (
        repositoryRevision !== null &&
        compressedHistory !== null &&
        (pack.items.length > 0 || pack.excludedStaleClaimIds.length > 0)
      ) {
        try {
          await service.recordLiveDogfoodComparison({
            pack,
            admission,
            compressedHistory,
            compressedHistoryLatencyMs,
            guardedMemoryLatencyMs,
          });
        } catch (error) {
          this.host.logger.warn(
            `[BaseAgent:${this.instanceId}] Evidence Memory dogfood observation failed`,
            {
              error: error instanceof Error ? error : new Error(String(error)),
            },
          );
        }
      }
      if (!promptInjectionEnabled) return modelMessages;
      const decisionPayload = {
        packId: pack.id,
        queryHash: pack.queryHash,
        claimIds: admission.selectedItems.map((item) => item.claim.id),
        reasonCodes: admission.reasonCodes,
        estimatedTokens: admission.estimatedTokens,
        claimCount: admission.claimCount,
        policyHash: admission.policyHash,
        packingStrategy: pack.diagnostics.strategy,
        codeSnippetCount: admission.selectedItems.reduce(
          (sum, item) => sum + item.codeEvidence.length,
          0,
        ),
        graphExpandedClaimCount: admission.selectedItems.filter(
          (item) => item.codeEvidence.length > 0,
        ).length,
        unusedTokens: Math.max(
          0,
          evidenceTokenBudget - admission.estimatedTokens,
        ),
        fallbackToCompressedHistory: !admission.admitted,
      };
      if (!admission.admitted) {
        await service.record({
          id: `context-pack-injection-rejected:${pack.id}`,
          taskId: this.instanceId,
          type: 'context_pack_injection_rejected',
          repositoryRevision,
          source: 'evidence_memory_injection',
          sourceId: pack.id,
          ingestionKey: `context-pack-injection:${pack.id}:rejected`,
          payload: decisionPayload,
        });
        return modelMessages;
      }

      await service.record({
        id: `context-pack-injection-admitted:${pack.id}`,
        taskId: this.instanceId,
        type: 'context_pack_injection_admitted',
        repositoryRevision,
        source: 'evidence_memory_injection',
        sourceId: pack.id,
        ingestionKey: `context-pack-injection:${pack.id}:admitted`,
        payload: decisionPayload,
      });
      const contextMessage: ModelMessage = {
        role: 'system',
        content: renderEvidenceMemoryContext(pack.id, admission.selectedItems, {
          repositoryRevision: repositoryRevision!,
          policyHash: admission.policyHash,
        }),
      };
      await service.record({
        id: `context-pack-injection-consumed:${pack.id}`,
        taskId: this.instanceId,
        type: 'context_pack_injection_consumed',
        repositoryRevision,
        source: 'evidence_memory_injection',
        sourceId: pack.id,
        ingestionKey: `context-pack-injection:${pack.id}:consumed`,
        payload: decisionPayload,
      });
      const insertionIndex = modelMessages[0]?.role === 'system' ? 1 : 0;
      return [
        ...modelMessages.slice(0, insertionIndex),
        contextMessage,
        ...modelMessages.slice(insertionIndex),
      ];
    } catch (error) {
      this.host.logger.warn(
        `[BaseAgent:${this.instanceId}] Evidence context injection failed; continuing with compressed memory`,
        {
          error: error instanceof Error ? error : new Error(String(error)),
        },
      );
      return modelMessages;
    }
  }

  private coalesceMemoryWriteReason(
    previous: MemoryWriteReason | null,
    next: MemoryWriteReason,
  ): MemoryWriteReason {
    if (previous === 'compression' || next === 'compression') {
      return 'compression';
    }
    if (previous === 'user-message' || next === 'user-message') {
      return 'user-message';
    }
    if (previous === 'queued-messages' || next === 'queued-messages') {
      return 'queued-messages';
    }
    if (previous === 'post-step' || next === 'post-step') return 'post-step';
    return next;
  }

  private scheduleMemorySnapshotWrite(reason: MemoryWriteReason): void {
    if (!this.config.persistent) return;
    this._pendingMemoryWriteReason = this.coalesceMemoryWriteReason(
      this._pendingMemoryWriteReason,
      reason,
    );
    if (this._memoryWriteTimer) clearTimeout(this._memoryWriteTimer);

    const elapsed = Date.now() - this._lastMemoryWriteAt;
    const throttleDelay = Math.max(0, 5000 - elapsed);
    const delay = Math.max(250, throttleDelay);
    this._memoryWriteTimer = setTimeout(() => {
      this._memoryWriteTimer = null;
      const pendingReason = this._pendingMemoryWriteReason ?? reason;
      this._pendingMemoryWriteReason = null;
      void this.flushMemorySnapshotWrite(pendingReason).catch((error) => {
        this.handleMemorySnapshotWriteFailure(
          pendingReason,
          error,
          'scheduled',
        );
      });
    }, delay);
  }

  private async flushMemorySnapshotWrite(
    reason: MemoryWriteReason,
  ): Promise<void> {
    const state = this.state.get();
    await this.getMemoryWriter().flush({
      title: state.title,
      activeModelId: state.activeModelId,
      history: state.history,
      reason,
    });
    this._lastMemoryWriteAt = Date.now();
  }

  private handleMemorySnapshotWriteFailure(
    reason: MemoryWriteReason,
    error: unknown,
    phase: 'scheduled' | 'teardown',
  ): void {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    this.host.logger.warn(
      `[BaseAgent:${this.instanceId}] ${phase === 'scheduled' ? 'Scheduled' : 'Teardown'} memory snapshot write failed`,
      { reason, error: normalizedError },
    );
    this.report(normalizedError, 'writeMemorySnapshot', { reason });
  }

  /**
   * Updates the persisted state of the agent
   */
  private async saveState(dirtyMessageIndices?: number[]): Promise<void> {
    if (!this.config.persistent) return;

    await this.state.persist(dirtyMessageIndices);
  }

  private getExecutionTargetForCurrentTurn(): AgentExecutionTarget {
    return resolveAgentExecutionTargetFromMessages(this.state.get().history);
  }

  /**
   * Checks, if the agent should immediately run a new step after last step execution.
   *
   * Conditions for running a new step are:
   *    - maxSteps is not set or the number of steps executed since last userMessage is less than maxSteps
   *    - maxTime is not set or the time since last userMessage is less than maxTime
   *    - onStepFinished returns true
   *    - there are no open tool approval requests
   *    - there are no unfinished tool calls
   *    - a tool call was included in the last step
   *    - there wasn't just one tool call to the "finish" tool
   *
   * @returns Whether the agent should run a new step based on the given conditions.
   */
  private shouldRunNewStep(
    r: StepResult<ToolSet>,
    userWantsToContinue: boolean,
  ): boolean {
    if (this.state.get().queuedMessages.length > 0) {
      // We should always continue if the user queued a message
      return true;
    }

    let stepsSinceLastMessage = 0;
    let lastUserMessageTime = 0;
    const historySnapshot = this.state.get().history;
    for (let i = historySnapshot.length - 1; i >= 0; i--) {
      const entry = historySnapshot[i];
      if (!entry) continue;
      if (entry.role === 'assistant') {
        stepsSinceLastMessage++;
        continue;
      } else if (entry.role === 'user') {
        lastUserMessageTime =
          entry.metadata?.partsMetadata[0]?.startedAt?.getTime() ?? Date.now();
        break;
      }
    }

    // Check if the maximum number of steps has been reached
    if (this.config.maxSteps && stepsSinceLastMessage >= this.config.maxSteps) {
      this.host.logger.debug(
        `[BaseAgent:${this.instanceId}] Maximum number of steps reached: ${stepsSinceLastMessage} >= ${this.config.maxSteps}`,
      );
      return false;
    }

    // Check if the maximum time has been reached
    if (
      this.config.maxTime &&
      Date.now() - lastUserMessageTime >= this.config.maxTime
    ) {
      this.host.logger.debug(
        `[BaseAgent:${this.instanceId}] Maximum time reached: ${Date.now() - lastUserMessageTime} >= ${this.config.maxTime}`,
      );
      return false;
    }

    //Also return a no-continue if one of the called tools is a "finish" tool and only the "finish" tool was called
    if (r.toolCalls.length === 1 && r.toolCalls[0]!.toolName === 'finish') {
      this.host.logger.debug(
        `[BaseAgent:${this.instanceId}] Only the "finish" tool was called`,
      );
      return false;
    }

    // Check if there are any open tool approval requests
    if (r.content.some((p) => p.type === 'tool-approval-request')) {
      this.host.logger.debug(
        `[BaseAgent:${this.instanceId}] There are open tool approval requests`,
      );
      return false;
    }

    // If the user does not want to continue, we don't run a new step
    if (!userWantsToContinue) return false;

    // We assume that approved tool calls are executed and results are attached,
    // because this is what AI-SDK with controlled tool execution promises us

    // When the model hits the output token limit, its response is truncated.
    // Tool calls with truncated JSON will have been caught by
    // experimental_repairToolCall, which throws a clear error. The SDK
    // surfaces that as a tool-result with errorText in history, so the
    // model can see exactly what went wrong on the next step.
    if (r.finishReason === 'length') {
      this.host.logger.warn(
        `[BaseAgent:${this.instanceId}] Output truncated (finishReason=length). Model will see error results and retry.`,
      );
      return true;
    }

    // Check if the finish reason is not tool-calls (which means user intervention is needed)
    if (r.finishReason !== 'tool-calls') {
      this.host.logger.debug(
        `[BaseAgent:${this.instanceId}] The finish reason is not "tool-calls", but "${r.finishReason}"`,
      );
      return false;
    }

    return true;
  }

  /**
   * Handles all the jobs that need to be done after a step is finished executing.
   *
   * @returns Whether the agent should run a new step based on the given conditions.
   */
  private async handlePostStep(
    result: StepResult<ToolSet>,
    expectedStepGeneration: number,
  ): Promise<boolean | null> {
    if (this._stepGeneration !== expectedStepGeneration) return null;
    this.state.commands.recordUsage({
      totalTokens: result.usage.totalTokens ?? 0,
    });

    this.updateUsageWarning(result);

    // Save the agent state for recovery
    await this.saveState();
    if (this._stepGeneration !== expectedStepGeneration) return null;

    // Drain any host-produced attachments (e.g. files written by a
    // sandbox/runtime side-channel during this step) into
    // metadata.attachments on the current assistant message.
    const pendingAtts = this.toolbox.drainPendingAttachments(this.instanceId);
    if (pendingAtts.length > 0) {
      this.state.commands.attachAttachmentsToLastAssistant({
        attachments: pendingAtts,
      });
    }

    // NOTE: populatePathReferencesOnAssistantMessage() is intentionally
    // NOT called here. It used to live in this spot, but handlePostStep
    // runs inside the SDK's onFinish callback, which fires BEFORE the
    // teed UI stream has finished draining tool-state transitions
    // (input-streaming → input-available → output-available). At this
    // point read tool parts are still in input-streaming, so
    // extractReadFilePathsFromAssistantMessage() returns [] and no
    // pathReferences are written — which in turn blocks the synthetic
    // user-message injection on the next step and leaves the LLM to
    // return an empty "stop" response. The call has been moved to
    // runStep(), AFTER Promise.all([handleUiStream, consumeStream])
    // resolves — see base-agent.ts runStep().

    this.host.telemetry?.capture('agent-step-completed', {
      agent_type: this.agentType,
      agent_instance_id: this.instanceId,
      model_id: this._stepResolvedModelId || this.state.get().activeModelId,
      selected_model_id:
        this._stepRequestedModelId || this.state.get().activeModelId,
      task_role: this._stepTaskRole,
      provider_mode: this._stepProviderMode,
      coding_plan_id: this._stepCodingPlanId,
      input_tokens: result.usage.inputTokens ?? 0,
      output_tokens: result.usage.outputTokens ?? 0,
      tool_call_count: result.toolCalls.length,
      finish_reason: result.finishReason ?? 'unknown',
      duration_ms: Date.now() - this._stepStartTime,
    });

    this.emitToolCallEvents(result);

    // Check the current token usage. If necessary, summarize the chat history.
    // Compress when used tokens exceed MIN(fraction * contextWindow, hardCap)
    // — the hard cap prevents large-context models (1M+) from accumulating
    // far more tokens than the fractional sweet-spot tuned for 200k models.
    const compactionThreshold = this.config.historyCompressionThreshold ?? 0.65;
    try {
      const contextWindowSize = (
        await this.host.models.getWithOptions(
          this._stepResolvedModelId || this.state.get().activeModelId,
          '',
        )
      ).contextWindowSize;
      if (this._stepGeneration !== expectedStepGeneration) return null;
      const fractionalTriggerTokens = compactionThreshold * contextWindowSize;
      const effectiveTriggerTokens = Math.min(
        fractionalTriggerTokens,
        BaseAgent.HISTORY_COMPRESSION_HARD_CAP_TOKENS,
      );
      if (
        compactionThreshold >= 0 &&
        this.state.get().usedTokens > effectiveTriggerTokens
      ) {
        void this.compressHistoryInternal(expectedStepGeneration);
      }
    } catch {
      // Model may have been deleted between step start and finish — skip compaction check
    }

    const userWantsToContinue = (await this.onStepFinished(result)) ?? true;
    if (this._stepGeneration !== expectedStepGeneration) return null;
    const shouldRunNewStep = this.shouldRunNewStep(result, userWantsToContinue);

    if (!shouldRunNewStep) {
      this.host.logger.debug(
        `[BaseAgent:${this.instanceId}] Not running new step. Agent Type: ${this.agentType}`,
      );
      return false;
    }

    this.host.logger.debug(
      `[BaseAgent:${this.instanceId}] Running new step. Agent Type: ${this.agentType}`,
    );

    return true;
  }

  /**
   * Handles the generation of context for a new step.
   *
   * Before converting history to model messages, this method captures the
   * current per-domain env state via the {@link DomainAdapterRegistry} and
   * attaches it to the **last message in history** — regardless of whether
   * it is a user or assistant message. Adapters that report no change
   * against the prior effective state are omitted from the persisted
   * entries; conversion inherits their state from the most recent earlier
   * message that carries it.
   *
   * When multiple queued messages are flushed at once, `queueFlushStart`
   * points to the first flushed message so the env-state entry is attached
   * there rather than at the end — env context appears before user
   * content.
   */
  private async generateContextForNewStep(
    queueFlushStart?: number,
    reasoningSignatureSource?: ReasoningSignatureSource,
    expectedStepGeneration?: number,
  ): Promise<ModelMessage[]> {
    // ─── Resolve env-domain allow-list from this agent type's profile ─
    // Hosts opt agent types into env capture explicitly via
    // `AgentHost.defineAgentProfile(...)`. If no profile is registered,
    // the agent gets no env adapters (and the chat prompt builder also
    // omits per-domain sections). Filtering happens here once and is
    // threaded into both env capture and message conversion so a
    // shrunk profile cannot leak historical entries into the rendered
    // prompt.
    // Missing profile means the agent type has not opted into any env
    // domains: capture and prompt-builder already treat this as "none",
    // and we default to an empty array here so message-conversion's
    // rendering path applies the same allow-list (no historical env
    // entries are replayed for unconfigured agents).
    const allowedEnvDomainIds =
      this.host.getAgentProfile(this.agentType)?.envDomainIds ?? [];

    // ─── Capture & attach per-domain env state to target message ──────
    const history = this.state.get().history;
    const targetIdx =
      queueFlushStart !== undefined && queueFlushStart < history.length
        ? queueFlushStart
        : history.length - 1;
    const prevStates =
      targetIdx > 0 ? resolveEffectiveEnvStates(history, targetIdx - 1) : {};
    const { entries } = await this.domainAdapterRegistry.captureAll(
      prevStates,
      this.instanceId,
      allowedEnvDomainIds,
    );
    if (
      expectedStepGeneration !== undefined &&
      this._stepGeneration !== expectedStepGeneration
    ) {
      return [];
    }
    if (entries.size > 0) {
      this.state.commands.attachEnvState({
        entries,
        queueFlushStart,
      });
    }

    // ─── Populate pathReferences on the last user message ─────────────
    // Extracts path: links, attachment paths, and mention paths, then
    // hashes each file/directory so the conversion pipeline can track
    // content state and deduplicate injections.
    await this.populatePathReferencesOnUserMessages(expectedStepGeneration);
    if (
      expectedStepGeneration !== undefined &&
      this._stepGeneration !== expectedStepGeneration
    ) {
      return [];
    }

    // ─── Build model messages from history ────────────────────────────
    const messages = this.state.get().history;

    const filteredUIMsgs = await this.transformMessagesBeforeStep(messages);
    if (
      expectedStepGeneration !== undefined &&
      this._stepGeneration !== expectedStepGeneration
    ) {
      return [];
    }

    const systemPrompt = await this.getSystemPrompt();
    if (
      expectedStepGeneration !== undefined &&
      this._stepGeneration !== expectedStepGeneration
    ) {
      return [];
    }

    const modelMessages = await this.transformMessagesToModelMessages(
      filteredUIMsgs,
      systemPrompt,
      reasoningSignatureSource,
      allowedEnvDomainIds,
    );
    if (
      expectedStepGeneration !== undefined &&
      this._stepGeneration !== expectedStepGeneration
    ) {
      return [];
    }

    // Then, we allow another step to modify the final model messages
    const transformedModelMessages =
      await this.transformModelMessagesBeforeStep(modelMessages);
    if (
      expectedStepGeneration !== undefined &&
      this._stepGeneration !== expectedStepGeneration
    ) {
      return [];
    }
    const evidenceAugmentedMessages = await this.injectEvidenceContextIfEnabled(
      transformedModelMessages,
    );
    if (
      expectedStepGeneration !== undefined &&
      this._stepGeneration !== expectedStepGeneration
    ) {
      return [];
    }

    const finalModelMessages = this.appendSyntheticContinuationIfNeeded(
      evidenceAugmentedMessages,
      expectedStepGeneration,
    );

    return finalModelMessages;
  }

  private appendSyntheticContinuationIfNeeded(
    modelMessages: ModelMessage[],
    expectedStepGeneration?: number,
  ): ModelMessage[] {
    if (
      expectedStepGeneration !== undefined &&
      this._stepGeneration !== expectedStepGeneration
    ) {
      return modelMessages;
    }
    const continuation = this._pendingSyntheticContinuation;
    if (!continuation) return modelMessages;

    this._pendingSyntheticContinuation = null;

    const lastMessage = modelMessages.at(-1);
    if (lastMessage?.role === 'user' || lastMessage?.role === 'tool') {
      this.host.logger.info(
        `[BaseAgent:${this.instanceId}] Synthetic continuation not appended because model context already ends with ${lastMessage.role}. reason=${continuation.reason}`,
      );
      return modelMessages;
    }

    this.host.logger.info(
      `[BaseAgent:${this.instanceId}] Appending synthetic model-only continuation. reason=${continuation.reason}, previousLastRole=${lastMessage?.role ?? 'none'}`,
    );

    return [...modelMessages, { role: 'user', content: 'continue' }];
  }

  /**
   * Populate `pathReferences` on all user messages in history that don't
   * already have them.
   *
   * The last user message is always (re-)populated so its hashes reflect
   * the current file state at step start. Earlier user messages that were
   * never populated (e.g. messages sent while a step was in-flight) are
   * also processed so their file content is injected during conversion.
   */
  private async populatePathReferencesOnUserMessages(
    expectedStepGeneration?: number,
  ): Promise<void> {
    const history = this.state.get().history;
    const mountPaths = this.toolbox.getMountedPathsForAgent(this.instanceId);

    // Collect indices of user messages that need (re-)population:
    // - All user messages without pathReferences (never populated)
    // - The last user message (always re-populate for fresh hashes)
    //
    // We iterate backward and stop as soon as we encounter a user message
    // that already has pathReferences (other than the last user message,
    // which is always re-populated). Reverted/re-sent messages are removed
    // from history before re-sending, so a populated message is a reliable
    // boundary — everything before it has been populated in a prior step.
    let lastUserIdx = -1;
    const indicesToPopulate: number[] = [];

    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]!.role !== 'user') continue;
      if (lastUserIdx < 0) {
        lastUserIdx = i;
        // Always re-populate the last user message for fresh hashes.
        indicesToPopulate.push(i);
        continue;
      }
      if (history[i]!.metadata?.pathReferences) {
        // Already populated — all earlier messages must also be populated.
        break;
      }
      indicesToPopulate.push(i);
    }

    if (indicesToPopulate.length === 0) return;

    // Process all target messages concurrently
    const results = await Promise.all(
      indicesToPopulate.map(async (idx) => {
        const message = history[idx]!;
        const messageCopy = {
          ...message,
          metadata: message.metadata
            ? { ...message.metadata }
            : { createdAt: new Date(), partsMetadata: [] },
        };

        await populatePathReferences(
          messageCopy,
          this.instanceId,
          mountPaths,
          this.host.paths,
          this.host.logger,
          this.host.protectedFiles,
        );

        return { idx, pathReferences: messageCopy.metadata?.pathReferences };
      }),
    );

    // Write back all populated pathReferences in a single state update
    const populated = results.filter((r) => r.pathReferences);
    if (populated.length === 0) return;
    if (
      expectedStepGeneration !== undefined &&
      this._stepGeneration !== expectedStepGeneration
    ) {
      return;
    }

    this.state.commands.setUserPathReferences({ populated });
  }

  /**
   * Populate `pathReferences` on the last assistant message by extracting
   * paths from completed `readFile` tool-call parts, resolving them, and
   * hashing the files.
   *
   * Called in `handlePostStep` after each step completes.
   */
  private async populatePathReferencesOnAssistantMessage(
    expectedStepGeneration?: number,
  ): Promise<void> {
    const history = this.state.get().history;
    // Capture the index at read-time so the write targets the same message
    // even if history grows concurrently (e.g. a new message appended).
    const targetIdx = history.length - 1;
    const lastMsg = history[targetIdx];
    if (!lastMsg || lastMsg.role !== 'assistant') return;

    // Collect paths from readFile tool calls AND from attachments created
    // via API.createAttachment(). Both should be tracked so their contents
    // are automatically injected into model context on the next turn.
    const pathsFromToolCalls =
      extractReadFilePathsFromAssistantMessage(lastMsg);
    const pathsFromAttachments = (lastMsg.metadata?.attachments ?? [])
      .map((att) => att.path)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);

    const mountedPaths = [
      ...new Set([...pathsFromToolCalls, ...pathsFromAttachments]),
    ];
    if (mountedPaths.length === 0) return;

    const mountPaths = this.toolbox.getMountedPathsForAgent(this.instanceId);
    const references: Record<string, string> = {};

    await Promise.all(
      mountedPaths.map(async (mountedPath) => {
        const absolutePath = resolveMountedPath(
          mountedPath,
          this.instanceId,
          mountPaths,
          this.host.paths,
        );
        if (!absolutePath) return;

        try {
          const hash =
            (await hashProtectedMountedFile(
              this.host.protectedFiles,
              this.host.paths,
              this.instanceId,
              mountedPath,
            )) ?? (await hashPath(absolutePath));
          references[mountedPath] = hash;
        } catch (err) {
          this.host.logger.debug(
            `[populatePathReferences:assistant] Failed to hash "${mountedPath}": ${err instanceof Error ? err.message : err}`,
          );
        }
      }),
    );

    if (
      expectedStepGeneration !== undefined &&
      this._stepGeneration !== expectedStepGeneration
    ) {
      return;
    }
    if (Object.keys(references).length > 0) {
      this.state.commands.mergeAssistantPathReferences({
        targetIdx,
        references,
      });
    }
  }

  /**
   * Persist the provider's signed `reasoning_details` array into the last
   * assistant message's metadata, tagged with the semantic route
   * ({@link ReasoningSignatureSource}) that produced it, so conversion can
   * re-inject it only for compatible future requests.
   *
   * Context: OpenRouter / Bedrock-hosted Claude refuses to extend a
   * thinking process when the conversation carries unsigned reasoning
   * blocks. We capture the per-step signatures here (surfaced by the host
   * provider under the OpenAI-compatible transport metadata key) and later
   * spread matching groups back onto outbound assistant messages via
   * `providerOptions.openaiCompatible.reasoning_details`.
   *
   * Multi-step continuations append to the existing source-owned group so
   * the full thinking history stays intact across tool-call rounds.
   *
   * Must be called AFTER the UI stream has drained — that is the only site
   * that pushes the assistant message into `state.history`.
   */
  private populateReasoningDetailsOnAssistantMessage(
    step: StepResult<ToolSet>,
    reasoningSignatureSource: ReasoningSignatureSource,
  ): void {
    const pm = step.providerMetadata as
      | Record<string, Record<string, unknown>>
      | undefined;
    const details = pm?.openaiCompatible?.reasoningDetails as
      | Record<string, unknown>[]
      | undefined;
    if (!Array.isArray(details) || details.length === 0) return;

    const history = this.state.get().history;
    const targetIdx = history.length - 1;
    const target = history[targetIdx];
    if (!target || target.role !== 'assistant') return;

    const existing = target.metadata?.ownedReasoningDetails ?? [];
    const matchingIdx = existing.findIndex((group) =>
      reasoningSourcesMatch(group.source, reasoningSignatureSource),
    );

    const next =
      matchingIdx >= 0
        ? existing.map((entry, idx) =>
            idx === matchingIdx
              ? { ...entry, details: [...entry.details, ...details] }
              : entry,
          )
        : [...existing, { source: reasoningSignatureSource, details }];

    this.state.commands.setAssistantOwnedReasoningDetails({
      targetIdx,
      ownedReasoningDetails: next,
    });
  }

  private getModelTaskRoleForNextStep(): ModelTaskRole {
    const history = this.state.get().history;
    const lastMessage = history.at(-1);
    if (!lastMessage || lastMessage.role === 'user') return 'analysis';

    const lastAssistant = lastMessage.role === 'assistant' ? lastMessage : null;
    if (!lastAssistant) return 'analysis';

    const toolNames = lastAssistant.parts.flatMap((part) => {
      if (part.type === 'dynamic-tool') return ['dynamic-tool'];
      if (!part.type.startsWith('tool-')) return [];
      return [part.type.slice('tool-'.length)];
    });
    if (toolNames.length === 0) return 'analysis';

    const reviewToolNames = new Set([
      'write',
      'multiEdit',
      'delete',
      'copy',
      'mkdir',
      'executeShellCommand',
      'getLintingDiagnostics',
    ]);
    if (toolNames.some((name) => reviewToolNames.has(name))) {
      return 'review';
    }

    const codingToolNames = new Set([
      'read',
      'getFileSkeleton',
      'getSymbolBody',
      'searchProjectSymbols',
      'grepSearch',
      'glob',
      'ls',
      'readConsoleLogs',
      'executeSandboxJs',
      'listLibraryDocs',
      'searchInLibraryDocs',
    ]);
    if (toolNames.some((name) => codingToolNames.has(name))) {
      return 'coding';
    }

    return 'analysis';
  }

  /**
   * Checks if the message history is ready to be processed by the model
   *
   * We check for the following conditions:
   *    - No step is currently running (stepAbortController exists and not aborted)
   *    - All non-provider tools with need for approval are executed and results are attached
   *    - All open tool approval requests are responded to (either deny or accept) in the last message of the history
   *
   * @returns Whether the agent can run a new step based on the given conditions.
   */
  private canRunStep(): boolean {
    if (
      this._activeStepRun !== null ||
      this._recoveredReplayExecutionId !== null ||
      this._approvalDurabilityInFlight > 0 ||
      this._approvalInvalidationInFlight > 0 ||
      this._approvalAdmissionFailedClosed ||
      this._approvalSweepPersistenceBlocked ||
      this._approvalSweepOperationsInFlight > 0 ||
      this._historyRewriteInFlight > 0 ||
      this._historyPreemptionInFlight > 0 ||
      this._approvalLifecycleInvalidationFailedClosed
    ) {
      return false;
    }

    // Only check stepAbortController for concurrency - isWorking is just a UI state indicator
    if (this.stepAbortController && !this.stepAbortController.signal.aborted) {
      return false;
    }

    // Because we use `stopWhen: () => true`, the stream ends after every step.
    // When the user approves/denies a tool, the stream for that step has already
    // terminated — tool execution only happens in the *next* runStep() call.
    // Therefore, `approval-responded` (both approved and denied) must be treated
    // as resolved here so the agent loop can proceed to that next step.
    const openToolCallRequests = this.state
      .get()
      .history.filter(
        (msg) =>
          msg.role === 'assistant' &&
          msg.parts.some(
            (p) =>
              (p.type.startsWith('tool-') || p.type === 'dynamic-tool') &&
              (p as AgentToolUIPart | DynamicToolUIPart).state !==
                'approval-responded' &&
              (p as AgentToolUIPart | DynamicToolUIPart).state !==
                'output-available' &&
              (p as AgentToolUIPart | DynamicToolUIPart).state !==
                'output-error' &&
              (p as AgentToolUIPart | DynamicToolUIPart).state !==
                'output-denied',
          ),
      );

    return openToolCallRequests.length === 0;
  }

  private async getToolsForStep(): Promise<Partial<ToolSet>> {
    const userTools = await this.getTools(this.messages);
    const maybeFinish = this.getFinishTool();
    const finishTool: Partial<ToolSet> = maybeFinish
      ? { finish: maybeFinish as ToolSet[string] }
      : {};
    return {
      ...userTools,
      ...finishTool,
    };
  }

  private getFinishTool(): Tool | null {
    if (!this.config.finishToolOutputSchema) return null;
    return tool({
      description:
        'Mark the conversation as done/finished. You must use this tool to mark the work/task as being done. Use it after all other tool calls are done.',
      inputSchema: this.config.finishToolOutputSchema,
      execute: async (input) => {
        // Type assertion needed because AI SDK infers `unknown` for generic schema types
        return await this.finishToolHandler?.(
          input as TFinishToolOutputSchema extends z.ZodType
            ? z.infer<TFinishToolOutputSchema>
            : never,
        );
      },
    });
  }

  /**
   * Drains the UI message stream and writes each chunk into history.
   *
   * This method only handles structural bookkeeping (adding the message,
   * updating parts, tracking part timing). It does NOT capture environment
   * snapshots — snapshots are attached to the last message in history by
   * `generateContextForNewStep` right before the conversion pipeline runs.
   *
   * When resuming after tool-approval, `lastAssistantMessage` is passed
   * so `readUIMessageStream` can append tool-result parts to the existing
   * message instead of creating a new one. It is cloned because the SDK
   * mutates it in-place, which would corrupt the stored history.
   */
  private async handleUiStream(
    uiStream: AsyncIterableStream<InferUIMessageChunk<AgentMessage>>,
    lastAssistantMessage?: AgentMessage,
    expectedStepGeneration?: number,
  ): Promise<void> {
    for await (const uiMessage of readUIMessageStream<AgentMessage>({
      stream: uiStream,
      message: lastAssistantMessage
        ? structuredClone(lastAssistantMessage)
        : undefined,
    })) {
      // Keep draining the tee for back-pressure, but never merge chunks from
      // a run superseded by stop/new-message/recovery.
      if (
        expectedStepGeneration !== undefined &&
        this._stepGeneration !== expectedStepGeneration
      ) {
        continue;
      }
      this.state.commands.mergeUIMessageStream({
        uiMessage,
        onApprovalRequested: ({ approvalId, toolPart }) => {
          // Emit `tool-approval-requested` exactly once per approval
          // id. The stream replays the approval-requested state many
          // times as the SDK merges chunks, so dedupe via
          // `_seenApprovalRequestIds`.
          if (!this._seenApprovalRequestIds.has(approvalId)) {
            this._seenApprovalRequestIds.add(approvalId);
            this.host.telemetry?.capture('tool-approval-requested', {
              tool_name:
                toolPart.type === 'dynamic-tool'
                  ? 'dynamic-tool'
                  : toolPart.type.replace('tool-', ''),
              agent_instance_id: this.instanceId,
              tool_call_id: approvalId,
            });
            this.emitNotificationEvent('question');
          }
        },
      });
    }
  }

  private assertApprovalLifecycleGeneration(
    expectedGeneration: number,
    approvalId: string,
  ): void {
    if (this._approvalLifecycleGeneration !== expectedGeneration) {
      throw new Error(
        `Tool approval response '${approvalId}' was invalidated by a newer agent lifecycle action`,
      );
    }
  }

  private async waitForApprovalDurabilityToSettle(): Promise<void> {
    if (this._approvalDurabilityInFlight === 0) return;
    await new Promise<void>((resolve) => {
      this._approvalDurabilitySettledWaiters.add(resolve);
    });
  }

  private async continueAfterToolApprovalResponse(input: {
    readonly lifecycleGeneration: number;
    readonly originatingStepGeneration: number;
    readonly originatingStepSettlement?: Promise<
      'completed' | 'failed' | 'superseded'
    >;
  }): Promise<void> {
    const settlementOutcome = input.originatingStepSettlement
      ? await input.originatingStepSettlement
      : 'completed';
    if (settlementOutcome === 'failed') {
      const invalidation =
        await this.invalidateOpenToolApprovals('system-interrupted');
      invalidation.release();
      return;
    }
    if (settlementOutcome === 'superseded') return;
    await this.waitForApprovalDurabilityToSettle();

    // A stop/new-message action or a superseding/error step owns the next
    // transition once either generation changes. The durable response may
    // already exist, but it must not revive execution after that boundary.
    if (
      this._approvalLifecycleGeneration !== input.lifecycleGeneration ||
      this._stepGeneration !== input.originatingStepGeneration
    ) {
      return;
    }

    await this.runStep(true);
  }

  private hasLocalOpenToolApproval(): boolean {
    const state = this.state.get();
    if (Object.keys(state.pendingApprovals).length > 0) return true;
    return state.history.some(
      (message) =>
        message.role === 'assistant' &&
        message.parts.some((part) => {
          if (
            !(part.type.startsWith('tool-') || part.type === 'dynamic-tool')
          ) {
            return false;
          }
          const toolPart = part as AgentToolUIPart | DynamicToolUIPart;
          return (
            toolPart.state === 'approval-requested' ||
            toolPart.state === 'approval-responded'
          );
        }),
    );
  }

  private async persistApprovalSweep(sweep: {
    readonly changed: boolean;
    readonly dirtyMessageIndices: readonly number[];
  }): Promise<void> {
    if (!this.config.persistent) return;
    if (sweep.changed) {
      this._approvalSweepPersistencePending = true;
      for (const index of sweep.dirtyMessageIndices) {
        if (Number.isSafeInteger(index) && index >= 0) {
          this._pendingApprovalSweepDirtyMessageIndices.add(index);
        }
      }
    }
    if (!this._approvalSweepPersistencePending) return;

    const history = this.state.get().history;
    const dirtyMessageIndices = [
      ...this._pendingApprovalSweepDirtyMessageIndices,
    ].filter((index) => index < history.length);
    try {
      await this.state.persist({
        dirtyMessageIndices,
        expectedMessageBindings: dirtyMessageIndices.map((messageIndex) => ({
          messageIndex,
          messageId: history[messageIndex]!.id,
        })),
        throwOnError: true,
      });
      this._approvalSweepPersistencePending = false;
      this._pendingApprovalSweepDirtyMessageIndices.clear();
      this._approvalSweepPersistenceBlocked = false;
    } catch (error) {
      this._approvalSweepPersistenceBlocked = true;
      throw error;
    }
  }

  private applyAndPersistApprovalSweep(
    mutate: () => {
      readonly changed: boolean;
      readonly dirtyMessageIndices: readonly number[];
    },
  ): Promise<void> {
    this._approvalSweepOperationsInFlight += 1;
    const operation = this._approvalSweepTail
      .catch(() => undefined)
      .then(() => this.applyAndPersistApprovalSweepSerialized(mutate));
    const tracked = operation.finally(() => {
      this._approvalSweepOperationsInFlight -= 1;
    });
    this._approvalSweepTail = tracked.catch(() => undefined);
    return tracked;
  }

  private async applyAndPersistApprovalSweepSerialized(
    mutate: () => {
      readonly changed: boolean;
      readonly dirtyMessageIndices: readonly number[];
    },
  ): Promise<void> {
    let sweep: {
      readonly changed: boolean;
      readonly dirtyMessageIndices: readonly number[];
    };
    try {
      sweep = mutate();
    } catch (mutationError) {
      // `AgentStore.update()` commits before notifying synchronous
      // subscribers. If a subscriber throws, the mutation has no returned
      // receipt even though history may already be changed. Persist every
      // current row as a conservative recovery receipt before propagating the
      // original error.
      const fallback = {
        changed: true,
        dirtyMessageIndices: this.state
          .get()
          .history.map((_, messageIndex) => messageIndex),
      } as const;
      try {
        await this.persistApprovalSweep(fallback);
      } catch (fallbackPersistenceError) {
        throw new AggregateError(
          [mutationError, fallbackPersistenceError],
          'Approval sweep mutation and conservative durable recovery both failed',
        );
      }
      throw mutationError;
    }
    await this.persistApprovalSweep(sweep);
  }

  /**
   * Durably closes host-managed approvals displaced by a newer lifecycle
   * action. The generation changes synchronously before the first await so an
   * explicit response already crossing persistence barriers cannot schedule a
   * continuation after stop/new-message wins the race.
   */
  private async invalidateOpenToolApprovals(
    reason: ToolApprovalInvalidationReason,
  ): Promise<{ release: () => void; invalidatedCount: number }> {
    this._approvalInvalidationInFlight += 1;
    this._approvalLifecycleGeneration += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this._approvalInvalidationInFlight -= 1;
    };
    try {
      let invalidatedCount = 0;
      const operation = this._approvalInvalidationTail
        .catch(() => undefined)
        .then(async () => {
          invalidatedCount =
            await this.invalidateOpenToolApprovalsSerialized(reason);
        });
      this._approvalInvalidationTail = operation.catch(() => undefined);
      await operation;
      return { release, invalidatedCount };
    } catch (error) {
      release();
      throw error;
    }
  }

  private async invalidateOpenToolApprovalsSerialized(
    reason: ToolApprovalInvalidationReason,
  ): Promise<number> {
    const lifecycle = this.toolApprovalLifecycle;

    const toolCallIds = new Set(this._approvalResponsesInFlight);
    const addToolCallId = (toolCallId: unknown) => {
      if (
        typeof toolCallId === 'string' &&
        toolCallId.length > 0 &&
        toolCallId === toolCallId.trim() &&
        !toolCallId.includes('\0')
      ) {
        toolCallIds.add(toolCallId);
      }
    };
    const state = this.state.get();
    for (const toolCallId of Object.keys(state.pendingApprovals)) {
      addToolCallId(toolCallId);
    }
    for (const message of state.history) {
      if (message.role !== 'assistant') continue;
      for (const part of message.parts) {
        if (!(part.type.startsWith('tool-') || part.type === 'dynamic-tool')) {
          continue;
        }
        const toolPart = part as AgentToolUIPart | DynamicToolUIPart;
        if (
          toolPart.state !== 'approval-requested' &&
          toolPart.state !== 'approval-responded'
        ) {
          continue;
        }
        addToolCallId(toolPart.toolCallId);
      }
    }

    const ids = [...toolCallIds];
    let invalidatedCount = 0;
    try {
      if (lifecycle) {
        const batchCount = Math.max(1, Math.ceil(ids.length / 1_000));
        for (let batch = 0; batch < batchCount; batch++) {
          const offset = batch * 1_000;
          invalidatedCount += await lifecycle.invalidateOpen({
            agentInstanceId: this.instanceId,
            toolCallIds: ids.slice(offset, offset + 1_000),
            reason,
          });
        }
      }
      await this.waitForApprovalDurabilityToSettle();
      this._approvalLifecycleInvalidationFailedClosed = false;
      return invalidatedCount;
    } catch (error) {
      this._approvalLifecycleInvalidationFailedClosed = true;
      throw error;
    }
  }

  private rememberClosedRecoveredReplayExecution(executionId: string): void {
    this._closedRecoveredReplayExecutionIds.add(executionId);
    while (this._closedRecoveredReplayExecutionIds.size > 256) {
      const oldest = this._closedRecoveredReplayExecutionIds
        .values()
        .next().value;
      if (typeof oldest !== 'string') break;
      this._closedRecoveredReplayExecutionIds.delete(oldest);
    }
  }

  private supersedeCurrentStep(): void {
    // Invalidate pending callbacks BEFORE firing abort — onAbort fires
    // synchronously and must see the new generation to be ignored.
    this._stepGeneration++;
    // Discard any deferred continuation so runStep's tail cannot
    // schedule another step or flip to idle after we've already
    // intervened. Also discard synthetic recovery continuations; the
    // recovery path sets a fresh one after calling internalStop().
    this._pendingContinue = null;
    this._pendingSyntheticContinuation = null;
    this._pendingToolCapabilityScopeId = null;
    try {
      this.stepAbortController?.abort();
    } catch {}
    this.stepAbortController = null;
    // Resolve approval-continuation waiters immediately as superseded, then
    // detach the old run so a replacement step is not held hostage by a
    // provider stream that ignores abort. The old run's identity-checked
    // finally block cannot clear a newer run.
    this._activeStepRun?.resolve('superseded');
    this._activeStepRun = null;
    if (this._recoveredReplayExecutionId !== null) {
      this.rememberClosedRecoveredReplayExecution(
        this._recoveredReplayExecutionId,
      );
      this._recoveredReplayExecutionId = null;
      this._recoveredReplayStepGeneration = null;
    }
  }

  private async internalStop(
    stopReason:
      | 'user-stopped'
      | 'user-flushed-queue'
      | 'system-interrupted' = 'user-stopped',
  ): Promise<void> {
    this.supersedeCurrentStep();

    const approvalInvalidationReason: ToolApprovalInvalidationReason =
      stopReason === 'user-stopped'
        ? 'user-stop'
        : stopReason === 'user-flushed-queue'
          ? 'queue-flush'
          : 'system-interrupted';
    const { release: releaseApprovalInvalidation } =
      await this.invalidateOpenToolApprovals(approvalInvalidationReason);

    try {
      const toolCallAbortReason =
        stopReason === 'system-interrupted'
          ? 'System was suspended or stalled before tool call finished.'
          : stopReason === 'user-stopped'
            ? (this.config.stopToolCallAbortReason ??
              'User stopped agent before tool call finished.')
            : (this.config.flushQueueToolCallAbortReason ??
              'User sent new message before tool call finished.');

      const toolCallRequestApprovalAbortReason =
        stopReason === 'system-interrupted'
          ? 'System was suspended or stalled before tool call approval was granted.'
          : stopReason === 'user-stopped'
            ? (this.config.stopToolCallRequestApprovalReason ??
              'User stopped agent before tool call approval was granted.')
            : (this.config.flushQueueToolCallRequestApprovalReason ??
              'User sent new message before tool call approval was granted.');

      await this.applyAndPersistApprovalSweep(() =>
        this.state.commands.terminateNonTerminalToolPartsInLastAssistant({
          approvalDenyReason: toolCallRequestApprovalAbortReason,
          outputErrorText: toolCallAbortReason,
        }),
      );

      // Security-critical cancellation is durable before best-effort host UI
      // cleanup can throw or re-enter unrelated code.
      this.toolbox.cancelPendingAgentDialogs(this.instanceId);
      this.toolbox.cancelPendingEdits?.(this.instanceId);
    } finally {
      releaseApprovalInvalidation();
    }
  }

  /**
   * Ensures the last model message is the `tool`-role message containing
   * `tool-approval-response` parts. The AI SDK's `collectToolApprovals`
   * only inspects the **last** message; if synthetic user messages
   * (env-changes, sandbox attachments) follow the tool message, the SDK
   * silently skips tool execution and the provider rejects the request.
   *
   * When trailing messages exist after the last tool message that carries
   * an approval response, they are relocated to just before the
   * corresponding assistant message so the tool message becomes last
   * while all context is preserved.
   *
   * No-op when the tool message is already last or has no approval
   * response parts.
   */
  private ensureToolApprovalResponseIsLast(
    messages: ModelMessage[],
  ): ModelMessage[] {
    let lastToolIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'tool') {
        lastToolIdx = i;
        break;
      }
    }
    if (lastToolIdx === -1 || lastToolIdx === messages.length - 1)
      return messages;

    const toolMsg = messages[lastToolIdx];
    if (!toolMsg) return messages;
    const hasApprovalResponse =
      Array.isArray(toolMsg.content) &&
      (toolMsg.content as Array<{ type: string }>).some(
        (p) => p.type === 'tool-approval-response',
      );
    if (!hasApprovalResponse) return messages;

    let assistantIdx = lastToolIdx - 1;
    while (assistantIdx >= 0 && messages[assistantIdx]?.role !== 'assistant')
      assistantIdx--;

    if (assistantIdx < 0) return messages;

    const trailing = messages.splice(lastToolIdx + 1);
    messages.splice(assistantIdx, 0, ...trailing);
    return messages;
  }

  /**
   * Max depth to unwrap nested `lastError` chains. Today the AI SDK wraps at
   * most once (RetryError -> APICallError), so 3 is defensive against future
   * wrapping layers (e.g. a retry-of-retry) while guaranteeing termination.
   */
  private static readonly MAX_ERROR_UNWRAP_DEPTH = 3;

  /**
   * HTTP status codes treated as "upstream overloaded / rate-limited".
   * 429: rate-limited.  502/503: provider down or no available provider.
   * 529: Anthropic's overload status (non-standard, vendor-specific).
   * See https://openrouter.ai/docs/api/reference/errors-and-debugging.mdx
   */
  private static readonly UPSTREAM_OVERLOAD_CODES: ReadonlySet<number> =
    new Set([429, 502, 503, 529]);

  /**
   * Walks the error chain (outer -> `lastError` -> ...) and returns the frame
   * carrying the fullest API context. The AI SDK wraps retried failures in
   * AI_RetryError whose own fields do NOT carry statusCode/responseBody; the
   * inner APICallError is exposed on `lastError`. Descend whenever EITHER
   * field is missing so partial wrappers (one field on the outer, the other
   * on the inner) still surface full context. The depth cap bounds iteration.
   */
  private static unwrapApiErrorFrame(error: Error): Record<string, unknown> {
    let current: Record<string, unknown> = error as unknown as Record<
      string,
      unknown
    >;
    for (let i = 0; i < BaseAgent.MAX_ERROR_UNWRAP_DEPTH; i++) {
      const missingStatus = current.statusCode === undefined;
      const missingBody = typeof current.responseBody !== 'string';
      if (
        (missingStatus || missingBody) &&
        current.lastError instanceof Error
      ) {
        current = current.lastError as unknown as Record<string, unknown>;
        continue;
      }
      break;
    }
    return current;
  }

  /**
   * Extract API error context for logging / telemetry. The responseBody is
   * truncated to bound payload size — do NOT use this for JSON-parsing
   * classifiers (large bodies would be sliced mid-JSON and fail to parse).
   * Classifiers should call `unwrapApiErrorFrame` directly and read the raw
   * `responseBody` off the returned frame.
   */
  private static extractApiErrorContext(error: Error): Record<string, unknown> {
    const current = BaseAgent.unwrapApiErrorFrame(error);
    const ctx: Record<string, unknown> = {};
    if (current.statusCode !== undefined) ctx.statusCode = current.statusCode;
    if (current.url !== undefined) ctx.url = current.url;
    if (current.isRetryable !== undefined)
      ctx.isRetryable = current.isRetryable;
    if (typeof current.responseBody === 'string')
      ctx.responseBody = current.responseBody.slice(0, 4000);
    if (current.cause instanceof Error)
      ctx.causeMessage = current.cause.message;
    return ctx;
  }

  private formatError(error: Error): string {
    const ctx = BaseAgent.extractApiErrorContext(error);
    const parts = [error.message];
    if (ctx.statusCode) parts.push(`status=${ctx.statusCode}`);
    if (ctx.url) parts.push(`url=${ctx.url}`);
    if (ctx.responseBody)
      parts.push(`response=${(ctx.responseBody as string).slice(0, 500)}`);
    if (ctx.causeMessage) parts.push(`cause=${ctx.causeMessage}`);
    return parts.join(', ');
  }

  private parsePlanLimitError(error: Error): AgentRuntimeError | null {
    // Read the RAW (untruncated) responseBody — classifiers must parse the
    // full JSON. `extractApiErrorContext` truncates for logging, which can
    // corrupt large bodies mid-JSON.
    const frame = BaseAgent.unwrapApiErrorFrame(error);
    const rawBody = frame.responseBody;
    if (typeof rawBody !== 'string') return null;
    try {
      const body = JSON.parse(rawBody);
      if (body?.error !== 'PLAN_LIMIT_EXCEEDED') return null;
      const exceededWindows =
        body.details?.exceededWindows
          ?.filter(
            (w: Record<string, unknown>) =>
              typeof w.type === 'string' && typeof w.resetsAt === 'string',
          )
          .map((w: { type: string; resetsAt: string }) => ({
            type: w.type,
            resetsAt: w.resetsAt,
          })) ?? [];
      const plan =
        typeof body.details?.plan === 'string' ? body.details.plan : undefined;
      return {
        kind: 'plan-limit-exceeded',
        message: body.message ?? 'Usage limit exceeded',
        plan,
        exceededWindows,
      };
    } catch {
      return null;
    }
  }

  private parseModelRestrictedError(error: Error): AgentRuntimeError | null {
    const frame = BaseAgent.unwrapApiErrorFrame(error);
    const rawBody = frame.responseBody;
    if (typeof rawBody !== 'string') return null;
    try {
      const body = JSON.parse(rawBody);
      if (body?.error !== 'MODEL_RESTRICTED') return null;
      const model =
        typeof body.details?.model === 'string'
          ? body.details.model
          : undefined;
      const plan =
        typeof body.details?.plan === 'string' ? body.details.plan : undefined;
      return {
        kind: 'model-restricted',
        message: body.message ?? 'This model is not available on your plan',
        model,
        plan,
      };
    } catch {
      return null;
    }
  }

  private parseProviderError(error: Error): ProviderApiError | null {
    const frame = BaseAgent.unwrapApiErrorFrame(error);
    const statusCode =
      typeof frame.statusCode === 'number' ? frame.statusCode : undefined;

    let body: Record<string, unknown> | null = null;
    if (typeof frame.responseBody === 'string') {
      try {
        body = JSON.parse(frame.responseBody);
      } catch {
        body = null;
      }
    }

    const errInBody = (body?.error ?? undefined) as
      | Record<string, unknown>
      | undefined;
    const message =
      typeof errInBody?.message === 'string'
        ? (errInBody.message as string)
        : undefined;
    const rawCode = errInBody?.code;
    const providerCode =
      typeof rawCode === 'string'
        ? rawCode
        : typeof rawCode === 'number'
          ? String(rawCode)
          : undefined;

    if (!message && statusCode === undefined && !providerCode) return null;
    return { message, statusCode, providerCode };
  }

  private isZaiBillingOrQuotaError(
    providerError: ProviderApiError | null,
    reasoningSignatureSource?: ReasoningSignatureSource,
  ): boolean {
    if (reasoningSignatureSource?.provider !== 'z-ai') return false;

    const message = providerError?.message?.toLowerCase() ?? '';
    const code = providerError?.providerCode;

    // Keep Z.ai billing/resource-package failures generic so the UI shows
    // the actionable upstream message instead of "temporarily unavailable".
    return (
      // Z.ai: { error: { code: '1113', message: 'Insufficient balance...' } }
      code === '1113' ||
      message.includes('insufficient balance') ||
      message.includes('no resource package') ||
      message.includes('please recharge')
    );
  }

  /**
   * Detect upstream-overload errors (429 rate-limits, 502/503 provider-down,
   * Anthropic `overloaded_error`). 429 is ambiguous, so provider billing or
   * quota failures are intentionally left as generic provider errors to show
   * the actionable upstream message instead of "temporarily unavailable".
   * See docs:
   * https://openrouter.ai/docs/api/reference/errors-and-debugging.mdx
   */
  private parseUpstreamOverloadError(error: Error): AgentRuntimeError | null {
    // Read the RAW (untruncated) responseBody directly off the unwrapped
    // frame. `extractApiErrorContext` truncates to 4 KB for logging, which
    // can corrupt large JSON bodies mid-object and silently skip matching.
    const frame = BaseAgent.unwrapApiErrorFrame(error);
    const statusCode =
      typeof frame.statusCode === 'number' ? frame.statusCode : undefined;

    let body: Record<string, unknown> | null = null;
    if (typeof frame.responseBody === 'string') {
      try {
        body = JSON.parse(frame.responseBody);
      } catch {
        body = null;
      }
    }

    const isOverloadStatus =
      statusCode !== undefined &&
      BaseAgent.UPSTREAM_OVERLOAD_CODES.has(statusCode);

    const errInBody = (body?.error ?? undefined) as
      | Record<string, unknown>
      | undefined;
    const isAnthropicOverload = errInBody?.type === 'overloaded_error';
    const bodyCode =
      typeof errInBody?.code === 'number' ? errInBody.code : undefined;
    const isOpenRouterOverloadBody =
      bodyCode !== undefined && BaseAgent.UPSTREAM_OVERLOAD_CODES.has(bodyCode);

    if (
      !isOverloadStatus &&
      !isAnthropicOverload &&
      !isOpenRouterOverloadBody
    ) {
      return null;
    }

    const metadata = errInBody?.metadata as Record<string, unknown> | undefined;
    const providerName =
      typeof metadata?.provider_name === 'string'
        ? (metadata.provider_name as string)
        : isAnthropicOverload
          ? 'Anthropic'
          : undefined;

    const bodyMessage =
      typeof errInBody?.message === 'string'
        ? (errInBody.message as string)
        : undefined;

    return {
      kind: 'upstream-overload',
      message: bodyMessage ?? error.message,
      providerName,
      statusCode: statusCode ?? bodyCode,
    };
  }

  private updateUsageWarning(result: StepResult<ToolSet>): void {
    const pm = result.providerMetadata as
      | Record<string, Record<string, unknown>>
      | undefined;
    const limits = pm?.clodex?.limits as
      | Array<{
          type: string;
          usedPercent: number;
          resetsAt: string;
        }>
      | undefined;
    if (!Array.isArray(limits)) return;

    const warned = limits.find(
      (w) => typeof w.usedPercent === 'number' && w.usedPercent >= 80,
    );

    // Emit telemetry only when the warning is newly surfaced or changed
    const current = this.state.get().usageWarning;
    if (
      warned &&
      (current?.windowType !== warned.type ||
        current?.usedPercent !== warned.usedPercent)
    ) {
      this.host.telemetry?.capture('usage-warning-shown', {
        agent_type: this.agentType,
        model_id: this._stepResolvedModelId || this.state.get().activeModelId,
        selected_model_id:
          this._stepRequestedModelId || this.state.get().activeModelId,
        task_role: this._stepTaskRole,
        provider_mode: this._stepProviderMode,
        window_type: warned.type,
        used_percent: warned.usedPercent,
        resets_at: warned.resetsAt,
      });
    }

    this.state.commands.setUsageWarning({
      warning: warned
        ? {
            windowType: warned.type,
            usedPercent: warned.usedPercent,
            resetsAt: warned.resetsAt,
          }
        : undefined,
    });
  }

  private report(
    error: Error,
    operation: string,
    extra?: Record<string, unknown>,
  ) {
    this.host.telemetry?.captureException(error, {
      service: 'base-agent',
      operation,
      modelId: this.state.get().activeModelId,
      agentType: this.agentType,
      instanceId: this.instanceId,
      ...BaseAgent.extractApiErrorContext(error),
      ...extra,
    });
  }

  /**
   * Removes the `strict` field from each tool definition.
   *
   * Rationale: tool factories pass `strict: false` (OpenAI-specific; ignored
   * by most other providers) so that Zod schemas with `z.any()` / unions are
   * not forced through OpenAI's strict JSON-Schema subset. However, the
   * Bedrock → Anthropic path serialises the field into the Anthropic
   * tool payload, which rejects unknown keys with
   * `tools.0.custom.strict: Extra inputs are not permitted`.
   *
   * For providers that flag `stripStrictFromTools`, we delete `strict`
   * here as the very last step before `streamText`, leaving the existing
   * `strict: false` defaults untouched for every other provider.
   */
  private stripStrictFromTools(tools: Partial<ToolSet>): Partial<ToolSet> {
    return stripStrictFromToolSet(tools);
  }

  private wrapToolsWithTiming(tools: Partial<ToolSet>): Partial<ToolSet> {
    const wrapped: Partial<ToolSet> = {};
    for (const [name, t] of Object.entries(tools)) {
      if (!t || typeof t !== 'object' || !('execute' in t) || !t.execute) {
        (wrapped as Record<string, unknown>)[name] = t;
        continue;
      }
      const originalExecute = t.execute;
      (wrapped as Record<string, unknown>)[name] = {
        ...t,
        execute: async (input: unknown, options: { toolCallId: string }) => {
          const start = Date.now();
          try {
            return await (
              originalExecute as (
                input: unknown,
                options: { toolCallId: string },
              ) => Promise<unknown>
            )(input, options);
          } finally {
            this._toolCallDurations.set(options.toolCallId, Date.now() - start);
          }
        },
      };
    }
    return wrapped;
  }

  /**
   * Wraps each tool's execute to enforce a shared per-step output budget.
   * All tool calls within a single step share one cumulative byte allowance.
   * When the budget is exhausted, later-finishing tools have their output
   * aggressively truncated, signalling the model to reduce parallelism.
   */
  private wrapToolsWithOutputBudget(
    tools: Partial<ToolSet>,
    maxBytes = 60 * 1024, // ~15k tokens
  ): Partial<ToolSet> {
    let used = 0;
    const wrapped: Partial<ToolSet> = {};

    for (const [name, t] of Object.entries(tools)) {
      if (!t || typeof t !== 'object' || !('execute' in t) || !t.execute) {
        (wrapped as Record<string, unknown>)[name] = t;
        continue;
      }
      const originalExecute = t.execute;
      (wrapped as Record<string, unknown>)[name] = {
        ...t,
        execute: async (input: unknown, options: { toolCallId: string }) => {
          const result = await (
            originalExecute as (
              input: unknown,
              options: { toolCallId: string },
            ) => Promise<unknown>
          )(input, options);

          try {
            const resultBytes = new TextEncoder().encode(
              JSON.stringify(result),
            ).length;
            const remaining = Math.max(0, maxBytes - used);

            if (resultBytes <= remaining) {
              used += resultBytes;
              return result;
            }

            // Budget exceeded — truncate this result to fit
            used += Math.min(resultBytes, remaining);
            if (remaining === 0) {
              return {
                message:
                  'Tool output omitted: combined tool output budget for this step was exceeded. ' +
                  'Reduce the number of parallel tool calls or request smaller outputs.',
              };
            }
            return capToolOutput(result, { maxBytes: remaining }).result;
          } catch (err) {
            // If size measurement fails (e.g. circular refs), let the
            // result through unmodified — over-budget is better than
            // crashing a successful tool call.
            this.report(err as Error, 'wrapToolsWithOutputBudget', {
              toolName: name,
              toolCallId: options.toolCallId,
            });
            return result;
          }
        },
      };
    }
    return wrapped;
  }

  private emitToolCallEvents(result: StepResult<ToolSet>): void {
    const modelId = this._stepResolvedModelId || this.state.get().activeModelId;
    const isFull = this.host.telemetry?.level === 'full';

    for (const part of result.content) {
      if (part.type !== 'tool-result' && part.type !== 'tool-error') continue;
      if (part.toolName === 'finish') continue;

      const inputObj =
        typeof part.input === 'object' && part.input !== null ? part.input : {};
      const inputKeys = Object.keys(inputObj as Record<string, unknown>);
      let inputSummary: string | undefined;
      if (isFull) {
        try {
          inputSummary = JSON.stringify(part.input).slice(0, 2048);
        } catch {}
      }

      const durationMs = this._toolCallDurations.get(part.toolCallId);
      this.recordToolEvidence(part, durationMs);

      if (part.type === 'tool-result') {
        this.host.telemetry?.capture('tool-call-executed', {
          tool_name: part.toolName,
          agent_type: this.agentType,
          agent_instance_id: this.instanceId,
          model_id: modelId,
          selected_model_id:
            this._stepRequestedModelId || this.state.get().activeModelId,
          task_role: this._stepTaskRole,
          success: true,
          input_keys: inputKeys,
          input_summary: inputSummary,
          duration_ms: durationMs,
        });
      } else {
        this.host.telemetry?.capture('tool-call-executed', {
          tool_name: part.toolName,
          agent_type: this.agentType,
          agent_instance_id: this.instanceId,
          model_id: modelId,
          selected_model_id:
            this._stepRequestedModelId || this.state.get().activeModelId,
          task_role: this._stepTaskRole,
          success: false,
          error_message: String(part.error).slice(0, 500),
          input_keys: inputKeys,
          input_summary: inputSummary,
          duration_ms: durationMs,
        });
      }
    }

    this._toolCallDurations.clear();
  }

  private recordToolEvidence(
    part: Extract<
      StepResult<ToolSet>['content'][number],
      { type: 'tool-result' | 'tool-error' }
    >,
    durationMs: number | undefined,
  ): void {
    const input = asRecord(part.input);
    const basePayload: Record<string, EvidenceMemoryJson> = {
      toolName: part.toolName,
      toolCallId: part.toolCallId,
      durationMs: durationMs ?? null,
    };
    const toolSource = {
      source: 'tool_call',
      sourceId: part.toolCallId,
    };
    this.recordEvidenceEvent('tool_started', basePayload, {
      ...toolSource,
      ingestionKey: `tool:${part.toolCallId}:started`,
      timestamp:
        durationMs === undefined
          ? undefined
          : Math.max(0, Date.now() - durationMs),
    });
    if (part.type === 'tool-error') {
      this.recordEvidenceEvent(
        'tool_failed',
        {
          ...basePayload,
          error: String(part.error).slice(0, 4_096),
        },
        {
          ...toolSource,
          ingestionKey: `tool:${part.toolCallId}:failed`,
        },
      );
      return;
    }

    const output = asRecord(part.output);
    this.recordEvidenceEvent('tool_completed', basePayload, {
      ...toolSource,
      ingestionKey: `tool:${part.toolCallId}:completed`,
    });
    const path =
      firstString(input, ['path', 'file_path', 'filePath', 'source']) ?? null;
    const destination =
      firstString(input, ['destination', 'destination_path', 'target']) ?? null;
    if (['read', 'getFileSkeleton', 'getSymbolBody'].includes(part.toolName)) {
      this.recordEvidenceEvent(
        'file_read',
        {
          ...basePayload,
          path,
          symbol: firstString(input, ['symbol', 'symbol_name', 'name']) ?? null,
        },
        {
          ...toolSource,
          ingestionKey: `tool:${part.toolCallId}:file-read`,
        },
      );
      return;
    }
    if (['write', 'multiEdit', 'copy'].includes(part.toolName)) {
      this.recordEvidenceEvent(
        'file_written',
        {
          ...basePayload,
          path: destination ?? path,
          sourcePath: part.toolName === 'copy' ? path : null,
        },
        {
          ...toolSource,
          ingestionKey: `tool:${part.toolCallId}:file-written`,
        },
      );
      return;
    }
    if (part.toolName === 'delete') {
      this.recordEvidenceEvent(
        'file_deleted',
        {
          ...basePayload,
          path,
        },
        {
          ...toolSource,
          ingestionKey: `tool:${part.toolCallId}:file-deleted`,
        },
      );
      return;
    }
    if (part.toolName === 'getLintingDiagnostics') {
      this.recordEvidenceEvent(
        'lint_completed',
        {
          ...basePayload,
          paths: jsonStringArray(input.paths),
          summary: jsonScalarRecord(output.summary),
        },
        {
          ...toolSource,
          ingestionKey: `tool:${part.toolCallId}:lint`,
        },
      );
      return;
    }
    if (part.toolName !== 'executeShellCommand') return;

    const command = firstString(input, ['command']) ?? '';
    const exitCode = firstNumber(output, ['exit_code', 'exitCode']);
    const shellPayload: Record<string, EvidenceMemoryJson> = {
      ...basePayload,
      command: command.slice(0, 16_384),
      explanation: firstString(input, ['explanation'])?.slice(0, 2_048) ?? null,
      exitCode,
      timedOut: firstBoolean(output, ['timed_out', 'timedOut']) ?? false,
    };
    this.recordEvidenceEvent('shell_executed', shellPayload, {
      ...toolSource,
      ingestionKey: `tool:${part.toolCallId}:shell`,
    });
    const specializedType = classifyVerificationCommand(command);
    if (specializedType) {
      this.recordEvidenceEvent(specializedType, shellPayload, {
        ...toolSource,
        ingestionKey: `tool:${part.toolCallId}:${specializedType}`,
      });
    }
  }

  /**
   * Must be called when the agent is torn down (deleted or closed) to clean up/ free resources (e.g. sandbox memory, state, etc.).
   */
  public async onTeardown(): Promise<void> {
    if (this._memoryWriteTimer) {
      clearTimeout(this._memoryWriteTimer);
      this._memoryWriteTimer = null;
    }
    const pendingMemoryWriteReason = this._pendingMemoryWriteReason;
    if (this.config.persistent && pendingMemoryWriteReason) {
      this._pendingMemoryWriteReason = null;
      try {
        await this.flushMemorySnapshotWrite(pendingMemoryWriteReason);
      } catch (error) {
        this.handleMemorySnapshotWriteFailure(
          pendingMemoryWriteReason,
          error,
          'teardown',
        );
      }
    }
    void this.toolbox.clearAgentTracking(this.instanceId);
    // NOTE: `fileReadCacheService` is app-wide and owned by bootstrap;
    // do not tear it down from an individual agent instance.
  }
}

function singleChunkUiStream(
  chunk: InferUIMessageChunk<AgentMessage>,
): AsyncIterableStream<InferUIMessageChunk<AgentMessage>> {
  const source = new ReadableStream<InferUIMessageChunk<AgentMessage>>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const stream = source as AsyncIterableStream<
    InferUIMessageChunk<AgentMessage>
  >;
  (
    stream as unknown as {
      [Symbol.asyncIterator]: () => AsyncIterator<
        InferUIMessageChunk<AgentMessage>
      >;
    }
  )[Symbol.asyncIterator] = () => {
    const reader = source.getReader();
    const iterator: AsyncIterator<InferUIMessageChunk<AgentMessage>> &
      AsyncIterable<InferUIMessageChunk<AgentMessage>> = {
      async next() {
        const result = await reader.read();
        if (result.done) {
          reader.releaseLock();
          return { done: true, value: undefined };
        }
        return { done: false, value: result.value };
      },
      async return() {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  };
  return stream;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    if (typeof value[key] === 'string') return value[key];
  }
  return null;
}

function firstNumber(
  value: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) {
      return value[key];
    }
  }
  return null;
}

function firstBoolean(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean | null {
  for (const key of keys) {
    if (typeof value[key] === 'boolean') return value[key];
  }
  return null;
}

function jsonStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function jsonScalarRecord(value: unknown): Record<string, EvidenceMemoryJson> {
  const record = asRecord(value);
  const result: Record<string, EvidenceMemoryJson> = {};
  for (const [key, item] of Object.entries(record)) {
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      result[key] = item;
    }
  }
  return result;
}

function classifyVerificationCommand(
  command: string,
): 'test_completed' | 'typecheck_completed' | 'lint_completed' | null {
  const normalized = command.toLowerCase();
  if (
    /\b(typecheck|type-check|tsc(?:\s|$))/.test(normalized) ||
    normalized.includes('check-types')
  ) {
    return 'typecheck_completed';
  }
  if (
    /\b(lint|eslint|biome|ruff|golangci-lint|shellcheck)(?:\s|$)/.test(
      normalized,
    )
  ) {
    return 'lint_completed';
  }
  if (
    /\b(vitest|jest|pytest|cargo\s+test|go\s+test|pnpm\s+test|npm\s+test|yarn\s+test)(?:\s|$)/.test(
      normalized,
    )
  ) {
    return 'test_completed';
  }
  return null;
}
