import { app } from 'electron';
import type { Logger } from '../services/logger';
import type { WindowLayoutService } from '../services/window-layout';
import { AUTH_CALLBACK_PROTOCOL } from '../services/auth/callback-scheme';
import {
  registerStartupFileHandler,
  registerStartupUrlHandler,
} from '../startup-url-events';
import {
  createSkillInstallUrl,
  extractSkillPackagePaths,
  extractUrlsFromArgs,
  isOpenableUrl,
  isSkillPackagePath,
} from '../skill-package-routing';

/**
 * Checks if a string is a valid URL that the browser can open
 */
type AuthCallbackHandler = (url: string) => boolean | Promise<boolean>;
type McpOAuthCallbackHandler = (url: string) => boolean | Promise<boolean>;
type SkillInstallHandler = (url: string) => boolean | Promise<boolean>;
const MAX_QUEUED_AUTH_CALLBACK_URLS = 5;
const MAX_QUEUED_MCP_OAUTH_CALLBACK_URLS = 5;
const MAX_QUEUED_SKILL_INSTALL_URLS = 5;

function isAuthCallbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== AUTH_CALLBACK_PROTOCOL) {
      return false;
    }
    // Only the canonical callback endpoint is reserved for account auth.
    // Normalize: clodex://auth/callback → hostname='auth', pathname='/callback',
    // so reconstruct the full path the same way auth/index.ts does.
    const callbackPath = parsed.hostname
      ? `/${parsed.hostname}${parsed.pathname}`
      : parsed.pathname;
    return callbackPath === '/auth/callback';
  } catch {
    return false;
  }
}

function isMcpOAuthCallbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'clodex:' &&
      parsed.protocol !== 'clodex-ide:' &&
      parsed.protocol !== 'clodex-prerelease:' &&
      parsed.protocol !== 'clodex-nightly:' &&
      parsed.protocol !== 'clodex-dev:'
    ) {
      return false;
    }
    const callbackPath = parsed.hostname
      ? `/${parsed.hostname}${parsed.pathname}`
      : parsed.pathname;
    return callbackPath === '/mcp/oauth/callback';
  } catch {
    return false;
  }
}

function isSkillInstallUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const routePath = parsed.hostname
      ? `/${parsed.hostname}${parsed.pathname}`
      : parsed.pathname;
    return routePath === '/skill/install';
  } catch {
    return false;
  }
}

function describeIncomingUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (isMcpOAuthCallbackUrl(url)) return 'MCP OAuth callback';
    if (isAuthCallbackUrl(url)) return 'auth callback';
    if (isSkillInstallUrl(url)) return 'skill install';
    return `${parsed.protocol}//${parsed.host || '(no-host)'}`;
  } catch {
    return 'unparseable URL';
  }
}

function handleMcpOAuthCallbackUrl(
  url: string,
  logger: Logger,
  handler: McpOAuthCallbackHandler,
): void {
  void Promise.resolve(handler(url)).catch((error) => {
    logger.error(
      `[Main] MCP OAuth callback handling failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

function handleAuthCallbackUrl(
  url: string,
  logger: Logger,
  authCallbackHandler: AuthCallbackHandler,
): void {
  void Promise.resolve(authCallbackHandler(url)).catch((error) => {
    logger.error(`[Main] Auth callback handling failed: ${String(error)}`);
  });
}

function handleSkillInstallUrl(
  url: string,
  logger: Logger,
  skillInstallHandler: SkillInstallHandler,
): void {
  void Promise.resolve(skillInstallHandler(url)).catch((error) => {
    logger.error(`[Main] Skill install handling failed: ${String(error)}`);
  });
}

/**
 * Opens a URL in a new browser tab, routing auth callbacks to the handler.
 */
function openIncomingUrl(
  url: string,
  windowLayoutService: WindowLayoutService,
  logger: Logger,
  authCallbackHandler: AuthCallbackHandler | null,
  mcpOAuthCallbackHandler: McpOAuthCallbackHandler | null,
  skillInstallHandler: SkillInstallHandler | null,
  queueAuthCallbackUrl?: (url: string) => void,
  queueMcpOAuthCallbackUrl?: (url: string) => void,
  queueSkillInstallUrl?: (url: string) => void,
): void {
  if (isMcpOAuthCallbackUrl(url)) {
    logger.debug('[Main] Received MCP OAuth callback URL');
    if (mcpOAuthCallbackHandler) {
      handleMcpOAuthCallbackUrl(url, logger, mcpOAuthCallbackHandler);
    } else {
      queueMcpOAuthCallbackUrl?.(url);
    }
    return;
  }
  if (isAuthCallbackUrl(url)) {
    logger.debug('[Main] Received auth callback URL');
    if (authCallbackHandler) {
      handleAuthCallbackUrl(url, logger, authCallbackHandler);
    } else {
      queueAuthCallbackUrl?.(url);
    }
    return;
  }
  if (isSkillInstallUrl(url)) {
    logger.debug('[Main] Received skill install URL');
    if (skillInstallHandler) {
      handleSkillInstallUrl(url, logger, skillInstallHandler);
    } else {
      queueSkillInstallUrl?.(url);
    }
    return;
  }
  logger.debug(`[Main] Opening incoming URL: ${describeIncomingUrl(url)}`);
  void windowLayoutService.openUrlInNewTab(url);
}

/**
 * Sets up event handlers for opening URLs from OS events.
 * Returns a function to register the auth callback handler once AuthService is ready.
 */
export function setupUrlHandlers(
  windowLayoutService: WindowLayoutService,
  logger: Logger,
): {
  registerAuthCallbackHandler: (handler: AuthCallbackHandler) => void;
  registerMcpOAuthCallbackHandler: (handler: McpOAuthCallbackHandler) => void;
  registerSkillInstallHandler: (handler: SkillInstallHandler) => void;
} {
  let authCallbackHandler: AuthCallbackHandler | null = null;
  let mcpOAuthCallbackHandler: McpOAuthCallbackHandler | null = null;
  let skillInstallHandler: SkillInstallHandler | null = null;
  const pendingAuthCallbackUrls: string[] = [];
  const pendingMcpOAuthCallbackUrls: string[] = [];
  const pendingSkillInstallUrls: string[] = [];
  const queueAuthCallbackUrl = (url: string) => {
    if (pendingAuthCallbackUrls.length >= MAX_QUEUED_AUTH_CALLBACK_URLS) {
      pendingAuthCallbackUrls.shift();
    }
    pendingAuthCallbackUrls.push(url);
    logger.debug('[Main] Queued auth callback URL until handler is ready');
  };
  const queueMcpOAuthCallbackUrl = (url: string) => {
    if (
      pendingMcpOAuthCallbackUrls.length >= MAX_QUEUED_MCP_OAUTH_CALLBACK_URLS
    ) {
      pendingMcpOAuthCallbackUrls.shift();
    }
    pendingMcpOAuthCallbackUrls.push(url);
    logger.debug('[Main] Queued MCP OAuth callback URL until handler is ready');
  };
  const queueSkillInstallUrl = (url: string) => {
    if (pendingSkillInstallUrls.length >= MAX_QUEUED_SKILL_INSTALL_URLS) {
      pendingSkillInstallUrls.shift();
    }
    pendingSkillInstallUrls.push(url);
    logger.debug('[Main] Queued skill install URL until handler is ready');
  };

  // Use registerStartupUrlHandler (installed in index.ts) to get all
  // open-url events, including those queued before main.ts runs.
  registerStartupUrlHandler((url) => {
    logger.debug(`[Main] open-url event received: ${describeIncomingUrl(url)}`);
    if (isOpenableUrl(url)) {
      openIncomingUrl(
        url,
        windowLayoutService,
        logger,
        authCallbackHandler,
        mcpOAuthCallbackHandler,
        skillInstallHandler,
        queueAuthCallbackUrl,
        queueMcpOAuthCallbackUrl,
        queueSkillInstallUrl,
      );
    }
  });
  registerStartupFileHandler((filePath) => {
    if (!isSkillPackagePath(filePath)) return;
    const url = createSkillInstallUrl(filePath);
    if (skillInstallHandler) {
      handleSkillInstallUrl(url, logger, skillInstallHandler);
    } else {
      queueSkillInstallUrl(url);
    }
  });

  // Handle 'second-instance' event (when app is already running)
  app.on('second-instance', (_ev: Electron.Event, argv: string[]) => {
    logger.debug(
      `[Main] second-instance event received with ${argv.length} arguments`,
    );
    const urls = extractUrlsFromArgs(argv);
    for (const url of urls) {
      openIncomingUrl(
        url,
        windowLayoutService,
        logger,
        authCallbackHandler,
        mcpOAuthCallbackHandler,
        skillInstallHandler,
        queueAuthCallbackUrl,
        queueMcpOAuthCallbackUrl,
        queueSkillInstallUrl,
      );
    }
    for (const filePath of extractSkillPackagePaths(argv)) {
      const url = createSkillInstallUrl(filePath);
      if (skillInstallHandler) {
        handleSkillInstallUrl(url, logger, skillInstallHandler);
      } else {
        queueSkillInstallUrl(url);
      }
    }
  });

  return {
    registerAuthCallbackHandler: (handler: AuthCallbackHandler) => {
      authCallbackHandler = handler;
      const urls = pendingAuthCallbackUrls.splice(0);
      for (const url of urls) {
        handleAuthCallbackUrl(url, logger, handler);
      }
    },
    registerMcpOAuthCallbackHandler: (handler: McpOAuthCallbackHandler) => {
      mcpOAuthCallbackHandler = handler;
      const urls = pendingMcpOAuthCallbackUrls.splice(0);
      for (const url of urls) {
        handleMcpOAuthCallbackUrl(url, logger, handler);
      }
    },
    registerSkillInstallHandler: (handler: SkillInstallHandler) => {
      skillInstallHandler = handler;
      const urls = pendingSkillInstallUrls.splice(0);
      for (const url of urls) {
        handleSkillInstallUrl(url, logger, handler);
      }
    },
  };
}

/**
 * Handles URLs from command line arguments on initial startup.
 * Packaged protocol launches may pass the callback URL as argv[1]
 * without a script-path argument, so we scan all of argv.
 */
export function handleCommandLineUrls(
  argv: string[],
  windowLayoutService: WindowLayoutService,
  logger: Logger,
  authCallbackHandler: AuthCallbackHandler | null,
  mcpOAuthCallbackHandler: McpOAuthCallbackHandler | null,
  skillInstallHandler: SkillInstallHandler | null,
): void {
  const urls = extractUrlsFromArgs(argv);
  if (urls.length > 0) {
    logger.debug(
      `[Main] Found ${urls.length} URLs in command line arguments: ${urls
        .map(describeIncomingUrl)
        .join(', ')}`,
    );
    // Open the first URL immediately, others will be queued
    openIncomingUrl(
      urls[0],
      windowLayoutService,
      logger,
      authCallbackHandler,
      mcpOAuthCallbackHandler,
      skillInstallHandler,
    );
    // Open remaining URLs after a short delay to ensure the first one is processed
    for (let i = 1; i < urls.length; i++) {
      setTimeout(() => {
        openIncomingUrl(
          urls[i],
          windowLayoutService,
          logger,
          authCallbackHandler,
          mcpOAuthCallbackHandler,
          skillInstallHandler,
        );
      }, i * 100);
    }
  }
  for (const filePath of extractSkillPackagePaths(argv)) {
    openIncomingUrl(
      createSkillInstallUrl(filePath),
      windowLayoutService,
      logger,
      authCallbackHandler,
      mcpOAuthCallbackHandler,
      skillInstallHandler,
    );
  }
}
