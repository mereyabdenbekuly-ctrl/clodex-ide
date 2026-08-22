import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { useTrack } from '@ui/hooks/use-track';
import { Tutorial } from '@ui/components/tutorial';
import {
  type MountEntry,
  EMPTY_MOUNTS,
  type KartonContract,
} from '@shared/karton-contracts/ui';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  executeWorkspaceGitActionByPath,
  type WorkspaceActionConfig,
} from './workspace-select-actions';
import { WorkspaceActionSelect } from './workspace-select-picker';
import { WorkspaceBadge } from './workspace-select-side-panels';
export {
  applyMountedWorkspaceActionDefault,
  createDefaultWorkspaceActionConfig,
  executeWorkspaceGitAction,
  executeWorkspaceGitActionByPath,
  toWorkspaceActionPayload,
  type WorkspaceAction,
  type WorkspaceActionConfig,
  type WorkspaceActionPayload,
  type WorkspaceGitActionExecutionResult,
} from './workspace-select-actions';
import {
  ConnectWorkspaceSelect,
  type ConnectMountResult,
} from './workspace-select-connect';

const _EMPTY_SKILLS: string[] = [];
type KartonState = KartonContract['state'];
type KartonProcedures = KartonContract['serverProcedures'];

// ============================================================================
// Workspace strip
// ============================================================================

interface WorkspaceSelectProps {
  onWorkspaceChange?: () => void;
  /**
   * When true (chat history is empty), each git-rooted workspace badge is
   * replaced by a `WorkspaceActionSelect` combined trigger that exposes a
   * worktree/branch action picker for the upcoming message.
   */
  chatIsEmpty: boolean;
  workspaceActionConfigs?: ReadonlyMap<string, WorkspaceActionConfig>;
  onWorkspaceActionConfigChange?: (
    mount: MountEntry,
    config: WorkspaceActionConfig,
  ) => void;
}

export const WorkspaceSelect = memo(function WorkspaceSelect({
  onWorkspaceChange,
  chatIsEmpty,
  workspaceActionConfigs,
  onWorkspaceActionConfigChange,
}: WorkspaceSelectProps) {
  const [openAgent] = useOpenAgent();
  const [openWorkspaceActionPrefixes, setOpenWorkspaceActionPrefixes] =
    useState<Set<string>>(() => new Set());

  const recentlyOpenedWorkspaces = useKartonState(
    (s: KartonState) =>
      s.userExperience.storedExperienceData.recentlyOpenedWorkspaces,
  );
  const mountWorkspace = useKartonProcedure(
    (p: KartonProcedures) => p.toolbox.mountWorkspace,
  );
  const createGitWorktreeByPath = useKartonProcedure(
    (p: KartonProcedures) => p.toolbox.createGitWorktreeByPath,
  );
  const createGitBranchByPath = useKartonProcedure(
    (p: KartonProcedures) => p.toolbox.createGitBranchByPath,
  );
  const switchGitBranchByPath = useKartonProcedure(
    (p: KartonProcedures) => p.toolbox.switchGitBranchByPath,
  );
  const unmountWorkspace = useKartonProcedure(
    (p: KartonProcedures) => p.toolbox.unmountWorkspace,
  );
  const track = useTrack();
  const allMounts = useKartonState((s: KartonState) =>
    openAgent
      ? (s.toolbox[openAgent]?.workspace?.mounts ?? EMPTY_MOUNTS)
      : EMPTY_MOUNTS,
  );
  const mountedPaths = useMemo(
    () => new Set<string>(allMounts.map((mount: MountEntry) => mount.path)),
    [allMounts],
  );
  const pendingConnectActionConfigsRef = useRef<
    Array<{
      id: number;
      path: string | undefined;
      config: WorkspaceActionConfig;
      previousPrefixes: ReadonlySet<string>;
    }>
  >([]);
  const pendingConnectActionIdRef = useRef(0);

  // Live ref of the mount count. We assign it during render so callbacks can
  // read the latest count after mountWorkspace() resolves without stale state.
  const allMountsCountRef = useRef(allMounts.length);
  allMountsCountRef.current = allMounts.length;

  const trackMountOutcome = useCallback(
    async (
      promise: Promise<void>,
      source: 'picker' | 'recent-workspace',
    ): Promise<boolean> => {
      const before = allMountsCountRef.current;
      try {
        await promise;
      } catch {
        track('workspace-connect-failed', { source });
        return false;
      }
      // A mount is considered successful if the count grew. If it stayed the
      // same and the user went through the picker, they closed it without
      // selecting. The recent-workspace path cannot be aborted the same way,
      // so we only track an abort for the picker case.
      if (allMountsCountRef.current > before) {
        track('workspace-connect-finished');
        return true;
      }
      if (source === 'picker') {
        track('workspace-connect-aborted', { reason: 'picker-closed' });
      }
      return false;
    },
    [track],
  );

  const hasMounts = allMounts.length > 0;

  const recentPaths = useMemo(
    () =>
      [...recentlyOpenedWorkspaces]
        .filter((w) => !mountedPaths.has(w.path))
        .sort((a, b) => b.openedAt - a.openedAt),
    [recentlyOpenedWorkspaces, mountedPaths],
  );

  const handleMount = useCallback(
    async (
      path: string | undefined,
      config: WorkspaceActionConfig | null,
    ): Promise<ConnectMountResult> => {
      if (!openAgent) return { ok: false, message: 'No active agent.' };
      // Guard against mounting an already-mounted recent. The connect
      // popover already filters mounted paths out, but a stale
      // pathStates entry could conceivably reference one.
      if (path !== undefined && mountedPaths.has(path)) {
        return { ok: false, message: 'Workspace is already connected.' };
      }

      track('workspace-connect-started');

      const previousPrefixes = new Set<string>(
        allMounts.map((mount: MountEntry) => mount.prefix),
      );

      // Connect-new is picker-first because there is no workspace path until
      // the native picker resolves. Carry the selected config into the
      // below-input selector once the picked workspace mounts.
      if (path === undefined) {
        if (!config)
          return { ok: false, message: 'No workspace action selected.' };
        const pendingId = ++pendingConnectActionIdRef.current;
        pendingConnectActionConfigsRef.current.push({
          id: pendingId,
          path,
          config,
          previousPrefixes,
        });
        const mountPromise = mountWorkspace(openAgent);
        void trackMountOutcome(mountPromise, 'picker').then((didMount) => {
          if (didMount) {
            onWorkspaceChange?.();
            return;
          }
          pendingConnectActionConfigsRef.current =
            pendingConnectActionConfigsRef.current.filter(
              (pending) => pending.id !== pendingId,
            );
        });
        return { ok: true };
      }

      // In the empty-chat state, recent-workspace actions are preparation for
      // the first message. Plain non-Git workspaces still mount for context,
      // but do not carry a pending Git action into the below-input selector.
      if (chatIsEmpty) {
        const mountPromise = mountWorkspace(openAgent, path);
        const pendingId = ++pendingConnectActionIdRef.current;
        if (config) {
          pendingConnectActionConfigsRef.current.push({
            id: pendingId,
            path,
            config,
            previousPrefixes,
          });
        }
        void trackMountOutcome(mountPromise, 'recent-workspace').then(
          (didMount) => {
            if (didMount) {
              onWorkspaceChange?.();
              return;
            }
            if (!config) return;
            pendingConnectActionConfigsRef.current =
              pendingConnectActionConfigsRef.current.filter(
                (pending) => pending.id !== pendingId,
              );
          },
        );
        return { ok: true };
      }

      if (!config) {
        try {
          await mountWorkspace(openAgent, path);
          track('workspace-connect-finished');
          onWorkspaceChange?.();
          return { ok: true };
        } catch (error) {
          track('workspace-connect-failed', { source: 'recent-workspace' });
          return {
            ok: false,
            message:
              error instanceof Error
                ? error.message
                : 'Failed to connect workspace.',
          };
        }
      }

      // After messages exist, there is no first-send preparation phase, so
      // recent-workspace actions execute immediately against the trusted path.
      try {
        const result = await executeWorkspaceGitActionByPath({
          agentInstanceId: openAgent,
          workspacePath: path,
          config,
          executor: {
            createGitWorktreeByPath,
            createGitBranchByPath,
            switchGitBranchByPath,
            mountWorkspace,
          },
        });

        if (!result.ok) {
          track('workspace-connect-failed', { source: 'recent-workspace' });
          return { ok: false, message: result.message };
        }

        track('workspace-connect-finished');
        onWorkspaceChange?.();
        return { ok: true };
      } catch (error) {
        track('workspace-connect-failed', { source: 'recent-workspace' });
        return {
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : 'Failed to connect workspace.',
        };
      }
    },
    [
      allMounts,
      chatIsEmpty,
      createGitBranchByPath,
      createGitWorktreeByPath,
      mountedPaths,
      mountWorkspace,
      onWorkspaceChange,
      openAgent,
      switchGitBranchByPath,
      track,
      trackMountOutcome,
    ],
  );

  useEffect(() => {
    if (!chatIsEmpty || !onWorkspaceActionConfigChange) return;
    if (pendingConnectActionConfigsRef.current.length === 0) return;

    for (const mount of allMounts) {
      const pendingIndex = pendingConnectActionConfigsRef.current.findIndex(
        (pending) =>
          // Empty-chat recent workspace connects are matched by absolute path;
          // picker-created workspaces are matched by the newly added prefix.
          pending.path === mount.path ||
          (pending.path === undefined &&
            !pending.previousPrefixes.has(mount.prefix)),
      );
      if (pendingIndex === -1) continue;

      const pending = pendingConnectActionConfigsRef.current[pendingIndex];
      if (!pending) continue;
      pendingConnectActionConfigsRef.current.splice(pendingIndex, 1);
      if (mount.git) {
        onWorkspaceActionConfigChange(mount, pending.config);
      }
    }
  }, [
    allMounts,
    chatIsEmpty,
    onWorkspaceActionConfigChange,
    workspaceActionConfigs,
  ]);

  const handleUnmount = useCallback(
    (prefix: string) => {
      if (openAgent) {
        setOpenWorkspaceActionPrefixes((prev) => {
          const next = new Set(prev);
          next.delete(prefix);
          return next;
        });
        void unmountWorkspace(openAgent, prefix);
        onWorkspaceChange?.();
      }
    },
    [openAgent, unmountWorkspace, onWorkspaceChange],
  );

  const handleWorkspaceActionOpenChange = useCallback(
    (mountPrefix: string, open: boolean) => {
      setOpenWorkspaceActionPrefixes((prev) => {
        const next = new Set(prev);
        if (open) next.add(mountPrefix);
        else next.delete(mountPrefix);
        return next;
      });
    },
    [],
  );

  if (!openAgent) return null;

  return (
    <>
      {allMounts.length > 0 && (
        <WorkspaceSelectionTutorial
          enabled={chatIsEmpty && allMounts.some((mount) => !!mount.git)}
          showOptionSteps={openWorkspaceActionPrefixes.size > 0}
        />
      )}
      <div className="scrollbar-none flex min-w-0 shrink-0 items-center gap-7 overflow-x-auto px-1 py-0.5">
        {/* Connected workspaces */}
        {allMounts.map((mount: MountEntry) => {
          const useActionSelect = chatIsEmpty && !!mount.git;
          return useActionSelect ? (
            <WorkspaceActionSelect
              key={mount.prefix}
              mount={mount}
              onUnmount={handleUnmount}
              config={workspaceActionConfigs?.get(mount.prefix)}
              onConfigChange={onWorkspaceActionConfigChange}
              onOpenChange={handleWorkspaceActionOpenChange}
              agentInstanceId={openAgent}
            />
          ) : (
            <WorkspaceBadge
              key={mount.prefix}
              mount={mount}
              onUnmount={handleUnmount}
              agentInstanceId={openAgent}
            />
          );
        })}

        <ConnectWorkspaceSelect
          hasMounts={hasMounts}
          recentPaths={recentPaths}
          onMount={handleMount}
        />
      </div>
    </>
  );
});

function WorkspaceSelectionTutorial({
  enabled,
  showOptionSteps,
}: {
  enabled: boolean;
  showOptionSteps: boolean;
}) {
  return (
    <>
      <Tutorial tutorialId="workspace-selection" enabled={enabled} />
      <Tutorial
        tutorialId="workspace-selection-options"
        enabled={enabled && showOptionSteps}
      />
    </>
  );
}
