/**
 * Workspace mount prefixes emitted by supported CLODEx versions:
 *
 * - legacy: `w` + 4 SHA-256 hex characters (16-bit namespace)
 * - current: `w` + 16 SHA-256 hex characters (64-bit namespace)
 *
 * Keep the accepted lengths explicit so arbitrary user paths such as
 * `widget/` or malformed internal identifiers are never stripped.
 */
const WORKSPACE_MOUNT_PREFIX_RE = /^w(?:[0-9a-f]{4}|[0-9a-f]{16})(?:\/|$)/;

export function stripWorkspaceMountPrefix(path: string): string {
  return path.replace(WORKSPACE_MOUNT_PREFIX_RE, '');
}
