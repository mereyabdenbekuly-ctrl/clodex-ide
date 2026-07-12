import { EMPTY_MOUNTS } from '@shared/karton-contracts/ui';
import type { AgentMessage } from '@shared/karton-contracts/ui/agent';
import { getAvailableModel } from '@shared/available-models';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import { generateId } from '@ui/utils';
import { getWorkspaceDisplayLabel } from '@ui/utils/workspace-display';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuickTask } from './quick-task-context';
import {
  QuickTaskComposer,
  type QuickTaskComposerSubmitResult,
} from './quick-task-composer';

const quickTaskModalActiveAttribute = 'data-quick-task-modal-active';

export function QuickTaskOverlay() {
  const { isOpen, initialPrompt, close } = useQuickTask();
  const [openAgent, setOpenAgent] = useOpenAgent();
  const createAgent = useKartonProcedure((p) => p.agents.create);
  const sendUserMessage = useKartonProcedure((p) => p.agents.sendUserMessage);
  const setLastOpenAgentId = useKartonProcedure(
    (p) => p.browser.setLastOpenAgentId,
  );
  const returnToMain = useKartonProcedure((p) => p.appScreen.closeProjects);
  const draftAgentIdRef = useRef<string | null>(null);
  const completedAgentIdRef = useRef<string | null>(null);

  const currentAgentState = useKartonState((state) =>
    openAgent ? state.agents.instances[openAgent]?.state : undefined,
  );
  const currentMounts = useKartonState((state) =>
    openAgent
      ? (state.toolbox[openAgent]?.workspace?.mounts ?? EMPTY_MOUNTS)
      : EMPTY_MOUNTS,
  );
  const currentModel = currentAgentState?.activeModelId
    ? getAvailableModel(currentAgentState.activeModelId)
    : undefined;
  const workspaceLabels = useMemo(
    () => currentMounts.map(getWorkspaceDisplayLabel),
    [currentMounts],
  );

  useEffect(() => {
    if (!isOpen) return;
    draftAgentIdRef.current = null;
    completedAgentIdRef.current = null;
    document.body.setAttribute(quickTaskModalActiveAttribute, '');
    return () => {
      document.body.removeAttribute(quickTaskModalActiveAttribute);
    };
  }, [isOpen]);

  const handleSubmit = useCallback(
    async (
      prompt: string,
      useCurrentWorkspace: boolean,
    ): Promise<QuickTaskComposerSubmitResult> => {
      try {
        let agentId = draftAgentIdRef.current;
        if (!agentId) {
          const workspacePaths =
            useCurrentWorkspace && currentMounts.length > 0
              ? currentMounts.map((mount) => mount.path)
              : undefined;
          agentId = await createAgent(
            undefined,
            currentAgentState?.activeModelId,
            currentAgentState?.toolApprovalMode,
            workspacePaths,
            Boolean(workspacePaths?.length),
          );
          draftAgentIdRef.current = agentId;
        }

        const message: AgentMessage & { role: 'user' } = {
          id: generateId(),
          role: 'user',
          parts: [{ type: 'text', text: prompt }],
          metadata: {
            createdAt: new Date(),
            partsMetadata: [],
            swarmMode: false,
          },
        };
        await sendUserMessage(agentId, message);
        completedAgentIdRef.current = agentId;
        draftAgentIdRef.current = null;
        return { ok: true };
      } catch (reason) {
        console.error('Failed to create quick task:', reason);
        return {
          ok: false,
          error: draftAgentIdRef.current
            ? 'The task was created, but the message could not be sent. Retry to continue in the same task.'
            : 'The quick task could not be created. Please try again.',
        };
      }
    },
    [
      createAgent,
      currentAgentState?.activeModelId,
      currentAgentState?.toolApprovalMode,
      currentMounts,
      sendUserMessage,
    ],
  );

  const handleSuccess = useCallback(() => {
    const agentId = completedAgentIdRef.current;
    completedAgentIdRef.current = null;
    if (!agentId) {
      close();
      return;
    }
    setOpenAgent(agentId);
    void setLastOpenAgentId(agentId).catch((reason) => {
      console.error('Failed to persist quick task selection:', reason);
    });
    void returnToMain().catch((reason) => {
      console.error('Failed to return to the main task screen:', reason);
    });
    close();
  }, [close, returnToMain, setLastOpenAgentId, setOpenAgent]);

  if (!isOpen) return null;

  return (
    <QuickTaskComposer
      initialPrompt={initialPrompt}
      hasCurrentWorkspace={currentMounts.length > 0}
      workspaceLabels={workspaceLabels}
      modelLabel={
        currentModel?.modelDisplayName ??
        currentAgentState?.activeModelId ??
        'Last used'
      }
      approvalLabel={currentAgentState?.toolApprovalMode ?? 'Default'}
      mode="overlay"
      onClose={close}
      onSuccess={handleSuccess}
      onSubmit={handleSubmit}
    />
  );
}
