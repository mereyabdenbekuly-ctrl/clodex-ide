import { useCallback } from 'react';
import { useKartonProcedure, useKartonState } from './use-karton';
import { useOpenAgent } from './use-open-chat';
import { generateId } from '@ui/utils';
import type { AgentMessage } from '@shared/karton-contracts/ui/agent';
import { getSwarmModeVariant, setSwarmModeActive } from './use-swarm-mode';

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
  const isWorking = useKartonState((state) =>
    openAgentId
      ? (state.agents.instances[openAgentId]?.state.isWorking ?? false)
      : false,
  );

  return useCallback(
    (promptOverride?: string) => {
      if (!openAgentId) return;

      const swarmModeVariant = getSwarmModeVariant();
      if (swarmModeVariant) {
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
            swarmModeVariant,
          },
        };

        const didDispatchOptimisticMessage = !isWorking;
        if (didDispatchOptimisticMessage) {
          window.dispatchEvent(
            new CustomEvent('chat-message-sent', { detail: { message } }),
          );
        }
        void sendUserMessage(openAgentId, message)
          .then((result) => {
            if (
              didDispatchOptimisticMessage &&
              result.disposition === 'queued'
            ) {
              window.dispatchEvent(
                new CustomEvent('chat-message-queued', {
                  detail: { clientId: message.id },
                }),
              );
            }
            setSwarmModeActive(false);
          })
          .catch(() => {
            if (didDispatchOptimisticMessage) {
              window.dispatchEvent(
                new CustomEvent('chat-message-failed', {
                  detail: { clientId: message.id },
                }),
              );
            }
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

      // Busy agents publish the queued message through AgentStore. Rendering
      // an optimistic history item here would duplicate it when the queue
      // flushes and the durable turn is admitted.
      const didDispatchOptimisticMessage = !isWorking;
      if (didDispatchOptimisticMessage) {
        window.dispatchEvent(
          new CustomEvent('chat-message-sent', { detail: { message } }),
        );
      }

      void sendUserMessage(openAgentId, message)
        .then((result) => {
          if (didDispatchOptimisticMessage && result.disposition === 'queued') {
            window.dispatchEvent(
              new CustomEvent('chat-message-queued', {
                detail: { clientId: message.id },
              }),
            );
          }
        })
        .catch(() => {
          if (didDispatchOptimisticMessage) {
            window.dispatchEvent(
              new CustomEvent('chat-message-failed', {
                detail: { clientId: message.id },
              }),
            );
          }
        });
    },
    [isWorking, openAgentId, sendUserMessage],
  );
}
