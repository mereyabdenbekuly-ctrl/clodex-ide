import type { AppState } from '@shared/karton-contracts/ui';
import {
  AgentTypes,
  type AgentHistoryEntry,
  type ChatProject,
} from '@shared/karton-contracts/ui/agent';
import { getBaseName } from '@shared/path-utils';
import { extractTipTapText, firstWords } from '@ui/utils/text-utils';
import type {
  ActiveAgentCardData,
  MergedAgentEntry,
  ProjectSessionGroup,
} from '../../../_lib/agent-list-model';
import { getToolActivityLabel } from './tool-label';

export const NO_WORKSPACE_GROUP_KEY = '__no-workspace__';

export type AgentAgeGroupLabel =
  | 'Today'
  | 'Yesterday'
  | 'Last 7 days'
  | 'Last 30 days'
  | 'Older';

export type AgentAgeGroupedItem =
  | { type: 'agent'; agent: MergedAgentEntry }
  | { type: 'header'; label: AgentAgeGroupLabel };

type ActivityPart = {
  type: string;
  text?: string;
};

type ActivityMessage = {
  role: string;
  parts: ActivityPart[];
};

export function stringArraysEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export function agentHistoryEntriesEqual(
  a: readonly AgentHistoryEntry[],
  b: readonly AgentHistoryEntry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (
      ai.id !== bi.id ||
      ai.projectId !== bi.projectId ||
      ai.projectRootPath !== bi.projectRootPath ||
      ai.projectName !== bi.projectName ||
      ai.title !== bi.title ||
      ai.createdAt !== bi.createdAt ||
      ai.lastMessageAt !== bi.lastMessageAt ||
      ai.messageCount !== bi.messageCount ||
      ai.parentAgentInstanceId !== bi.parentAgentInstanceId ||
      (ai.mountedWorkspaces?.length ?? 0) !==
        (bi.mountedWorkspaces?.length ?? 0)
    ) {
      return false;
    }

    for (let j = 0; j < (ai.mountedWorkspaces?.length ?? 0); j++) {
      const aw = ai.mountedWorkspaces?.[j];
      const bw = bi.mountedWorkspaces?.[j];
      if (
        aw?.path !== bw?.path ||
        aw?.git?.repositoryId !== bw?.git?.repositoryId ||
        aw?.git?.worktreeId !== bw?.git?.worktreeId
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Derive a short preview from the latest assistant output, input draft, or
 * latest user text. This function intentionally mirrors the sidebar's
 * historical fallback order.
 */
export function deriveActivityText(
  history: readonly ActivityMessage[],
  inputState: string,
): { text: string; isUserInput: boolean } {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (message.role !== 'assistant') continue;
    for (let j = message.parts.length - 1; j >= 0; j--) {
      const part = message.parts[j]!;
      if (part.type === 'reasoning') {
        return { text: 'Thinking…', isUserInput: false };
      }
      if (part.type === 'text') {
        const snippet = firstWords(part.text ?? '', 10);
        if (snippet) return { text: snippet, isUserInput: false };
        continue;
      }
      if (part.type.startsWith('tool-')) {
        return {
          text: getToolActivityLabel(part.type),
          isUserInput: false,
        };
      }
    }
    break;
  }

  if (inputState) {
    const draftText = extractTipTapText(inputState).trim();
    if (draftText) {
      const snippet = firstWords(draftText, 10, false);
      if (snippet) return { text: snippet, isUserInput: true };
    }
  }

  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (message.role !== 'user') continue;
    for (let j = message.parts.length - 1; j >= 0; j--) {
      const part = message.parts[j]!;
      if (part.type === 'text') {
        const snippet = firstWords(part.text ?? '', 10);
        if (snippet) return { text: snippet, isUserInput: true };
      }
    }
    break;
  }

  return { text: '', isUserInput: false };
}

export function deriveActiveAgentCards(
  state: Pick<AppState, 'agents' | 'toolbox'>,
): ActiveAgentCardData[] {
  return Object.entries(state.agents.instances)
    .filter(
      ([, agent]) =>
        agent.type === AgentTypes.CHAT || agent.type === AgentTypes.MAGUS,
    )
    .map(([id, agent]) => {
      const history = agent.state.history;
      const lastMessage = history[history.length - 1];
      const mountedWorkspaces = state.toolbox[id]?.workspace?.mounts ?? [];
      const projectRootPath = mountedWorkspaces[0]?.path ?? null;
      const hasPendingQuestion = !!state.toolbox[id]?.pendingUserQuestion;
      const hasPendingFileApproval =
        state.toolbox[id]?.pendingProposedEdits?.some(
          (edit) => edit.status === 'pending',
        ) ?? false;
      const hasPendingToolApproval = (() => {
        for (let i = history.length - 1; i >= 0; i--) {
          const message = history[i]!;
          if (message.role !== 'assistant') continue;
          return message.parts.some(
            (part) =>
              (part as { state?: string }).state === 'approval-requested',
          );
        }
        return false;
      })();
      const rawActivity = hasPendingQuestion
        ? { text: 'Waiting for response...', isUserInput: false }
        : hasPendingFileApproval
          ? { text: 'Waiting for file approval...', isUserInput: false }
          : deriveActivityText(
              history as ActivityMessage[],
              agent.state.inputState,
            );
      const activity =
        agent.state.isWorking && rawActivity.isUserInput
          ? { text: 'Working…', isUserInput: false }
          : rawActivity;

      return {
        id,
        type: agent.type,
        title: agent.state.title,
        isWorking: agent.state.isWorking,
        isWaitingForUser:
          hasPendingQuestion ||
          hasPendingFileApproval ||
          hasPendingToolApproval,
        activityText: activity.text,
        activityIsUserInput: activity.isUserInput,
        hasError:
          !!agent.state.error &&
          agent.state.error.kind !== 'plan-limit-exceeded',
        unread: !!agent.state.unread,
        lastMessageAt: lastMessage?.metadata?.createdAt
          ? new Date(lastMessage.metadata.createdAt).getTime()
          : 0,
        createdAt: history[0]?.metadata?.createdAt
          ? new Date(history[0].metadata.createdAt).getTime()
          : 0,
        messageCount: history.length,
        mountedWorkspaces,
        projectRootPath,
        projectName: projectRootPath
          ? getBaseName(projectRootPath) || projectRootPath
          : undefined,
      };
    });
}

export function getRemoteRepositoryOpenLabel(
  url: string | null | undefined,
): string {
  if (!url) return 'Open remote repository';

  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'github.com' || host.endsWith('.github.com')) {
      return 'Open in GitHub';
    }
    if (host === 'gitlab.com' || host.endsWith('.gitlab.com')) {
      return 'Open in GitLab';
    }
    if (host === 'bitbucket.org' || host.endsWith('.bitbucket.org')) {
      return 'Open in Bitbucket';
    }
  } catch {
    return 'Open remote repository';
  }

  return 'Open remote repository';
}

export function getAgentAgeGroupLabel(
  timestamp: number,
  now = new Date(),
): AgentAgeGroupLabel {
  if (!timestamp) return 'Today';
  const timestampDate = new Date(timestamp);
  const nowMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const timestampMidnight = new Date(
    timestampDate.getFullYear(),
    timestampDate.getMonth(),
    timestampDate.getDate(),
  ).getTime();
  const diffDays = Math.round((nowMidnight - timestampMidnight) / 86_400_000);
  if (diffDays < 0) return 'Today';
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays <= 7) return 'Last 7 days';
  if (diffDays <= 30) return 'Last 30 days';
  return 'Older';
}

export function insertAgentAgeGroupHeaders(
  agents: readonly MergedAgentEntry[],
  now?: Date,
): AgentAgeGroupedItem[] {
  const result: AgentAgeGroupedItem[] = [];
  let currentGroup: AgentAgeGroupLabel | null = null;
  for (const agent of agents) {
    const group = getAgentAgeGroupLabel(agent.lastMessageAt, now ?? new Date());
    if (group !== currentGroup) {
      currentGroup = group;
      result.push({ type: 'header', label: group });
    }
    result.push({ type: 'agent', agent });
  }
  return result;
}

export function mergeUniqueAgentHistoryEntries(
  preferredEntries: readonly AgentHistoryEntry[],
  remainingEntries: readonly AgentHistoryEntry[],
): AgentHistoryEntry[] {
  const seenIds = new Set<string>();
  const merged: AgentHistoryEntry[] = [];
  for (const entry of [...preferredEntries, ...remainingEntries]) {
    if (seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

export function filterAgentsByTitle(
  agents: readonly MergedAgentEntry[],
  searchQuery: string,
): MergedAgentEntry[] {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return [...agents];
  return agents.filter((agent) => agent.title.toLowerCase().includes(query));
}

export function partitionPinnedAgents(
  agents: readonly MergedAgentEntry[],
  pinnedAgentIds: readonly string[],
): {
  pinnedAgents: MergedAgentEntry[];
  unpinnedAgents: MergedAgentEntry[];
} {
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const pinnedIdSet = new Set(pinnedAgentIds);
  return {
    pinnedAgents: pinnedAgentIds
      .map((id) => agentsById.get(id))
      .filter((agent): agent is MergedAgentEntry => !!agent),
    unpinnedAgents: agents.filter((agent) => !pinnedIdSet.has(agent.id)),
  };
}

export function reorderVisiblePinnedAgentIds({
  pinnedAgentIds,
  visiblePinnedAgentIds,
  activeId,
  overId,
}: {
  pinnedAgentIds: readonly string[];
  visiblePinnedAgentIds: readonly string[];
  activeId: string;
  overId: string;
}): string[] {
  const oldVisibleIndex = visiblePinnedAgentIds.indexOf(activeId);
  const newVisibleIndex = visiblePinnedAgentIds.indexOf(overId);
  if (oldVisibleIndex === -1 || newVisibleIndex === -1) {
    return [...pinnedAgentIds];
  }

  const reorderedVisibleIds = [...visiblePinnedAgentIds];
  const [movedId] = reorderedVisibleIds.splice(oldVisibleIndex, 1);
  if (!movedId) return [...pinnedAgentIds];
  reorderedVisibleIds.splice(newVisibleIndex, 0, movedId);

  const reorderedVisibleIdSet = new Set(reorderedVisibleIds);
  let visibleIndex = 0;
  return pinnedAgentIds.map((id) => {
    if (!reorderedVisibleIdSet.has(id)) return id;
    const nextVisibleId = reorderedVisibleIds[visibleIndex++];
    return nextVisibleId ?? id;
  });
}

export function appendOrphanProjectGroups(
  groups: ProjectSessionGroup[],
  projects: readonly ChatProject[],
): ProjectSessionGroup[] {
  if (projects.length === 0) return groups;

  const knownKeys = new Set(groups.map((group) => group.key));
  const orphanGroups: ProjectSessionGroup[] = [];
  for (const project of projects) {
    const rootPath = project.rootPath ?? null;
    const key = rootPath ? `project:${rootPath}` : 'project:__none__';
    if (knownKeys.has(key)) continue;
    orphanGroups.push({
      key,
      label: project.name,
      rootPath,
      severity: null,
      updatedAt: project.updatedAt.getTime(),
      agents: [],
    });
  }

  if (orphanGroups.length === 0) return groups;
  return [...groups, ...orphanGroups].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function findProjectGroupKeysForAgent(
  agentId: string,
  projectGroups: readonly ProjectSessionGroup[],
): string[] {
  const project = projectGroups.find((group) =>
    group.agents.some((agent) => agent.id === agentId),
  );
  return project ? [project.key] : [];
}
