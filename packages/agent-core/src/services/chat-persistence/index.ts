import path from 'node:path';
import type { AgentHistoryEntry } from '../../types/agent';
import type { AgentPersistenceDB } from '../agent-persistence/db';

export const NO_PROJECT_ID = '__no_project__';

export type ChatProject = {
  id: string;
  rootPath: string | null;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  sessions: AgentHistoryEntry[];
};

export type ChatPersistenceServiceDeps = {
  persistenceDb: AgentPersistenceDB;
  enrichHistoryEntries?: (
    entries: AgentHistoryEntry[],
  ) => Promise<AgentHistoryEntry[]>;
};

export function getProjectNameFromRoot(rootPath: string | null): string {
  if (!rootPath) return 'No project';
  return path.basename(rootPath) || rootPath;
}

export function getProjectIdFromRoot(rootPath: string | null): string {
  return rootPath ?? NO_PROJECT_ID;
}

export function attachProjectToSession(
  entry: AgentHistoryEntry,
): AgentHistoryEntry {
  const rootPath = entry.mountedWorkspaces?.[0]?.path ?? null;
  const projectId = getProjectIdFromRoot(rootPath);
  const projectName = getProjectNameFromRoot(rootPath);

  return {
    ...entry,
    projectId,
    projectRootPath: rootPath,
    projectName,
  };
}

export function groupSessionsByProject(
  sessions: AgentHistoryEntry[],
): ChatProject[] {
  const projects = new Map<string, ChatProject>();

  for (const rawSession of sessions) {
    const session = attachProjectToSession(rawSession);
    const projectId = session.projectId ?? NO_PROJECT_ID;
    const rootPath = session.projectRootPath ?? null;
    let project = projects.get(projectId);
    if (!project) {
      project = {
        id: projectId,
        rootPath,
        name: session.projectName ?? getProjectNameFromRoot(rootPath),
        createdAt: session.createdAt,
        updatedAt: session.lastMessageAt,
        sessions: [],
      };
      projects.set(projectId, project);
    }

    project.createdAt =
      session.createdAt < project.createdAt
        ? session.createdAt
        : project.createdAt;
    project.updatedAt =
      session.lastMessageAt > project.updatedAt
        ? session.lastMessageAt
        : project.updatedAt;
    project.sessions.push(session);
  }

  return Array.from(projects.values()).sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
}

export class ChatPersistenceService {
  private readonly persistenceDb: AgentPersistenceDB;
  private readonly enrichHistoryEntries?: (
    entries: AgentHistoryEntry[],
  ) => Promise<AgentHistoryEntry[]>;

  public constructor(deps: ChatPersistenceServiceDeps) {
    this.persistenceDb = deps.persistenceDb;
    this.enrichHistoryEntries = deps.enrichHistoryEntries;
  }

  public async getSessions(
    offset: number,
    limit: number,
    searchString?: string,
    archived = false,
  ): Promise<AgentHistoryEntry[]> {
    const entries = await this.persistenceDb.getAgentHistoryEntries(
      limit,
      offset,
      [],
      searchString && searchString.trim().length > 0
        ? `%${searchString.trim()}%`
        : undefined,
      archived,
    );
    return await this.enrichAndProject(entries);
  }

  public async getSessionsByIds(
    ids: string[],
    archived = false,
  ): Promise<AgentHistoryEntry[]> {
    const entries = await this.persistenceDb.getAgentHistoryEntriesByIds(
      ids,
      archived,
    );
    return await this.enrichAndProject(entries);
  }

  public async getProjects(
    offset: number,
    limit: number,
    searchString?: string,
    archived = false,
  ): Promise<ChatProject[]> {
    return groupSessionsByProject(
      await this.getSessions(offset, limit, searchString, archived),
    );
  }

  private async enrichAndProject(
    entries: AgentHistoryEntry[],
  ): Promise<AgentHistoryEntry[]> {
    const enriched = this.enrichHistoryEntries
      ? await this.enrichHistoryEntries(entries)
      : entries;
    return enriched.map(attachProjectToSession);
  }
}
