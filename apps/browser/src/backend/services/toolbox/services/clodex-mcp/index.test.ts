import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from '@/services/auth';
import type { Logger } from '@/services/logger';
import type { GuardianAssessment } from '@shared/guardian';

const connectMock = vi.fn();
const listToolsMock = vi.fn();
const callToolMock = vi.fn();
const closeMock = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: connectMock,
    listTools: listToolsMock,
    callTool: callToolMock,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation(() => ({
    close: closeMock,
  })),
}));

import { ClodexMcpService } from './index';

function makeAuthService(token: string | undefined = 'ide-token'): AuthService {
  return {
    ensureModelAccessToken: vi.fn(async () => token),
  } as unknown as AuthService;
}

function makeAuthServiceWithoutToken(): AuthService {
  return {
    ensureModelAccessToken: vi.fn(async () => undefined),
  } as unknown as AuthService;
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

const objectSchema = {
  type: 'object' as const,
  properties: {
    host: { type: 'string' },
  },
  required: ['host'],
};

describe('ClodexMcpService', () => {
  beforeEach(() => {
    connectMock.mockReset();
    connectMock.mockResolvedValue(undefined);
    listToolsMock.mockReset();
    callToolMock.mockReset();
    closeMock.mockReset();
  });

  it('does not request a token or connect before Clodex is selected', async () => {
    const authService = makeAuthService();
    const service = new ClodexMcpService({
      authService,
      logger: makeLogger(),
      gatewayUrl: 'https://clodex.xyz/tools-gateway/mcp',
      isEnabled: () => false,
    });

    await expect(service.getTools('agent-1')).resolves.toEqual({});
    expect(authService.ensureModelAccessToken).not.toHaveBeenCalled();
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('registers read-only tools and explicitly approved destructive tools for the MVP', async () => {
    listToolsMock.mockResolvedValueOnce({
      tools: [
        {
          name: 'tcp_check',
          description: 'Check a TCP port from Clodex cloud.',
          inputSchema: objectSchema,
          annotations: { readOnlyHint: true },
        },
        {
          name: 'ssh_exec',
          description: 'Execute a command over SSH.',
          inputSchema: objectSchema,
          annotations: { destructiveHint: true },
        },
        {
          name: 'write_remote_file',
          description: 'Mutates remote state.',
          inputSchema: objectSchema,
          annotations: { destructiveHint: true },
        },
      ],
    });

    const service = new ClodexMcpService({
      authService: makeAuthService(),
      logger: makeLogger(),
      gatewayUrl: 'https://clodex.xyz/tools-gateway/mcp',
    });

    const tools = await service.getTools('agent-1');

    expect(Object.keys(tools).sort()).toEqual([
      'mcp_clodex_ssh_exec',
      'mcp_clodex_tcp_check',
    ]);
    expect(tools.mcp_clodex_write_remote_file).toBeUndefined();
  });

  it('requires approval before executing ssh_exec and records a UI explanation', async () => {
    listToolsMock.mockResolvedValueOnce({
      tools: [
        {
          name: 'ssh_exec',
          description: 'Execute a command over SSH.',
          inputSchema: objectSchema,
          annotations: { destructiveHint: true },
        },
      ],
    });
    const recordPendingApproval = vi.fn();

    const service = new ClodexMcpService({
      authService: makeAuthService(),
      logger: makeLogger(),
      gatewayUrl: 'https://clodex.xyz/tools-gateway/mcp',
      recordPendingApproval,
    });

    const tools = await service.getTools('agent-1');
    const sshExec = tools.mcp_clodex_ssh_exec as any;

    await expect(
      sshExec.needsApproval({ host: 'example.com' }, { toolCallId: 'tc_1' }),
    ).resolves.toBe(true);
    expect(recordPendingApproval).toHaveBeenCalledWith(
      'agent-1',
      'tc_1',
      expect.stringContaining('remote SSH command'),
    );
  });

  it('does not require approval for tcp_check', async () => {
    listToolsMock.mockResolvedValueOnce({
      tools: [
        {
          name: 'tcp_check',
          description: 'Check a TCP port from Clodex cloud.',
          inputSchema: objectSchema,
          annotations: { readOnlyHint: true },
        },
      ],
    });
    const recordPendingApproval = vi.fn();

    const service = new ClodexMcpService({
      authService: makeAuthService(),
      logger: makeLogger(),
      gatewayUrl: 'https://clodex.xyz/tools-gateway/mcp',
      recordPendingApproval,
    });

    const tools = await service.getTools('agent-1');
    const tcpCheck = tools.mcp_clodex_tcp_check as any;

    await expect(
      tcpCheck.needsApproval({ host: 'clodex.xyz' }, { toolCallId: 'tc_1' }),
    ).resolves.toBe(false);
    expect(recordPendingApproval).not.toHaveBeenCalled();
  });

  it('routes MCP approval through content-free Guardian context', async () => {
    listToolsMock.mockResolvedValueOnce({
      tools: [
        {
          name: 'ssh_exec',
          description: 'Execute a command over SSH.',
          inputSchema: objectSchema,
          annotations: { destructiveHint: true },
        },
      ],
    });
    const assessGuardian = vi.fn(async () => ({
      kind: 'mcp' as const,
      summary: 'Run a remote MCP tool',
      risk: 'critical' as const,
      decision: 'escalate' as const,
      irreversible: true,
      evidence: ['remote-target' as const, 'irreversible' as const],
      explanation: 'Remote execution requires explicit human approval.',
    }));
    const recordPendingApproval = vi.fn();
    const service = new ClodexMcpService({
      authService: makeAuthService(),
      logger: makeLogger(),
      assessGuardian,
      recordPendingApproval,
    });

    const tools = await service.getTools('agent-1');
    const sshExec = tools.mcp_clodex_ssh_exec as any;
    await expect(
      sshExec.needsApproval(
        { host: 'secret.example.com', command: 'private command' },
        { toolCallId: 'tc_1' },
      ),
    ).resolves.toBe(true);

    expect(assessGuardian).toHaveBeenCalledWith({
      kind: 'mcp',
      summary: 'Run a remote MCP tool',
      readOnly: false,
      irreversible: true,
      context: {
        resourceScope: 'remote',
        targetTrust: 'known-remote',
        operation: 'execute',
        capabilities: ['network', 'remote-execution', 'delete'],
      },
    });
    expect(JSON.stringify(assessGuardian.mock.calls)).not.toContain(
      'secret.example.com',
    );
    expect(JSON.stringify(assessGuardian.mock.calls)).not.toContain(
      'private command',
    );
    expect(recordPendingApproval).toHaveBeenCalledWith(
      'agent-1',
      'tc_1',
      'Remote execution requires explicit human approval.',
    );
  });

  it('blocks an MCP tool when Guardian denies it', async () => {
    listToolsMock.mockResolvedValueOnce({
      tools: [
        {
          name: 'tcp_check',
          description: 'Check a TCP port from Clodex cloud.',
          inputSchema: objectSchema,
          annotations: { readOnlyHint: true },
        },
      ],
    });
    const deniedAssessment: GuardianAssessment = {
      kind: 'mcp',
      summary: 'Run a read-only remote MCP tool',
      risk: 'critical',
      decision: 'deny',
      irreversible: false,
      evidence: ['policy-change'],
      explanation: 'Guardian policy blocked this remote action.',
    };
    const service = new ClodexMcpService({
      authService: makeAuthService(),
      logger: makeLogger(),
      assessGuardian: vi.fn(async () => deniedAssessment),
    });

    const tools = await service.getTools('agent-1');
    const tcpCheck = tools.mcp_clodex_tcp_check as any;
    await expect(
      tcpCheck.needsApproval({ host: 'clodex.xyz' }, { toolCallId: 'tc_1' }),
    ).rejects.toThrow('Guardian denied action');
  });

  it('executes a safe MCP tool through the connected gateway client', async () => {
    listToolsMock.mockResolvedValueOnce({
      tools: [
        {
          name: 'tcp_check',
          description: 'Check a TCP port from Clodex cloud.',
          inputSchema: objectSchema,
          annotations: { readOnlyHint: true },
        },
      ],
    });
    callToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'tcp open' }],
    });

    const service = new ClodexMcpService({
      authService: makeAuthService(),
      logger: makeLogger(),
      gatewayUrl: 'https://clodex.xyz/tools-gateway/mcp',
    });

    const tools = await service.getTools('agent-1');
    const result = await (tools.mcp_clodex_tcp_check as any).execute({
      host: 'clodex.xyz',
    });

    expect(callToolMock).toHaveBeenCalledWith(
      {
        name: 'tcp_check',
        arguments: { host: 'clodex.xyz' },
      },
      undefined,
      { timeout: 60_000 },
    );
    expect(result.message).toBe('Clodex cloud tool tcp_check completed.');
    expect(result.result.content).toEqual(['tcp open']);
  });

  it('caches listed tools for the active Clodex token', async () => {
    listToolsMock.mockResolvedValueOnce({
      tools: [
        {
          name: 'tcp_check',
          description: 'Check a TCP port from Clodex cloud.',
          inputSchema: objectSchema,
          annotations: { readOnlyHint: true },
        },
      ],
    });

    const service = new ClodexMcpService({
      authService: makeAuthService('token-a'),
      logger: makeLogger(),
    });

    await service.getTools('agent-1');
    await service.getTools('agent-2');

    expect(listToolsMock).toHaveBeenCalledTimes(1);
  });

  it('returns no tools when there is no active Clodex model token', async () => {
    const service = new ClodexMcpService({
      authService: makeAuthServiceWithoutToken(),
      logger: makeLogger(),
    });

    await expect(service.getTools('agent-1')).resolves.toEqual({});
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('reports signed-out capability status without connecting', async () => {
    const service = new ClodexMcpService({
      authService: makeAuthServiceWithoutToken(),
      logger: makeLogger(),
      gatewayUrl:
        'https://user:secret@clodex.xyz/tools-gateway/mcp?token=hidden',
    });

    const status = await service.getCapabilityStatus();

    expect(status.state).toBe('signed-out');
    expect(status.gatewayUrl).toBe('https://clodex.xyz/tools-gateway/mcp');
    expect(status.tools).toEqual([]);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('returns safe MCP tool metadata for the settings capability view', async () => {
    listToolsMock.mockResolvedValueOnce({
      tools: [
        {
          name: 'ssh_exec',
          description: 'Execute a command over SSH.',
          inputSchema: {
            type: 'object',
            properties: {
              host: {
                type: 'string',
                description: 'Remote host name.',
              },
              command: { type: 'string' },
            },
            required: ['host', 'command'],
          },
          annotations: { destructiveHint: true },
        },
      ],
    });

    const service = new ClodexMcpService({
      authService: makeAuthService(),
      logger: makeLogger(),
    });

    const status = await service.getCapabilityStatus();

    expect(status.state).toBe('connected');
    expect(status.tools).toEqual([
      expect.objectContaining({
        id: 'mcp_clodex_ssh_exec',
        name: 'ssh_exec',
        requiresApproval: true,
        destructive: true,
        inputFields: [
          {
            name: 'host',
            type: 'string',
            required: true,
            description: 'Remote host name.',
          },
          {
            name: 'command',
            type: 'string',
            required: true,
            description: undefined,
          },
        ],
      }),
    ]);
    expect(status.cacheExpiresAt).toBeInstanceOf(Date);
  });
});
