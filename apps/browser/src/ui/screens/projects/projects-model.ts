import type {
  AgentHistoryEntry,
  ChatProject,
} from '@shared/karton-contracts/ui/agent';

function timestamp(value: Date): number {
  return new Date(value).getTime();
}

function sortSessions(sessions: AgentHistoryEntry[]): AgentHistoryEntry[] {
  return sessions
    .slice()
    .sort((a, b) => timestamp(b.lastMessageAt) - timestamp(a.lastMessageAt));
}

function normalizeProject(project: ChatProject): ChatProject {
  return {
    ...project,
    createdAt: new Date(project.createdAt),
    updatedAt: new Date(project.updatedAt),
    sessions: sortSessions(project.sessions),
  };
}

export function mergeProjectPages(
  current: ChatProject[],
  incoming: ChatProject[],
): ChatProject[] {
  const projects = new Map(
    current.map((project) => [project.id, normalizeProject(project)]),
  );

  for (const rawProject of incoming) {
    const project = normalizeProject(rawProject);
    const existing = projects.get(project.id);
    if (!existing) {
      projects.set(project.id, project);
      continue;
    }

    const sessions = new Map(
      existing.sessions.map((session) => [session.id, session]),
    );
    for (const session of project.sessions) {
      sessions.set(session.id, session);
    }

    projects.set(project.id, {
      ...existing,
      ...project,
      rootPath: project.rootPath ?? existing.rootPath,
      name: project.name || existing.name,
      createdAt: new Date(
        Math.min(timestamp(existing.createdAt), timestamp(project.createdAt)),
      ),
      updatedAt: new Date(
        Math.max(timestamp(existing.updatedAt), timestamp(project.updatedAt)),
      ),
      sessions: sortSessions(Array.from(sessions.values())),
    });
  }

  return Array.from(projects.values()).sort(
    (a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt),
  );
}

export function filterProjects(
  projects: ChatProject[],
  query: string,
): ChatProject[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return projects;

  return projects.filter(
    (project) =>
      project.name.toLowerCase().includes(normalizedQuery) ||
      project.rootPath?.toLowerCase().includes(normalizedQuery) ||
      project.sessions.some((session) =>
        session.title.toLowerCase().includes(normalizedQuery),
      ),
  );
}

export function getProjectsSummary(projects: ChatProject[]) {
  return {
    projects: projects.length,
    sessions: projects.reduce(
      (total, project) => total + project.sessions.length,
      0,
    ),
    connectedRoots: new Set(
      projects
        .map((project) => project.rootPath)
        .filter((rootPath): rootPath is string => Boolean(rootPath)),
    ).size,
  };
}
