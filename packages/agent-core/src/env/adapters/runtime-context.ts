/**
 * `runtimeContext` core {@link DomainAdapter}.
 *
 * Renders volatile host/runtime data plus workspace-root project rules
 * (`.clodexrules` / `.cursorrules`) into every chat prompt.
 */
import path from 'node:path';
import type { AgentHost } from '../../host/host';
import type { MountManager } from '../../services/mount-manager/mount-registry';
import { readFile } from '../../fs';
import type { DomainAdapter } from '../contract';
import type { RuntimeContextSnapshot } from '../../host/environment-sources';
import {
  CORE_ENV_SCHEMA_VERSION,
  type EnvironmentChangeEntry,
  escAttr,
  escXml,
  renderChangesXml,
} from './shared';
import RuntimeContextPromptSection from './runtime-context.prompt.md?raw';

export interface RuntimeContextDomainAdapterDeps {
  host: AgentHost;
  mountManager: MountManager;
  renderOrder?: number;
}

interface ProjectRulesEntry {
  mountPrefix: string;
  filename: '.clodexrules' | '.cursorrules';
  content: string;
  truncated?: boolean;
}

export interface RuntimeContextState extends RuntimeContextSnapshot {
  workspaceRoots: Array<{ prefix: string; path: string }>;
  projectRules: ProjectRulesEntry[];
}

const PROJECT_RULE_FILENAMES = ['.clodexrules', '.cursorrules'] as const;
const MAX_PROJECT_RULE_CHARS = 12_000;

async function buildRuntimeContextState(
  agentInstanceId: string,
  host: AgentHost,
  mountManager: MountManager,
): Promise<RuntimeContextState> {
  const prefixes = mountManager.getMountPrefixes(agentInstanceId) ?? [];
  const workspaceRoots = prefixes
    .map((prefix) => {
      const workspacePath = mountManager.getWorkspacePathForPrefix(prefix);
      return workspacePath ? { prefix, path: workspacePath } : null;
    })
    .filter((entry): entry is { prefix: string; path: string } => !!entry)
    .sort((a, b) => a.prefix.localeCompare(b.prefix));

  const fallbackRuntime: RuntimeContextSnapshot = {
    osName: process.platform,
    osArch: process.arch,
    currentTime: new Date().toISOString(),
    activeFilePath: null,
  };
  const runtime =
    (await host.environmentSources?.getRuntimeContext?.(agentInstanceId)) ??
    fallbackRuntime;

  return {
    osName: runtime.osName || fallbackRuntime.osName,
    osArch: runtime.osArch || fallbackRuntime.osArch,
    currentTime: runtime.currentTime || fallbackRuntime.currentTime,
    activeFilePath: runtime.activeFilePath ?? null,
    workspaceRoots,
    projectRules: await readProjectRules(workspaceRoots),
  };
}

async function readProjectRules(
  workspaceRoots: RuntimeContextState['workspaceRoots'],
): Promise<ProjectRulesEntry[]> {
  const entries = await Promise.all(
    workspaceRoots.flatMap((workspace) =>
      PROJECT_RULE_FILENAMES.map(async (filename) => {
        const absolutePath = path.join(workspace.path, filename);
        try {
          const raw = await readFile(absolutePath, 'utf8');
          const content =
            raw.length > MAX_PROJECT_RULE_CHARS
              ? raw.slice(0, MAX_PROJECT_RULE_CHARS)
              : raw;
          return {
            mountPrefix: workspace.prefix,
            filename,
            content,
            ...(raw.length > MAX_PROJECT_RULE_CHARS ? { truncated: true } : {}),
          };
        } catch {
          return null;
        }
      }),
    ),
  );

  return entries
    .filter((entry): entry is ProjectRulesEntry => !!entry)
    .sort((a, b) =>
      `${a.mountPrefix}/${a.filename}`.localeCompare(
        `${b.mountPrefix}/${b.filename}`,
      ),
    );
}

function renderFullRuntimeContext(state: RuntimeContextState): string {
  const activeFile = state.activeFilePath?.trim() || 'unknown';
  const workspaces =
    state.workspaceRoots.length === 0
      ? 'none'
      : state.workspaceRoots
          .map((root) => `${root.prefix}/ -> ${root.path}`)
          .join('\n');

  return [
    '<environment_context>',
    `OS: ${escXml(state.osName)} (Arch: ${escXml(state.osArch)})`,
    `Workspace: ${escXml(workspaces)}`,
    `Active editor file: ${escXml(activeFile)}`,
    `Current time: ${escXml(state.currentTime)}`,
    '</environment_context>',
    renderProjectRules(state.projectRules),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function renderProjectRules(entries: readonly ProjectRulesEntry[]): string {
  if (entries.length === 0)
    return '<project_rules>No project rules found.</project_rules>';

  return [
    '<project_rules>',
    ...entries.map((entry) =>
      [
        `<file path="${escAttr(entry.mountPrefix)}/${entry.filename}"${entry.truncated ? ' truncated="true"' : ''}>`,
        escXml(entry.content),
        '</file>',
      ].join('\n'),
    ),
    '</project_rules>',
  ].join('\n');
}

function computeRuntimeContextChanges(
  previous: RuntimeContextState,
  current: RuntimeContextState,
): EnvironmentChangeEntry[] {
  const changes: EnvironmentChangeEntry[] = [];

  if (previous.activeFilePath !== current.activeFilePath) {
    changes.push({
      type: 'active-file-changed',
      attributes: {
        from: previous.activeFilePath ?? 'unknown',
        to: current.activeFilePath ?? 'unknown',
      },
    });
  }

  const prevRules = new Map(
    previous.projectRules.map((entry) => [
      `${entry.mountPrefix}/${entry.filename}`,
      entry.content,
    ]),
  );
  const currRules = new Map(
    current.projectRules.map((entry) => [
      `${entry.mountPrefix}/${entry.filename}`,
      entry.content,
    ]),
  );

  for (const [rulePath, content] of currRules) {
    if (!prevRules.has(rulePath)) {
      changes.push({
        type: 'project-rules-created',
        detail: content,
        attributes: { path: rulePath },
      });
    } else if (prevRules.get(rulePath) !== content) {
      changes.push({
        type: 'project-rules-updated',
        detail: content,
        attributes: { path: rulePath },
      });
    }
  }

  for (const [rulePath] of prevRules) {
    if (!currRules.has(rulePath)) {
      changes.push({
        type: 'project-rules-deleted',
        attributes: { path: rulePath },
      });
    }
  }

  return changes;
}

/** Stable env-domain id for runtime context. */
export const RUNTIME_CONTEXT_DOMAIN_ID = 'runtimeContext';

export function createRuntimeContextDomainAdapter(
  deps: RuntimeContextDomainAdapterDeps,
): DomainAdapter<RuntimeContextState> {
  return {
    domainId: RUNTIME_CONTEXT_DOMAIN_ID,
    renderOrder: deps.renderOrder ?? 0.5,
    schemaVersion: CORE_ENV_SCHEMA_VERSION,
    promptSection: RuntimeContextPromptSection,
    getState(agentInstanceId) {
      return buildRuntimeContextState(
        agentInstanceId,
        deps.host,
        deps.mountManager,
      );
    },
    renderState(prev, curr) {
      if (prev === null) return renderFullRuntimeContext(curr);
      return renderChangesXml(computeRuntimeContextChanges(prev, curr));
    },
    equals(a, b) {
      return runtimeContextComparable(a) === runtimeContextComparable(b);
    },
  };
}

function runtimeContextComparable(state: RuntimeContextState): string {
  return JSON.stringify({
    osName: state.osName,
    osArch: state.osArch,
    activeFilePath: state.activeFilePath ?? null,
    workspaceRoots: state.workspaceRoots,
    projectRules: state.projectRules,
  });
}
