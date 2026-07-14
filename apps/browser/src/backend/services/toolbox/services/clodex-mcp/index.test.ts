import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from '@/services/auth';
import type { Logger } from '@/services/logger';
import type { GuardianAssessment } from '@shared/guardian';
import {
  bindTrustedMcpFinalAuthorityToFence,
  createTrustedMcpFenceAuthority,
} from '@/services/mcp/trusted-dispatch-gateway';

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

  it('registers only the host-maintained read-only allowlist for the MVP', async () => {
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

    expect(Object.keys(tools)).toEqual(['mcp_clodex_tcp_check']);
    expect(tools.mcp_clodex_ssh_exec).toBeUndefined();
    expect(tools.mcp_clodex_write_remote_file).toBeUndefined();
  });

  it('withholds ssh_exec until the SDK exposes an atomic before-send hook', async () => {
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
    expect(tools.mcp_clodex_ssh_exec).toBeUndefined();
    expect(recordPendingApproval).not.toHaveBeenCalled();
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

  it('routes Guardian escalation through content-free approval context', async () => {
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
    const stageApproval = vi.fn(async () => undefined);
    const service = new ClodexMcpService({
      authService: makeAuthService(),
      logger: makeLogger(),
      assessGuardian,
      recordPendingApproval,
      stageApproval,
    });

    const tools = await service.getTools('agent-1');
    const tcpCheck = tools.mcp_clodex_tcp_check as any;
    await expect(
      tcpCheck.needsApproval(
        { host: 'secret.example.com', port: 443 },
        { toolCallId: 'tc_1' },
      ),
    ).resolves.toBe(true);

    expect(assessGuardian).toHaveBeenCalledWith({
      kind: 'mcp',
      summary: 'Run a read-only remote MCP tool',
      readOnly: true,
      irreversible: false,
      context: {
        resourceScope: 'remote',
        targetTrust: 'known-remote',
        operation: 'inspect',
        capabilities: ['network', 'read'],
      },
    });
    expect(JSON.stringify(assessGuardian.mock.calls)).not.toContain(
      'secret.example.com',
    );
    expect(JSON.stringify(assessGuardian.mock.calls)).not.toContain('443');
    expect(stageApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        agentInstanceId: 'agent-1',
        toolCallId: 'tc_1',
        aiToolName: 'mcp_clodex_tcp_check',
      }),
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

  it('blocks cloud dispatch when the approval lifecycle advances after claim', async () => {
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
    let lifecycleCurrent = true;
    const assertCurrent = vi.fn(
      (_agentInstanceId: string, approvalLifecycleEpoch: number) => {
        if (!lifecycleCurrent || approvalLifecycleEpoch !== 7) {
          throw new Error('approval lifecycle superseded');
        }
      },
    );
    const claimApprovalAuthority = vi.fn(async () => {
      const authority = bindTrustedMcpFinalAuthorityToFence(
        createTrustedMcpFenceAuthority(() => undefined),
        () => assertCurrent('agent-1', 7),
      );
      lifecycleCurrent = false;
      return authority;
    });
    const service = new ClodexMcpService({
      authService: makeAuthService(),
      logger: makeLogger(),
      gatewayUrl: 'https://clodex.xyz/tools-gateway/mcp',
      claimApprovalAuthority,
      assertApprovalLifecycleCurrent: assertCurrent,
    });

    const tools = await service.getTools('agent-1', 7);
    await expect(
      (tools.mcp_clodex_tcp_check as any).execute(
        { host: 'clodex.xyz' },
        { toolCallId: 'tc_1' },
      ),
    ).rejects.toThrow('approval lifecycle superseded');

    expect(claimApprovalAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        agentInstanceId: 'agent-1',
        toolCallId: 'tc_1',
      }),
      7,
    );
    expect(callToolMock).not.toHaveBeenCalled();
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
      gatewayUrl: 'https://clodex.xyz/tools-gateway/mcp',
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
          name: 'tcp_check',
          description: 'Check a TCP port from Clodex cloud.',
          inputSchema: {
            type: 'object',
            properties: {
              host: {
                type: 'string',
                description: 'Remote host name.',
              },
              port: { type: 'number' },
            },
            required: ['host', 'port'],
          },
          annotations: { readOnlyHint: true },
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
        id: 'mcp_clodex_tcp_check',
        name: 'tcp_check',
        requiresApproval: false,
        destructive: false,
        inputFields: [
          {
            name: 'host',
            type: 'string',
            required: true,
            description: 'Remote host name.',
          },
          {
            name: 'port',
            type: 'number',
            required: true,
            description: undefined,
          },
        ],
      }),
    ]);
    expect(status.cacheExpiresAt).toBeInstanceOf(Date);
  });
});
