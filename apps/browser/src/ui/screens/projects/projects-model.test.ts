import { describe, expect, it } from 'vitest';
import { AgentTypes } from '@shared/karton-contracts/ui/agent';
import type {
  AgentHistoryEntry,
  ChatProject,
} from '@shared/karton-contracts/ui/agent';
import {
  filterProjects,
  getProjectsSummary,
  mergeProjectPages,
} from './projects-model';

function session(
  id: string,
  title: string,
  lastMessageAt: string,
): AgentHistoryEntry {
  return {
    id,
    type: AgentTypes.CHAT,
    title,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    lastMessageAt: new Date(lastMessageAt),
    messageCount: 2,
    parentAgentInstanceId: null,
  };
}

function project(
  id: string,
  name: string,
  rootPath: string | null,
  sessions: AgentHistoryEntry[],
): ChatProject {
  return {
    id,
    name,
    rootPath,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: sessions[0]?.lastMessageAt ?? new Date(0),
    sessions,
  };
}

describe('projects model', () => {
  it('merges paginated projects and deduplicates sessions', () => {
    const first = project('alpha', 'Alpha', '/repo/alpha', [
      session('one', 'First task', '2026-07-09T10:00:00.000Z'),
    ]);
    const next = project('alpha', 'Alpha', '/repo/alpha', [
      session('two', 'Second task', '2026-07-10T10:00:00.000Z'),
      session('one', 'First task renamed', '2026-07-09T10:00:00.000Z'),
    ]);

    const merged = mergeProjectPages([first], [next]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.sessions.map((entry) => entry.id)).toEqual([
      'two',
      'one',
    ]);
    expect(merged[0]?.sessions[1]?.title).toBe('First task renamed');
  });

  it('filters by project name, root path, or session title', () => {
    const projects = [
      project('alpha', 'Alpha', '/repo/alpha', [
        session('one', 'Fix navigation', '2026-07-10T10:00:00.000Z'),
      ]),
    ];

    expect(filterProjects(projects, 'alpha')).toHaveLength(1);
    expect(filterProjects(projects, '/repo')).toHaveLength(1);
    expect(filterProjects(projects, 'navigation')).toHaveLength(1);
    expect(filterProjects(projects, 'missing')).toHaveLength(0);
  });

  it('summarizes projects, sessions, and unique connected roots', () => {
    const projects = [
      project('alpha', 'Alpha', '/repo/alpha', [
        session('one', 'One', '2026-07-10T10:00:00.000Z'),
        session('two', 'Two', '2026-07-09T10:00:00.000Z'),
      ]),
      project('none', 'No project', null, [
        session('three', 'Three', '2026-07-08T10:00:00.000Z'),
      ]),
    ];

    expect(getProjectsSummary(projects)).toEqual({
      projects: 2,
      sessions: 3,
      connectedRoots: 1,
    });
  });
});
