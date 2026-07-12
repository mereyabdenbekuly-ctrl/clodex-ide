import { useCallback } from 'react';
import { useKartonProcedure } from './use-karton';
import { useOpenAgent } from './use-open-chat';
import { generateId } from '@ui/utils';
import type { AgentMessage } from '@shared/karton-contracts/ui/agent';
import { getSwarmModeActive, setSwarmModeActive } from './use-swarm-mode';

/**
 * Returns a stable callback that sends a synthetic `/implement`
 * slash-command message to the currently open agent.
 *
 * Handles:
 * - Building the `AgentMessage` with the `[/implement](slash:command:implement)` link
 * - Dispatching `chat-message-sent` for optimistic rendering + auto-scroll
 * - Calling `sendUserMessage` on the Karton procedure
 *
 * No-ops silently when no agent is open.
 */
export function useSendImplement(): (promptOverride?: string) => void {
  const [openAgentId] = useOpenAgent();
  const sendUserMessage = useKartonProcedure((p) => p.agents.sendUserMessage);
  const runSwarm = useKartonProcedure((p) => p.swarm.run);

  return useCallback(
    (promptOverride?: string) => {
      if (!openAgentId) return;

      if (getSwarmModeActive()) {
        const prompt =
          promptOverride?.trim() ||
          'Implement the active plan using the Dynamic Swarm workflow. Do not use the default sequential planner.';
        const message: AgentMessage & { role: 'user' } = {
          id: generateId(),
          role: 'user',
          parts: [{ type: 'text', text: prompt }],
          metadata: {
            createdAt: new Date(),
            partsMetadata: [],
            swarmMode: true,
          },
        };

        window.dispatchEvent(
          new CustomEvent('chat-message-sent', { detail: { message } }),
        );
        setSwarmModeActive(false);
        void runSwarm(openAgentId, prompt).catch(() => {
          window.dispatchEvent(
            new CustomEvent('chat-message-failed', {
              detail: { clientId: message.id },
            }),
          );
        });
        return;
      }

      const message: AgentMessage & { role: 'user' } = {
        id: generateId(),
        role: 'user',
        parts: [
          {
            type: 'text',
            text: '[/implement](slash:command:implement)',
          },
        ],
        metadata: {
          createdAt: new Date(),
          partsMetadata: [],
          swarmMode: false,
        },
      };

      // Dispatch for optimistic rendering + auto-scroll
      window.dispatchEvent(
        new CustomEvent('chat-message-sent', { detail: { message } }),
      );

      void sendUserMessage(openAgentId, message);
    },
    [openAgentId, runSwarm, sendUserMessage],
  );
}
