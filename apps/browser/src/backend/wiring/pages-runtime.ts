import { wirePagesHandlers } from './pages-handler-wiring';
import { wirePagesStateSync } from './pages-state-sync';

type PagesStateSyncDependencies = Parameters<typeof wirePagesStateSync>[0];
type PagesHandlerDependencies = Parameters<typeof wirePagesHandlers>[0];

type PagesRuntimeDependencies = PagesStateSyncDependencies &
  PagesHandlerDependencies;

export async function wirePagesRuntime(
  deps: PagesRuntimeDependencies,
): Promise<void> {
  const {
    uiKarton,
    pagesService,
    globalConfigService,
    diffHistoryService,
    pendingEditService,
    windowLayoutService,
    getSandboxService,
    activeAppController,
    hostedPullRequestService,
    generatedAppLibraryService,
    pluginMarketplaceService,
    preferencesService,
    credentialsService,
    logger,
  } = deps;

  await wirePagesStateSync({
    uiKarton,
    pagesService,
    globalConfigService,
    logger,
  });

  wirePagesHandlers({
    uiKarton,
    pagesService,
    diffHistoryService,
    pendingEditService,
    windowLayoutService,
    getSandboxService,
    activeAppController,
    hostedPullRequestService,
    generatedAppLibraryService,
    pluginMarketplaceService,
    preferencesService,
    credentialsService,
    logger,
  });

  pagesService.setClearPermissionExceptionsHandler(() =>
    preferencesService.clearAllPermissionExceptionsForAllTypes(),
  );
}
