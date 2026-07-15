import path from 'node:path';
import type { HostPaths } from '@clodex/agent-core/host';

/**
 * Session-scoped paths under `os.tmpdir()/clodex-cli/<sessionId>/`.
 */
export function createCliHostPaths(sessionRoot: string): HostPaths {
  if (sessionRoot.trim().length === 0) {
    throw new Error('CLI session root must be non-empty');
  }
  const root = path.resolve(sessionRoot);
  const data = path.join(root, 'data');
  const clodex = path.join(data, 'clodex');

  return {
    dataDir: () => clodex,
    tempDir: () => path.join(root, 'tmp'),

    agentsDir: () => path.join(clodex, 'agents'),
    agentDir: (agentId: string) =>
      path.join(clodex, 'agents', requirePathSegment(agentId, 'Agent ID')),
    agentAttachmentsDir: (agentId: string) =>
      path.join(
        clodex,
        'agents',
        requirePathSegment(agentId, 'Agent ID'),
        'attachments',
      ),
    agentAttachmentPath: (agentId: string, attachmentId: string) =>
      path.join(
        clodex,
        'agents',
        requirePathSegment(agentId, 'Agent ID'),
        'attachments',
        requirePathSegment(attachmentId, 'Attachment ID'),
      ),
    agentAppsDir: (agentId: string) =>
      path.join(
        clodex,
        'agents',
        requirePathSegment(agentId, 'Agent ID'),
        'apps',
      ),
    agentShellLogsDir: (agentId: string) =>
      path.join(
        clodex,
        'agents',
        requirePathSegment(agentId, 'Agent ID'),
        'shell-logs',
      ),

    diffHistoryDir: () => path.join(clodex, 'diff-history'),
    diffHistoryDbPath: () => path.join(clodex, 'diff-history', 'data.sqlite'),
    diffHistoryBlobsDir: () => path.join(clodex, 'diff-history', 'blobs'),
    agentDbPath: () => path.join(clodex, 'agents', 'instances.sqlite'),
    fileReadCacheDbPath: () => path.join(clodex, 'file-read-cache.sqlite'),
    processedImageCacheDbPath: () =>
      path.join(clodex, 'processed-image-cache.sqlite'),

    userDataDir: () => path.join(clodex, 'user'),
    plansDir: () => path.join(clodex, 'user', 'plans'),
    logsDir: () => path.join(clodex, 'user', 'logs'),
    memoryDir: () => path.join(clodex, 'user', 'memory'),

    pluginsDir: () => path.join(root, 'bundled', 'plugins'),
    builtinSkillsDir: () => path.join(root, 'bundled', 'builtin-skills'),
    ripgrepBaseDir: () => path.join(root, 'bundled', 'ripgrep'),
  };
}

function requirePathSegment(value: string, label: string): string {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('\0') ||
    value.includes('/') ||
    value.includes('\\') ||
    path.basename(value) !== value
  ) {
    throw new Error(`${label} must be a single safe path segment`);
  }
  return value;
}
