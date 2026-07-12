import type { StepResult, Tool, ToolSet } from 'ai';
import { z } from 'zod';
import { BaseAgent, type BaseAgentConfig } from '../base-agent';
import { AgentTypes } from '../../types/agent';
import { isPlanPath } from '../../plans/ownership';
import type { WriteToolInput } from '../../types/tools';
import { buildChatSystemPrompt } from './system-prompt-builder/system-prompt-builder';

/**
 * Primary chat agent. Host registers this class on {@link AgentTypeRegistry}.
 */
export class ChatAgent extends BaseAgent<never, undefined> {
  public static readonly agentType: AgentTypes = AgentTypes.CHAT;
  public static readonly config = {
    persistent: true,
    defaultModelId: 'claude-sonnet-4.6',
    allowModelSelection: true,
    requiredCapabilities: {
      inputModalities: {
        text: true,
        image: true,
        video: false,
        audio: false,
        file: true,
      },
      outputModalities: {
        text: true,
        image: false,
        video: false,
        audio: false,
        file: false,
      },
      toolCalling: true,
    },
    finishToolOutputSchema: undefined,
    allowUserInput: true,
    generateTitles: true,
    updateTitlesEveryNUserMessages: 20,
    historyCompressionThreshold: 0.5,
    minUncompressedMessages: 12, // We keep this relatively high to ensure we always have enough turns for full context for the agent
  } satisfies BaseAgentConfig<never>;

  protected getSystemPrompt(): string {
    const basePrompt = buildChatSystemPrompt({
      host: this.host,
      domainAdapterRegistry: this.domainAdapterRegistry,
      agentType: this.agentType,
    });
    const selectedModelId = this.getActiveModelId();
    const selectedModelDisplayName = getModelDisplayName(selectedModelId);
    const currentModelId = this.getCurrentStepModelId();
    const currentModelDisplayName = getModelDisplayName(currentModelId);
    const englishModelIdentityAnswer = `I'm ${currentModelDisplayName} (\`${currentModelId}\`), running in Clodex IDE.`;
    const russianModelIdentityAnswer = `Я модель ${currentModelDisplayName} (\`${currentModelId}\`), работающая в среде Clodex IDE.`;
    const runtimeContext = [
      '<clodex-runtime>',
      'Product identity: Clodex IDE.',
      `Selected chat model: ${escapePromptText(selectedModelDisplayName)} (\`${escapePromptText(selectedModelId)}\`).`,
      `Current routed request model: ${escapePromptText(currentModelDisplayName)} (\`${escapePromptText(currentModelId)}\`).`,
      'Model requests are routed through the selected Clodex key and the Clodex OpenAI-compatible endpoint.',
      'The current routed model name and ID are not confidential.',
      `If the user asks who you are or what model you are, answer directly in the user's language. English: "${escapePromptText(englishModelIdentityAnswer)}" Russian: "${escapePromptText(russianModelIdentityAnswer)}"`,
      'Do not refuse model identity questions. Do not say that you cannot disclose the underlying model. Do not claim to be stage or clodex.',
      '</clodex-runtime>',
    ].join('\n');

    return `${basePrompt}\n${runtimeContext}`;
  }

  /**
   * Stop generation after the agent creates a new plan file.
   *
   * When the step contains a `write` tool result whose path matches `plans/*.md`
   * (i.e. the file was just created, not updated), we return `false`
   * so the agent goes idle and the plan-creation tool part is the
   * last visible element in the chat.
   */
  protected onStepFinished(result: StepResult<ToolSet>): boolean {
    for (const tr of result.toolResults) {
      if (tr.toolName !== 'write') continue;

      const input = tr.input as WriteToolInput;
      if (!isPlanPath(input.path)) continue;

      // Plan was created or updated — stop so the UI can present it cleanly.
      return false;
    }

    return true;
  }

  /**
   * Template hook for host-specific tools (browser, shell, sandbox, …).
   *
   * Subclasses override this to inject the tools their host implements
   * (e.g. `executeSandboxJs`, `executeShellCommand`). The base
   * {@link ChatAgent} returns an empty record so it remains
   * host-agnostic and works in headless hosts that ship only the
   * universal file-op toolset.
   *
   * Returned `null` entries (typical when the toolbox cannot satisfy a
   * tool name in the current context) are filtered out by
   * {@link ChatAgent.getTools} after merging.
   */
  protected async getAdditionalTools(): Promise<Record<string, Tool | null>> {
    return {};
  }

  protected async getTools(): Promise<Partial<ToolSet>> {
    const id = this.instanceId;
    const box = this.toolbox;
    const workspaceMdRelativePath = this.host.workspaceMdRelativePath();
    const baseline: Record<string, Tool | null> = {
      read: await box.getTool('read', id),
      getFileSkeleton: await box.getTool('getFileSkeleton', id),
      getSymbolBody: await box.getTool('getSymbolBody', id),
      searchProjectSymbols: await box.getTool('searchProjectSymbols', id),
      write: await box.getTool('write', id),
      copy: await box.getTool('copy', id),
      multiEdit: await box.getTool('multiEdit', id),
      delete: await box.getTool('delete', id),
      glob: await box.getTool('glob', id),
      grepSearch: await box.getTool('grepSearch', id),
      addMemory: await box.getTool('addMemory', id),
      listMemories: await box.getTool('listMemories', id),
      readMemory: await box.getTool('readMemory', id),
      searchMemories: await box.getTool('searchMemories', id),
      deleteMemory: await box.getTool('deleteMemory', id),
      updateWorkspaceMd: this.getSpawnChildAgentTool(
        `Triggers an update of the \`${workspaceMdRelativePath}\` file. Use this whenever you find that the content of the file \`${workspaceMdRelativePath}\` in the system context is outdated or needs to be updated. Provide a brief reason for the update. Most importantly, provide the mount prefix of the workspace to update.`,
        z.object({
          updateReason: z.string().min(5),
          mountPrefix: z.string().min(1),
        }),
        AgentTypes.WORKSPACE_MD,
        (input) => {
          return {
            updateReason: input.updateReason,
            mountPrefix: input.mountPrefix,
            parentAgentInstanceId: this.instanceId,
          };
        },
        'asynchronous',
      ),
    };
    const extra = await this.getAdditionalTools();
    return Object.fromEntries(
      Object.entries({ ...baseline, ...extra }).filter(
        ([, tool]) => tool !== null,
      ),
    ) as Partial<ToolSet>;
  }
}

function escapePromptText(value: string): string {
  return value.replace(/[<>&]/g, (char) => {
    switch (char) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      default:
        return char;
    }
  });
}

function getModelDisplayName(modelId: string): string {
  const normalized = modelId.trim();
  if (!normalized) {
    return modelId;
  }

  const withoutProvider = normalized.split('/').at(-1) ?? normalized;
  const knownFamilies = [
    { pattern: /^(?:claude[-_])?opus[-_](\d+(?:[.-]\d+)*)$/i, name: 'Opus' },
    {
      pattern: /^(?:claude[-_])?sonnet[-_](\d+(?:[.-]\d+)*)$/i,
      name: 'Sonnet',
    },
    { pattern: /^(?:claude[-_])?haiku[-_](\d+(?:[.-]\d+)*)$/i, name: 'Haiku' },
  ];

  for (const { pattern, name } of knownFamilies) {
    const match = withoutProvider.match(pattern);
    if (match?.[1] != null) {
      return `${name} ${formatModelVersion(match[1])}`;
    }
  }

  if (/^gpt[-_]/i.test(withoutProvider)) {
    return withoutProvider
      .replace(/^gpt/i, 'GPT')
      .split(/[-_]/)
      .map((part, index) => (index === 0 ? part : titleCase(part)))
      .join('-')
      .replace(/-Mini$/i, ' Mini');
  }

  return normalized;
}

function formatModelVersion(version: string): string {
  const parts = version.split(/[.-]/);
  if (parts.length <= 2) {
    return parts.join('.');
  }
  return `${parts.slice(0, -1).join('.')}-${parts.at(-1)}`;
}

function titleCase(value: string): string {
  return value.length > 0
    ? `${value.charAt(0).toUpperCase()}${value.slice(1).toLowerCase()}`
    : value;
}
