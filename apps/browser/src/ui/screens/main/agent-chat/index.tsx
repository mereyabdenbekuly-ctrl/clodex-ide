import { Chat } from './chat';
import {
  ResizablePanel,
  type ImperativePanelHandle,
} from '@clodex/stage-ui/components/resizable';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSidebarCollapsed } from '../_components/sidebar-collapsed-context';
import { SidebarTitlebarRow } from '../_components/sidebar-titlebar-row';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { useEmptyAgentId } from '@ui/hooks/use-empty-agent';
import { usePendingRemovals } from '@ui/hooks/use-pending-agent-removals';
import { useTrack } from '@ui/hooks/use-track';
import { EMPTY_MOUNTS } from '@shared/karton-contracts/ui';
import { AgentChatTitlebar } from './agent-chat-titlebar';
import type { StoredAgentPreview } from '@shared/karton-contracts/ui/agent';
import { resolveFeatureGate } from '@shared/feature-gates';
import { TeleportControl } from './teleport-control';

type AgentChatProps = {
  topRightActions?: ReactNode;
  defaultSize?: number;
  minSize?: number;
};

export function AgentChat({
  topRightActions,
  defaultSize = 35,
  minSize = 20,
}: AgentChatProps) {
  const panelRef = useRef<ImperativePanelHandle>(null);
  const previousSizeRef = useRef<number | null>(null);
  const { collapsed } = useSidebarCollapsed();
  const [openAgent, setOpenAgent] = useOpenAgent();
  const createAgent = useKartonProcedure((p) => p.agents.create);
  const setLastOpenAgentId = useKartonProcedure(
    (p) => p.browser.setLastOpenAgentId,
  );
  const getStoredInstance = useKartonProcedure(
    (p) => p.agents.getStoredInstance,
  );
  const resumeAgent = useKartonProcedure((p) => p.agents.resume);
  const unarchiveAgent = useKartonProcedure((p) => p.agents.unarchive);
  const track = useTrack();
  const [lineage, setLineage] = useState<{
    source: StoredAgentPreview;
    sourceMessageId: string | null;
  } | null>(null);

  const agentTitle = useKartonState((s) =>
    openAgent ? s.agents.instances[openAgent]?.state.title : undefined,
  );
  const teleportState = useKartonState((s) =>
    openAgent ? s.cloudTasks.teleportByAgentId[openAgent] : undefined,
  );
  const cloudTasksEnabled = useKartonState(
    (s) =>
      resolveFeatureGate(
        'cloud-tasks',
        s.preferences.featureGates.overrides,
        __APP_RELEASE_CHANNEL__,
      ).enabled,
  );
  const continueLocally = useKartonProcedure(
    (p) => p.cloudTasks.continueLocally,
  );
  const resumeInCloud = useKartonProcedure((p) => p.cloudTasks.resumeInCloud);
  const retryMemorySync = useKartonProcedure(
    (p) => p.cloudTasks.retryMemorySync,
  );
  const resolveMemoryDivergence = useKartonProcedure(
    (p) => p.cloudTasks.resolveMemoryDivergence,
  );
  const exportMemorySyncDiagnostics = useKartonProcedure(
    (p) => p.cloudTasks.exportMemorySyncDiagnostics,
  );

  const openAgentModelId = useKartonState((s) =>
    openAgent
      ? (s.agents.instances[openAgent]?.state.activeModelId ?? null)
      : null,
  );
  const openAgentToolApprovalMode = useKartonState((s) =>
    openAgent
      ? (s.agents.instances[openAgent]?.state.toolApprovalMode ?? null)
      : null,
  );
  const currentMounts = useKartonState((s) =>
    openAgent
      ? (s.toolbox[openAgent]?.workspace?.mounts ?? EMPTY_MOUNTS)
      : EMPTY_MOUNTS,
  );

  // Ref snapshots so the callback isn't re-created on every state change.
  const openAgentModelIdRef = useRef(openAgentModelId);
  openAgentModelIdRef.current = openAgentModelId;
  const openAgentToolApprovalModeRef = useRef(openAgentToolApprovalMode);
  openAgentToolApprovalModeRef.current = openAgentToolApprovalMode;
  const currentMountPathsRef = useRef(currentMounts.map((m) => m.path));
  currentMountPathsRef.current = currentMounts.map((m) => m.path);

  const [, emptyAgentIdRef] = useEmptyAgentId();

  useEffect(() => {
    let cancelled = false;
    setLineage(null);
    if (!openAgent) return;

    void (async () => {
      const current = await getStoredInstance(openAgent);
      if (cancelled || !current?.forkedFromAgentId) return;

      const source = await getStoredInstance(current.forkedFromAgentId);
      if (cancelled || !source) return;
      setLineage({
        source,
        sourceMessageId: current.forkedFromMessageId,
      });
    })().catch((error) => {
      if (!cancelled) {
        console.error('Failed to load task lineage:', error);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [getStoredInstance, openAgent]);

  const { pending: pendingRemovals } = usePendingRemovals();
  const pendingRemovalsRef = useRef(pendingRemovals);
  pendingRemovalsRef.current = pendingRemovals;

  // Pending guard: prevents duplicate blank chats on rapid clicks.
  const [pendingCreate, setPendingCreate] = useState(false);

  const handleCreateChat = useCallback(() => {
    if (pendingCreate) return;
    void track('chat-new-agent-clicked', {
      source: 'collapsed-titlebar',
    });

    // Reuse an existing empty agent instead of creating a new one.
    const existingEmpty = emptyAgentIdRef.current;
    if (existingEmpty && !pendingRemovalsRef.current.has(existingEmpty)) {
      setOpenAgent(existingEmpty);
      void setLastOpenAgentId(existingEmpty);
      return;
    }

    setPendingCreate(true);
    const currentModelId = openAgentModelIdRef.current ?? undefined;
    const currentToolApprovalMode =
      openAgentToolApprovalModeRef.current ?? undefined;
    const paths = currentMountPathsRef.current;
    void createAgent(
      undefined,
      currentModelId,
      currentToolApprovalMode,
      paths.length > 0 ? paths : undefined,
    )
      .then((id) => {
        setOpenAgent(id);
        setPendingCreate(false);
        void setLastOpenAgentId(id);
      })
      .catch((err) => {
        console.error('Failed to create agent:', err);
        setPendingCreate(false);
      });
  }, [pendingCreate, createAgent, emptyAgentIdRef, setOpenAgent, track]);

  const handleOpenLineageSource = useCallback(() => {
    if (!lineage) return;
    void (async () => {
      if (lineage.source.archivedAt) {
        await unarchiveAgent(lineage.source.id);
      }
      setOpenAgent(lineage.source.id);
      await setLastOpenAgentId(lineage.source.id);
      await resumeAgent(lineage.source.id);
    })().catch((error) => {
      console.error('Failed to open fork source task:', error);
    });
  }, [lineage, resumeAgent, setLastOpenAgentId, setOpenAgent, unarchiveAgent]);

  return (
    <ResizablePanel
      ref={panelRef}
      id="sidebar-panel"
      order={1}
      defaultSize={defaultSize}
      minSize={minSize}
      maxSize={80}
      onResize={(size) => {
        if (size > 0) previousSizeRef.current = size;
      }}
      className="@container group overflow-visible! relative z-10 flex h-full flex-col items-stretch justify-between bg-token-main-surface-primary"
    >
      {collapsed && topRightActions && (
        <div
          data-tutorial="new-tab-buttons"
          className="app-no-drag pointer-events-auto absolute top-1 right-2 z-30 flex h-8 items-center gap-0 rounded-xl"
        >
          {topRightActions}
        </div>
      )}
      {collapsed && (
        <SidebarTitlebarRow
          absolute
          sidebarCollapsed
          agentTitle={agentTitle}
          onCreateChat={handleCreateChat}
        />
      )}
      {!collapsed && (
        <AgentChatTitlebar
          agentTitle={agentTitle}
          actions={topRightActions}
          teleport={
            openAgent && cloudTasksEnabled && teleportState ? (
              <TeleportControl
                state={teleportState}
                onContinueLocally={() => continueLocally(openAgent)}
                onResumeInCloud={() => resumeInCloud(openAgent)}
                onRetryMemorySync={() => retryMemorySync(openAgent)}
                onResolveMemoryDivergence={(strategy) =>
                  resolveMemoryDivergence(openAgent, strategy)
                }
                onExportMemorySyncDiagnostics={() =>
                  exportMemorySyncDiagnostics(openAgent)
                }
              />
            ) : null
          }
          lineage={
            lineage
              ? {
                  sourceTitle: lineage.source.title,
                  sourceMessageId: lineage.sourceMessageId,
                  onOpenSource: handleOpenLineageSource,
                }
              : null
          }
        />
      )}
      <div className="flex h-full flex-col items-stretch justify-between px-1 pb-1">
        <Chat />
      </div>
    </ResizablePanel>
  );
}
