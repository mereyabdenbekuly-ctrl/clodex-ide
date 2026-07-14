import fs from 'node:fs/promises';
import { app } from 'electron';
import path from 'node:path';

export const getDataRoot = (): string =>
  path.join(app.getPath('userData'), 'clodex');

export const getTempRoot = (): string =>
  path.join(app.getPath('temp'), 'clodex');

export type DbName =
  | 'favicon'
  | 'web-data'
  | 'history'
  | 'thumbnails'
  | 'asset-cache'
  | 'file-read-cache'
  | 'processed-image-cache';

export const getDbPath = (name: DbName): string =>
  path.join(getDataRoot(), `${name}.sqlite`);

export const getAgentDbPath = (): string =>
  path.join(getDataRoot(), 'agents', 'instances.sqlite');

export const getDiffHistoryDbPath = (): string =>
  path.join(getDataRoot(), 'diff-history', 'data.sqlite');

export type JsonName =
  | 'config'
  | 'identity'
  | 'auth-session'
  | 'credentials'
  | 'provider-api-keys'
  | 'mcp-custom-credentials'
  | 'mcp-registry'
  | 'mcp-oauth-sessions'
  | 'mcp-approval-authority'
  | 'private-marketplace-sources'
  | 'remote-connections'
  | 'docker-runner-profiles'
  | 'data-protection-key'
  | 'runner-signing-identity'
  | 'ssh-runner-signing-identity'
  | 'docker-runner-signing-identity'
  | 'preferences'
  | 'recently-opened-workspaces'
  | 'onboarding-state'
  | 'downloads-state'
  | 'window-state'
  | 'tab-state'
  | 'tutorial-state'
  | 'experience-survey'
  | 'experience-founder-call-survey'
  | 'generated-app-library'
  | 'automations'
  | 'automation-dispatch-wal'
  | 'artifact-capability-grants'
  | 'artifact-effect-wal'
  | 'generated-app-package-trust'
  | 'spaces'
  | 'session-shares'
  | 'session-checkpoints'
  | 'first-used-at';

export const getJsonPath = (name: JsonName): string =>
  path.join(getDataRoot(), `${name}.json`);

export const getAgentsDir = (): string => path.join(getDataRoot(), 'agents');

export const getAgentDir = (agentId: string): string =>
  path.join(getDataRoot(), 'agents', agentId);

export const getAgentAttachmentsDir = (agentId: string): string =>
  path.join(getDataRoot(), 'agents', agentId, 'data-attachments');

export const getAgentAttachmentPath = (
  agentId: string,
  attachmentId: string,
): string =>
  path.join(getDataRoot(), 'agents', agentId, 'data-attachments', attachmentId);

export const getAgentAppsDir = (agentId: string): string =>
  path.join(getDataRoot(), 'agents', agentId, 'apps');

export const getAgentShellLogsDir = (agentId: string): string =>
  path.join(getDataRoot(), 'agents', agentId, 'shell-logs');

export const getDiffHistoryDir = (): string =>
  path.join(getDataRoot(), 'diff-history');

export const getDiffHistoryBlobsDir = (): string =>
  path.join(getDataRoot(), 'diff-history', 'data-blobs');

export const getUserDataDir = (): string =>
  path.join(getDataRoot(), 'user-data');

export const getPlansDir = (): string => path.join(getUserDataDir(), 'plans');

export const getLogsDir = (): string => path.join(getUserDataDir(), 'logs');

export const getMemoryDir = (): string => path.join(getUserDataDir(), 'memory');

export const getAgentOsDir = (): string =>
  path.join(getUserDataDir(), 'agent-os');

export const getAgentOsStatePath = (): string =>
  path.join(getAgentOsDir(), 'state.json');

export const getChronicleDir = (): string =>
  path.join(getAgentOsDir(), 'chronicle');

export const getChronicleSegmentsDir = (): string =>
  path.join(getChronicleDir(), 'segments');

export const getChronicleOcrDir = (): string =>
  path.join(getChronicleDir(), 'ocr');

export const getChronicleSummariesDir = (): string =>
  path.join(getChronicleDir(), 'summaries');

export const getInstalledSkillsDir = (): string =>
  path.join(getAgentOsDir(), 'installed-skills');

export const getPluginMarketplaceDir = (): string =>
  path.join(getAgentOsDir(), 'plugin-marketplace');

export const getInstalledPluginsDir = (): string =>
  path.join(getPluginMarketplaceDir(), 'installed');

export const getPluginMarketplaceStagingDir = (): string =>
  path.join(getPluginMarketplaceDir(), 'staging');

export const getPluginMarketplaceLockPath = (): string =>
  path.join(getPluginMarketplaceDir(), 'lock.json');

export const getRemoteControlDir = (): string =>
  path.join(getAgentOsDir(), 'remote-control');

export const getNetworkPolicyAuditPath = (): string =>
  path.join(getAgentOsDir(), 'audit', 'network-policy.jsonl');

export const getArtifactBridgeAuditPath = (): string =>
  path.join(getAgentOsDir(), 'audit', 'artifact-bridge.jsonl');

export const getShellCapabilityAuditPath = (): string =>
  path.join(getAgentOsDir(), 'audit', 'shell-capabilities.jsonl');

export const getRemoteControlSecretsPath = (): string =>
  path.join(getRemoteControlDir(), 'clients.json');

export const getWorktreesDir = (): string =>
  path.join(app.getPath('home'), '.clodex', 'worktrees');

export const getRipgrepBasePath = (): string => path.join(getDataRoot(), 'bin');

export async function ensureDataDirectories(): Promise<void> {
  await Promise.all([
    fs.mkdir(getDataRoot(), { recursive: true }),
    fs.mkdir(getTempRoot(), { recursive: true }),
    fs.mkdir(getAgentsDir(), { recursive: true }),
    fs.mkdir(getDiffHistoryDir(), { recursive: true }),
    fs.mkdir(getRipgrepBasePath(), { recursive: true }),
    fs.mkdir(getUserDataDir(), { recursive: true }),
    fs.mkdir(getPlansDir(), { recursive: true }),
    fs.mkdir(getLogsDir(), { recursive: true }),
    fs.mkdir(getMemoryDir(), { recursive: true }),
    fs.mkdir(getAgentOsDir(), { recursive: true }),
    fs.mkdir(getChronicleDir(), { recursive: true }),
    fs.mkdir(getChronicleSegmentsDir(), { recursive: true }),
    fs.mkdir(getChronicleOcrDir(), { recursive: true }),
    fs.mkdir(getChronicleSummariesDir(), { recursive: true }),
    fs.mkdir(getInstalledSkillsDir(), { recursive: true }),
    fs.mkdir(getPluginMarketplaceDir(), { recursive: true }),
    fs.mkdir(getInstalledPluginsDir(), { recursive: true }),
    fs.mkdir(getPluginMarketplaceStagingDir(), { recursive: true }),
    fs.mkdir(getRemoteControlDir(), { recursive: true }),
    fs.mkdir(getWorktreesDir(), { recursive: true }),
  ]);
}

export const getPluginsPath = (): string => {
  if (app.isPackaged)
    return path.join(process.resourcesPath, 'bundled', 'plugins');
  return path.join(app.getAppPath(), 'bundled', 'plugins');
};

export const getBundledPluginMarketplaceIndexPath = (): string => {
  if (app.isPackaged)
    return path.join(
      process.resourcesPath,
      'bundled',
      'marketplace',
      'index.json',
    );
  return path.join(app.getAppPath(), 'bundled', 'marketplace', 'index.json');
};

export const getBuiltinSkillsPath = (): string => {
  if (app.isPackaged)
    return path.join(process.resourcesPath, 'bundled', 'skills');
  return path.join(app.getAppPath(), 'bundled', 'skills');
};
