import { describe, expect, it, vi } from 'vitest';
import type { McpServerConfig, McpToolDescriptor } from '@clodex/mcp-runtime';
import type { McpRegistryService } from './index';
import {
  bindTrustedMcpFinalAuthorityToFence,
  createTrustedMcpDispatchCommitment,
  createTrustedMcpFenceAuthority,
  createTrustedRegistryMcpDescriptorCommitment,
} from './trusted-dispatch-gateway';
import { createRegistryMcpTools } from './tools';

function makeRegistry({
  defaultPolicy = 'ask',
  toolOverride,
  annotations = { readOnlyHint: true },
  source = { kind: 'user' },
}: {
  defaultPolicy?: 'ask' | 'deny' | 'allow-read-only';
  toolOverride?: 'allow' | 'ask' | 'deny';
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  source?: McpServerConfig['source'];
}) {
  const policyTools: Record<string, 'allow' | 'ask' | 'deny'> = toolOverride
    ? { read_data: toolOverride }
    : {};
  const server = {
    id: 'custom',
    displayName: 'Custom MCP',
    enabled: true,
    source,
    transport: {
      type: 'stdio' as const,
      command: '/usr/local/bin/example-mcp',
      args: [],
      env: {},
    },
    policy: {
      default: defaultPolicy,
      tools: policyTools,
    },
  } satisfies McpServerConfig;
  const descriptor = {
    name: 'read_data',
    description: 'Read data',
    inputSchema: { type: 'object' },
    annotations,
  } satisfies McpToolDescriptor;

  return {
    snapshot: () => ({
      schemaVersion: 1 as const,
      servers: {
        custom: server,
      },
    }),
    listTools: vi.fn(async () => [descriptor]),
    getToolDispatchCommitment: vi.fn((serverId: string, toolName: string) => {
      if (serverId !== server.id || toolName !== descriptor.name) {
        throw new Error('Unexpected MCP test commitment request');
      }
      const reviewed = createTrustedRegistryMcpDescriptorCommitment(
        server,
        descriptor,
      );
      if (reviewed.evaluation.policy.decision === 'deny') {
        throw new Error('MCP test policy denied the committed tool');
      }
      return createTrustedMcpDispatchCommitment(reviewed.descriptor, {
        connectionGeneration: 1,
        guardianPolicyRevision: 1,
        serverId,
      });
    }),
    listResources: vi.fn(async () => []),
    listResourceTemplates: vi.fn(async () => []),
    listPrompts: vi.fn(async () => []),
    readResource: vi.fn(async () => ({
      contents: [{ uri: 'file:///README.md', text: '# README' }],
    })),
    getPrompt: vi.fn(async () => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: 'Review this' },
        },
      ],
    })),
    callTool: vi.fn(async () => ({
      content: [{ type: 'text', text: 'ok' }],
    })),
  } as unknown as McpRegistryService & {
    listTools: ReturnType<typeof vi.fn>;
    getToolDispatchCommitment: ReturnType<typeof vi.fn>;
    listResources: ReturnType<typeof vi.fn>;
    listPrompts: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
  };
}

describe('registry MCP tools', () => {
  it('requires approval for custom tools even when the server claims read-only', async () => {
    const registry = makeRegistry({});
    const recordPendingApproval = vi.fn();
    const stageApproval = vi.fn(async () => undefined);
    const tools = await createRegistryMcpTools({
      registry,
      agentInstanceId: 'agent-1',
      recordPendingApproval,
      stageApproval,
    });
    const registered = Object.values(tools);

    expect(registered).toHaveLength(1);
    await expect(
      (registered[0] as any).needsApproval({}, { toolCallId: 'tool-call-1' }),
    ).resolves.toBe(true);
    expect(recordPendingApproval).toHaveBeenCalledWith(
      'tool-call-1',
      expect.stringContaining('Custom MCP/read_data'),
    );
    expect(stageApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        agentInstanceId: 'agent-1',
        aiToolName: expect.stringMatching(/^mcp_custom_read_data_/),
        toolCallId: 'tool-call-1',
      }),
    );
  });

  it('allows an explicitly approved reversible tool', async () => {
    const registry = makeRegistry({ toolOverride: 'allow' });
    const tools = await createRegistryMcpTools({
      registry,
      agentInstanceId: 'agent-1',
    });

    await expect(
      (Object.values(tools)[0] as any).needsApproval(
        {},
        { toolCallId: 'tool-call-1' },
      ),
    ).resolves.toBe(false);
  });

  it('does not let an explicit allow bypass a destructive annotation', async () => {
    const registry = makeRegistry({
      toolOverride: 'allow',
      annotations: { readOnlyHint: true, destructiveHint: true },
    });
    const tools = await createRegistryMcpTools({
      registry,
      agentInstanceId: 'agent-1',
      stageApproval: vi.fn(async () => undefined),
    });

    await expect(
      (Object.values(tools)[0] as any).needsApproval(
        {},
        { toolCallId: 'tool-call-1' },
      ),
    ).resolves.toBe(true);
  });

  it('does not register explicitly denied tools', async () => {
    const registry = makeRegistry({ toolOverride: 'deny' });
    const tools = await createRegistryMcpTools({
      registry,
      agentInstanceId: 'agent-1',
    });
    expect(tools).toEqual({});
  });

  it('executes through the registry and caps the result envelope', async () => {
    const registry = makeRegistry({ toolOverride: 'allow' });
    const tools = await createRegistryMcpTools({
      registry,
      agentInstanceId: 'agent-1',
    });
    const result = await (Object.values(tools)[0] as any).execute({
      query: 'test',
    });

    expect(registry.callTool).toHaveBeenCalledWith(
      'custom',
      'read_data',
      {
        query: 'test',
      },
      expect.objectContaining({
        agentInstanceId: 'agent-1',
        expectedDescriptorCommitment: expect.objectContaining({
          toolName: 'read_data',
        }),
        expectedDispatchCommitment: expect.any(Object),
      }),
    );
    expect(result.message).toContain('Custom MCP/read_data completed');
  });

  it('blocks final registry dispatch when the approval lifecycle advances after claim', async () => {
    const registry = makeRegistry({ toolOverride: 'allow' });
    let lifecycleCurrent = true;
    let effectDispatched = false;
    const assertLifecycleCurrent = () => {
      if (!lifecycleCurrent) throw new Error('approval lifecycle superseded');
    };
    const claimApprovalAuthority = vi.fn(async () => {
      const authority = bindTrustedMcpFinalAuthorityToFence(
        createTrustedMcpFenceAuthority(() => undefined),
        assertLifecycleCurrent,
      );
      lifecycleCurrent = false;
      return authority;
    });
    registry.callTool.mockImplementationOnce(
      async (
        _serverId: string,
        _toolName: string,
        _args: Record<string, unknown>,
        options: { beforeDispatch?: () => void },
      ) => {
        options.beforeDispatch?.();
        effectDispatched = true;
        return { content: [{ type: 'text', text: 'unexpected' }] };
      },
    );
    const tools = await createRegistryMcpTools({
      registry,
      agentInstanceId: 'agent-1',
      claimApprovalAuthority,
      assertApprovalLifecycleCurrent: assertLifecycleCurrent,
    });

    await expect(
      (Object.values(tools)[0] as any).execute(
        { query: 'test' },
        { toolCallId: 'tool-call-1' },
      ),
    ).rejects.toThrow('approval lifecycle superseded');
    expect(claimApprovalAuthority).toHaveBeenCalledOnce();
    expect(effectDispatched).toBe(false);
  });

  it.each([
    {
      label: 'user',
      source: { kind: 'user' } as const,
    },
    {
      label: 'imported',
      source: {
        kind: 'imported',
        importer: 'claude-desktop',
        importedAt: 1,
      } as const,
    },
    {
      label: 'builtin',
      source: { kind: 'builtin', builtinId: 'clodex-gateway' } as const,
    },
    {
      label: 'signed plugin',
      source: {
        kind: 'plugin',
        pluginId: 'example-plugin',
        pluginVersion: '1.0.0',
      } as const,
    },
  ])('does not expose resource or prompt context for $label servers', async ({
    source,
  }) => {
    const registry = makeRegistry({
      toolOverride: 'allow',
      source,
    });
    registry.listResources.mockResolvedValue([
      { uri: 'file:///README.md', name: 'README' },
    ]);
    registry.listPrompts.mockResolvedValue([{ name: 'review' }]);

    const tools = await createRegistryMcpTools({
      registry,
      agentInstanceId: 'agent-1',
    });
    expect(Object.values(tools)).toHaveLength(1);
    expect(registry.listResources).not.toHaveBeenCalled();
    expect(registry.listPrompts).not.toHaveBeenCalled();
    expect(registry.readResource).not.toHaveBeenCalled();
    expect(registry.getPrompt).not.toHaveBeenCalled();
  });
});
