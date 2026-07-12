/**
 * Agent persistence service — stores agent metadata and message history
 * in a SQLite database keyed on `host.paths.agentDbPath()`.
 *
 * Construction is host-agnostic: callers pass `HostPaths`, `Logger`, and an
 * optional host-owned `DataProtection` capability. The package never reads
 * Electron-specific paths or keychain APIs directly.
 */
export {
  AgentPersistenceDB,
  collectWorkspaceLastUsedAtByPath,
  type AgentPersistenceDBDeps,
} from './db';
export type {
  StoredAgentInstance,
  NewStoredAgentInstance,
} from './schema';
