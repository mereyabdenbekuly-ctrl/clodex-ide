import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routingEvents = vi.hoisted(() => {
  const state = {
    startupUrlHandler: null as ((url: string) => void) | null,
    startupFileHandler: null as ((filePath: string) => void) | null,
    secondInstanceHandler: null as
      | ((event: unknown, argv: string[]) => void)
      | null,
    registrationOrder: [] as string[],
  };

  return {
    state,
    appOn: vi.fn(
      (event: string, handler: (event: unknown, argv: string[]) => void) => {
        if (event === 'second-instance') {
          state.secondInstanceHandler = handler;
          state.registrationOrder.push('second-instance');
        }
      },
    ),
    registerStartupUrlHandler: vi.fn((handler: (url: string) => void) => {
      state.startupUrlHandler = handler;
      state.registrationOrder.push('open-url');
      return () => undefined;
    }),
    registerStartupFileHandler: vi.fn((handler: (filePath: string) => void) => {
      state.startupFileHandler = handler;
      state.registrationOrder.push('open-file');
      return () => undefined;
    }),
  };
});

vi.mock('electron', () => ({
  app: {
    on: routingEvents.appOn,
  },
}));

vi.mock('../startup-url-events', () => ({
  registerStartupFileHandler: routingEvents.registerStartupFileHandler,
  registerStartupUrlHandler: routingEvents.registerStartupUrlHandler,
}));

vi.mock('../services/auth/callback-scheme', () => ({
  AUTH_CALLBACK_PROTOCOL: 'clodex-ide:',
}));

import type { Logger } from '../services/logger';
import type { WindowLayoutService } from '../services/window-layout';
import { createSkillInstallUrl } from '../skill-package-routing';
import { handleCommandLineUrls, setupUrlHandlers } from './url-routing';

function createHarness() {
  const openUrlInNewTab = vi.fn(async (_url: string) => 'tab-id');
  const windowLayoutService = {
    openUrlInNewTab,
  } as unknown as WindowLayoutService;
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;

  return {
    logger,
    openUrlInNewTab,
    registrations: setupUrlHandlers(windowLayoutService, logger),
    windowLayoutService,
  };
}

function getStartupUrlHandler(): (url: string) => void {
  expect(routingEvents.state.startupUrlHandler).not.toBeNull();
  return routingEvents.state.startupUrlHandler!;
}

function getStartupFileHandler(): (filePath: string) => void {
  expect(routingEvents.state.startupFileHandler).not.toBeNull();
  return routingEvents.state.startupFileHandler!;
}

function getSecondInstanceHandler(): (event: unknown, argv: string[]) => void {
  expect(routingEvents.state.secondInstanceHandler).not.toBeNull();
  return routingEvents.state.secondInstanceHandler!;
}

beforeEach(() => {
  vi.clearAllMocks();
  routingEvents.state.startupUrlHandler = null;
  routingEvents.state.startupFileHandler = null;
  routingEvents.state.secondInstanceHandler = null;
  routingEvents.state.registrationOrder.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startup URL routing', () => {
  it('routes callback categories before the generic browser fallback', () => {
    const { logger, openUrlInNewTab, registrations } = createHarness();
    const authHandler = vi.fn(() => true);
    const mcpHandler = vi.fn(() => true);
    const skillHandler = vi.fn(() => true);
    registrations.registerAuthCallbackHandler(authHandler);
    registrations.registerMcpOAuthCallbackHandler(mcpHandler);
    registrations.registerSkillInstallHandler(skillHandler);

    const mcpUrl = 'clodex://mcp/oauth/callback?code=mcp-secret';
    const authUrl = 'clodex-ide://auth/callback?code=auth-secret';
    const skillUrl = 'https://skill/install?path=/tmp/example.skill';
    const genericUrl = 'https://example.com/private?secret=hidden';
    const handleUrl = getStartupUrlHandler();

    handleUrl(mcpUrl);
    handleUrl(authUrl);
    handleUrl(skillUrl);
    handleUrl(genericUrl);
    handleUrl('mailto:user@example.com');

    expect(mcpHandler).toHaveBeenCalledTimes(1);
    expect(mcpHandler).toHaveBeenCalledWith(mcpUrl);
    expect(authHandler).toHaveBeenCalledTimes(1);
    expect(authHandler).toHaveBeenCalledWith(authUrl);
    expect(skillHandler).toHaveBeenCalledTimes(1);
    expect(skillHandler).toHaveBeenCalledWith(skillUrl);
    expect(openUrlInNewTab).toHaveBeenCalledTimes(1);
    expect(openUrlInNewTab).toHaveBeenCalledWith(genericUrl);

    const debugOutput = vi
      .mocked(logger.debug)
      .mock.calls.flat()
      .map(String)
      .join('\n');
    expect(debugOutput).toContain(
      '[Main] open-url event received: MCP OAuth callback',
    );
    expect(debugOutput).toContain(
      '[Main] open-url event received: auth callback',
    );
    expect(debugOutput).toContain(
      '[Main] open-url event received: skill install',
    );
    expect(debugOutput).toContain(
      '[Main] open-url event received: https://example.com',
    );
    expect(debugOutput).not.toContain('mcp-secret');
    expect(debugOutput).not.toContain('auth-secret');
    expect(debugOutput).not.toContain('hidden');
  });

  it('reserves only the exact account auth callback path', () => {
    const { openUrlInNewTab, registrations } = createHarness();
    const authHandler = vi.fn(() => true);
    registrations.registerAuthCallbackHandler(authHandler);

    const handleUrl = getStartupUrlHandler();
    const lookalikeUrl =
      'clodex-ide://authorization/callback?code=unbound-code';
    handleUrl(lookalikeUrl);

    expect(authHandler).not.toHaveBeenCalled();
    expect(openUrlInNewTab).toHaveBeenCalledWith(lookalikeUrl);
  });

  it('keeps independent FIFO queues capped at five URLs per handler', () => {
    const { openUrlInNewTab, registrations } = createHarness();
    const handleUrl = getStartupUrlHandler();
    const authUrls = Array.from(
      { length: 6 },
      (_, index) => `clodex-ide://auth/callback?index=${index}`,
    );
    const mcpUrls = Array.from(
      { length: 6 },
      (_, index) => `clodex://mcp/oauth/callback?index=${index}`,
    );
    const skillUrls = Array.from(
      { length: 6 },
      (_, index) => `clodex://skill/install?index=${index}`,
    );

    for (let index = 0; index < 6; index++) {
      handleUrl(authUrls[index]);
      handleUrl(mcpUrls[index]);
      handleUrl(skillUrls[index]);
    }

    const authHandler = vi.fn((_url: string) => true);
    const mcpHandler = vi.fn((_url: string) => true);
    const skillHandler = vi.fn((_url: string) => true);
    registrations.registerAuthCallbackHandler(authHandler);
    registrations.registerMcpOAuthCallbackHandler(mcpHandler);
    registrations.registerSkillInstallHandler(skillHandler);

    expect(authHandler.mock.calls.map(([url]) => url)).toEqual(
      authUrls.slice(1),
    );
    expect(mcpHandler.mock.calls.map(([url]) => url)).toEqual(mcpUrls.slice(1));
    expect(skillHandler.mock.calls.map(([url]) => url)).toEqual(
      skillUrls.slice(1),
    );
    expect(openUrlInNewTab).not.toHaveBeenCalled();
  });

  it('preserves listener registration, open-file, and second-instance ordering', () => {
    const { logger, openUrlInNewTab, registrations } = createHarness();
    expect(routingEvents.state.registrationOrder).toEqual([
      'open-url',
      'open-file',
      'second-instance',
    ]);

    const order: string[] = [];
    openUrlInNewTab.mockImplementation(async (url: string) => {
      order.push(`tab:${url}`);
      return 'tab-id';
    });
    registrations.registerAuthCallbackHandler((url) => {
      order.push(`auth:${url}`);
      return true;
    });
    registrations.registerMcpOAuthCallbackHandler((url) => {
      order.push(`mcp:${url}`);
      return true;
    });

    const handleFile = getStartupFileHandler();
    handleFile('/tmp/readme.md');
    const queuedFiles = Array.from(
      { length: 6 },
      (_, index) => `/tmp/queued-open-file-${index}.skill`,
    );
    for (const filePath of queuedFiles) {
      handleFile(filePath);
    }
    expect(order).toEqual([]);

    registrations.registerSkillInstallHandler((url) => {
      order.push(`skill:${url}`);
      return true;
    });
    expect(order).toEqual(
      queuedFiles
        .slice(1)
        .map((filePath) => `skill:${createSkillInstallUrl(filePath)}`),
    );

    order.length = 0;
    handleFile('/tmp/from-open-file.skill');
    expect(order).toEqual([
      `skill:${createSkillInstallUrl('/tmp/from-open-file.skill')}`,
    ]);

    order.length = 0;
    const genericUrl = 'https://second.example/path';
    const authUrl = 'clodex-ide://auth/callback?source=second';
    const mcpUrl = 'clodex://mcp/oauth/callback?source=second';
    const skillUrl = 'clodex://skill/install?source=second';
    const firstFile = '/tmp/first.skill';
    const secondFile = '/tmp/SKILL.md';
    const argv = [
      'electron',
      firstFile,
      genericUrl,
      authUrl,
      secondFile,
      mcpUrl,
      skillUrl,
    ];

    getSecondInstanceHandler()({}, argv);

    expect(order).toEqual([
      `tab:${genericUrl}`,
      `auth:${authUrl}`,
      `mcp:${mcpUrl}`,
      `skill:${skillUrl}`,
      `skill:${createSkillInstallUrl(firstFile)}`,
      `skill:${createSkillInstallUrl(secondFile)}`,
    ]);
    expect(logger.debug).toHaveBeenCalledWith(
      `[Main] second-instance event received with ${argv.length} arguments`,
    );
  });

  it('opens the first command-line URL and skill files before delayed URLs', () => {
    vi.useFakeTimers();
    const { logger, openUrlInNewTab, windowLayoutService } = createHarness();
    const order: string[] = [];
    openUrlInNewTab.mockImplementation(async (url: string) => {
      order.push(`tab:${url}`);
      return 'tab-id';
    });
    const authHandler = vi.fn((url: string) => {
      order.push(`auth:${url}`);
      return true;
    });
    const mcpHandler = vi.fn((url: string) => {
      order.push(`mcp:${url}`);
      return true;
    });
    const skillHandler = vi.fn((url: string) => {
      order.push(`skill:${url}`);
      return true;
    });
    const authUrl = 'clodex-ide://auth/callback?source=cli';
    const genericUrl = 'https://cli.example/path?secret=hidden';
    const mcpUrl = 'clodex://mcp/oauth/callback?source=cli';
    const skillFile = '/tmp/command.skill';

    handleCommandLineUrls(
      ['electron', authUrl, genericUrl, mcpUrl, skillFile],
      windowLayoutService,
      logger,
      authHandler,
      mcpHandler,
      skillHandler,
    );

    expect(order).toEqual([
      `auth:${authUrl}`,
      `skill:${createSkillInstallUrl(skillFile)}`,
    ]);

    vi.advanceTimersByTime(99);
    expect(order).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(order).toEqual([
      `auth:${authUrl}`,
      `skill:${createSkillInstallUrl(skillFile)}`,
      `tab:${genericUrl}`,
    ]);
    vi.advanceTimersByTime(100);
    expect(order).toEqual([
      `auth:${authUrl}`,
      `skill:${createSkillInstallUrl(skillFile)}`,
      `tab:${genericUrl}`,
      `mcp:${mcpUrl}`,
    ]);
    expect(logger.debug).toHaveBeenCalledWith(
      '[Main] Found 3 URLs in command line arguments: auth callback, https://cli.example, MCP OAuth callback',
    );
  });

  it('logs rejected callback handlers with the existing category formats', async () => {
    const { logger, registrations } = createHarness();
    registrations.registerAuthCallbackHandler(async () => {
      throw new Error('auth failure');
    });
    registrations.registerMcpOAuthCallbackHandler(async () => {
      throw new Error('mcp failure');
    });
    registrations.registerSkillInstallHandler(async () => {
      throw new Error('skill failure');
    });

    const handleUrl = getStartupUrlHandler();
    handleUrl('clodex-ide://auth/callback');
    handleUrl('clodex://mcp/oauth/callback');
    handleUrl('clodex://skill/install');
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalledWith(
      '[Main] Auth callback handling failed: Error: auth failure',
    );
    expect(logger.error).toHaveBeenCalledWith(
      '[Main] MCP OAuth callback handling failed: mcp failure',
    );
    expect(logger.error).toHaveBeenCalledWith(
      '[Main] Skill install handling failed: Error: skill failure',
    );
  });
});
