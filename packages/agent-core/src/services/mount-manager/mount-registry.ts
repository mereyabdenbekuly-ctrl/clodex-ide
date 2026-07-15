import { createHash } from 'node:crypto';
import path from 'node:path';
import type { MountEntry } from '../../types/metadata';
import type { Logger } from '../../host/logger';
import type { TelemetrySink } from '../../host/telemetry';
import type { AgentStore } from '../../store';
import { setAgentMounts } from './mount-state';
import { watch, type FSWatcher } from '../../fs';
import type { WorkspaceSnapshot } from '../../types/metadata';
import type { MountManagerHostHooks } from './types';
import {
  DEFAULT_WORKSPACE_MD_RELATIVE_PATH,
  getSkills,
  readAgentsMd,
  readWorkspaceMd,
  splitWorkspaceMdRelativePath,
} from './workspace-info';
import { pickOwningWorkspace } from '../../workspace';

type AgentInstanceId = string;
type MountPrefix = string;
type WorkspacePath = string;

const LEGACY_MOUNT_PREFIX_DIGEST_HEX_LENGTH = 4;
const MOUNT_PREFIX_DIGEST_HEX_LENGTH = 16;

function mountPrefixForPathWithDigestLength(
  workspacePath: string,
  digestHexLength: number,
): MountPrefix {
  const hash = createHash('sha256')
    .update(workspacePath)
    .digest('hex')
    .slice(0, digestHexLength);
  return `w${hash}`;
}

/**
 * Stable hash prefix for a workspace path. Identical across processes for the
 * same absolute path; the UI and `att/` mount both rely on this determinism.
 *
 * Sixteen hexadecimal digest characters provide a 64-bit namespace. The
 * registry still detects a collision and fails closed before aliasing two
 * distinct workspace paths.
 */
export function mountPrefixForPath(workspacePath: string): MountPrefix {
  return mountPrefixForPathWithDigestLength(
    workspacePath,
    MOUNT_PREFIX_DIGEST_HEX_LENGTH,
  );
}

/**
 * Prefix emitted before the 64-bit mount namespace rollout. Kept only for
 * deterministic migration of persisted message history; it must never be
 * used to register a new mount because its 16-bit namespace collides easily.
 */
export function legacyMountPrefixForPath(workspacePath: string): MountPrefix {
  return mountPrefixForPathWithDigestLength(
    workspacePath,
    LEGACY_MOUNT_PREFIX_DIGEST_HEX_LENGTH,
  );
}

export interface MountManagerOptions {
  store: AgentStore;
  logger: Logger;
  telemetry?: TelemetrySink;
  hooks: MountManagerHostHooks;
  /**
   * Resolver for the agent type used in telemetry properties. The
   * host supplies this because agent-type is part of the Karton
   * `agents.instances` slice; the core does not read Karton directly.
   * Returns `'unknown'` when unknown.
   */
  getAgentType?: (agentInstanceId: string) => string;
  /**
   * Mount-relative path to the WORKSPACE.md memo, sourced from
   * `AgentHost.workspaceMdRelativePath()`. Defaults to
   * `.clodex/WORKSPACE.md`. Determines (a) which file the
   * registry reads and (b) which `<dir>/<file>` pair the workspace
   * watcher whitelists.
   */
  workspaceMdRelativePath?: string;
}

/**
 * Core mount registry. Owns the per-agent mount map, the shared
 * workspace→prefix index, the chokidar watchers, and the reactive
 * `MountEntry` cache. Stays agnostic of Electron, Karton,
 * `ClientRuntimeNode`, and `LspService` — the host supplies those via
 * `MountManagerHostHooks`.
 *
 * Writes always flow through {@link setAgentMounts} against the
 * injected `AgentStore` so the bridge mirror can observe
 * reference-identity diffs. Per-field updates build a fresh
 * `MountEntry` object; full refreshes build a fresh array.
 */
export class MountManager {
  private readonly logger: Logger;
  private readonly telemetry: TelemetrySink | undefined;
  private readonly hooks: MountManagerHostHooks;
  private readonly store: AgentStore;
  private readonly getAgentType: (agentInstanceId: string) => string;
  private readonly workspaceMdRelativePath: string;
  private readonly workspaceMdDir: string;
  private readonly workspaceMdFile: string;

  private agentMounts: Map<AgentInstanceId, Set<MountPrefix>> = new Map();
  private workspacePathsPerMount: Map<MountPrefix, WorkspacePath> = new Map();
  private mountEntriesPerAgent: Map<
    AgentInstanceId,
    Map<MountPrefix, MountEntry>
  > = new Map();

  /**
   * Mount requests are serialized per agent. Besides making duplicate mount
   * calls idempotent while an async attach is in flight, this prevents two
   * different workspace mounts from racing the agent's Set/entry updates.
   */
  private mountOperationsPerAgent: Map<AgentInstanceId, Promise<void>> =
    new Map();

  /**
   * A prefix is written to `workspacePathsPerMount` before its host attach
   * hook is awaited. Other agents mounting the same path wait on this promise;
   * a distinct path that resolves to the same prefix fails closed against the
   * reservation instead of entering a second attach hook.
   */
  private workspaceInitializations: Map<MountPrefix, Promise<void>> = new Map();

  private watchersPerPath: Map<WorkspacePath, FSWatcher> = new Map();
  private watcherDebounceTimers: Map<
    WorkspacePath,
    ReturnType<typeof setTimeout>
  > = new Map();

  constructor(options: MountManagerOptions) {
    this.logger = options.logger;
    this.telemetry = options.telemetry;
    this.hooks = options.hooks;
    this.store = options.store;
    this.getAgentType = options.getAgentType ?? (() => 'unknown');
    this.workspaceMdRelativePath =
      options.workspaceMdRelativePath ?? DEFAULT_WORKSPACE_MD_RELATIVE_PATH;
    const split = splitWorkspaceMdRelativePath(this.workspaceMdRelativePath);
    this.workspaceMdDir = split.dir;
    this.workspaceMdFile = split.file;
  }

  /**
   * Attach a workspace to an agent instance. The host is expected to
   * resolve the file picker (if any) and pass a concrete absolute
   * path. Fires `onWorkspaceAttached` for new workspace paths before
   * reading workspace-info for the first time.
   */
  public async mountWorkspace(
    agentInstanceId: string,
    workspacePath: string,
  ): Promise<void> {
    const previous = this.mountOperationsPerAgent.get(agentInstanceId);
    const operation = (
      previous ? previous.catch(() => undefined) : Promise.resolve()
    ).then(() => this.mountWorkspaceSerial(agentInstanceId, workspacePath));
    this.mountOperationsPerAgent.set(agentInstanceId, operation);

    try {
      await operation;
    } finally {
      if (this.mountOperationsPerAgent.get(agentInstanceId) === operation) {
        this.mountOperationsPerAgent.delete(agentInstanceId);
      }
    }
  }

  private async mountWorkspaceSerial(
    agentInstanceId: string,
    workspacePath: string,
  ): Promise<void> {
    const prefix = mountPrefixForPath(workspacePath);
    const registeredWorkspacePath = this.workspacePathsPerMount.get(prefix);
    if (
      registeredWorkspacePath !== undefined &&
      registeredWorkspacePath !== workspacePath
    ) {
      throw new Error(
        `Workspace mount prefix collision for ${prefix}; refusing to alias distinct paths`,
      );
    }
    const isNewWorkspace = registeredWorkspacePath === undefined;

    // Bail if this agent already has this workspace mounted.
    const existing = this.agentMounts.get(agentInstanceId);
    if (existing?.has(prefix)) return;

    if (isNewWorkspace) {
      // Reserve synchronously before awaiting the host. This closes the
      // check/attach/write race for both same-path and colliding-path mounts.
      this.workspacePathsPerMount.set(prefix, workspacePath);
      const initialization = this.initializeWorkspace(workspacePath);
      this.workspaceInitializations.set(prefix, initialization);
      try {
        await initialization;
      } catch (error) {
        if (this.workspacePathsPerMount.get(prefix) === workspacePath) {
          this.workspacePathsPerMount.delete(prefix);
        }
        throw error;
      } finally {
        if (this.workspaceInitializations.get(prefix) === initialization) {
          this.workspaceInitializations.delete(prefix);
        }
      }
    } else {
      // Another agent may have claimed this path immediately before awaiting
      // its host attach hook. Do not expose a half-initialized workspace.
      await this.workspaceInitializations.get(prefix);
    }

    const mounts = existing ?? new Set<MountPrefix>();
    mounts.add(prefix);
    this.agentMounts.set(agentInstanceId, mounts);

    const [workspaceMdContent, agentsMdContent, skills, git] =
      await Promise.all([
        readWorkspaceMd(workspacePath),
        readAgentsMd(workspacePath),
        getSkills(workspacePath),
        Promise.resolve(
          this.hooks.getWorkspaceGitSummary?.(workspacePath),
        ).then((summary) => summary ?? null),
      ]);

    const entry: MountEntry = {
      prefix,
      path: workspacePath,
      git,
      skills: skills.map((s) => ({
        name: s.name,
        description: s.description,
      })),
      workspaceMdContent,
      agentsMdContent,
    };
    let agentEntries = this.mountEntriesPerAgent.get(agentInstanceId);
    if (!agentEntries) {
      agentEntries = new Map<MountPrefix, MountEntry>();
      this.mountEntriesPerAgent.set(agentInstanceId, agentEntries);
    }
    agentEntries.set(prefix, entry);
    this.rebuildMountsFor(agentInstanceId);

    this.hooks.onMountsChanged?.(agentInstanceId);

    this.telemetry?.capture('workspace-mounted', {
      agent_type: this.getAgentType(agentInstanceId),
      agent_instance_id: agentInstanceId,
    });
  }

  private async initializeWorkspace(workspacePath: string): Promise<void> {
    try {
      // Host spins up ClientRuntime / LSP first so subsequent reads (and
      // watcher refreshes) find a ready runtime.
      await this.hooks.onWorkspaceAttached?.(workspacePath);
      this.startWorkspaceWatcher(workspacePath);
    } catch (error) {
      this.stopWorkspaceWatcher(workspacePath);
      try {
        this.hooks.onWorkspaceReleased?.(workspacePath);
      } catch (releaseError) {
        this.logger.debug(
          '[MountManager] Failed to release workspace after attach failure',
          { error: releaseError, path: workspacePath },
        );
      }
      throw error;
    }
  }

  /**
   * Detach a single mount prefix from an agent instance. Releases the
   * underlying workspace when it is no longer referenced by any
   * agent.
   */
  public unmountWorkspace(agentInstanceId: string, mountPrefix: string): void {
    const mounts = this.agentMounts.get(agentInstanceId);
    if (!mounts?.has(mountPrefix)) return;

    mounts.delete(mountPrefix);
    this.releaseMountIfUnused(mountPrefix);

    const agentEntries = this.mountEntriesPerAgent.get(agentInstanceId);
    agentEntries?.delete(mountPrefix);
    this.rebuildMountsFor(agentInstanceId);

    this.hooks.onMountsChanged?.(agentInstanceId);
    this.telemetry?.capture('workspace-unmounted', {
      agent_type: this.getAgentType(agentInstanceId),
      agent_instance_id: agentInstanceId,
    });
  }

  /**
   * Drops every mount for an agent. Releases orphan workspace paths
   * so watchers / LSP / runtime state do not leak.
   */
  public clearAgentMounts(agentInstanceId: string): void {
    const mounts = this.agentMounts.get(agentInstanceId);
    this.agentMounts.delete(agentInstanceId);
    this.mountEntriesPerAgent.delete(agentInstanceId);
    if (!mounts) return;
    for (const prefix of mounts) this.releaseMountIfUnused(prefix);
  }

  /**
   * Replace the in-memory `workspaceMdContent` for every mount that
   * points at `workspacePath`. Host-side `WorkspaceMdAgent` uses this
   * after writing a new workspace document so the Karton-mirrored
   * state reflects the new content immediately.
   */
  public setWorkspaceMdContent(
    workspacePath: string,
    content: string | null,
  ): void {
    const dirtyAgents = new Set<AgentInstanceId>();
    for (const [agentId, entries] of this.mountEntriesPerAgent) {
      for (const [prefix, entry] of entries) {
        if (entry.path !== workspacePath) continue;
        entries.set(prefix, { ...entry, workspaceMdContent: content });
        dirtyAgents.add(agentId);
      }
    }
    for (const agentId of dirtyAgents) this.rebuildMountsFor(agentId);
  }

  public findWorkspaceForFile(
    agentInstanceId: string,
    filePath: string,
  ): string | undefined {
    const mounts = this.agentMounts.get(agentInstanceId);
    if (!mounts) return undefined;
    const candidates: string[] = [];
    for (const prefix of mounts) {
      const wsPath = this.workspacePathsPerMount.get(prefix);
      if (wsPath) candidates.push(wsPath);
    }
    return pickOwningWorkspace(filePath, candidates);
  }

  public getAllMountedPaths(): Set<string> {
    return new Set(this.workspacePathsPerMount.values());
  }

  public getMountPrefixes(agentInstanceId: string): MountPrefix[] | undefined {
    const mounts = this.agentMounts.get(agentInstanceId);
    return mounts ? [...mounts] : undefined;
  }

  public getWorkspacePathForPrefix(prefix: string): string | undefined {
    return this.workspacePathsPerMount.get(prefix);
  }

  public getWorkspaceSnapshot(agentInstanceId: string): WorkspaceSnapshot {
    const mounts = this.agentMounts.get(agentInstanceId);
    if (!mounts || mounts.size === 0) return { mounts: [] };

    return {
      mounts: [...mounts]
        .map((prefix) => ({
          prefix,
          path: this.workspacePathsPerMount.get(prefix) ?? '',
        }))
        .filter((m) => m.path !== ''),
    };
  }

  public async teardownWatchers(): Promise<void> {
    for (const wsPath of [...this.watchersPerPath.keys()]) {
      this.stopWorkspaceWatcher(wsPath);
    }
  }

  /**
   * Rebuild the per-agent `MountEntry[]` from `agentMounts` +
   * `mountEntriesPerAgent` and write it through the store. Always
   * allocates a fresh array so the bridge mirror's reference-identity
   * diff fires.
   */
  private rebuildMountsFor(agentInstanceId: AgentInstanceId): void {
    const mounts = this.agentMounts.get(agentInstanceId);
    const entries = this.mountEntriesPerAgent.get(agentInstanceId);
    if (!mounts || !entries) {
      setAgentMounts(this.store, agentInstanceId, []);
      return;
    }
    const fresh: MountEntry[] = [];
    for (const prefix of mounts) {
      const entry = entries.get(prefix);
      if (entry) fresh.push(entry);
    }
    setAgentMounts(this.store, agentInstanceId, fresh);
  }

  private releaseMountIfUnused(mountPrefix: string): void {
    const stillInUse = [...this.agentMounts.values()].some((m) =>
      m.has(mountPrefix),
    );
    if (stillInUse) return;
    const workspacePath = this.workspacePathsPerMount.get(mountPrefix);
    if (!workspacePath) return;
    this.workspacePathsPerMount.delete(mountPrefix);
    this.stopWorkspaceWatcher(workspacePath);
    this.hooks.onWorkspaceReleased?.(workspacePath);
  }

  private startWorkspaceWatcher(wsPath: WorkspacePath): void {
    if (this.watchersPerPath.has(wsPath)) return;

    // Always include `.clodex` so the legacy skills dir keeps
    // working. When the host-configured workspaceMd dir is something
    // else (e.g. `.agents`), it's added too so the watcher fires on
    // file changes there.
    const allowedTopLevel = new Set([
      '.clodex',
      '.agents',
      '.git',
      'AGENTS.md',
      this.workspaceMdDir,
    ]);
    const allowedChildren: Record<string, Set<string>> = {
      '.clodex': new Set(['skills']),
      '.agents': new Set(['skills']),
      '.git': new Set(['HEAD']),
    };
    // Add the host-configured workspace-md file under its dir.
    if (!allowedChildren[this.workspaceMdDir]) {
      allowedChildren[this.workspaceMdDir] = new Set();
    }
    allowedChildren[this.workspaceMdDir]!.add(this.workspaceMdFile);

    const workspaceMdPath = path.join(wsPath, this.workspaceMdRelativePath);
    const watcher = watch([wsPath, workspaceMdPath], {
      persistent: true,
      ignoreInitial: true,
      // depth 4 = .clodex/skills/<skill-name>/SKILL.md
      depth: 4,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      ignored: (filePath: string) => {
        if (filePath === wsPath) return false;
        const rel = path.relative(wsPath, filePath);
        const segments = rel.split(path.sep);
        const first = segments[0] ?? '';
        const second = segments[1] ?? '';
        if (segments.length === 1) return !allowedTopLevel.has(first);
        if (segments.length === 2) {
          const allowed = allowedChildren[first];
          return !allowed?.has(second);
        }
        return !(
          (first === '.clodex' || first === '.agents') &&
          second === 'skills'
        );
      },
    });

    const scheduleRefresh = () => {
      const existing = this.watcherDebounceTimers.get(wsPath);
      if (existing) clearTimeout(existing);
      this.watcherDebounceTimers.set(
        wsPath,
        setTimeout(() => {
          this.watcherDebounceTimers.delete(wsPath);
          void this.refreshWorkspaceInfo(wsPath);
        }, 400),
      );
    };

    watcher
      .on('add', scheduleRefresh)
      .on('change', scheduleRefresh)
      .on('unlink', scheduleRefresh)
      .on('addDir', scheduleRefresh)
      .on('unlinkDir', scheduleRefresh)
      .on('error', (error) => {
        this.logger.debug('[MountManager] Workspace watcher error', {
          error,
          path: wsPath,
        });
      });

    this.watchersPerPath.set(wsPath, watcher);
    this.logger.debug('[MountManager] Started workspace watcher', {
      path: wsPath,
    });
  }

  private stopWorkspaceWatcher(wsPath: WorkspacePath): void {
    const timer = this.watcherDebounceTimers.get(wsPath);
    if (timer) {
      clearTimeout(timer);
      this.watcherDebounceTimers.delete(wsPath);
    }
    const watcher = this.watchersPerPath.get(wsPath);
    if (watcher) {
      void watcher.close();
      this.watchersPerPath.delete(wsPath);
      this.logger.debug('[MountManager] Stopped workspace watcher', {
        path: wsPath,
      });
    }
  }

  /** Re-reads skills and MD files, then pushes updates through the store. */
  private async refreshWorkspaceInfo(wsPath: WorkspacePath): Promise<void> {
    try {
      const [workspaceMdContent, agentsMdContent, skills, git] =
        await Promise.all([
          readWorkspaceMd(wsPath),
          readAgentsMd(wsPath),
          getSkills(wsPath),
          Promise.resolve(this.hooks.getWorkspaceGitSummary?.(wsPath)).then(
            (summary) => summary ?? null,
          ),
        ]);

      const skillEntries = skills.map((s) => ({
        name: s.name,
        description: s.description,
      }));

      const dirtyAgents = new Set<AgentInstanceId>();
      for (const [agentId, entries] of this.mountEntriesPerAgent) {
        for (const [prefix, entry] of entries) {
          if (entry.path !== wsPath) continue;
          entries.set(prefix, {
            ...entry,
            skills: skillEntries,
            git,
            workspaceMdContent,
            agentsMdContent,
          });
          dirtyAgents.add(agentId);
        }
      }
      for (const agentId of dirtyAgents) this.rebuildMountsFor(agentId);

      for (const [agentId, mounts] of this.agentMounts) {
        for (const prefix of mounts) {
          if (this.workspacePathsPerMount.get(prefix) === wsPath) {
            this.hooks.onMountsChanged?.(agentId);
            break;
          }
        }
      }
    } catch (error) {
      this.logger.debug('[MountManager] Failed to refresh workspace info', {
        error,
        path: wsPath,
      });
      this.report(error as Error, 'refreshWorkspaceInfo', { path: wsPath });
    }
  }

  private report(
    error: Error,
    operation: string,
    extra?: Record<string, unknown>,
  ): void {
    this.telemetry?.captureException(error, {
      service: 'mount-manager',
      operation,
      ...extra,
    });
  }
}
