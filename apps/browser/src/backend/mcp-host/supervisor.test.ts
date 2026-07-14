import {
  MCP_HOST_PROTOCOL_VERSION,
  type MainToMcpHostMessage,
  type McpHostToMainMessage,
} from '@clodex/mcp-runtime';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../services/logger';

const electronMocks = vi.hoisted(() => ({
  fork: vi.fn(),
}));

vi.mock('electron', () => ({
  utilityProcess: {
    fork: electronMocks.fork,
  },
}));

import { McpHostSupervisor } from './supervisor';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

class FakeUtilityProcess extends EventEmitter {
  public pid: number | undefined;
  public stdout = null;
  public stderr = null;
  public readonly messages: MainToMcpHostMessage[] = [];
  public autoReady = true;
  public autoConnect = true;
  public ignoreToolCalls = false;
  public requireOAuth = false;
  public readonly kill = vi.fn(() => {
    queueMicrotask(() => this.exit(143));
    return true;
  });
  private exited = false;

  public constructor(pid: number) {
    super();
    this.pid = pid;
  }

  public postMessage(message: MainToMcpHostMessage): void {
    this.messages.push(message);
    switch (message.type) {
      case 'initialize':
        if (!this.autoReady) break;
        queueMicrotask(() => {
          this.sendReady(message.launchId);
        });
        break;
      case 'connect-server':
        if (!this.autoConnect) break;
        queueMicrotask(() => {
          this.send({
            type: 'connection-state',
            launchId: message.launchId,
            requestId: message.requestId,
            serverId: message.serverId,
            connectionId: message.connectionId,
            state: this.requireOAuth ? 'authorization-required' : 'connected',
          });
        });
        break;
      case 'disconnect-server':
        queueMicrotask(() => {
          this.send({
            type: 'connection-state',
            launchId: message.launchId,
            requestId: message.requestId,
            serverId: message.serverId,
            connectionId: message.connectionId,
            state: 'disconnected',
          });
        });
        break;
      case 'list-tools':
        queueMicrotask(() => {
          this.send({
            type: 'tools-result',
            launchId: message.launchId,
            requestId: message.requestId,
            serverId: message.serverId,
            tools: [
              {
                name: 'read_data',
                description: 'Read test data',
                inputSchema: { type: 'object' },
                annotations: { readOnlyHint: true },
              },
            ],
          });
        });
        break;
      case 'list-resources':
        queueMicrotask(() => {
          this.send({
            type: 'resources-result',
            launchId: message.launchId,
            requestId: message.requestId,
            serverId: message.serverId,
            resources: [
              {
                uri: 'file:///workspace/README.md',
                name: 'README',
                mimeType: 'text/markdown',
              },
            ],
          });
        });
        break;
      case 'list-resource-templates':
        queueMicrotask(() => {
          this.send({
            type: 'resource-templates-result',
            launchId: message.launchId,
            requestId: message.requestId,
            serverId: message.serverId,
            resourceTemplates: [
              {
                uriTemplate: 'file:///workspace/{path}',
                name: 'Workspace file',
              },
            ],
          });
        });
        break;
      case 'read-resource':
        queueMicrotask(() => {
          this.send({
            type: 'resource-read-result',
            launchId: message.launchId,
            requestId: message.requestId,
            serverId: message.serverId,
            uri: message.uri,
            result: {
              contents: [{ uri: message.uri, text: '# README' }],
            },
          });
        });
        break;
      case 'list-prompts':
        queueMicrotask(() => {
          this.send({
            type: 'prompts-result',
            launchId: message.launchId,
            requestId: message.requestId,
            serverId: message.serverId,
            prompts: [
              {
                name: 'review',
                arguments: [{ name: 'focus', required: false }],
              },
            ],
          });
        });
        break;
      case 'get-prompt':
        queueMicrotask(() => {
          this.send({
            type: 'prompt-result',
            launchId: message.launchId,
            requestId: message.requestId,
            serverId: message.serverId,
            promptName: message.promptName,
            result: {
              messages: [
                {
                  role: 'user',
                  content: { type: 'text', text: 'Review the code' },
                },
              ],
            },
          });
        });
        break;
      case 'call-tool':
        if (this.ignoreToolCalls) break;
        queueMicrotask(() => {
          this.send({
            type: 'tool-call-result',
            launchId: message.launchId,
            requestId: message.requestId,
            serverId: message.serverId,
            toolName: message.toolName,
            result: { content: [{ type: 'text', text: 'ok' }] },
          });
        });
        break;
      case 'finish-oauth':
        queueMicrotask(() => {
          this.send({
            type: 'oauth-finish-result',
            launchId: message.launchId,
            requestId: message.requestId,
            serverId: message.serverId,
          });
        });
        break;
      case 'shutdown':
        queueMicrotask(() => {
          this.send({
            type: 'shutdown-complete',
            launchId: message.launchId,
            requestId: message.requestId,
          });
          this.exit(0);
        });
        break;
      case 'cancel-request':
      case 'ping':
      case 'oauth-rpc-result':
      case 'elicitation-rpc-result':
        break;
    }
  }

  public send(message: McpHostToMainMessage): void {
    this.emit('message', message);
  }

  public sendReady(launchId?: string): void {
    const initialize = this.messages.find(
      (message) => message.type === 'initialize',
    );
    const activeLaunchId =
      launchId ??
      (initialize?.type === 'initialize' ? initialize.launchId : undefined);
    if (!activeLaunchId) throw new Error('MCP host was not initialized');
    this.send({
      type: 'ready',
      protocolVersion: MCP_HOST_PROTOCOL_VERSION,
      launchId: activeLaunchId,
      pid: this.pid ?? 0,
      startedAt: Date.now(),
    });
  }

  public exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code);
    this.pid = undefined;
  }
}

class Harness {
  public readonly children: FakeUtilityProcess[] = [];
  public autoReady = true;
  public autoConnect = true;
  public readonly fork = vi.fn(
    (_modulePath: string, _args: string[], _options: Electron.ForkOptions) => {
      const child = new FakeUtilityProcess(20_000 + this.children.length);
      child.autoReady = this.autoReady;
      child.autoConnect = this.autoConnect;
      this.children.push(child);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  );
}

const supervisors: McpHostSupervisor[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(async () => {
  delete process.env.MCP_SUPERVISOR_TEST_SECRET;
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.teardown();
  }
  await flushMicrotasks();
  vi.useRealTimers();
});

describe('McpHostSupervisor', () => {
  it('starts with a versioned handshake', async () => {
    process.env.MCP_SUPERVISOR_TEST_SECRET = 'must-not-be-inherited';
    const harness = new Harness();
    const supervisor = await createSupervisor(harness);
    const child = harness.children[0];

    expect(supervisor.processStatus).toBe('ready');
    expect(supervisor.pid).toBe(child?.pid);
    expect(child?.messages[0]).toMatchObject({
      type: 'initialize',
      protocolVersion: MCP_HOST_PROTOCOL_VERSION,
    });
    const forkOptions = harness.fork.mock.calls[0]?.[2];
    expect(forkOptions?.env).not.toHaveProperty('MCP_SUPERVISOR_TEST_SECRET');
    delete process.env.MCP_SUPERVISOR_TEST_SECRET;
  });

  it('connects, lists tools, and calls tools through typed requests', async () => {
    const harness = new Harness();
    const supervisor = await createSupervisor(harness);

    await supervisor.connectServer('local-test', {
      type: 'stdio',
      command: '/usr/local/bin/example-mcp',
      args: [],
      env: { PATH: '/usr/bin' },
    });
    await expect(supervisor.listTools('local-test')).resolves.toEqual([
      expect.objectContaining({ name: 'read_data' }),
    ]);
    await expect(
      supervisor.callTool('local-test', 'read_data', {}),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
    });
    await expect(supervisor.listResources('local-test')).resolves.toEqual({
      resources: [expect.objectContaining({ name: 'README' })],
      nextCursor: undefined,
    });
    await expect(
      supervisor.listResourceTemplates('local-test'),
    ).resolves.toEqual({
      resourceTemplates: [expect.objectContaining({ name: 'Workspace file' })],
      nextCursor: undefined,
    });
    await expect(
      supervisor.readResource('local-test', 'file:///workspace/README.md'),
    ).resolves.toEqual({
      contents: [{ uri: 'file:///workspace/README.md', text: '# README' }],
    });
    await expect(supervisor.listPrompts('local-test')).resolves.toEqual({
      prompts: [expect.objectContaining({ name: 'review' })],
      nextCursor: undefined,
    });
    await expect(
      supervisor.getPrompt('local-test', 'review', { focus: 'security' }),
    ).resolves.toEqual({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: 'Review the code' },
        },
      ],
    });
  });

  it('serializes connection generations and suppresses stale completion state', async () => {
    const harness = new Harness();
    const onConnectionState = vi.fn();
    const supervisor = await createSupervisor(harness, { onConnectionState });
    const child = harness.children[0]!;
    child.autoConnect = false;

    const first = supervisor.connectServer('local-test', {
      type: 'stdio',
      command: '/usr/local/bin/connection-a',
      args: [],
      env: {},
    });
    const firstRejection = expect(first).rejects.toThrow(
      'connection was superseded',
    );
    await flushMicrotasks();
    const firstRequest = child.messages.find(
      (message) => message.type === 'connect-server',
    );
    expect(firstRequest?.type).toBe('connect-server');

    const second = supervisor.connectServer('local-test', {
      type: 'stdio',
      command: '/usr/local/bin/connection-b',
      args: [],
      env: {},
    });
    await flushMicrotasks();
    expect(
      child.messages.filter((message) => message.type === 'connect-server'),
    ).toHaveLength(1);

    if (firstRequest?.type !== 'connect-server') {
      throw new Error('Missing first connection request');
    }
    child.send({
      type: 'connection-state',
      launchId: firstRequest.launchId,
      requestId: firstRequest.requestId,
      serverId: firstRequest.serverId,
      connectionId: firstRequest.connectionId,
      state: 'connected',
    });
    await firstRejection;
    await flushMicrotasks();

    const connectRequests = child.messages.filter(
      (message) => message.type === 'connect-server',
    );
    expect(connectRequests).toHaveLength(2);
    expect(onConnectionState).not.toHaveBeenCalledWith(
      'local-test',
      'connected',
      undefined,
    );
    const secondRequest = connectRequests[1];
    if (secondRequest?.type !== 'connect-server') {
      throw new Error('Missing second connection request');
    }
    child.send({
      type: 'connection-state',
      launchId: secondRequest.launchId,
      requestId: secondRequest.requestId,
      serverId: secondRequest.serverId,
      connectionId: secondRequest.connectionId,
      state: 'connected',
    });

    await expect(second).resolves.toBe('connected');
    expect(onConnectionState).toHaveBeenCalledTimes(1);
    expect(onConnectionState).toHaveBeenCalledWith(
      'local-test',
      'connected',
      undefined,
    );
  });

  it('runs the dispatch fence after readiness and immediately before tool IPC', async () => {
    const harness = new Harness();
    const supervisor = await createSupervisor(harness);
    const child = harness.children[0]!;
    const beforeDispatch = vi.fn(() => {
      expect(
        child.messages.some((message) => message.type === 'call-tool'),
      ).toBe(false);
    });

    await expect(
      supervisor.callTool('local-test', 'read_data', {}, { beforeDispatch }),
    ).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
    });

    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    const request = child.messages.find(
      (message) => message.type === 'call-tool',
    );
    expect(request).toBeDefined();
    expect(request).not.toHaveProperty('beforeDispatch');
  });

  it('rechecks the dispatch fence after waiting for host readiness', async () => {
    const harness = new Harness();
    const supervisor = await createSupervisor(harness);
    harness.autoReady = false;
    harness.children[0]!.exit(1);

    let revoked = false;
    const beforeDispatch = vi.fn(() => {
      if (revoked) throw new Error('Host generation was revoked');
    });
    const result = supervisor.callTool(
      'local-test',
      'read_data',
      {},
      { beforeDispatch },
    );
    const rejection = expect(result).rejects.toThrow(
      'Host generation was revoked',
    );

    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();
    const restarted = harness.children[1]!;
    expect(restarted).toBeDefined();
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(
      restarted.messages.some((message) => message.type === 'call-tool'),
    ).toBe(false);

    revoked = true;
    restarted.sendReady();
    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    expect(
      restarted.messages.some((message) => message.type === 'call-tool'),
    ).toBe(false);
  });

  it('proxies OAuth storage requests to the trusted main-process handler', async () => {
    const harness = new Harness();
    const onOAuthRequest = vi.fn(async () => ({ access_token: 'secret' }));
    await createSupervisor(harness, { onOAuthRequest });
    const child = harness.children[0]!;
    child.send({
      type: 'oauth-rpc-request',
      launchId: child.messages[0]!.launchId,
      authRequestId: 'auth-request-1',
      serverId: 'remote-test',
      request: { operation: 'load-tokens' },
    });
    await flushMicrotasks();

    expect(onOAuthRequest).toHaveBeenCalledWith('remote-test', {
      operation: 'load-tokens',
    });
    expect(child.messages).toContainEqual(
      expect.objectContaining({
        type: 'oauth-rpc-result',
        authRequestId: 'auth-request-1',
        ok: true,
        value: { access_token: 'secret' },
      }),
    );
  });

  it('forwards typed tools, resources, and prompts list-changed events', async () => {
    const harness = new Harness();
    const onListChanged = vi.fn();
    const supervisor = await createSupervisor(harness, { onListChanged });
    const child = harness.children[0]!;
    const launchId = child.messages[0]!.launchId;
    await supervisor.connectServer('local-test', {
      type: 'stdio',
      command: '/usr/local/bin/mcp-test',
      args: [],
      env: {},
    });
    const connection = child.messages
      .filter((message) => message.type === 'connect-server')
      .at(-1);
    if (connection?.type !== 'connect-server') {
      throw new Error('Missing active connection identity');
    }

    child.send({
      type: 'list-changed',
      launchId,
      serverId: 'local-test',
      connectionId: connection.connectionId,
      kind: 'tools',
      tools: [{ name: 'catalog_echo', inputSchema: { type: 'object' } }],
    });
    child.send({
      type: 'list-changed',
      launchId,
      serverId: 'local-test',
      connectionId: connection.connectionId,
      kind: 'resources',
      resources: [
        { uri: 'smoke://fixture/catalog-status', name: 'Catalog status' },
      ],
    });
    child.send({
      type: 'list-changed',
      launchId,
      serverId: 'local-test',
      connectionId: connection.connectionId,
      kind: 'prompts',
      prompts: [{ name: 'catalog-review' }],
    });
    await flushMicrotasks();

    expect(onListChanged).toHaveBeenNthCalledWith(1, 'local-test', 'tools', [
      expect.objectContaining({ name: 'catalog_echo' }),
    ]);
    expect(onListChanged).toHaveBeenNthCalledWith(
      2,
      'local-test',
      'resources',
      [expect.objectContaining({ name: 'Catalog status' })],
    );
    expect(onListChanged).toHaveBeenNthCalledWith(3, 'local-test', 'prompts', [
      expect.objectContaining({ name: 'catalog-review' }),
    ]);
  });

  it('drops stale close and list-changed events from a superseded connection token', async () => {
    const harness = new Harness();
    const onConnectionState = vi.fn();
    const onListChanged = vi.fn();
    const supervisor = await createSupervisor(harness, {
      onConnectionState,
      onListChanged,
    });
    const child = harness.children[0]!;
    child.autoConnect = false;

    const first = supervisor.connectServer('local-test', {
      type: 'stdio',
      command: '/usr/local/bin/connection-a',
      args: [],
      env: {},
    });
    await flushMicrotasks();
    const firstRequest = child.messages.find(
      (message) => message.type === 'connect-server',
    );
    if (firstRequest?.type !== 'connect-server') {
      throw new Error('Missing first connection request');
    }
    child.send({
      type: 'connection-state',
      launchId: firstRequest.launchId,
      requestId: firstRequest.requestId,
      serverId: firstRequest.serverId,
      connectionId: firstRequest.connectionId,
      state: 'connected',
    });
    await first;

    const second = supervisor.connectServer('local-test', {
      type: 'stdio',
      command: '/usr/local/bin/connection-b',
      args: [],
      env: {},
    });
    await flushMicrotasks();
    const secondRequest = child.messages
      .filter((message) => message.type === 'connect-server')
      .at(-1);
    if (secondRequest?.type !== 'connect-server') {
      throw new Error('Missing second connection request');
    }
    child.send({
      type: 'connection-state',
      launchId: secondRequest.launchId,
      requestId: secondRequest.requestId,
      serverId: secondRequest.serverId,
      connectionId: secondRequest.connectionId,
      state: 'connected',
    });
    await second;
    onConnectionState.mockClear();
    onListChanged.mockClear();

    child.send({
      type: 'connection-state',
      launchId: firstRequest.launchId,
      serverId: firstRequest.serverId,
      connectionId: firstRequest.connectionId,
      state: 'disconnected',
    });
    child.send({
      type: 'list-changed',
      launchId: firstRequest.launchId,
      serverId: firstRequest.serverId,
      connectionId: firstRequest.connectionId,
      kind: 'tools',
      tools: [{ name: 'stale_tool', inputSchema: { type: 'object' } }],
    });
    child.send({
      type: 'list-changed',
      launchId: secondRequest.launchId,
      serverId: secondRequest.serverId,
      connectionId: secondRequest.connectionId,
      kind: 'tools',
      tools: [{ name: 'current_tool', inputSchema: { type: 'object' } }],
    });
    await flushMicrotasks();

    expect(onConnectionState).not.toHaveBeenCalled();
    expect(onListChanged).toHaveBeenCalledTimes(1);
    expect(onListChanged).toHaveBeenCalledWith('local-test', 'tools', [
      expect.objectContaining({ name: 'current_tool' }),
    ]);
  });

  it('round-trips form elicitation through the trusted main handler', async () => {
    const harness = new Harness();
    const onElicitationRequest = vi.fn(async () => ({
      action: 'accept' as const,
      content: { environment: 'staging' },
    }));
    const supervisor = await createSupervisor(harness, {
      onElicitationRequest,
    });
    const child = harness.children[0]!;
    child.send({
      type: 'elicitation-rpc-request',
      launchId: child.messages[0]!.launchId,
      elicitationRequestId: 'elicitation-1',
      serverId: 'local-test',
      agentInstanceId: 'agent-1',
      request: {
        message: 'Choose an environment.',
        fields: [
          {
            id: 'environment',
            kind: 'select',
            label: 'Environment',
            required: true,
            options: [{ value: 'staging', label: 'Staging' }],
          },
        ],
      },
    });
    await flushMicrotasks();

    expect(onElicitationRequest).toHaveBeenCalledWith(
      'local-test',
      'agent-1',
      expect.objectContaining({ message: 'Choose an environment.' }),
      expect.any(AbortSignal),
    );
    expect(child.messages).toContainEqual({
      type: 'elicitation-rpc-result',
      launchId: child.messages[0]!.launchId,
      elicitationRequestId: 'elicitation-1',
      ok: true,
      result: {
        action: 'accept',
        content: { environment: 'staging' },
      },
    });
    await supervisor.callTool(
      'local-test',
      'read_data',
      {},
      { agentInstanceId: 'agent-1' },
    );
    expect(child.messages).toContainEqual(
      expect.objectContaining({
        type: 'call-tool',
        agentInstanceId: 'agent-1',
      }),
    );
  });

  it('aborts a pending main-process elicitation after host cancellation', async () => {
    const harness = new Harness();
    const receivedSignals: AbortSignal[] = [];
    await createSupervisor(harness, {
      onElicitationRequest: async (
        _serverId,
        _agentInstanceId,
        _request,
        signal,
      ) => {
        receivedSignals.push(signal);
        return await new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => resolve({ action: 'cancel' }),
            { once: true },
          );
        });
      },
    });
    const child = harness.children[0]!;
    const launchId = child.messages[0]!.launchId;
    child.send({
      type: 'elicitation-rpc-request',
      launchId,
      elicitationRequestId: 'elicitation-1',
      serverId: 'local-test',
      agentInstanceId: 'agent-1',
      request: {
        message: 'Confirm.',
        fields: [
          {
            id: 'confirm',
            kind: 'boolean',
            label: 'Confirm',
            required: false,
          },
        ],
      },
    });
    await flushMicrotasks();
    child.send({
      type: 'elicitation-rpc-cancel',
      launchId,
      elicitationRequestId: 'elicitation-1',
      serverId: 'local-test',
    });
    await flushMicrotasks();

    expect(receivedSignals[0]?.aborted).toBe(true);
    expect(
      child.messages.some(
        (message) =>
          message.type === 'elicitation-rpc-result' &&
          message.elicitationRequestId === 'elicitation-1',
      ),
    ).toBe(false);
  });

  it('returns authorization-required as a terminal connect result', async () => {
    const harness = new Harness();
    const supervisor = await createSupervisor(harness);
    harness.children[0]!.requireOAuth = true;

    await expect(
      supervisor.connectServer('remote-oauth', {
        type: 'streamable-http',
        url: 'https://mcp.example.com/rpc',
        headers: {},
        oauth: {
          clientRegistrationId: 'clodex-dynamic',
          redirectUrl: 'clodex-ide://mcp/oauth/callback',
          scopes: [],
          clientMetadata: {
            redirect_uris: ['clodex-ide://mcp/oauth/callback'],
          },
          allowedAuthorizationOrigins: ['https://mcp.example.com'],
        },
      }),
    ).resolves.toBe('authorization-required');
  });

  it('restarts after a crash and restores desired servers', async () => {
    const harness = new Harness();
    const supervisor = await createSupervisor(harness);
    await supervisor.connectServer('local-test', {
      type: 'stdio',
      command: '/usr/local/bin/example-mcp',
      args: [],
      env: { PATH: '/usr/bin' },
    });

    harness.children[0]?.exit(1);
    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();

    const restarted = harness.children[1];
    expect(restarted).toBeDefined();
    await flushMicrotasks();
    expect(
      restarted?.messages.some(
        (message) =>
          message.type === 'connect-server' &&
          message.serverId === 'local-test',
      ),
    ).toBe(true);
  });

  it('cannot let a stale restore overwrite a newer explicit connection', async () => {
    const harness = new Harness();
    const onConnectionState = vi.fn();
    const supervisor = await createSupervisor(harness, { onConnectionState });
    await supervisor.connectServer('local-test', {
      type: 'stdio',
      command: '/usr/local/bin/connection-a',
      args: [],
      env: {},
    });
    onConnectionState.mockClear();

    harness.autoConnect = false;
    harness.children[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();
    const restarted = harness.children[1]!;
    const restoreRequest = restarted.messages.find(
      (message) => message.type === 'connect-server',
    );
    if (restoreRequest?.type !== 'connect-server') {
      throw new Error('Missing restore connection request');
    }

    const explicitConnection = supervisor.connectServer('local-test', {
      type: 'stdio',
      command: '/usr/local/bin/connection-b',
      args: [],
      env: {},
    });
    const explicitResolution =
      expect(explicitConnection).resolves.toBe('connected');
    await flushMicrotasks();
    expect(
      restarted.messages.filter((message) => message.type === 'connect-server'),
    ).toHaveLength(1);

    restarted.send({
      type: 'connection-state',
      launchId: restoreRequest.launchId,
      requestId: restoreRequest.requestId,
      serverId: restoreRequest.serverId,
      connectionId: restoreRequest.connectionId,
      state: 'connected',
    });
    for (let index = 0; index < 10; index += 1) {
      await flushMicrotasks();
      if (
        restarted.messages.filter(
          (message) => message.type === 'connect-server',
        ).length === 2
      ) {
        break;
      }
    }
    const connectRequests = restarted.messages.filter(
      (message) => message.type === 'connect-server',
    );
    expect(connectRequests).toHaveLength(2);
    expect(onConnectionState).not.toHaveBeenCalledWith(
      'local-test',
      'connected',
      undefined,
    );

    const explicitRequest = connectRequests[1];
    if (explicitRequest?.type !== 'connect-server') {
      throw new Error('Missing explicit connection request');
    }
    restarted.send({
      type: 'connection-state',
      launchId: explicitRequest.launchId,
      requestId: explicitRequest.requestId,
      serverId: explicitRequest.serverId,
      connectionId: explicitRequest.connectionId,
      state: 'connected',
    });
    await explicitResolution;
    expect(onConnectionState).toHaveBeenCalledTimes(1);
    expect(onConnectionState).toHaveBeenCalledWith(
      'local-test',
      'connected',
      undefined,
    );
  });

  it('attaches and revokes a scoped proxy for remote transports', async () => {
    const harness = new Harness();
    const revokeNetworkProxy = vi.fn();
    const supervisor = await createSupervisor(harness, {
      resolveNetworkProxy: (serverId, transport) =>
        transport.type === 'stdio'
          ? undefined
          : {
              url: 'http://127.0.0.1:4319',
              authorization: `Basic ${serverId}`,
            },
      revokeNetworkProxy,
    });

    await supervisor.connectServer('remote-test', {
      type: 'streamable-http',
      url: 'https://mcp.example.com',
      headers: {},
    });

    expect(
      harness.children[0]?.messages.find(
        (message) =>
          message.type === 'connect-server' &&
          message.serverId === 'remote-test',
      ),
    ).toMatchObject({
      networkProxy: {
        url: 'http://127.0.0.1:4319',
        authorization: 'Basic remote-test',
      },
    });

    await supervisor.disconnectServer('remote-test');
    expect(revokeNetworkProxy).toHaveBeenCalledWith('remote-test', {
      url: 'http://127.0.0.1:4319',
      authorization: 'Basic remote-test',
    });
  });

  it('cancels an in-flight tool call when the caller aborts', async () => {
    const harness = new Harness();
    const supervisor = await createSupervisor(harness);
    const child = harness.children[0];
    child!.ignoreToolCalls = true;

    const controller = new AbortController();
    const result = supervisor.callTool(
      'local-test',
      'slow',
      {},
      { timeoutMs: 10_000, signal: controller.signal },
    );
    await flushMicrotasks();
    const request = child?.messages.find(
      (message) => message.type === 'call-tool',
    );
    const rejection = expect(result).rejects.toMatchObject({
      name: 'AbortError',
    });
    controller.abort();
    await rejection;
    expect(child?.messages).toContainEqual(
      expect.objectContaining({
        type: 'cancel-request',
        requestId:
          request?.type === 'call-tool' ? request.requestId : undefined,
      }),
    );
  });

  it('times out an unresponsive tool call and sends cancellation', async () => {
    const harness = new Harness();
    const supervisor = await createSupervisor(harness);
    const child = harness.children[0];
    child!.ignoreToolCalls = true;

    const result = supervisor.callTool(
      'local-test',
      'slow',
      {},
      { timeoutMs: 100 },
    );
    await flushMicrotasks();
    const request = child?.messages.find(
      (message) => message.type === 'call-tool',
    );
    const rejection = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(2_100);
    await rejection;
    expect(child?.messages).toContainEqual(
      expect.objectContaining({
        type: 'cancel-request',
        requestId:
          request?.type === 'call-tool' ? request.requestId : undefined,
      }),
    );
  });
});

async function createSupervisor(
  harness: Harness,
  options: Partial<Parameters<typeof McpHostSupervisor.create>[1]> = {},
): Promise<McpHostSupervisor> {
  const promise = McpHostSupervisor.create(logger, {
    fork: harness.fork,
    readyTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    restartBaseDelayMs: 250,
    ...options,
  });
  await flushMicrotasks();
  const supervisor = await promise;
  supervisors.push(supervisor);
  return supervisor;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
