import { AgentTypes } from '@shared/karton-contracts/ui/agent';
import {
  ChatAgent,
  type BaseAgentConfig,
  type BaseAgentToolboxView,
} from '@clodex/agent-core/agents';

type BrowserToolboxView = BaseAgentToolboxView & {
  getClodexMcpTools?: (agentInstanceId: string) => Promise<Record<string, any>>;
};

/**
 * Magus is the visible OpenManus-flavoured agent surface. It keeps the normal
 * chat UX, mounts and approvals, but strongly prefers delegating long
 * autonomous work to the bundled OpenManus runtime through `runOpenManus`.
 */
export class BrowserMagusAgent extends ChatAgent {
  public static readonly agentType: AgentTypes = AgentTypes.MAGUS;
  public static readonly config = {
    ...ChatAgent.config,
    defaultModelId: 'gpt-5.5',
  } satisfies BaseAgentConfig<never>;

  protected async getAdditionalTools(): Promise<Record<string, any>> {
    const id = this.instanceId;
    const box = this.toolbox as BrowserToolboxView;
    const clodexMcpTools = (await box.getClodexMcpTools?.(id)) ?? {};
    return {
      executeSandboxJs: await box.getTool('executeSandboxJs', id),
      listLibraryDocs: await box.getTool('listLibraryDocs', id),
      searchInLibraryDocs: await box.getTool('searchInLibraryDocs', id),
      getLintingDiagnostics: await box.getTool('getLintingDiagnostics', id),
      readConsoleLogs: await box.getTool('readConsoleLogs', id),
      askUserQuestions: await box.getTool('askUserQuestions', id),
      runOpenManus: await box.getTool('runOpenManus', id),
      createShellSession: await box.getTool('createShellSession', id),
      executeShellCommand: await box.getTool('executeShellCommand', id),
      ...clodexMcpTools,
    };
  }

  protected getSystemPrompt(): string {
    return `${super.getSystemPrompt()}

<magus-agent>
You are Magus, the OpenManus autonomous agent inside Clodex IDE.
For broad research, multi-step codebase exploration, filesystem-heavy analysis, browser-style investigation, or tasks explicitly asking for OpenManus/Magus, use the runOpenManus tool against the active workspace.
For small direct questions or tiny edits, you may answer normally with the standard Clodex tools.
When using runOpenManus, pass a clear prompt and the active workspace mount prefix. Summarize the OpenManus result for the user after the tool finishes.
</magus-agent>`;
  }
}
