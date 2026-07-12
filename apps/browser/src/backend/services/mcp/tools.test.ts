import { describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '@clodex/mcp-runtime';
import type { McpRegistryService } from './index';
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
  return {
    snapshot: () => ({
      schemaVersion: 1 as const,
      servers: {
        custom: {
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
            tools: toolOverride ? { read_data: toolOverride } : {},
          },
        },
      },
    }),
    listTools: vi.fn(async () => [
      {
        name: 'read_data',
        description: 'Read data',
        inputSchema: { type: 'object' },
        annotations,
      },
    ]),
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
    listResources: ReturnType<typeof vi.fn>;
    listPrompts: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
  };
}

describe('registry MCP tools', () => {
  it('requires approval for custom tools even when the server claims read-only', async () => {
    const registry = makeRegistry({});
    const recordPendingApproval = vi.fn();
    const tools = await createRegistryMcpTools({
      registry,
      agentInstanceId: 'agent-1',
      recordPendingApproval,
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
      {
        agentInstanceId: 'agent-1',
      },
    );
    expect(result.message).toContain('Custom MCP/read_data completed');
  });

  it('exposes resources and prompts as approval-gated context tools', async () => {
    const registry = makeRegistry({ toolOverride: 'allow' });
    registry.listResources.mockResolvedValue([
      { uri: 'file:///README.md', name: 'README' },
    ]);
    registry.listPrompts.mockResolvedValue([
      {
        name: 'review',
        arguments: [{ name: 'focus', required: false }],
      },
    ]);
    const tools = await createRegistryMcpTools({
      registry,
      agentInstanceId: 'agent-1',
    });
    const contextTools = Object.values(tools).slice(1) as any[];

    expect(contextTools).toHaveLength(2);
    expect(contextTools[0].needsApproval).toBe(true);
    expect(contextTools[1].needsApproval).toBe(true);
    await contextTools[0].execute({ uri: 'file:///README.md' });
    await contextTools[1].execute({
      name: 'review',
      arguments: { focus: 'security' },
    });
    expect(registry.readResource).toHaveBeenCalledWith(
      'custom',
      'file:///README.md',
    );
    expect(registry.getPrompt).toHaveBeenCalledWith('custom', 'review', {
      focus: 'security',
    });
  });

  it('requires approval for imported resource and prompt context', async () => {
    const registry = makeRegistry({
      toolOverride: 'allow',
      source: {
        kind: 'imported',
        importer: 'claude-desktop',
        importedAt: Date.now(),
      },
    });
    registry.listResources.mockResolvedValue([
      { uri: 'file:///README.md', name: 'README' },
    ]);
    registry.listPrompts.mockResolvedValue([{ name: 'review' }]);

    const tools = await createRegistryMcpTools({
      registry,
      agentInstanceId: 'agent-1',
    });
    const contextTools = Object.values(tools).slice(1) as any[];

    expect(contextTools[0].needsApproval).toBe(true);
    expect(contextTools[1].needsApproval).toBe(true);
  });

  it.each([
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
  ])('does not add redundant context approval for $label servers', async ({
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
    const contextTools = Object.values(tools).slice(1) as any[];

    expect(contextTools[0].needsApproval).toBe(false);
    expect(contextTools[1].needsApproval).toBe(false);
  });
});
