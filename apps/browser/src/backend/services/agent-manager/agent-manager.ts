import type {
  AgentManagerStartupPolicy,
  AgentManagerToolboxPort,
  AgentNotificationEvent,
  PreparedAgentSessionCheckpointState,
  AgentStepExecutor,
  AgentStore,
  AgentMessage,
  CommandRegistry,
  CommandName,
  CommandContext,
} from '@clodex/agent-core';
import { AgentManager } from '@clodex/agent-core';
import type { AgentHost } from '@clodex/agent-core/host';
import type {
  AgentTypeRegistry,
  BaseAgentToolboxView,
  AgentStepExecution,
  AgentStepExecutionRequest,
  ToolApprovalLifecycleHooks,
} from '@clodex/agent-core/agents';
import type { ProcessedImageCacheService } from '@clodex/agent-core/processed-image-cache';
import type { FileReadCacheService } from '@clodex/agent-core/file-read-cache';
import type { AttachmentsService } from '@clodex/agent-core/attachments';
import type { AgentPersistenceDB } from '@clodex/agent-core/agent-persistence';
import type { ChatPersistenceService } from '@clodex/agent-core';
import type { DomainAdapter, DomainId } from '@clodex/agent-core/env';
import type { AgentHistoryEntry } from '@clodex/agent-core/types/agent';
import { net } from 'electron';
import { DisposableService } from '../disposable';
import type { KartonService } from '../karton';
import type { SkillDefinitionUI } from '@shared/skills';
import { renderBrowserExtraMention } from '@/agents/shared/base-agent/utils';
import type {
  DebugInspectorEvent,
  HookRunResult,
  HookTrigger,
} from '@shared/agent-os';

const AGENT_RPC_COMMANDS = [
  'agents.create',
  'agents.resume',
  'agents.sendUserMessage',
  'agents.interruptQuestionWithMessage',
  'agents.sendToolApprovalResponse',
  'agents.setToolApprovalMode',
  'agents.stop',
  'agents.flushQueue',
  'agents.clearQueue',
  'agents.deleteQueuedMessage',
  'agents.revertToUserMessage',
  'agents.replaceUserMessage',
  'agents.delete',
  'agents.fork',
  'agents.archive',
  'agents.unarchive',
  'agents.setGoal',
  'agents.setGoalStatus',
  'agents.clearGoal',
  'agents.setActiveModelId',
  'agents.setTitle',
  'agents.getAgentsHistoryList',
  'agents.getChatProjects',
  'agents.getAgentHistoryEntriesByIds',
  'agents.updateInputState',
  'agents.retryLastUserMessage',
  'agents.storeAttachment',
  'agents.storeAttachmentByPath',
  'agents.getStoredInstance',
  'agents.getTouchedFiles',
  'agents.revealWorkingDirectory',
] as const satisfies ReadonlyArray<CommandName>;

type SwarmSubmitHandler = (
  instanceId: string,
  message: AgentMessage & { role: 'user' },
) => Promise<boolean>;

export type AutomaticSwarmStepHandler = (
  request: AgentStepExecutionRequest,
) => Promise<AgentStepExecution | null>;

export function createAutomaticSwarmStepExecutor({
  delegate,
  getHandler,
}: {
  delegate: AgentStepExecutor;
  getHandler: () => AutomaticSwarmStepHandler | null;
}): AgentStepExecutor {
  return {
    async execute(request) {
      const handler = getHandler();
      if (request.context.executionTarget !== 'cloud' && handler) {
        const execution = await handler(request);
        if (execution) return execution;
      }
      return await delegate.execute(request);
    },
  };
}

export class AgentManagerService extends DisposableService {
  private readonly manager: AgentManager;
  private readonly commandRegistry: CommandRegistry;
  private readonly karton: KartonService;
  private readonly installAutomaticSwarmStepHandler:
    | ((handler: AutomaticSwarmStepHandler) => void)
    | undefined;
  private lifecycleHookRunner:
    | ((
        trigger: HookTrigger,
        context: {
          values?: Record<string, unknown>;
        },
      ) => Promise<HookRunResult>)
    | null = null;
  private debugEventSink:
    | ((event: Omit<DebugInspectorEvent, 'id' | 'createdAt'>) => void)
    | null = null;

  public constructor(
    karton: KartonService,
    commandRegistry: CommandRegistry,
    toolbox: AgentManagerToolboxPort & BaseAgentToolboxView,
    agentStore: AgentStore,
    getSkillsForSlashRedaction: () => ReadonlyArray<
      Pick<SkillDefinitionUI, 'id' | 'source'>
    >,
    startupPolicy: AgentManagerStartupPolicy,
    fileReadCacheService: FileReadCacheService,
    attachments: AttachmentsService,
    agentDb: AgentPersistenceDB,
    chatPersistence: ChatPersistenceService | undefined,
    agentCoreHost: AgentHost,
    agentTypeRegistry: AgentTypeRegistry,
    _assetCacheService: unknown,
    processedImageCacheService?: ProcessedImageCacheService,
    notificationEventHandler?: (
      event: AgentNotificationEvent,
      agentId: string,
    ) => void | Promise<void>,
    enrichHistoryEntries?: (
      entries: AgentHistoryEntry[],
    ) => Promise<AgentHistoryEntry[]>,
    stepExecutor?: AgentStepExecutor,
    installAutomaticSwarmStepHandler?: (
      handler: AutomaticSwarmStepHandler,
    ) => void,
    toolApprovalLifecycle?: ToolApprovalLifecycleHooks,
  ) {
    super();
    this.commandRegistry = commandRegistry;
    this.karton = karton;
    this.installAutomaticSwarmStepHandler = installAutomaticSwarmStepHandler;
    this.manager = new AgentManager({
      host: agentCoreHost,
      commandRegistry,
      agentTypeRegistry,
      startupPolicy,
      state: {
        store: agentStore,
      },
      storage: {
        persistenceDb: agentDb,
        chatPersistence,
        attachments,
        fileReadCache: fileReadCacheService,
        imageCache: processedImageCacheService,
      },
      tools: {
        managerToolbox: toolbox,
        agentToolbox: toolbox,
      },
      execution: {
        stepExecutor,
      },
      hooks: {
        onAgentEvent: notificationEventHandler,
        toolApprovalLifecycle,
        renderHostMention: renderBrowserExtraMention,
        skillsForSlashRedaction: getSkillsForSlashRedaction,
        enrichHistoryEntries,
        isNetworkOnline: () => net.isOnline(),
      },
    });
    this.registerKartonForwarders();
  }

  /**
   * Forwarding handle for {@link AgentManager.registerEnvAdapter}. Both
   * core-owned and host-owned env-state adapters wire in via this
   * method from the bootstrap site in `main.ts` (see
   * `registerHostEnvDomainAdapters` plus the individual core-adapter
   * `createXxxDomainAdapter(...)` registrations).
   */
  public registerEnvAdapter(adapter: DomainAdapter): void {
    this.manager.registerEnvAdapter(adapter);
  }

  /**
   * Forwarding handle for {@link AgentManager.unregisterEnvAdapter}.
   * Primarily exposed for tests and host shutdown paths.
   */
  public unregisterEnvAdapter(domainId: DomainId): void {
    this.manager.unregisterEnvAdapter(domainId);
  }

  public async generateWorkspaceMdForPath(
    workspacePath: string,
  ): Promise<void> {
    await this.manager.generateWorkspaceMdForPath(workspacePath);
  }

  public async recoverInterruptedActiveAgents(
    reason: 'system-resumed' | 'event-loop-stalled',
    details?: { stalledForMs?: number },
  ): Promise<void> {
    await this.manager.recoverInterruptedActiveAgents(reason, details);
  }

  public async retryNetworkFailedAgentsNow(reason: string): Promise<void> {
    await this.manager.retryNetworkFailedAgentsNow(reason);
  }

  public setSwarmSubmitHandler(_handler: SwarmSubmitHandler): void {
    // Compatibility registration retained for composition-root parity.
    // Swarm routing happens only after BaseAgent durably admits the user turn
    // and reaches the host AgentStepExecutor seam.
  }

  public setAutomaticSwarmStepHandler(
    handler: AutomaticSwarmStepHandler,
  ): void {
    if (!this.installAutomaticSwarmStepHandler) {
      throw new Error(
        'Automatic Swarm local-executor composition is unavailable',
      );
    }
    this.installAutomaticSwarmStepHandler(handler);
  }

  public setLifecycleHookRunner(
    runner:
      | ((
          trigger: HookTrigger,
          context: { values?: Record<string, unknown> },
        ) => Promise<HookRunResult>)
      | null,
  ): void {
    this.lifecycleHookRunner = runner;
  }

  public setDebugEventSink(
    sink:
      | ((event: Omit<DebugInspectorEvent, 'id' | 'createdAt'>) => void)
      | null,
  ): void {
    this.debugEventSink = sink;
  }

  public async dispatchCommand(
    name: CommandName,
    args: unknown[],
    callerId = 'agent-os',
  ): Promise<unknown> {
    return await this.commandRegistry.dispatch(name, { callerId }, args);
  }

  public async prepareSessionCheckpoint(
    agentInstanceId: string,
  ): Promise<PreparedAgentSessionCheckpointState> {
    return await this.manager.prepareSessionCheckpoint(agentInstanceId);
  }

  public async replayRecoveredUiChunk(
    agentInstanceId: string,
    input: Parameters<AgentManager['replayRecoveredUiChunk']>[1],
  ): Promise<'applied' | 'duplicate'> {
    return await this.manager.replayRecoveredUiChunk(agentInstanceId, input);
  }

  public async finishRecoveredUiReplay(
    agentInstanceId: string,
    input: Parameters<AgentManager['finishRecoveredUiReplay']>[1],
  ): Promise<void> {
    await this.manager.finishRecoveredUiReplay(agentInstanceId, input);
  }

  private registerKartonForwarders(): void {
    for (const name of AGENT_RPC_COMMANDS) {
      this.karton.registerServerProcedureHandler(
        name as any,
        async (callingClientId: string, ...rest: unknown[]) => {
          const startedAt = Date.now();
          this.debugEventSink?.({
            channel: 'agent',
            level: 'debug',
            message: `Agent command started: ${name}`,
          });
          try {
            if (name === 'agents.sendUserMessage') {
              const [instanceId, originalMessage] = rest as [
                string,
                AgentMessage & { role: 'user' },
              ];
              let message = originalMessage;
              const beforeTurn = await this.lifecycleHookRunner?.(
                'before-turn',
                { values: { agentInstanceId: instanceId } },
              );
              if (beforeTurn?.promptText) {
                message = structuredClone(originalMessage);
                const textPart = message.parts.find(
                  (part) => part.type === 'text',
                );
                if (textPart?.type === 'text') {
                  textPart.text = `${textPart.text}\n\n<agent-os-hooks>\n${beforeTurn.promptText}\n</agent-os-hooks>`;
                } else {
                  message.parts.push({
                    type: 'text',
                    text: `<agent-os-hooks>\n${beforeTurn.promptText}\n</agent-os-hooks>`,
                  });
                }
                rest[1] = message;
              }
            }

            const ctx: CommandContext = { callerId: callingClientId };
            const result = await this.commandRegistry.dispatch(name, ctx, rest);
            if (name === 'agents.sendUserMessage') {
              await this.lifecycleHookRunner?.('after-turn', {
                values: { agentInstanceId: rest[0] },
              });
            }
            this.debugEventSink?.({
              channel: 'agent',
              level: 'info',
              message: `Agent command completed: ${name}`,
              payload: { durationMs: Date.now() - startedAt },
            });
            return result;
          } catch (error) {
            this.debugEventSink?.({
              channel: 'agent',
              level: 'error',
              message: `Agent command failed: ${name}`,
              payload: {
                durationMs: Date.now() - startedAt,
                error: error instanceof Error ? error.message : String(error),
              },
            });
            throw error;
          }
        },
      );
    }
  }

  protected async onTeardown(): Promise<void> {
    await this.manager.teardown();
  }
}
