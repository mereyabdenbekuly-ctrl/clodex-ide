import type { DiffHistoryService } from '../diff-history';
import type { PendingEditService } from '../pending-edits';
import type { ProjectIndexService } from '../project-index';
import type { HostPaths, Logger, ProtectedFileStorage } from '../../host';
export type MountPermission = 'read' | 'write' | 'create' | 'delete';

export interface StaticMount {
  prefix: string;
  absolutePath: string;
  permissions: readonly MountPermission[];
}

export interface UniversalToolboxMountManager {
  getMountPrefixes(agentInstanceId: string): string[] | undefined;
  getWorkspacePathForPrefix(prefix: string): string | undefined;
  getMountPermissionsForPrefix?(
    agentInstanceId: string,
    prefix: string,
  ): readonly MountPermission[] | undefined;
  findWorkspaceForFile(
    agentInstanceId: string,
    filePath: string,
  ): string | undefined;
}

export interface UniversalToolboxMutationObserver {
  onTextFileWritten?: (
    agentInstanceId: string,
    absolutePath: string,
    content: string,
  ) => Promise<void> | void;
  onTextFileClosed?: (
    agentInstanceId: string,
    absolutePath: string,
  ) => Promise<void> | void;
}

export interface UniversalToolboxDeps {
  agentInstanceId: string;
  hostPaths: HostPaths;
  mountManager?: UniversalToolboxMountManager | null;
  staticMounts?: readonly StaticMount[];
  diffHistoryService?: DiffHistoryService | null;
  pendingEditService?: PendingEditService | null;
  projectIndexService?: ProjectIndexService | null;
  logger?: Logger;
  protectedFiles?: ProtectedFileStorage;
  mutations?: UniversalToolboxMutationObserver;
  /**
   * Path passed to ClientRuntimeNode for ripgrep dispatch. When absent
   * or pointing at a missing binary, runtime-node silently falls back
   * to its minimatch + ignore JS path.
   */
  rgBinaryBasePath?: string;
}

export type MakeUniversalToolsDeps = UniversalToolboxDeps;
