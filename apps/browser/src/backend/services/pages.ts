import { net, session, shell } from 'electron';
import type { Logger } from './logger';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { inferMimeType } from '@shared/mime-utils';
import {
  createKartonServer,
  type KartonServer,
  ElectronServerTransport,
  type MessagePortMain,
} from '@clodex/karton/server';
import {
  type PagesApiContract,
  defaultState,
  type WorkspaceMountInfo,
} from '@shared/karton-contracts/pages-api';
import type { PlanEntry } from '@shared/karton-contracts/ui';
import type { FileDiff } from '@shared/karton-contracts/ui/shared-types';
import type { GlobalConfig } from '@shared/karton-contracts/ui/shared-types';
import type { HistoryService } from './history';
import type { FaviconService } from './favicon';
import type {
  ClearBrowsingDataOptions,
  ClearBrowsingDataResult,
  PendingEditsResult,
  ExternalFileContentResult,
  HistoryFilter,
  HistoryResult,
  FaviconBitmapResult,
} from '@shared/karton-contracts/pages-api/types';
import { DisposableService } from './disposable';
import type { TelemetryService } from './telemetry';
import { isUIEventName, parseUIEventProperties } from './telemetry';
import { getPlansDir } from '@/utils/paths';
import { registerAppProtocol } from './app-protocol';
import type {
  HostedPullRequestMergeInput,
  HostedPullRequestMergeResult,
  HostedPullRequestQuery,
  HostedPullRequestResult,
  HostedPullRequestSubmitReviewInput,
  HostedPullRequestSubmitReviewResult,
} from '@shared/hosted-pull-request';
import type {
  GeneratedApp,
  GeneratedAppActionResult,
  GeneratedAppIdentityInput,
  GeneratedAppsListResult,
  GeneratedAppsQuery,
  LaunchGeneratedAppResult,
} from '@shared/generated-apps';
import type {
  PluginLibraryCredentialInput,
  PluginLibraryOperationResult,
  PluginLibrarySnapshot,
} from '@shared/plugin-library';

declare const PAGES_VITE_DEV_SERVER_URL: string;
declare const PAGES_VITE_NAME: string;

function emptyPluginLibrarySnapshot(): PluginLibrarySnapshot {
  return {
    plugins: [],
    disabledPluginIds: [],
    configuredCredentialIds: [],
    marketplace: {
      enabled: false,
      status: 'unavailable',
      keyId: null,
      generatedAt: null,
      expiresAt: null,
      refreshedAt: null,
      error: null,
      warnings: [],
      catalog: [],
      installed: [],
    },
  };
}

/**
 * Service responsible for the clodex:// protocol handler for the pages
 * renderer (internal pages: history, downloads, diff-review, plans) and the
 * PagesApi Karton contract for communication with those pages.
 */
export class PagesService extends DisposableService {
  private readonly logger: Logger;
  private readonly historyService: HistoryService;
  private readonly faviconService: FaviconService;
  private kartonServer: KartonServer<PagesApiContract>;
  private transport: ElectronServerTransport;
  private portCloseListeners = new Map<MessagePortMain, () => void>();
  private openTabHandler?: (url: string, setActive?: boolean) => Promise<void>;
  private getPendingEditsHandler?: (
    agentInstanceId: string,
  ) => Promise<PendingEditsResult>;
  private getHostedPullRequestHandler?: (
    query: HostedPullRequestQuery,
  ) => Promise<HostedPullRequestResult>;
  private submitHostedPullRequestReviewHandler?: (
    input: HostedPullRequestSubmitReviewInput,
  ) => Promise<HostedPullRequestSubmitReviewResult>;
  private mergeHostedPullRequestHandler?: (
    input: HostedPullRequestMergeInput,
  ) => Promise<HostedPullRequestMergeResult>;
  private listGeneratedAppsHandler?: (
    query?: GeneratedAppsQuery,
  ) => Promise<GeneratedAppsListResult>;
  private getGeneratedAppHandler?: (
    input: GeneratedAppIdentityInput,
  ) => Promise<GeneratedApp | null>;
  private launchGeneratedAppHandler?: (
    input: GeneratedAppIdentityInput,
  ) => Promise<LaunchGeneratedAppResult>;
  private deleteGeneratedAppHandler?: (
    input: GeneratedAppIdentityInput,
  ) => Promise<GeneratedAppActionResult>;
  private regenerateGeneratedAppHandler?: (
    input: GeneratedAppIdentityInput,
  ) => Promise<GeneratedAppActionResult>;
  private getPluginLibraryHandler?: () => Promise<PluginLibrarySnapshot>;
  private refreshPluginLibraryHandler?: () => Promise<PluginLibrarySnapshot>;
  private pluginLibraryOperationHandler?: (
    operation: 'install' | 'update' | 'uninstall',
    pluginId: string,
  ) => Promise<PluginLibraryOperationResult>;
  private pluginLibraryItemEnabledHandler?: (
    pluginId: string,
    enabled: boolean,
  ) => Promise<PluginLibrarySnapshot>;
  private pluginLibraryCredentialHandler?: (
    input: PluginLibraryCredentialInput,
  ) => Promise<PluginLibrarySnapshot>;
  private pluginLibraryCredentialDeleteHandler?: (
    typeId: string,
  ) => Promise<PluginLibrarySnapshot>;
  private forwardAppMessageHandler?: (
    agentInstanceId: string,
    appId: string,
    pluginId: string | undefined,
    data: unknown,
  ) => Promise<void>;
  private clearPendingAppMessageHandler?: (
    agentInstanceId: string,
  ) => Promise<void>;
  private acceptAllPendingEditsHandler?: (
    agentInstanceId: string,
  ) => Promise<void>;
  private rejectAllPendingEditsHandler?: (
    agentInstanceId: string,
  ) => Promise<void>;
  private acceptPendingEditHandler?: (
    agentInstanceId: string,
    path: string,
  ) => Promise<void>;
  private rejectPendingEditHandler?: (
    agentInstanceId: string,
    fileId: string,
  ) => Promise<void>;
  private clearPermissionExceptionsHandler?: () => Promise<void>;
  private trustCertificateAndReloadHandler?: (
    tabId: string,
    origin: string,
  ) => Promise<void>;
  private getExternalFileContentHandler?: (
    oid: string,
  ) => Promise<ExternalFileContentResult | null>;

  private readonly telemetryService: TelemetryService;

  private constructor(
    logger: Logger,
    historyService: HistoryService,
    faviconService: FaviconService,
    telemetryService: TelemetryService,
  ) {
    super();
    this.logger = logger;
    this.historyService = historyService;
    this.faviconService = faviconService;
    this.telemetryService = telemetryService;

    this.transport = new ElectronServerTransport();

    this.kartonServer = createKartonServer<PagesApiContract>({
      initialState: defaultState,
      transport: this.transport,
    });

    this.logger.debug(
      '[PagesService] Karton server initialized with MessagePort transport',
    );
  }

  private report(
    error: Error,
    operation: string,
    extra?: Record<string, unknown>,
  ) {
    this.telemetryService.captureException(error, {
      service: 'pages',
      operation,
      ...extra,
    });
  }

  public static async create(
    logger: Logger,
    historyService: HistoryService,
    faviconService: FaviconService,
    telemetryService: TelemetryService,
  ): Promise<PagesService> {
    const instance = new PagesService(
      logger,
      historyService,
      faviconService,
      telemetryService,
    );
    await instance.initialize();
    logger.debug('[PagesService] Created service');
    return instance;
  }

  private async initialize(): Promise<void> {
    // Register procedure handlers
    this.registerProcedureHandlers();

    // Get the default browsing session used by tabs (same partition as tab-controller)
    const ses = session.fromPartition('persist:browser-content');

    ses.protocol.handle('clodex', (request) => {
      let normalizedRequestUrl = request.url;
      if (
        normalizedRequestUrl === 'clodex://' ||
        normalizedRequestUrl.endsWith('://')
      )
        normalizedRequestUrl = 'clodex://internal/';

      let url: URL;
      try {
        url = new URL(normalizedRequestUrl);
      } catch (err) {
        this.logger.error(
          `[PagesService] Failed to parse URL: ${err}. Redirecting to not-found page.`,
        );
        return Response.redirect('clodex://internal/not-found', 302);
      }

      if (url.hostname !== 'internal') {
        this.logger.debug(
          `[PagesService] Redirecting request with origin: ${url.hostname} to not-found page. Only "internal" origin is allowed.`,
        );
        return Response.redirect('clodex://internal/not-found', 302);
      }

      if (PAGES_VITE_DEV_SERVER_URL) {
        const pathname = url.pathname || '/';
        const search = url.search || '';
        const devServerUrl = `${PAGES_VITE_DEV_SERVER_URL}${pathname}${search}`;
        return net.fetch(devServerUrl);
      }

      const requestPath = url.pathname || '/';

      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const pagesBaseDir = path.resolve(
        __dirname,
        `../renderer/${PAGES_VITE_NAME}`,
      );

      if (!requestPath || requestPath === '/') {
        const indexPath = path.resolve(pagesBaseDir, 'index.html');
        const normalizedIndexPath = indexPath.replace(/\\/g, '/');
        const fileUrl = `file:///${normalizedIndexPath}`;
        return net.fetch(fileUrl);
      }

      const normalizedPath = requestPath.startsWith('/')
        ? requestPath.slice(1)
        : requestPath;
      const filePath = path.resolve(pagesBaseDir, normalizedPath);

      const targetPath = existsSync(filePath)
        ? filePath
        : path.resolve(pagesBaseDir, 'index.html');
      const normalizedTargetPath = targetPath.replace(/\\/g, '/');
      const fileUrl = `file:///${normalizedTargetPath}`;
      return net.fetch(fileUrl);
    });

    this.logger.debug(
      '[PagesService] Registered clodex protocol handler for browsing session',
    );

    // workspace:// protocol
    ses.protocol.handle('workspace', async (request) => {
      try {
        const secFetchSite = request.headers.get('Sec-Fetch-Site');
        if (secFetchSite === 'cross-site')
          return new Response('Forbidden', { status: 403 });

        const url = new URL(request.url);
        const mountPrefix = url.hostname;
        const relativePath = decodeURIComponent(
          url.pathname.replace(/^\//, ''),
        );
        const requestedRoot = url.searchParams.get('root');

        if (!mountPrefix || !relativePath)
          return new Response('Invalid workspace URL', { status: 400 });

        const workspaceRoot = this.findMountPath(mountPrefix, requestedRoot);
        if (!workspaceRoot)
          return new Response('Mount not found', { status: 404 });

        const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
        const absolutePath = path.resolve(resolvedWorkspaceRoot, relativePath);
        if (!absolutePath.startsWith(resolvedWorkspaceRoot + path.sep))
          return new Response('Path traversal denied', { status: 400 });

        const realWorkspaceRoot = await fs.realpath(resolvedWorkspaceRoot);
        const realFilePath = await fs.realpath(absolutePath);
        const relativeFromRoot = path.relative(realWorkspaceRoot, realFilePath);
        if (
          relativeFromRoot === '..' ||
          relativeFromRoot.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativeFromRoot)
        ) {
          return new Response('Path traversal denied', { status: 400 });
        }

        const mime = inferMimeType(relativePath);
        const fileUrl = pathToFileURL(realFilePath).href;
        const fileResponse = await net.fetch(fileUrl);

        return new Response(fileResponse.body, {
          status: 200,
          headers: { 'Content-Type': mime },
        });
      } catch (err) {
        this.logger.error(
          '[PagesService] workspace protocol error (browsing session)',
          { error: err, url: request.url },
        );
        return new Response('Internal error', { status: 500 });
      }
    });

    this.logger.debug(
      '[PagesService] Registered workspace protocol handler for browsing session',
    );

    // plans:// protocol
    ses.protocol.handle('plans', async (request) => {
      try {
        const secFetchSite = request.headers.get('Sec-Fetch-Site');
        if (secFetchSite === 'cross-site')
          return new Response('Forbidden', { status: 403 });

        const url = new URL(request.url);
        const filename = decodeURIComponent(url.pathname.replace(/^\//, ''));

        if (!filename)
          return new Response('Invalid plans URL', { status: 400 });

        const plansDir = getPlansDir();
        const absolutePath = path.resolve(plansDir, filename);
        if (!absolutePath.startsWith(plansDir + path.sep))
          return new Response('Path traversal denied', { status: 400 });

        const mime = inferMimeType(filename);
        const fileUrl = pathToFileURL(absolutePath).href;
        const fileResponse = await net.fetch(fileUrl);

        return new Response(fileResponse.body, {
          status: 200,
          headers: { 'Content-Type': mime },
        });
      } catch (err) {
        this.logger.error(
          '[PagesService] plans protocol error (browsing session)',
          { error: err, url: request.url },
        );
        return new Response('Internal error', { status: 500 });
      }
    });

    this.logger.debug(
      '[PagesService] Registered plans protocol handler for browsing session',
    );

    registerAppProtocol(ses, this.logger);
    this.logger.debug(
      '[PagesService] Registered app protocol handler for browsing session',
    );
  }

  private registerProcedureHandlers(): void {
    this.kartonServer.registerServerProcedureHandler(
      'openTab',
      async (
        _callingClientId: string,
        url: string,
        setActive?: boolean,
      ): Promise<void> => {
        if (!this.openTabHandler) {
          this.logger.warn(
            '[PagesService] openTab called but no handler is set',
          );
          return;
        }
        await this.openTabHandler(url, setActive);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'getHistory',
      async (
        _callingClientId: string,
        filter: HistoryFilter,
      ): Promise<HistoryResult[]> => {
        const results = await this.historyService.queryHistory(filter);
        const pageUrls = results.map((result) => result.url);
        const faviconMap =
          await this.faviconService.getFaviconsForUrls(pageUrls);
        return results.map((result) => ({
          ...result,
          faviconUrl: faviconMap.get(result.url) ?? null,
        }));
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'forwardAppMessage',
      async (
        _callingClientId: string,
        agentInstanceId: string,
        appId: string,
        pluginId: string | undefined,
        data: unknown,
      ): Promise<void> => {
        if (!this.forwardAppMessageHandler) {
          this.logger.warn(
            '[PagesService] forwardAppMessage called but no handler is set',
          );
          return;
        }
        await this.forwardAppMessageHandler(
          agentInstanceId,
          appId,
          pluginId,
          data,
        );
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'clearPendingAppMessage',
      async (
        _callingClientId: string,
        agentInstanceId: string,
      ): Promise<void> => {
        if (!this.clearPendingAppMessageHandler) {
          this.logger.warn(
            '[PagesService] clearPendingAppMessage called but no handler is set',
          );
          return;
        }
        await this.clearPendingAppMessageHandler(agentInstanceId);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'getFaviconBitmaps',
      async (
        _callingClientId: string,
        faviconUrls: string[],
      ): Promise<Record<string, FaviconBitmapResult>> => {
        const bitmapMap =
          await this.faviconService.getFaviconBitmaps(faviconUrls);
        const result: Record<string, FaviconBitmapResult> = {};
        for (const [url, bitmap] of bitmapMap) {
          result[url] = bitmap;
        }
        return result;
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'openExternalUrl',
      async (_callingClientId: string, url: string): Promise<void> => {
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          this.logger.warn(
            `[PagesService] Rejected openExternalUrl (unparseable, length=${url.length})`,
          );
          return;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          this.logger.warn(
            `[PagesService] Rejected openExternalUrl (bad scheme ${parsed.protocol}): ${parsed.protocol}//${parsed.host}`,
          );
          return;
        }
        await shell.openExternal(parsed.toString());
      },
    );

    // Bridge pages-renderer telemetry into the backend TelemetryService.
    this.kartonServer.registerServerProcedureHandler(
      'captureTelemetry',
      async (
        _callingClientId: string,
        eventName: string,
        properties?: Record<string, unknown>,
      ): Promise<void> => {
        if (!isUIEventName(eventName)) {
          this.logger.warn(
            `[PagesService] Ignoring unknown UI telemetry event: ${eventName}`,
          );
          return;
        }
        const parsedProperties = parseUIEventProperties(eventName, properties);
        if (parsedProperties === null) {
          this.logger.warn(
            `[PagesService] Ignoring invalid UI telemetry payload for event: ${eventName}`,
          );
          return;
        }
        this.telemetryService.capture(eventName, parsedProperties);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'getPendingEdits',
      async (
        _callingClientId: string,
        agentInstanceId: string,
      ): Promise<PendingEditsResult> => {
        if (!this.getPendingEditsHandler) {
          this.logger.warn(
            '[PagesService] getPendingEdits called but no handler is set',
          );
          return { found: false, edits: [] };
        }
        return this.getPendingEditsHandler(agentInstanceId);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'getHostedPullRequest',
      async (
        _callingClientId: string,
        query: HostedPullRequestQuery,
      ): Promise<HostedPullRequestResult> => {
        if (!this.getHostedPullRequestHandler) {
          this.logger.warn(
            '[PagesService] getHostedPullRequest called but no handler is set',
          );
          return {
            status: 'unavailable',
            reason: 'provider-error',
            message: 'Hosted pull request review is not ready yet.',
            authenticated: false,
            retryable: true,
          };
        }
        return this.getHostedPullRequestHandler(query);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'submitHostedPullRequestReview',
      async (
        _callingClientId: string,
        input: HostedPullRequestSubmitReviewInput,
      ): Promise<HostedPullRequestSubmitReviewResult> => {
        if (!this.submitHostedPullRequestReviewHandler) {
          this.logger.warn(
            '[PagesService] submitHostedPullRequestReview called but no handler is set',
          );
          return {
            ok: false,
            reason: 'provider-error',
            message: 'Hosted pull request review submission is not ready yet.',
            retryable: true,
          };
        }
        return this.submitHostedPullRequestReviewHandler(input);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'mergeHostedPullRequest',
      async (
        _callingClientId: string,
        input: HostedPullRequestMergeInput,
      ): Promise<HostedPullRequestMergeResult> => {
        if (!this.mergeHostedPullRequestHandler) {
          this.logger.warn(
            '[PagesService] mergeHostedPullRequest called but no handler is set',
          );
          return {
            ok: false,
            reason: 'provider-error',
            message: 'Protected pull request merge is not ready yet.',
            retryable: true,
          };
        }
        return this.mergeHostedPullRequestHandler(input);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'listGeneratedApps',
      async (
        _callingClientId: string,
        query?: GeneratedAppsQuery,
      ): Promise<GeneratedAppsListResult> => {
        if (!this.listGeneratedAppsHandler) {
          this.logger.warn(
            '[PagesService] listGeneratedApps called but no handler is set',
          );
          return {
            apps: [],
            summary: {
              total: 0,
              ready: 0,
              needsAttention: 0,
              regenerating: 0,
            },
          };
        }
        return this.listGeneratedAppsHandler(query);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'getGeneratedApp',
      async (
        _callingClientId: string,
        input: GeneratedAppIdentityInput,
      ): Promise<GeneratedApp | null> => {
        if (!this.getGeneratedAppHandler) {
          this.logger.warn(
            '[PagesService] getGeneratedApp called but no handler is set',
          );
          return null;
        }
        return this.getGeneratedAppHandler(input);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'launchGeneratedApp',
      async (
        _callingClientId: string,
        input: GeneratedAppIdentityInput,
      ): Promise<LaunchGeneratedAppResult> => {
        if (!this.launchGeneratedAppHandler) {
          this.logger.warn(
            '[PagesService] launchGeneratedApp called but no handler is set',
          );
          return {
            ok: false,
            code: 'operation-failed',
            message: 'Generated app launching is not ready yet.',
            retryable: true,
          };
        }
        return this.launchGeneratedAppHandler(input);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'deleteGeneratedApp',
      async (
        _callingClientId: string,
        input: GeneratedAppIdentityInput,
      ): Promise<GeneratedAppActionResult> => {
        if (!this.deleteGeneratedAppHandler) {
          this.logger.warn(
            '[PagesService] deleteGeneratedApp called but no handler is set',
          );
          return {
            ok: false,
            code: 'operation-failed',
            message: 'Generated app deletion is not ready yet.',
            retryable: true,
          };
        }
        return this.deleteGeneratedAppHandler(input);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'regenerateGeneratedApp',
      async (
        _callingClientId: string,
        input: GeneratedAppIdentityInput,
      ): Promise<GeneratedAppActionResult> => {
        if (!this.regenerateGeneratedAppHandler) {
          this.logger.warn(
            '[PagesService] regenerateGeneratedApp called but no handler is set',
          );
          return {
            ok: false,
            code: 'owner-unavailable',
            message: 'Generated app regeneration is not ready yet.',
            retryable: true,
          };
        }
        return this.regenerateGeneratedAppHandler(input);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'getPluginLibrary',
      async (): Promise<PluginLibrarySnapshot> => {
        if (!this.getPluginLibraryHandler) {
          this.logger.warn(
            '[PagesService] getPluginLibrary called but no handler is set',
          );
          return emptyPluginLibrarySnapshot();
        }
        return this.getPluginLibraryHandler();
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'refreshPluginLibrary',
      async (): Promise<PluginLibrarySnapshot> => {
        if (!this.refreshPluginLibraryHandler) {
          this.logger.warn(
            '[PagesService] refreshPluginLibrary called but no handler is set',
          );
          return emptyPluginLibrarySnapshot();
        }
        return this.refreshPluginLibraryHandler();
      },
    );

    const registerPluginLibraryOperation = (
      procedure:
        | 'installPluginLibraryItem'
        | 'updatePluginLibraryItem'
        | 'uninstallPluginLibraryItem',
      operation: 'install' | 'update' | 'uninstall',
    ) => {
      this.kartonServer.registerServerProcedureHandler(
        procedure,
        async (
          _callingClientId: string,
          pluginId: string,
        ): Promise<PluginLibraryOperationResult> => {
          if (!this.pluginLibraryOperationHandler) {
            this.logger.warn(
              `[PagesService] ${procedure} called but no handler is set`,
            );
            const snapshot = emptyPluginLibrarySnapshot();
            return {
              result: {
                ok: false,
                operation,
                pluginId,
                error: 'Plugin marketplace operations are not ready yet.',
                rolledBack: false,
                state: snapshot.marketplace,
              },
              snapshot,
            };
          }
          return this.pluginLibraryOperationHandler(operation, pluginId);
        },
      );
    };
    registerPluginLibraryOperation('installPluginLibraryItem', 'install');
    registerPluginLibraryOperation('updatePluginLibraryItem', 'update');
    registerPluginLibraryOperation('uninstallPluginLibraryItem', 'uninstall');

    this.kartonServer.registerServerProcedureHandler(
      'setPluginLibraryItemEnabled',
      async (
        _callingClientId: string,
        pluginId: string,
        enabled: boolean,
      ): Promise<PluginLibrarySnapshot> => {
        if (!this.pluginLibraryItemEnabledHandler) {
          this.logger.warn(
            '[PagesService] setPluginLibraryItemEnabled called but no handler is set',
          );
          return emptyPluginLibrarySnapshot();
        }
        return this.pluginLibraryItemEnabledHandler(pluginId, enabled);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'setPluginLibraryCredential',
      async (
        _callingClientId: string,
        input: PluginLibraryCredentialInput,
      ): Promise<PluginLibrarySnapshot> => {
        if (!this.pluginLibraryCredentialHandler) {
          this.logger.warn(
            '[PagesService] setPluginLibraryCredential called but no handler is set',
          );
          return emptyPluginLibrarySnapshot();
        }
        return this.pluginLibraryCredentialHandler(input);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'deletePluginLibraryCredential',
      async (
        _callingClientId: string,
        typeId: string,
      ): Promise<PluginLibrarySnapshot> => {
        if (!this.pluginLibraryCredentialDeleteHandler) {
          this.logger.warn(
            '[PagesService] deletePluginLibraryCredential called but no handler is set',
          );
          return emptyPluginLibrarySnapshot();
        }
        return this.pluginLibraryCredentialDeleteHandler(typeId);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'acceptAllPendingEdits',
      async (
        _callingClientId: string,
        agentInstanceId: string,
      ): Promise<void> => {
        if (!this.acceptAllPendingEditsHandler) {
          this.logger.warn(
            '[PagesService] acceptAllPendingEdits called but no handler is set',
          );
          return;
        }
        await this.acceptAllPendingEditsHandler(agentInstanceId);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'rejectAllPendingEdits',
      async (
        _callingClientId: string,
        agentInstanceId: string,
      ): Promise<void> => {
        if (!this.rejectAllPendingEditsHandler) {
          this.logger.warn(
            '[PagesService] rejectAllPendingEdits called but no handler is set',
          );
          return;
        }
        await this.rejectAllPendingEditsHandler(agentInstanceId);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'acceptPendingEdit',
      async (
        _callingClientId: string,
        agentInstanceId: string,
        fileId: string,
      ): Promise<void> => {
        if (!this.acceptPendingEditHandler) {
          this.logger.warn(
            '[PagesService] acceptPendingEdit called but no handler is set',
          );
          return;
        }
        await this.acceptPendingEditHandler(agentInstanceId, fileId);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'rejectPendingEdit',
      async (
        _callingClientId: string,
        agentInstanceId: string,
        fileId: string,
      ): Promise<void> => {
        if (!this.rejectPendingEditHandler) {
          this.logger.warn(
            '[PagesService] rejectPendingEdit called but no handler is set',
          );
          return;
        }
        await this.rejectPendingEditHandler(agentInstanceId, fileId);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'getExternalFileContent',
      async (
        _callingClientId: string,
        oid: string,
      ): Promise<ExternalFileContentResult | null> => {
        if (!this.getExternalFileContentHandler) {
          this.logger.warn(
            '[PagesService] getExternalFileContent called but no handler is set',
          );
          return null;
        }
        return this.getExternalFileContentHandler(oid);
      },
    );

    this.kartonServer.registerServerProcedureHandler(
      'trustCertificateAndReload',
      async (
        _callingClientId: string,
        tabId: string,
        origin: string,
      ): Promise<void> => {
        if (!this.trustCertificateAndReloadHandler) {
          this.logger.warn(
            '[PagesService] trustCertificateAndReload called but no handler is set',
          );
          return;
        }
        await this.trustCertificateAndReloadHandler(tabId, origin);
      },
    );
  }

  // ── Public setter methods (called by wiring) ──

  public setOpenTabHandler(
    handler: (url: string, setActive?: boolean) => Promise<void>,
  ): void {
    this.openTabHandler = handler;
  }

  public setGetPendingEditsHandler(
    handler: (agentInstanceId: string) => Promise<PendingEditsResult>,
  ): void {
    this.getPendingEditsHandler = handler;
  }

  public setGetHostedPullRequestHandler(
    handler: (
      query: HostedPullRequestQuery,
    ) => Promise<HostedPullRequestResult>,
  ): void {
    this.getHostedPullRequestHandler = handler;
  }

  public setSubmitHostedPullRequestReviewHandler(
    handler: (
      input: HostedPullRequestSubmitReviewInput,
    ) => Promise<HostedPullRequestSubmitReviewResult>,
  ): void {
    this.submitHostedPullRequestReviewHandler = handler;
  }

  public setMergeHostedPullRequestHandler(
    handler: (
      input: HostedPullRequestMergeInput,
    ) => Promise<HostedPullRequestMergeResult>,
  ): void {
    this.mergeHostedPullRequestHandler = handler;
  }

  public setListGeneratedAppsHandler(
    handler: (query?: GeneratedAppsQuery) => Promise<GeneratedAppsListResult>,
  ): void {
    this.listGeneratedAppsHandler = handler;
  }

  public setGetGeneratedAppHandler(
    handler: (input: GeneratedAppIdentityInput) => Promise<GeneratedApp | null>,
  ): void {
    this.getGeneratedAppHandler = handler;
  }

  public setLaunchGeneratedAppHandler(
    handler: (
      input: GeneratedAppIdentityInput,
    ) => Promise<LaunchGeneratedAppResult>,
  ): void {
    this.launchGeneratedAppHandler = handler;
  }

  public setDeleteGeneratedAppHandler(
    handler: (
      input: GeneratedAppIdentityInput,
    ) => Promise<GeneratedAppActionResult>,
  ): void {
    this.deleteGeneratedAppHandler = handler;
  }

  public setRegenerateGeneratedAppHandler(
    handler: (
      input: GeneratedAppIdentityInput,
    ) => Promise<GeneratedAppActionResult>,
  ): void {
    this.regenerateGeneratedAppHandler = handler;
  }

  public setGetPluginLibraryHandler(
    handler: () => Promise<PluginLibrarySnapshot>,
  ): void {
    this.getPluginLibraryHandler = handler;
  }

  public setRefreshPluginLibraryHandler(
    handler: () => Promise<PluginLibrarySnapshot>,
  ): void {
    this.refreshPluginLibraryHandler = handler;
  }

  public setPluginLibraryOperationHandler(
    handler: (
      operation: 'install' | 'update' | 'uninstall',
      pluginId: string,
    ) => Promise<PluginLibraryOperationResult>,
  ): void {
    this.pluginLibraryOperationHandler = handler;
  }

  public setPluginLibraryItemEnabledHandler(
    handler: (
      pluginId: string,
      enabled: boolean,
    ) => Promise<PluginLibrarySnapshot>,
  ): void {
    this.pluginLibraryItemEnabledHandler = handler;
  }

  public setPluginLibraryCredentialHandler(
    handler: (
      input: PluginLibraryCredentialInput,
    ) => Promise<PluginLibrarySnapshot>,
  ): void {
    this.pluginLibraryCredentialHandler = handler;
  }

  public setDeletePluginLibraryCredentialHandler(
    handler: (typeId: string) => Promise<PluginLibrarySnapshot>,
  ): void {
    this.pluginLibraryCredentialDeleteHandler = handler;
  }

  public setForwardAppMessageHandler(
    handler: (
      agentInstanceId: string,
      appId: string,
      pluginId: string | undefined,
      data: unknown,
    ) => Promise<void>,
  ): void {
    this.forwardAppMessageHandler = handler;
  }

  public setClearPendingAppMessageHandler(
    handler: (agentInstanceId: string) => Promise<void>,
  ): void {
    this.clearPendingAppMessageHandler = handler;
  }

  public setAcceptAllPendingEditsHandler(
    handler: (agentInstanceId: string) => Promise<void>,
  ): void {
    this.acceptAllPendingEditsHandler = handler;
  }

  public setRejectAllPendingEditsHandler(
    handler: (agentInstanceId: string) => Promise<void>,
  ): void {
    this.rejectAllPendingEditsHandler = handler;
  }

  public setAcceptPendingEditHandler(
    handler: (agentInstanceId: string, fileId: string) => Promise<void>,
  ): void {
    this.acceptPendingEditHandler = handler;
  }

  public setRejectPendingEditHandler(
    handler: (agentInstanceId: string, fileId: string) => Promise<void>,
  ): void {
    this.rejectPendingEditHandler = handler;
  }

  public setGetExternalFileContentHandler(
    handler: (oid: string) => Promise<ExternalFileContentResult | null>,
  ): void {
    this.getExternalFileContentHandler = handler;
  }

  public setTrustCertificateAndReloadHandler(
    handler: (tabId: string, origin: string) => Promise<void>,
  ): void {
    this.trustCertificateAndReloadHandler = handler;
  }

  public setClearPermissionExceptionsHandler(
    handler: () => Promise<void>,
  ): void {
    this.clearPermissionExceptionsHandler = handler;
  }

  // ── State sync methods ──

  public syncGlobalConfigState(config: GlobalConfig): void {
    this.kartonServer.setState((draft) => {
      draft.globalConfig = config;
    });
  }

  public syncWorkspaceMountsState(mounts: WorkspaceMountInfo[]): void {
    this.kartonServer.setState((draft) => {
      draft.workspaceMounts = mounts;
    });
  }

  public syncPlansState(plans: PlanEntry[]): void {
    this.kartonServer.setState((draft) => {
      draft.plans = plans;
    });
  }

  public updatePendingEditsState(
    agentInstanceId: string,
    edits: FileDiff[],
  ): void {
    this.kartonServer.setState((draft) => {
      draft.pendingEditsByAgentInstanceId[agentInstanceId] = edits;
    });
  }

  public updatePendingAppMessageState(
    agentInstanceId: string,
    message: { appId: string; pluginId?: string; data: unknown } | null,
  ): void {
    this.kartonServer.setState((draft) => {
      draft.pendingAppMessagesByAgentInstanceId[agentInstanceId] = message;
    });
  }

  // ── Port & lifecycle ──

  private findMountPath(
    prefix: string,
    root: string | null = null,
  ): string | null {
    const resolvedRoot = root ? path.resolve(root) : null;

    for (const mount of this.kartonServer.state.workspaceMounts) {
      if (
        mount.prefix === prefix &&
        (!resolvedRoot || path.resolve(mount.path) === resolvedRoot)
      ) {
        return mount.path;
      }
    }
    return null;
  }

  public acceptPort(port: MessagePortMain): string {
    const closeListener = () => {
      this.logger.warn('[PagesService] MessagePort closed - connection lost');
      this.portCloseListeners.delete(port);
    };
    this.portCloseListeners.set(port, closeListener);
    port.on('close', closeListener);
    const id = this.transport.setPort(port);
    this.logger.debug(`[PagesService] Accepted port connection: ${id}`);
    return id;
  }

  /**
   * Clear browsing data. Public method callable from the main UI Karton
   * handler (preferences.ts) as well.
   */
  async clearBrowsingData(
    options: ClearBrowsingDataOptions,
  ): Promise<ClearBrowsingDataResult> {
    this.logger.info('[PagesService] Clear browsing data requested', {
      history: options.history,
      favicons: options.favicons,
      downloads: options.downloads,
      cookies: options.cookies,
      cache: options.cache,
      storage: options.storage,
      indexedDB: options.indexedDB,
      serviceWorkers: options.serviceWorkers,
      cacheStorage: options.cacheStorage,
      permissionExceptions: options.permissionExceptions,
      timeRange: options.timeRange,
    });

    try {
      const result: ClearBrowsingDataResult = { success: true };

      if (options.history) {
        if (options.timeRange?.start || options.timeRange?.end) {
          const start = options.timeRange.start ?? new Date(0);
          const end = options.timeRange.end ?? new Date();
          result.historyEntriesCleared =
            await this.historyService.clearHistoryRange(start, end);
        } else {
          result.historyEntriesCleared =
            await this.historyService.clearAllData();
        }
      }

      if (options.downloads) {
        // Downloads clearing is not time-range scoped — only clear for
        // "all time" requests to avoid unexpectedly wiping the full
        // download history when the user expects a limited clear.
        if (options.timeRange?.start || options.timeRange?.end) {
          this.logger.debug(
            '[PagesService] Skipping downloads clear — time-range not supported',
          );
        } else {
          result.downloadsCleared =
            (await this.historyService.clearDownloads()) > 0;
        }
      }

      if (options.favicons) {
        result.faviconsCleared = await this.faviconService.clearAllData();
      } else if (options.history) {
        result.faviconsCleared =
          await this.faviconService.cleanupOrphanedFavicons();
      }

      const ses = session.fromPartition('persist:browser-content');

      if (options.cache) {
        await ses.clearCache();
        result.cacheCleared = true;
        this.logger.debug('[PagesService] HTTP cache cleared');
      }

      const storageTypes: string[] = [];
      if (options.cookies) storageTypes.push('cookies');
      if (options.storage) storageTypes.push('localstorage');
      if (options.indexedDB) storageTypes.push('indexdb');
      if (options.serviceWorkers) storageTypes.push('serviceworkers');
      if (options.cacheStorage) storageTypes.push('cachestorage');

      if (storageTypes.length > 0) {
        const clearStorageOptions: Electron.ClearStorageDataOptions = {
          storages:
            storageTypes as Electron.ClearStorageDataOptions['storages'],
        };

        if (
          options.cookies &&
          options.timeRange?.start &&
          storageTypes.length === 1
        ) {
          this.logger.debug(
            '[PagesService] Time range filtering not fully supported for session storage, clearing all',
          );
        }

        await ses.clearStorageData(clearStorageOptions);

        if (options.cookies) result.cookiesCleared = true;
        if (
          options.storage ||
          options.indexedDB ||
          options.serviceWorkers ||
          options.cacheStorage
        ) {
          result.storageCleared = true;
        }

        this.logger.debug('[PagesService] Session storage data cleared', {
          storageTypes,
        });
      }

      if (options.permissionExceptions) {
        if (this.clearPermissionExceptionsHandler) {
          await this.clearPermissionExceptionsHandler();
          result.permissionExceptionsCleared = true;
          this.logger.debug('[PagesService] Permission exceptions cleared');
        } else {
          this.logger.warn(
            '[PagesService] Permission exceptions clear requested but no handler registered',
          );
        }
      }

      if (options.vacuum !== false) {
        const vacuumPromises: Promise<void>[] = [];
        if (options.history || options.downloads) {
          vacuumPromises.push(this.historyService.vacuum());
        }
        if (options.favicons) {
          vacuumPromises.push(this.faviconService.vacuum());
        }
        await Promise.all(vacuumPromises);
      }

      this.logger.info('[PagesService] Clear browsing data completed', result);
      return result;
    } catch (error) {
      this.logger.error('[PagesService] Clear browsing data failed', error);
      this.report(error as Error, 'clearBrowsingData');
      return {
        success: false,
        error:
          error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  protected async onTeardown(): Promise<void> {
    this.logger.debug('[PagesService] Tearing down...');

    this.kartonServer.removeServerProcedureHandler('openTab');
    this.kartonServer.removeServerProcedureHandler('openExternalUrl');
    this.kartonServer.removeServerProcedureHandler('captureTelemetry');
    this.kartonServer.removeServerProcedureHandler('getPendingEdits');
    this.kartonServer.removeServerProcedureHandler('getHostedPullRequest');
    this.kartonServer.removeServerProcedureHandler(
      'submitHostedPullRequestReview',
    );
    this.kartonServer.removeServerProcedureHandler('mergeHostedPullRequest');
    this.kartonServer.removeServerProcedureHandler('listGeneratedApps');
    this.kartonServer.removeServerProcedureHandler('getGeneratedApp');
    this.kartonServer.removeServerProcedureHandler('launchGeneratedApp');
    this.kartonServer.removeServerProcedureHandler('deleteGeneratedApp');
    this.kartonServer.removeServerProcedureHandler('regenerateGeneratedApp');
    this.kartonServer.removeServerProcedureHandler('getPluginLibrary');
    this.kartonServer.removeServerProcedureHandler('refreshPluginLibrary');
    this.kartonServer.removeServerProcedureHandler('installPluginLibraryItem');
    this.kartonServer.removeServerProcedureHandler('updatePluginLibraryItem');
    this.kartonServer.removeServerProcedureHandler(
      'uninstallPluginLibraryItem',
    );
    this.kartonServer.removeServerProcedureHandler(
      'setPluginLibraryItemEnabled',
    );
    this.kartonServer.removeServerProcedureHandler(
      'setPluginLibraryCredential',
    );
    this.kartonServer.removeServerProcedureHandler(
      'deletePluginLibraryCredential',
    );
    this.kartonServer.removeServerProcedureHandler('forwardAppMessage');
    this.kartonServer.removeServerProcedureHandler('clearPendingAppMessage');
    this.kartonServer.removeServerProcedureHandler('acceptAllPendingEdits');
    this.kartonServer.removeServerProcedureHandler('rejectAllPendingEdits');
    this.kartonServer.removeServerProcedureHandler('acceptPendingEdit');
    this.kartonServer.removeServerProcedureHandler('rejectPendingEdit');
    this.kartonServer.removeServerProcedureHandler('getExternalFileContent');
    this.kartonServer.removeServerProcedureHandler('trustCertificateAndReload');

    const ses = session.fromPartition('persist:browser-content');
    ses.protocol.unhandle('clodex');
    ses.protocol.unhandle('workspace');
    ses.protocol.unhandle('plans');
    ses.protocol.unhandle('app');

    for (const [port, listener] of this.portCloseListeners.entries()) {
      port.off('close', listener);
    }
    this.portCloseListeners.clear();
    this.openTabHandler = undefined;
    this.trustCertificateAndReloadHandler = undefined;
    this.getExternalFileContentHandler = undefined;
    this.forwardAppMessageHandler = undefined;
    this.clearPendingAppMessageHandler = undefined;
    this.getHostedPullRequestHandler = undefined;
    this.submitHostedPullRequestReviewHandler = undefined;
    this.mergeHostedPullRequestHandler = undefined;
    this.listGeneratedAppsHandler = undefined;
    this.getGeneratedAppHandler = undefined;
    this.launchGeneratedAppHandler = undefined;
    this.deleteGeneratedAppHandler = undefined;
    this.regenerateGeneratedAppHandler = undefined;
    this.getPluginLibraryHandler = undefined;
    this.refreshPluginLibraryHandler = undefined;
    this.pluginLibraryOperationHandler = undefined;
    this.pluginLibraryItemEnabledHandler = undefined;
    this.pluginLibraryCredentialHandler = undefined;
    this.pluginLibraryCredentialDeleteHandler = undefined;

    await this.transport.close();
    this.logger.debug('[PagesService] Teardown complete');
  }
}
