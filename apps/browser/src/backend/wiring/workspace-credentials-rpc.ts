import type { CredentialTypeId } from '@shared/credential-types';
import type { WorktreeSetupScriptVariant } from '@shared/worktree-setup';
import type { AgentManagerService } from '../services/agent-manager';
import type { CredentialsService } from '../services/credentials';
import type { KartonService } from '../services/karton';
import type { ToolboxService } from '../services/toolbox';
import type { WorktreeSetupSettingsService } from '../services/worktree-setup-settings';

export function wireWorkspaceCredentialsRpc(deps: {
  uiKarton: Pick<KartonService, 'registerServerProcedureHandler'>;
  toolboxService: Pick<ToolboxService, 'getContextFilesForAllWorkspaces'>;
  agentManagerService: Pick<AgentManagerService, 'generateWorkspaceMdForPath'>;
  worktreeSetupSettingsService: Pick<
    WorktreeSetupSettingsService,
    'listRepositories' | 'saveScript' | 'deleteManagedWorktree'
  >;
  credentialsService: Pick<
    CredentialsService,
    'set' | 'delete' | 'listConfigured'
  >;
}): void {
  const {
    uiKarton,
    toolboxService,
    agentManagerService,
    worktreeSetupSettingsService,
    credentialsService,
  } = deps;

  // toolbox.getContextFiles / toolbox.generateWorkspaceMdForPath
  uiKarton.registerServerProcedureHandler(
    'toolbox.getContextFiles',
    async (_cid: string) => {
      return toolboxService.getContextFilesForAllWorkspaces();
    },
  );
  uiKarton.registerServerProcedureHandler(
    'toolbox.generateWorkspaceMdForPath',
    async (_cid: string, workspacePath: string) => {
      await agentManagerService.generateWorkspaceMdForPath(workspacePath);
    },
  );

  // toolbox worktree setup settings procedures
  uiKarton.registerServerProcedureHandler(
    'toolbox.listWorktreeSetupRepositories',
    async () => worktreeSetupSettingsService.listRepositories(),
  );
  uiKarton.registerServerProcedureHandler(
    'toolbox.saveWorktreeSetupScript',
    async (
      _cid: string,
      mainWorktreePath: string,
      variant: WorktreeSetupScriptVariant,
      content: string,
    ) =>
      worktreeSetupSettingsService.saveScript(
        mainWorktreePath,
        variant,
        content,
      ),
  );
  uiKarton.registerServerProcedureHandler(
    'toolbox.deleteWorktreeSetupWorktree',
    async (_cid: string, worktreePath: string) =>
      worktreeSetupSettingsService.deleteManagedWorktree(worktreePath),
  );

  // credentials.set / credentials.delete / credentials.getConfiguredIds
  uiKarton.registerServerProcedureHandler(
    'credentials.set',
    async (_cid: string, typeId: string, data: Record<string, string>) => {
      await credentialsService.set(
        typeId as CredentialTypeId,
        data as Parameters<typeof credentialsService.set>[1],
      );
    },
  );
  uiKarton.registerServerProcedureHandler(
    'credentials.delete',
    async (_cid: string, typeId: string) => {
      await credentialsService.delete(typeId as CredentialTypeId);
    },
  );
  uiKarton.registerServerProcedureHandler(
    'credentials.getConfiguredIds',
    async (_cid: string) => {
      return credentialsService.listConfigured();
    },
  );
}
