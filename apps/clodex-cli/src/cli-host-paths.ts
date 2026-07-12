import path from 'node:path';
import type { HostPaths } from '@clodex/agent-core/host';

/**
 * Session-scoped paths under `os.tmpdir()/clodex-cli/<sessionId>/`.
 */
export function createCliHostPaths(sessionRoot: string): HostPaths {
  const data = path.join(sessionRoot, 'data');
  const clodex = path.join(data, 'clodex');

  return {
    dataDir: () => clodex,
    tempDir: () => path.join(sessionRoot, 'tmp'),

    agentsDir: () => path.join(clodex, 'agents'),
    agentDir: (agentId: string) => path.join(clodex, 'agents', agentId),
    agentAttachmentsDir: (agentId: string) =>
      path.join(clodex, 'agents', agentId, 'attachments'),
    agentAttachmentPath: (agentId: string, attachmentId: string) =>
      path.join(clodex, 'agents', agentId, 'attachments', attachmentId),
    agentAppsDir: (agentId: string) =>
      path.join(clodex, 'agents', agentId, 'apps'),
    agentShellLogsDir: (agentId: string) =>
      path.join(clodex, 'agents', agentId, 'shell-logs'),

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

    pluginsDir: () => path.join(sessionRoot, 'bundled', 'plugins'),
    builtinSkillsDir: () => path.join(sessionRoot, 'bundled', 'builtin-skills'),
    ripgrepBaseDir: () => path.join(sessionRoot, 'bundled', 'ripgrep'),
  };
}
