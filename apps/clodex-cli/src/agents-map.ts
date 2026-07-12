import { AgentTypes } from '@clodex/agent-core/types/agent';
import type { ChatAgent, WorkspaceMdAgent } from '@clodex/agent-core/agents';

declare module '@clodex/agent-core/agents' {
  interface AgentTypeMap {
    [AgentTypes.CHAT]: typeof ChatAgent;
    [AgentTypes.WORKSPACE_MD]: typeof WorkspaceMdAgent;
  }
}
