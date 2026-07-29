import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HostPaths } from '../../host';
import { createTestAgentHost } from '../../host/test-utils';
import { AgentStore, createInitialAgentSystemState } from '../../store';
import { DiffHistoryService } from './index';

function makeHostPaths(root: string): HostPaths {
  return {
    dataDir: () => path.join(root, 'data'),
    tempDir: () => path.join(root, 'tmp'),
    agentsDir: () => path.join(root, 'agents'),
    agentDir: (agentId) => path.join(root, 'agents', agentId),
    agentAttachmentsDir: (agentId) =>
      path.join(root, 'agents', agentId, 'attachments'),
    agentAttachmentPath: (agentId, attachmentId) =>
      path.join(root, 'agents', agentId, 'attachments', attachmentId),
    agentAppsDir: (agentId) => path.join(root, 'agents', agentId, 'apps'),
    agentShellLogsDir: (agentId) =>
      path.join(root, 'agents', agentId, 'shells'),
    diffHistoryDir: () => path.join(root, 'diff-history'),
    // This suite validates service semantics, not file-backed reopen behavior.
    // Keeping SQLite in memory also avoids a native libsql Windows teardown
    // race where a just-closed database file can remain undeletable until the
    // Vitest worker exits.
    // libsql transactions use a second connection. `cache=shared` keeps the
    // schema and rows visible across those connections while retaining the
    // Windows-safe in-memory teardown behavior this integration suite needs.
    diffHistoryDbPath: () => ':memory:?cache=shared',
    diffHistoryBlobsDir: () => path.join(root, 'diff-history', 'blobs'),
    agentDbPath: () => path.join(root, 'agent.sqlite'),
    fileReadCacheDbPath: () => path.join(root, 'file-read-cache.sqlite'),
    processedImageCacheDbPath: () =>
      path.join(root, 'processed-image-cache.sqlite'),
    userDataDir: () => path.join(root, 'user-data'),
    plansDir: () => path.join(root, 'plans'),
    logsDir: () => path.join(root, 'logs'),
    memoryDir: () => path.join(root, 'memory'),
    pluginsDir: () => path.join(root, 'plugins'),
    builtinSkillsDir: () => path.join(root, 'plugins'),
    ripgrepBaseDir: () => path.join(root, 'rg'),
  };
}

describe('durable human-accepted edit provenance', () => {
  let root: string;
  let paths: HostPaths;
  let service: DiffHistoryService;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'clodex-human-accepted-edit-'));
    paths = makeHostPaths(root);
    for (const directory of [
      paths.diffHistoryDir(),
      paths.diffHistoryBlobsDir(),
      paths.plansDir(),
      paths.logsDir(),
      paths.tempDir(),
    ]) {
      mkdirSync(directory, { recursive: true });
    }
    service = await DiffHistoryService.create({
      host: createTestAgentHost({ paths }),
      store: new AgentStore(createInitialAgentSystemState()),
    });
  });

  afterEach(async () => {
    await service.teardown();
    // Windows can retain the closed SQLite file for a few scheduler ticks.
    // Node's recursive rm retry loop is specifically designed for transient
    // EBUSY/EPERM/ENOTEMPTY cleanup races on that platform.
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });

  it('records a human acceptance for an internal plan without relying on UI projection', async () => {
    const planPath = path.join(paths.plansDir(), 'accepted-plan.md');
    await service.registerAgentEdit({
      agentInstanceId: 'agent-1',
      path: planPath,
      toolCallId: 'create-plan',
      workspaceRoot: paths.plansDir(),
      isExternal: false,
      contentBefore: null,
      contentAfter: '# Accepted plan\n',
    });

    await expect(
      service.hasCleanHumanAcceptedEditForAgentFile('agent-1', planPath),
    ).resolves.toBe(false);

    await service.acceptPendingEditsForAgentFile('agent-1', planPath);

    await expect(
      service.hasCleanHumanAcceptedEditForAgentFile('agent-1', planPath),
    ).resolves.toBe(true);
  });

  it('retains the accepted owner through consecutive automatic policy edits', async () => {
    const planPath = path.join(paths.plansDir(), 'progress-plan.md');
    const initial = '- [ ] first\n- [ ] second\n';
    const afterFirst = '- [x] first\n- [ ] second\n';
    const afterSecond = '- [x] first\n- [x] second\n';
    await service.registerAgentEdit({
      agentInstanceId: 'agent-1',
      path: planPath,
      toolCallId: 'create-plan',
      workspaceRoot: paths.plansDir(),
      isExternal: false,
      contentBefore: null,
      contentAfter: initial,
    });
    await service.acceptPendingEditsForAgentFile('agent-1', planPath);

    await expect(
      service.registerAutoApprovedTextEdit({
        agentInstanceId: 'agent-1',
        path: planPath,
        toolCallId: 'check-first',
        workspaceRoot: paths.plansDir(),
        contentBefore: initial,
        contentAfter: afterFirst,
      }),
    ).resolves.toBe(true);
    await expect(
      service.hasCleanHumanAcceptedEditForAgentFile('agent-1', planPath),
    ).resolves.toBe(true);

    await expect(
      service.registerAutoApprovedTextEdit({
        agentInstanceId: 'agent-1',
        path: planPath,
        toolCallId: 'check-second',
        workspaceRoot: paths.plansDir(),
        contentBefore: afterFirst,
        contentAfter: afterSecond,
      }),
    ).resolves.toBe(true);
    await expect(
      service.hasCleanHumanAcceptedEditForAgentFile('agent-1', planPath),
    ).resolves.toBe(true);
    await expect(
      service.hasCleanHumanAcceptedEditForAgentFile('agent-2', planPath),
    ).resolves.toBe(false);
  });

  it('requires clean history and transfers the latest human acceptance between agents', async () => {
    const planPath = path.join(paths.plansDir(), 'transferred-plan.md');
    await service.registerAgentEdit({
      agentInstanceId: 'agent-1',
      path: planPath,
      toolCallId: 'create-plan',
      workspaceRoot: paths.plansDir(),
      isExternal: false,
      contentBefore: null,
      contentAfter: '# First owner\n',
    });
    await service.acceptPendingEditsForAgentFile('agent-1', planPath);

    await service.registerAgentEdit({
      agentInstanceId: 'agent-2',
      path: planPath,
      toolCallId: 'replace-plan',
      workspaceRoot: paths.plansDir(),
      isExternal: false,
      contentBefore: '# First owner\n',
      contentAfter: '# Second owner\n',
    });

    await expect(
      service.hasCleanHumanAcceptedEditForAgentFile('agent-1', planPath),
    ).resolves.toBe(false);
    await expect(
      service.hasCleanHumanAcceptedEditForAgentFile('agent-2', planPath),
    ).resolves.toBe(false);

    await service.acceptPendingEditsForAgentFile('agent-2', planPath);

    await expect(
      service.hasCleanHumanAcceptedEditForAgentFile('agent-1', planPath),
    ).resolves.toBe(false);
    await expect(
      service.hasCleanHumanAcceptedEditForAgentFile('agent-2', planPath),
    ).resolves.toBe(true);
  });
});
