import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import express from 'express';
import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import { McpHostSupervisor } from '../src/backend/mcp-host/supervisor';
import type { Logger } from '../src/backend/services/logger';

const outputDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(outputDirectory, 'mcp-host.cjs');
const stdioFixturePath = path.resolve(
  process.cwd(),
  'scripts/fixtures/mcp-stdio-fixture.mjs',
);
const nodeExecutable =
  process.env.npm_node_execpath ??
  process.env.NODE ??
  path.resolve(process.execPath);

const logger = {
  debug() {},
  info() {},
  warn(message: unknown, error?: unknown) {
    console.warn(message, error ?? '');
  },
  error(message: unknown, error?: unknown) {
    console.error(message, error ?? '');
  },
} as unknown as Logger;

let supervisor: McpHostSupervisor | null = null;
let httpServer: ReturnType<
  ReturnType<typeof createMcpExpressApp>['listen']
> | null = null;

void runSmoke();

async function runSmoke(): Promise<void> {
  try {
    console.log('MCP_HOST_SMOKE phase=electron-start');
    app.disableHardwareAcceleration();
    await app.whenReady();
    console.log('MCP_HOST_SMOKE phase=electron-ready');

    const remote = await startRemoteFixtures();
    console.log(`MCP_HOST_SMOKE phase=fixtures-ready url=${remote.baseUrl}`);
    httpServer = remote.httpServer;
    const secret = 'mcp-smoke-secret-7f34'; // gitleaks:allow
    const serverLogs: string[] = [];
    const listChangedEvents: Array<{
      serverId: string;
      kind: 'tools' | 'resources' | 'prompts';
      names: string[];
    }> = [];
    const elicitationRequests: Array<{
      serverId: string;
      agentInstanceId: string;
      message: string;
    }> = [];
    let elicitationAbortObserved = false;
    let hostRestarts = 0;
    const oauthSession: {
      clientInformation?: Record<string, unknown>;
      tokens?: Record<string, unknown>;
      codeVerifier?: string;
      discoveryState?: unknown;
      state?: string;
      authorizationUrl?: string;
    } = {};

    supervisor = await McpHostSupervisor.create(logger, {
      workerPath,
      readyTimeoutMs: 10_000,
      requestTimeoutMs: 5_000,
      restartBaseDelayMs: 50,
      heartbeatTimeoutMs: 15_000,
      onServerLog: (_serverId, _level, message) => {
        serverLogs.push(message);
      },
      onHostRestart: () => {
        hostRestarts += 1;
      },
      onElicitationRequest: async (
        serverId,
        agentInstanceId,
        request,
        signal,
      ) => {
        elicitationRequests.push({
          serverId,
          agentInstanceId,
          message: request.message,
        });
        assert(serverId === 'smoke-stdio', 'unexpected elicitation server');
        assert(
          agentInstanceId === 'smoke-agent',
          'unexpected elicitation agent',
        );
        assert(
          request.fields.map((field) => field.kind).join(',') ===
            'text,number,boolean,select,multi-select',
          'elicitation fields were not normalized',
        );
        if (request.message === 'Wait for cancellation.') {
          await new Promise<void>((resolve) => {
            const handleAbort = () => {
              elicitationAbortObserved = true;
              resolve();
            };
            signal.addEventListener('abort', handleAbort, { once: true });
            if (signal.aborted) handleAbort();
          });
          return { action: 'cancel' };
        }
        return {
          action: 'accept',
          content: {
            name: 'API',
            replicas: 3,
            enabled: true,
            environment: 'staging',
            regions: ['us'],
          },
        };
      },
      onListChanged: (serverId, kind, items) => {
        const event = {
          serverId,
          kind,
          names: items.map((item) =>
            'name' in item ? item.name : String(item.uri),
          ),
        };
        listChangedEvents.push(event);
        console.log(
          `MCP_HOST_SMOKE phase=list-changed server=${serverId} kind=${kind} names=${event.names.join(',')}`,
        );
      },
      onOAuthRequest: async (_serverId, request) => {
        switch (request.operation) {
          case 'load-client-information':
            return oauthSession.clientInformation;
          case 'save-client-information':
            oauthSession.clientInformation = request.value as Record<
              string,
              unknown
            >;
            return undefined;
          case 'load-tokens':
            return oauthSession.tokens;
          case 'save-tokens':
            oauthSession.tokens = request.value as Record<string, unknown>;
            return undefined;
          case 'prepare-state':
            oauthSession.state = 'mcp-oauth-smoke-state';
            return oauthSession.state;
          case 'open-authorization':
            oauthSession.authorizationUrl = request.authorizationUrl;
            return undefined;
          case 'save-code-verifier':
            oauthSession.codeVerifier = request.codeVerifier;
            return undefined;
          case 'load-code-verifier':
            return oauthSession.codeVerifier;
          case 'save-discovery-state':
            oauthSession.discoveryState = request.value;
            return undefined;
          case 'load-discovery-state':
            return oauthSession.discoveryState;
          case 'invalidate-credentials':
            if (request.scope === 'all' || request.scope === 'client') {
              delete oauthSession.clientInformation;
            }
            if (request.scope === 'all' || request.scope === 'tokens') {
              delete oauthSession.tokens;
            }
            if (request.scope === 'all' || request.scope === 'verifier') {
              delete oauthSession.codeVerifier;
              delete oauthSession.state;
            }
            if (request.scope === 'all' || request.scope === 'discovery') {
              delete oauthSession.discoveryState;
            }
            return undefined;
        }
      },
    });
    console.log('MCP_HOST_SMOKE phase=host-ready');

    const initialPid = supervisor.pid;
    assert(
      typeof initialPid === 'number' && initialPid > 0,
      'MCP host did not expose a utility-process PID',
    );
    assert(initialPid !== process.pid, 'MCP host was not isolated');

    await supervisor.connectServer(
      'smoke-stdio',
      {
        type: 'stdio',
        command: nodeExecutable,
        args: [stdioFixturePath],
        cwd: path.dirname(stdioFixturePath),
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          SMOKE_SECRET: secret,
        },
      },
      [secret],
    );
    await supervisor.connectServer('smoke-http', {
      type: 'streamable-http',
      url: `${remote.baseUrl}/mcp`,
      headers: {},
    });
    await supervisor.connectServer('smoke-sse', {
      type: 'sse',
      url: `${remote.baseUrl}/sse`,
      headers: {},
    });
    console.log('MCP_HOST_SMOKE phase=oauth-connect-start');
    const oauthConnectionState = await supervisor.connectServer('smoke-oauth', {
      type: 'streamable-http',
      url: `${remote.baseUrl}/oauth-mcp`,
      headers: {},
      oauth: {
        clientRegistrationId: 'clodex-dynamic',
        redirectUrl: 'clodex-ide://mcp/oauth/callback',
        scopes: ['mcp:tools'],
        clientMetadata: {
          redirect_uris: ['clodex-ide://mcp/oauth/callback'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          client_name: 'Clodex MCP smoke',
          scope: 'mcp:tools',
        },
        allowedAuthorizationOrigins: [remote.baseUrl],
      },
    });
    console.log(
      `MCP_HOST_SMOKE phase=oauth-connect-result state=${oauthConnectionState}`,
    );
    assert(
      oauthConnectionState === 'authorization-required',
      'OAuth MCP did not request authorization',
    );
    assert(
      Boolean(oauthSession.authorizationUrl),
      'OAuth MCP did not emit an authorization URL',
    );
    const authorizationUrl = new URL(oauthSession.authorizationUrl!);
    assert(
      authorizationUrl.origin === remote.baseUrl,
      'OAuth authorization escaped the registered origin',
    );
    assert(
      authorizationUrl.searchParams.get('state') === oauthSession.state,
      'OAuth authorization state was not preserved',
    );
    assert(
      authorizationUrl.searchParams.get('code_challenge_method') === 'S256',
      'OAuth authorization did not use PKCE S256',
    );
    await supervisor.finishOAuth('smoke-oauth', 'smoke-code');
    console.log('MCP_HOST_SMOKE phase=oauth-finish');
    assert(
      oauthSession.tokens?.access_token === 'mcp-oauth-smoke-access-token',
      'OAuth token exchange did not persist the access token through main RPC',
    );
    assert(
      (await supervisor.connectServer('smoke-oauth', {
        type: 'streamable-http',
        url: `${remote.baseUrl}/oauth-mcp`,
        headers: {},
        oauth: {
          clientRegistrationId: 'clodex-dynamic',
          redirectUrl: 'clodex-ide://mcp/oauth/callback',
          scopes: ['mcp:tools'],
          clientMetadata: {
            redirect_uris: ['clodex-ide://mcp/oauth/callback'],
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            client_name: 'Clodex MCP smoke',
            scope: 'mcp:tools',
          },
          allowedAuthorizationOrigins: [remote.baseUrl],
        },
      })) === 'connected',
      'OAuth MCP did not reconnect with persisted tokens',
    );
    console.log('MCP_HOST_SMOKE phase=oauth-reconnected');

    for (const [serverId, expectedPrefix] of [
      ['smoke-stdio', 'stdio'],
      ['smoke-http', 'streamable-http'],
      ['smoke-sse', 'sse'],
      ['smoke-oauth', 'oauth'],
    ] as const) {
      const tools = await supervisor.listTools(serverId);
      assert(
        tools.some((tool) => tool.name === 'echo'),
        `${serverId} did not expose echo`,
      );
      const result = await supervisor.callTool(serverId, 'echo', {
        message: 'ok',
      });
      assert(
        JSON.stringify(result).includes(`${expectedPrefix}:ok`),
        `${serverId} returned an unexpected tool result`,
      );
      const resources = await supervisor.listResources(serverId);
      assert(
        resources.resources.some(
          (resource) => resource.uri === `smoke://${expectedPrefix}/readme`,
        ),
        `${serverId} did not expose the static resource`,
      );
      const templates = await supervisor.listResourceTemplates(serverId);
      assert(
        templates.resourceTemplates.some(
          (template) =>
            template.uriTemplate === `smoke://${expectedPrefix}/items/{id}`,
        ),
        `${serverId} did not expose the resource template`,
      );
      const resource = await supervisor.readResource(
        serverId,
        `smoke://${expectedPrefix}/readme`,
      );
      assert(
        JSON.stringify(resource).includes(`${expectedPrefix}:readme`),
        `${serverId} returned an unexpected resource`,
      );
      const prompts = await supervisor.listPrompts(serverId);
      assert(
        prompts.prompts.some((prompt) => prompt.name === 'review'),
        `${serverId} did not expose the review prompt`,
      );
      const prompt = await supervisor.getPrompt(serverId, 'review', {
        focus: 'security',
      });
      assert(
        JSON.stringify(prompt).includes(`${expectedPrefix}:review:security`),
        `${serverId} returned an unexpected prompt`,
      );
    }

    const elicited = await supervisor.callTool(
      'smoke-stdio',
      'elicit',
      {},
      { agentInstanceId: 'smoke-agent' },
    );
    assert(
      JSON.stringify(elicited).includes('staging') &&
        JSON.stringify(elicited).includes('API'),
      'accepted elicitation content did not reach the MCP tool',
    );
    assert(
      elicitationRequests.length === 1,
      'accepted elicitation did not reach main exactly once',
    );

    const withoutAgent = await supervisor.callTool('smoke-stdio', 'elicit', {});
    assert(
      JSON.stringify(withoutAgent).includes('cancel'),
      'agentless elicitation was not cancelled',
    );
    assert(
      elicitationRequests.length === 1,
      'agentless elicitation unexpectedly opened UI',
    );

    const ambiguousCalls = await Promise.all([
      supervisor.callTool(
        'smoke-stdio',
        'elicit',
        { delayBeforeElicitMs: 75 },
        { agentInstanceId: 'ambiguous-agent-a' },
      ),
      supervisor.callTool(
        'smoke-stdio',
        'elicit',
        { delayBeforeElicitMs: 75 },
        { agentInstanceId: 'ambiguous-agent-b' },
      ),
    ]);
    assert(
      ambiguousCalls.every((result) =>
        JSON.stringify(result).includes('cancel'),
      ),
      'ambiguous multi-agent elicitation was not cancelled',
    );
    assert(
      elicitationRequests.length === 1,
      'ambiguous multi-agent elicitation unexpectedly opened UI',
    );

    const elicitationAbortController = new AbortController();
    const cancelledElicitation = supervisor.callTool(
      'smoke-stdio',
      'elicit',
      { message: 'Wait for cancellation.' },
      {
        timeoutMs: 10_000,
        signal: elicitationAbortController.signal,
        agentInstanceId: 'smoke-agent',
      },
    );
    await waitFor(
      () =>
        elicitationRequests.some(
          (request) => request.message === 'Wait for cancellation.',
        ),
      'pending elicitation',
    );
    elicitationAbortController.abort();
    await assertRejects(
      cancelledElicitation,
      (error) => error.name === 'AbortError',
    );
    await waitFor(
      () => elicitationAbortObserved,
      'elicitation cancellation propagation',
    );

    await supervisor.callTool('smoke-stdio', 'change_catalog', {});
    await waitFor(
      () =>
        (['tools', 'resources', 'prompts'] as const).every((kind) =>
          listChangedEvents.some(
            (event) =>
              event.serverId === 'smoke-stdio' &&
              event.kind === kind &&
              event.names.some((name) => name.startsWith('catalog')),
          ),
        ),
      'tools/resources/prompts list-changed refresh',
    );

    const abortController = new AbortController();
    const cancelled = supervisor.callTool(
      'smoke-stdio',
      'slow',
      { delayMs: 5_000 },
      { timeoutMs: 10_000, signal: abortController.signal },
    );
    setTimeout(() => abortController.abort(), 50);
    await assertRejects(cancelled, (error) => error.name === 'AbortError');

    await assertRejects(
      supervisor.callTool(
        'smoke-stdio',
        'slow',
        { delayMs: 5_000 },
        { timeoutMs: 75 },
      ),
      (error) => /timed out|timeout/i.test(error.message),
    );

    await waitFor(
      () => serverLogs.some((message) => message.includes('[REDACTED]')),
      'stdio secret redaction',
    );
    assert(
      !serverLogs.some((message) => message.includes(secret)),
      'raw secret reached MCP host logs',
    );

    assert(process.kill(initialPid, 'SIGKILL'), 'failed to kill MCP host');
    await waitFor(
      () =>
        supervisor?.processStatus === 'ready' &&
        typeof supervisor.pid === 'number' &&
        supervisor.pid !== initialPid,
      'MCP host restart',
    );
    await waitFor(async () => {
      try {
        const tools = await supervisor?.listTools('smoke-http');
        return tools?.some((tool) => tool.name === 'echo') === true;
      } catch {
        return false;
      }
    }, 'MCP server restoration after host restart');
    assert(hostRestarts >= 1, 'MCP host restart callback was not emitted');

    await supervisor.teardown();
    supervisor = null;
    await closeHttpServer(httpServer);
    httpServer = null;
    console.log(
      `MCP_HOST_SMOKE stdio=true streamableHttp=true sse=true oauth=true resources=true resourceTemplates=true prompts=true listChanged=true elicitation=true elicitationAgentlessCancel=true elicitationAmbiguityCancel=true elicitationAbort=true cancel=true timeout=true redaction=true restarted=true workerPid=${initialPid} exit=0`,
    );
    app.exit(0);
  } catch (error) {
    if (supervisor) await supervisor.teardown().catch(() => {});
    if (httpServer) await closeHttpServer(httpServer).catch(() => {});
    console.error(
      'MCP_HOST_SMOKE stdio=false streamableHttp=false sse=false exit=1',
      error instanceof Error ? error.stack : error,
    );
    app.exit(1);
  }
}

function createFixtureServer(prefix: string): McpServer {
  const server = new McpServer({
    name: `clodex-mcp-${prefix}-smoke-fixture`,
    version: '1.0.0',
  });
  registerContextFixtures(server, prefix);
  server.registerTool(
    'echo',
    {
      description: `Echo through the ${prefix} fixture.`,
      inputSchema: { message: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ message }) => ({
      content: [{ type: 'text', text: `${prefix}:${message}` }],
    }),
  );
  server.registerTool(
    'slow',
    {
      description: 'Slow fixture call.',
      inputSchema: { delayMs: z.number().int().min(1).max(30_000) },
    },
    async ({ delayMs }) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        content: [{ type: 'text', text: `${prefix}:waited:${delayMs}` }],
      };
    },
  );
  let catalogChanged = false;
  server.registerTool(
    'change_catalog',
    {
      description: 'Register additional fixture catalog entries.',
      inputSchema: {},
    },
    async () => {
      if (!catalogChanged) {
        catalogChanged = true;
        registerChangedCatalog(server, prefix);
      }
      return {
        content: [{ type: 'text', text: `${prefix}:catalog-changed` }],
      };
    },
  );
  return server;
}

function registerContextFixtures(server: McpServer, prefix: string): void {
  server.registerResource(
    'readme',
    `smoke://${prefix}/readme`,
    {
      title: `${prefix} README`,
      description: `Static resource from the ${prefix} smoke fixture.`,
      mimeType: 'text/plain',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: `${prefix}:readme` }],
    }),
  );
  server.registerResource(
    'item',
    new ResourceTemplate(`smoke://${prefix}/items/{id}`, {
      list: undefined,
    }),
    {
      title: `${prefix} item`,
      description: `Templated resource from the ${prefix} smoke fixture.`,
      mimeType: 'text/plain',
    },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          text: `${prefix}:item:${String(variables.id)}`,
        },
      ],
    }),
  );
  server.registerPrompt(
    'review',
    {
      description: `Review prompt from the ${prefix} smoke fixture.`,
      argsSchema: { focus: z.string().optional() },
    },
    async ({ focus }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `${prefix}:review:${focus ?? 'general'}`,
          },
        },
      ],
    }),
  );
}

function registerChangedCatalog(server: McpServer, prefix: string): void {
  server.registerTool(
    'catalog_echo',
    {
      description: 'Tool registered after a list-changed event.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: `${prefix}:catalog-echo` }],
    }),
  );
  server.registerResource(
    'catalog-status',
    `smoke://${prefix}/catalog-status`,
    {
      description: 'Resource registered after a list-changed event.',
      mimeType: 'text/plain',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: `${prefix}:catalog-status` }],
    }),
  );
  server.registerPrompt(
    'catalog-review',
    {
      description: 'Prompt registered after a list-changed event.',
    },
    async () => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: `${prefix}:catalog-review` },
        },
      ],
    }),
  );
}

async function startRemoteFixtures(): Promise<{
  httpServer: ReturnType<ReturnType<typeof createMcpExpressApp>['listen']>;
  baseUrl: string;
}> {
  const expressApp = createMcpExpressApp();
  expressApp.use(express.urlencoded({ extended: false }));
  const sseTransports = new Map<string, SSEServerTransport>();
  const oauthAccessToken = 'mcp-oauth-smoke-access-token';

  expressApp.get(
    '/.well-known/oauth-protected-resource',
    (request, response) => {
      const origin = `${request.protocol}://${request.get('host')}`;
      response.json({
        resource: `${origin}/oauth-mcp`,
        authorization_servers: [origin],
        scopes_supported: ['mcp:tools'],
      });
    },
  );
  expressApp.get(
    '/.well-known/oauth-authorization-server',
    (request, response) => {
      const origin = `${request.protocol}://${request.get('host')}`;
      response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['mcp:tools'],
      });
    },
  );
  expressApp.post('/register', (request, response) => {
    response.json({
      ...request.body,
      client_id: 'mcp-oauth-smoke-client',
      client_id_issued_at: Math.floor(Date.now() / 1_000),
    });
  });
  expressApp.post('/token', (request, response) => {
    if (
      request.body?.grant_type !== 'authorization_code' ||
      request.body?.code !== 'smoke-code' ||
      typeof request.body?.code_verifier !== 'string' ||
      request.body.code_verifier.length < 43
    ) {
      response.status(400).json({ error: 'invalid_grant' });
      return;
    }
    response.json({
      access_token: oauthAccessToken,
      token_type: 'Bearer',
      scope: 'mcp:tools',
    });
  });

  const requireOAuth = (
    request: express.Request,
    response: express.Response,
  ): boolean => {
    if (request.get('authorization') === `Bearer ${oauthAccessToken}`) {
      return true;
    }
    const origin = `${request.protocol}://${request.get('host')}`;
    response
      .status(401)
      .set(
        'www-authenticate',
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="mcp:tools"`,
      )
      .end();
    return false;
  };

  expressApp.post('/oauth-mcp', async (request, response) => {
    if (!requireOAuth(request, response)) return;
    const server = createFixtureServer('oauth');
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } finally {
      response.on('close', () => {
        void transport.close();
        void server.close();
      });
    }
  });
  expressApp.get('/oauth-mcp', (request, response) => {
    if (!requireOAuth(request, response)) return;
    response.status(405).end();
  });
  expressApp.delete('/oauth-mcp', (request, response) => {
    if (!requireOAuth(request, response)) return;
    response.status(405).end();
  });

  expressApp.post('/mcp', async (request, response) => {
    const server = createFixtureServer('streamable-http');
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } finally {
      response.on('close', () => {
        void transport.close();
        void server.close();
      });
    }
  });
  expressApp.get('/mcp', (_request, response) => {
    response.status(405).end();
  });
  expressApp.delete('/mcp', (_request, response) => {
    response.status(405).end();
  });

  expressApp.get('/sse', async (_request, response) => {
    const transport = new SSEServerTransport('/messages', response);
    sseTransports.set(transport.sessionId, transport);
    transport.onclose = () => {
      sseTransports.delete(transport.sessionId);
    };
    await createFixtureServer('sse').connect(transport);
  });
  expressApp.post('/messages', async (request, response) => {
    const sessionId =
      typeof request.query.sessionId === 'string'
        ? request.query.sessionId
        : null;
    const transport = sessionId ? sseTransports.get(sessionId) : undefined;
    if (!transport) {
      response.status(404).end();
      return;
    }
    await transport.handlePostMessage(request, response, request.body);
  });

  const httpServer = await new Promise<
    ReturnType<ReturnType<typeof createMcpExpressApp>['listen']>
  >((resolve, reject) => {
    const server = expressApp.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
  const address = httpServer.address();
  assert(
    address && typeof address === 'object',
    'Remote MCP fixture did not expose a port',
  );
  return {
    httpServer,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeHttpServer(
  server: ReturnType<ReturnType<typeof createMcpExpressApp>['listen']>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

async function assertRejects(
  promise: Promise<unknown>,
  predicate: (error: Error) => boolean,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    assert(
      predicate(normalized),
      `Unexpected rejection: ${normalized.message}`,
    );
    return;
  }
  throw new Error('Expected operation to reject');
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
