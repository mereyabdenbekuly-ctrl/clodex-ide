import { describe, expect, it, vi } from 'vitest';
import { wireWorkspaceCredentialsRpc } from './workspace-credentials-rpc';

type Handler = (
  callingClientId: string,
  ...args: unknown[]
) => Promise<unknown>;

function createHarness() {
  const handlers = new Map<string, Handler>();
  const registerServerProcedureHandler = vi.fn(
    (name: string, handler: unknown) => {
      handlers.set(name, handler as Handler);
    },
  );
  const getContextFilesForAllWorkspaces = vi.fn();
  const generateWorkspaceMdForPath = vi.fn();
  const listRepositories = vi.fn();
  const saveScript = vi.fn();
  const deleteManagedWorktree = vi.fn();
  const setCredential = vi.fn();
  const deleteCredential = vi.fn();
  const listConfigured = vi.fn();

  wireWorkspaceCredentialsRpc({
    uiKarton: { registerServerProcedureHandler },
    toolboxService: { getContextFilesForAllWorkspaces },
    agentManagerService: { generateWorkspaceMdForPath },
    worktreeSetupSettingsService: {
      listRepositories,
      saveScript,
      deleteManagedWorktree,
    },
    credentialsService: {
      set: setCredential,
      delete: deleteCredential,
      listConfigured,
    },
  } as unknown as Parameters<typeof wireWorkspaceCredentialsRpc>[0]);

  const getHandler = (name: string): Handler => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Missing handler: ${name}`);
    return handler;
  };

  return {
    registerServerProcedureHandler,
    getHandler,
    getContextFilesForAllWorkspaces,
    generateWorkspaceMdForPath,
    listRepositories,
    saveScript,
    deleteManagedWorktree,
    setCredential,
    deleteCredential,
    listConfigured,
  };
}

describe('wireWorkspaceCredentialsRpc', () => {
  it('registers workspace and credential procedures in order', () => {
    const { registerServerProcedureHandler } = createHarness();

    expect(
      registerServerProcedureHandler.mock.calls.map(([name]) => name),
    ).toEqual([
      'toolbox.getContextFiles',
      'toolbox.generateWorkspaceMdForPath',
      'toolbox.listWorktreeSetupRepositories',
      'toolbox.saveWorktreeSetupScript',
      'toolbox.deleteWorktreeSetupWorktree',
      'credentials.set',
      'credentials.delete',
      'credentials.getConfiguredIds',
    ]);
  });

  it('forwards workspace context procedures and preserves return semantics', async () => {
    const harness = createHarness();
    const contextFiles = { marker: 'context-files' };
    harness.getContextFilesForAllWorkspaces.mockResolvedValue(contextFiles);
    harness.generateWorkspaceMdForPath.mockResolvedValue('discarded');

    await expect(
      harness.getHandler('toolbox.getContextFiles')('client-1'),
    ).resolves.toBe(contextFiles);
    await expect(
      harness.getHandler('toolbox.generateWorkspaceMdForPath')(
        'client-1',
        '/workspace',
      ),
    ).resolves.toBeUndefined();

    expect(harness.getContextFilesForAllWorkspaces).toHaveBeenCalledWith();
    expect(harness.generateWorkspaceMdForPath).toHaveBeenCalledWith(
      '/workspace',
    );
  });

  it('forwards worktree setup procedures and returns service results', async () => {
    const harness = createHarness();
    const repositories = { repositories: [] };
    const saveResult = { ok: true, marker: 'saved' };
    const deleteResult = { ok: true, marker: 'deleted' };
    harness.listRepositories.mockResolvedValue(repositories);
    harness.saveScript.mockResolvedValue(saveResult);
    harness.deleteManagedWorktree.mockResolvedValue(deleteResult);

    await expect(
      harness.getHandler('toolbox.listWorktreeSetupRepositories')('client-2'),
    ).resolves.toBe(repositories);
    await expect(
      harness.getHandler('toolbox.saveWorktreeSetupScript')(
        'client-2',
        '/repo',
        'posix',
        'echo setup',
      ),
    ).resolves.toBe(saveResult);
    await expect(
      harness.getHandler('toolbox.deleteWorktreeSetupWorktree')(
        'client-2',
        '/repo/.worktrees/task',
      ),
    ).resolves.toBe(deleteResult);

    expect(harness.listRepositories).toHaveBeenCalledWith();
    expect(harness.saveScript).toHaveBeenCalledWith(
      '/repo',
      'posix',
      'echo setup',
    );
    expect(harness.deleteManagedWorktree).toHaveBeenCalledWith(
      '/repo/.worktrees/task',
    );
  });

  it('forwards credential procedures and preserves void and list results', async () => {
    const harness = createHarness();
    const data = { token: 'secret' };
    const configuredIds = ['figma-pat'];
    harness.setCredential.mockResolvedValue('discarded');
    harness.deleteCredential.mockResolvedValue('discarded');
    harness.listConfigured.mockReturnValue(configuredIds);

    await expect(
      harness.getHandler('credentials.set')('client-3', 'figma-pat', data),
    ).resolves.toBeUndefined();
    await expect(
      harness.getHandler('credentials.delete')('client-3', 'figma-pat'),
    ).resolves.toBeUndefined();
    await expect(
      harness.getHandler('credentials.getConfiguredIds')('client-3'),
    ).resolves.toBe(configuredIds);

    expect(harness.setCredential).toHaveBeenCalledWith('figma-pat', data);
    expect(harness.deleteCredential).toHaveBeenCalledWith('figma-pat');
    expect(harness.listConfigured).toHaveBeenCalledWith();
  });
});
