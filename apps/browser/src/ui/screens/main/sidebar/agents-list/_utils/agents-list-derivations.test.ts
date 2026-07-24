import { describe, expect, it } from 'vitest';
import { AgentTypes } from '@shared/karton-contracts/ui/agent';
import type { AgentHistoryEntry } from '@shared/karton-contracts/ui/agent';
import type {
  MergedAgentEntry,
  ProjectSessionGroup,
} from '../../../_lib/agent-list-model';
import {
  agentHistoryEntriesEqual,
  appendOrphanProjectGroups,
  deriveActiveAgentCards,
  deriveActivityText,
  filterAgentsByTitle,
  findProjectGroupKeysForAgent,
  getAgentAgeGroupLabel,
  getRemoteRepositoryOpenLabel,
  insertAgentAgeGroupHeaders,
  mergeUniqueAgentHistoryEntries,
  partitionPinnedAgents,
  reorderVisiblePinnedAgentIds,
  stringArraysEqual,
} from './agents-list-derivations';

function agent(
  id: string,
  overrides: Partial<MergedAgentEntry> = {},
): MergedAgentEntry {
  return {
    id,
    type: AgentTypes.CHAT,
    title: id,
    isWorking: false,
    isWaitingForUser: false,
    activityText: '',
    activityIsUserInput: false,
    hasError: false,
    lastMessageAt: 0,
    createdAt: 0,
    messageCount: 0,
    unread: false,
    mountedWorkspaces: [],
    isLive: true,
    ...overrides,
  };
}

function historyEntry(
  id: string,
  overrides: Partial<AgentHistoryEntry> = {},
): AgentHistoryEntry {
  return {
    id,
    type: AgentTypes.CHAT,
    title: id,
    createdAt: new Date('2026-07-12T08:00:00.000Z'),
    lastMessageAt: new Date('2026-07-12T09:00:00.000Z'),
    messageCount: 1,
    parentAgentInstanceId: null,
    mountedWorkspaces: [],
    ...overrides,
  };
}

describe('agents list primitive derivations', () => {
  it('compares ordered string arrays and the history fields used by the selector', () => {
    expect(stringArraysEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(stringArraysEqual(['a', 'b'], ['b', 'a'])).toBe(false);

    const entry = historyEntry('a', {
      mountedWorkspaces: [
        {
          path: '/repo',
          permissions: [],
          git: {
            repositoryId: '/repo/.git',
            worktreeId: '/repo',
            repoRoot: '/repo',
            mainWorktreePath: '/repo',
            commonGitDir: '/repo/.git',
            isWorktree: false,
            branch: 'main',
            headSha: 'abc',
            status: {
              dirty: false,
              stagedCount: 0,
              unstagedCount: 0,
              untrackedCount: 0,
            },
          },
        },
      ],
    });
    expect(agentHistoryEntriesEqual([entry], [{ ...entry }])).toBe(true);
    expect(
      agentHistoryEntriesEqual(
        [entry],
        [
          {
            ...entry,
            mountedWorkspaces: [
              {
                ...entry.mountedWorkspaces![0]!,
                git: {
                  ...entry.mountedWorkspaces![0]!.git!,
                  worktreeId: '/repo-other',
                },
              },
            ],
          },
        ],
      ),
    ).toBe(false);
  });

  it('preserves the activity fallback order', () => {
    expect(
      deriveActivityText(
        [
          {
            role: 'assistant',
            parts: [{ type: 'reasoning', text: 'private reasoning' }],
          },
        ],
        '',
      ),
    ).toEqual({ text: 'Thinking…', isUserInput: false });

    expect(
      deriveActivityText(
        [{ role: 'assistant', parts: [{ type: 'tool-read' }] }],
        '',
      ),
    ).toEqual({ text: 'Reading file', isUserInput: false });

    expect(
      deriveActivityText(
        [{ role: 'user', parts: [{ type: 'text', text: 'sent text' }] }],
        JSON.stringify({
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'draft text' }],
            },
          ],
        }),
      ),
    ).toEqual({ text: 'draft text', isUserInput: true });
  });

  it('derives active chat cards while excluding non-chat agent types', () => {
    const state = {
      agents: {
        instances: {
          chat: {
            type: AgentTypes.CHAT,
            state: {
              title: 'Chat agent',
              history: [
                {
                  role: 'assistant',
                  parts: [
                    {
                      type: 'tool-read',
                      state: 'approval-requested',
                    },
                  ],
                  metadata: { createdAt: '2026-07-12T09:00:00.000Z' },
                },
              ],
              inputState: '',
              isWorking: true,
              error: null,
              unread: true,
            },
          },
          workspace: {
            type: AgentTypes.WORKSPACE_MD,
            state: {
              title: 'Workspace metadata',
              history: [],
              inputState: '',
              isWorking: false,
              error: null,
              unread: false,
            },
          },
        },
      },
      toolbox: {
        chat: {
          workspace: { mounts: [{ path: '/repos/clodex', git: null }] },
          pendingUserQuestion: null,
        },
      },
    } as unknown as Parameters<typeof deriveActiveAgentCards>[0];

    expect(deriveActiveAgentCards(state)).toEqual([
      expect.objectContaining({
        id: 'chat',
        title: 'Chat agent',
        isWorking: true,
        isWaitingForUser: true,
        activityText: 'Reading file',
        unread: true,
        projectRootPath: '/repos/clodex',
        projectName: 'clodex',
        messageCount: 1,
      }),
    ]);
  });

  it('shows waiting and working fallbacks without exposing draft text', () => {
    const baseState = {
      agents: {
        instances: {
          chat: {
            type: AgentTypes.CHAT,
            state: {
              title: 'Chat agent',
              history: [],
              inputState: JSON.stringify({
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'unfinished draft' }],
                  },
                ],
              }),
              isWorking: true,
              error: { kind: 'plan-limit-exceeded', message: 'limit' },
              unread: false,
            },
          },
        },
      },
      toolbox: {
        chat: {
          workspace: { mounts: [] },
          pendingUserQuestion: null,
          pendingProposedEdits: [],
        },
      },
    } as unknown as Parameters<typeof deriveActiveAgentCards>[0];

    expect(deriveActiveAgentCards(baseState)[0]).toEqual(
      expect.objectContaining({
        activityText: 'Working…',
        activityIsUserInput: false,
        hasError: false,
      }),
    );

    const waitingState = structuredClone(baseState);
    waitingState.toolbox.chat!.pendingUserQuestion = {} as never;
    expect(deriveActiveAgentCards(waitingState)[0]).toEqual(
      expect.objectContaining({
        activityText: 'Waiting for response...',
        isWaitingForUser: true,
      }),
    );

    const fileApprovalState = structuredClone(baseState);
    fileApprovalState.toolbox.chat!.pendingProposedEdits = [
      { status: 'pending' },
    ] as never;
    expect(deriveActiveAgentCards(fileApprovalState)[0]).toEqual(
      expect.objectContaining({
        activityText: 'Waiting for file approval...',
        isWaitingForUser: true,
      }),
    );
  });
});

describe('agents list filtering and grouping derivations', () => {
  it('keeps preferred history entries first while removing duplicate ids', () => {
    const pinned = historyEntry('pinned', { title: 'Pinned copy' });
    const merged = mergeUniqueAgentHistoryEntries(
      [pinned],
      [
        historyEntry('pinned', { title: 'History copy' }),
        historyEntry('other'),
      ],
    );
    expect(merged.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: 'pinned', title: 'Pinned copy' },
      { id: 'other', title: 'other' },
    ]);
  });

  it('filters titles case-insensitively and preserves pinned preference order', () => {
    const agents = [
      agent('a', { title: 'Alpha task' }),
      agent('b', { title: 'Beta task' }),
      agent('c', { title: 'Alpha review' }),
    ];
    const filtered = filterAgentsByTitle(agents, ' ALPHA ');
    expect(filtered.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(partitionPinnedAgents(filtered, ['c', 'missing', 'a'])).toEqual({
      pinnedAgents: [agents[2], agents[0]],
      unpinnedAgents: [],
    });
  });

  it('reorders only visible pinned slots and leaves hidden pinned ids in place', () => {
    expect(
      reorderVisiblePinnedAgentIds({
        pinnedAgentIds: ['a', 'hidden', 'b', 'c'],
        visiblePinnedAgentIds: ['a', 'b', 'c'],
        activeId: 'c',
        overId: 'a',
      }),
    ).toEqual(['c', 'hidden', 'a', 'b']);
  });

  it('groups entries by local calendar age using the existing boundaries', () => {
    const now = new Date(2026, 6, 12, 12, 0, 0);
    expect(getAgentAgeGroupLabel(0, now)).toBe('Today');
    expect(
      getAgentAgeGroupLabel(new Date(2026, 6, 11, 23).getTime(), now),
    ).toBe('Yesterday');
    expect(getAgentAgeGroupLabel(new Date(2026, 6, 5, 10).getTime(), now)).toBe(
      'Last 7 days',
    );
    expect(
      getAgentAgeGroupLabel(new Date(2026, 5, 20, 10).getTime(), now),
    ).toBe('Last 30 days');
    expect(getAgentAgeGroupLabel(new Date(2026, 4, 1, 10).getTime(), now)).toBe(
      'Older',
    );

    const today = agent('today', {
      lastMessageAt: new Date(2026, 6, 12, 9).getTime(),
    });
    const yesterday = agent('yesterday', {
      lastMessageAt: new Date(2026, 6, 11, 9).getTime(),
    });
    expect(insertAgentAgeGroupHeaders([today, yesterday], now)).toEqual([
      { type: 'header', label: 'Today' },
      { type: 'agent', agent: today },
      { type: 'header', label: 'Yesterday' },
      { type: 'agent', agent: yesterday },
    ]);
  });

  it('adds missing project groups and keeps the newest group first', () => {
    const existing: ProjectSessionGroup = {
      key: 'project:/repo',
      label: 'repo',
      rootPath: '/repo',
      severity: null,
      updatedAt: 100,
      agents: [agent('existing')],
    };
    const result = appendOrphanProjectGroups(
      [existing],
      [
        {
          id: 'repo',
          rootPath: '/repo',
          name: 'repo',
          createdAt: new Date(50),
          updatedAt: new Date(100),
          sessions: [],
        },
        {
          id: 'late',
          rootPath: '/late',
          name: 'late',
          createdAt: new Date(150),
          updatedAt: new Date(200),
          sessions: [],
        },
      ],
    );

    expect(result.map((group) => group.key)).toEqual([
      'project:/late',
      'project:/repo',
    ]);
    expect(result[0]?.agents).toEqual([]);
  });
});

describe('agents list presentation-independent lookups', () => {
  it('labels known git hosting providers without trusting malformed URLs', () => {
    expect(getRemoteRepositoryOpenLabel('https://github.com/org/repo')).toBe(
      'Open in GitHub',
    );
    expect(getRemoteRepositoryOpenLabel('https://gitlab.com/org/repo')).toBe(
      'Open in GitLab',
    );
    expect(getRemoteRepositoryOpenLabel('https://bitbucket.org/org/repo')).toBe(
      'Open in Bitbucket',
    );
    expect(getRemoteRepositoryOpenLabel('not a URL')).toBe(
      'Open remote repository',
    );
  });

  it('finds the project ancestor for an agent', () => {
    const direct = agent('direct');
    const projectGroup: ProjectSessionGroup = {
      key: 'project:/repo',
      label: 'repo',
      rootPath: '/repo',
      severity: null,
      updatedAt: 0,
      agents: [direct],
    };

    expect(findProjectGroupKeysForAgent('direct', [projectGroup])).toEqual([
      'project:/repo',
    ]);
  });
});
