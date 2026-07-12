import { AgentTypes } from '@shared/karton-contracts/ui/agent';
import { WorkspaceMdAgent } from '@clodex/agent-core/agents';
import { BrowserChatAgent } from './chat/chat';
import { BrowserMagusAgent } from './magus/magus';

/**
 * Augment the package-side `AgentTypeMap` so `AgentCtor<T>` and the
 * generics on `BaseAgent.spawnChildAgentHandler` /
 * `BaseAgentDependencies` resolve to the concrete browser-host agent
 * constructors. See `@clodex/agent-core/agents` for the augmentation
 * contract.
 */
declare module '@clodex/agent-core/agents' {
  interface AgentTypeMap {
    [AgentTypes.CHAT]: typeof BrowserChatAgent;
    [AgentTypes.MAGUS]: typeof BrowserMagusAgent;
    [AgentTypes.WORKSPACE_MD]: typeof WorkspaceMdAgent;
  }
}

/**
 * Re-export the (now host-augmented) map so existing callers can
 * import `AgentTypeMap` from this module without reaching into the
 * core package directly.
 */
export type { AgentTypeMap } from '@clodex/agent-core/agents';

/**
 * Runtime registry of agent constructors keyed by `AgentTypes`. Used
 * for static `.config` lookups (`AgentsMap[type].config.…`). The
 * cross-cutting `AgentTypeRegistry` instance is built in
 * `agents-registry.ts` for `BaseAgent.spawnChildAgentHandler`.
 */
export const AgentsMap = {
  [AgentTypes.CHAT]: BrowserChatAgent,
  [AgentTypes.MAGUS]: BrowserMagusAgent,
  [AgentTypes.WORKSPACE_MD]: WorkspaceMdAgent,
} as const;
