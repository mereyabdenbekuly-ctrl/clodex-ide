import type { KartonService } from '../services/karton';
import type { PagesService } from '../services/pages';
import type { DiffHistoryService } from '@clodex/agent-core/diff-history';
import type { WindowLayoutService } from '../services/window-layout';
import type { Logger } from '../services/logger';
import type { SandboxService } from '../services/sandbox';
import type { ActiveAppStateController } from '../services/agent-core-bridge/state/toolbox-active-app';
import type { PendingEditService } from '@clodex/agent-core';
import type { HostedPullRequestService } from '../services/hosted-pull-request';
import type { GeneratedAppLibraryService } from '../services/generated-app-library';
import type { PluginMarketplaceService } from '../services/plugin-marketplace';
import type { PreferencesService } from '../services/preferences';
import type { CredentialsService } from '../services/credentials';
import type { CredentialTypeId } from '@shared/credential-types';
import type { PluginLibrarySnapshot } from '@shared/plugin-library';
import type { Patch } from 'immer';

export function wirePagesHandlers(deps: {
  uiKarton: KartonService;
  pagesService: PagesService;
  diffHistoryService: DiffHistoryService;
  windowLayoutService: WindowLayoutService;
  getSandboxService: () => SandboxService | null;
  activeAppController: ActiveAppStateController;
  pendingEditService: PendingEditService;
  hostedPullRequestService: HostedPullRequestService;
  generatedAppLibraryService: GeneratedAppLibraryService;
  pluginMarketplaceService: PluginMarketplaceService;
  preferencesService: PreferencesService;
  credentialsService: CredentialsService;
  logger: Logger;
}): void {
  const {
    uiKarton,
    pagesService,
    diffHistoryService,
    windowLayoutService,
    getSandboxService,
    activeAppController,
    pendingEditService,
    hostedPullRequestService,
    generatedAppLibraryService,
    pluginMarketplaceService,
    preferencesService,
    credentialsService,
    logger,
  } = deps;

  const getPluginLibrarySnapshot = (): PluginLibrarySnapshot => ({
    plugins: structuredClone(uiKarton.state.plugins),
    marketplace: pluginMarketplaceService.getState(),
    disabledPluginIds: [
      ...preferencesService.get().agent.disabledPluginIds,
    ].sort(),
    configuredCredentialIds: [...credentialsService.listConfigured()].sort(),
  });

  // --- Pending edits read handler ---
  pagesService.setGetPendingEditsHandler(async (agentInstanceId: string) => {
    const pendingEdits =
      uiKarton.state.toolbox[agentInstanceId]?.pendingProposedEdits.map(
        (edit) => edit.fileDiff,
      ) ??
      uiKarton.state.toolbox[agentInstanceId]?.pendingFileDiffs ??
      [];
    return {
      found: true,
      edits: pendingEdits,
    };
  });

  pagesService.setGetHostedPullRequestHandler((query) =>
    hostedPullRequestService.getPullRequest(query),
  );
  pagesService.setSubmitHostedPullRequestReviewHandler((input) =>
    hostedPullRequestService.submitReview(input),
  );
  pagesService.setMergeHostedPullRequestHandler((input) =>
    hostedPullRequestService.mergePullRequest(input),
  );
  pagesService.setListGeneratedAppsHandler((query) =>
    generatedAppLibraryService.listGeneratedApps(query),
  );
  pagesService.setGetGeneratedAppHandler((input) =>
    generatedAppLibraryService.getGeneratedApp(input.key),
  );
  pagesService.setLaunchGeneratedAppHandler((input) =>
    generatedAppLibraryService.launchGeneratedApp(input.key),
  );
  pagesService.setDeleteGeneratedAppHandler((input) =>
    generatedAppLibraryService.deleteGeneratedApp(input.key),
  );
  pagesService.setRegenerateGeneratedAppHandler((input) =>
    generatedAppLibraryService.regenerateGeneratedApp(input.key),
  );
  pagesService.setGetPluginLibraryHandler(async () =>
    getPluginLibrarySnapshot(),
  );
  pagesService.setRefreshPluginLibraryHandler(async () => {
    await pluginMarketplaceService.refresh();
    return getPluginLibrarySnapshot();
  });
  pagesService.setPluginLibraryOperationHandler(async (operation, pluginId) => {
    const result = await pluginMarketplaceService[operation](pluginId);
    return { result, snapshot: getPluginLibrarySnapshot() };
  });
  pagesService.setPluginLibraryItemEnabledHandler(async (pluginId, enabled) => {
    if (!uiKarton.state.plugins.some((plugin) => plugin.id === pluginId)) {
      throw new Error('Only installed plugins can be enabled or disabled.');
    }
    const disabledPluginIds = new Set(
      preferencesService.get().agent.disabledPluginIds,
    );
    if (enabled) disabledPluginIds.delete(pluginId);
    else disabledPluginIds.add(pluginId);
    const patch: Patch = {
      op: 'replace',
      path: ['agent', 'disabledPluginIds'],
      value: [...disabledPluginIds].sort(),
    };
    await preferencesService.update([patch]);
    return getPluginLibrarySnapshot();
  });
  pagesService.setPluginLibraryCredentialHandler(async ({ typeId, data }) => {
    await credentialsService.set(
      typeId as CredentialTypeId,
      data as Parameters<typeof credentialsService.set>[1],
    );
    return getPluginLibrarySnapshot();
  });
  pagesService.setDeletePluginLibraryCredentialHandler(async (typeId) => {
    await credentialsService.delete(typeId as CredentialTypeId);
    return getPluginLibrarySnapshot();
  });

  // --- Mini-app message bridge handlers ---
  pagesService.setForwardAppMessageHandler(
    async (
      agentInstanceId: string,
      appId: string,
      pluginId: string | undefined,
      data: unknown,
    ) => {
      getSandboxService()?.forwardAppMessage(
        agentInstanceId,
        appId,
        pluginId,
        data,
      );
    },
  );

  pagesService.setClearPendingAppMessageHandler(
    async (agentInstanceId: string) => {
      activeAppController.clearPendingAppMessage(agentInstanceId);
    },
  );

  // --- External file content handler ---
  pagesService.setGetExternalFileContentHandler(async (oid: string) => {
    return diffHistoryService.getExternalFileContent(oid);
  });

  // --- Certificate trust handler ---
  pagesService.setTrustCertificateAndReloadHandler(
    async (tabId: string, origin: string) => {
      windowLayoutService.trustCertificateAndReload(tabId, origin);
    },
  );

  // --- Accept/reject pending edits handlers ---
  pagesService.setAcceptAllPendingEditsHandler(
    async (agentInstanceId: string) => {
      const pendingEdits =
        uiKarton.state.toolbox[agentInstanceId]?.pendingFileDiffs ?? [];
      if (pendingEdits.length === 0) {
        logger.warn(
          `[Main] acceptAllPendingEdits: no pending edits for agent instance ${agentInstanceId}`,
        );
        return;
      }
      await diffHistoryService.acceptAndRejectHunks(
        pendingEdits.flatMap((e) =>
          !e.isExternal ? e.hunks.map((h) => h.id) : [e.hunkId],
        ),
        [],
      );
    },
  );

  pagesService.setRejectAllPendingEditsHandler(
    async (agentInstanceId: string) => {
      const pendingEdits =
        uiKarton.state.toolbox[agentInstanceId]?.pendingFileDiffs ?? [];
      if (pendingEdits.length === 0) {
        logger.warn(
          `[Main] rejectAllPendingEdits: no pending edits for agent instance ${agentInstanceId}`,
        );
        return;
      }
      await diffHistoryService.acceptAndRejectHunks(
        [],
        pendingEdits.flatMap((e) =>
          !e.isExternal ? e.hunks.map((h) => h.id) : [e.hunkId],
        ),
      );
    },
  );

  pagesService.setAcceptPendingEditHandler(
    async (agentInstanceId: string, fileId: string) => {
      const proposedEdit = uiKarton.state.toolbox[
        agentInstanceId
      ]?.pendingProposedEdits.find((edit) => edit.fileDiff.fileId === fileId);
      if (proposedEdit) {
        await pendingEditService.acceptEdit(proposedEdit.id);
        return;
      }
      const pendingEdits =
        uiKarton.state.toolbox[agentInstanceId]?.pendingFileDiffs ?? [];
      if (pendingEdits.length === 0) {
        logger.warn(
          `[Main] acceptPendingEdit: no pending edits for agent instance ${agentInstanceId}`,
        );
        return;
      }
      const hunkIds = pendingEdits
        .filter((e) => e.fileId === fileId)
        .flatMap((e) =>
          !e.isExternal ? e.hunks.map((h) => h.id) : [e.hunkId],
        );
      await diffHistoryService.acceptAndRejectHunks(hunkIds, []);
    },
  );

  pagesService.setRejectPendingEditHandler(
    async (agentInstanceId: string, fileId: string) => {
      const proposedEdit = uiKarton.state.toolbox[
        agentInstanceId
      ]?.pendingProposedEdits.find((edit) => edit.fileDiff.fileId === fileId);
      if (proposedEdit) {
        pendingEditService.rejectEdit(proposedEdit.id);
        return;
      }
      const pendingEdits =
        uiKarton.state.toolbox[agentInstanceId]?.pendingFileDiffs ?? [];
      if (pendingEdits.length === 0) {
        logger.warn(
          `[Main] rejectPendingEdit: no pending edits for agent instance ${agentInstanceId}`,
        );
        return;
      }
      const hunkIds = pendingEdits
        .filter((e) => e.fileId === fileId)
        .flatMap((e) =>
          !e.isExternal ? e.hunks.map((h) => h.id) : [e.hunkId],
        );
      await diffHistoryService.acceptAndRejectHunks([], hunkIds);
    },
  );
}
