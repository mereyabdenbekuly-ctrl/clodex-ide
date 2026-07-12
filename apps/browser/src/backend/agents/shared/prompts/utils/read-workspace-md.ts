/**
 * Thin re-export shim — the canonical implementation lives in
 * `@clodex/agent-core/mount-manager` (see Phase 8).
 *
 * `WORKSPACE_MD_DIR` stays host-local because only the browser-side
 * writer (`WorkspaceMdAgent`) consumes it; the core reader resolves
 * the directory internally via `WORKSPACE_MD_FILENAME`.
 */
export {
  readWorkspaceMd,
  WORKSPACE_MD_FILENAME,
} from '@clodex/agent-core/mount-manager';

export const WORKSPACE_MD_DIR = '.clodex';
