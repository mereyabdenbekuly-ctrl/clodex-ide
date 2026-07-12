import type { MemoryNotesService } from '@clodex/agent-core/memory-notes';
import { describe, expect, it, vi } from 'vitest';
import { makeMemoryNoteTools } from './index';

function makeService() {
  return {
    add: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    read: vi.fn().mockResolvedValue(null),
    search: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(false),
  };
}

function makeTools(
  service: ReturnType<typeof makeService>,
  isEnabled = () => true,
) {
  return makeMemoryNoteTools({
    service: service as unknown as MemoryNotesService,
    agentInstanceId: 'agent-1',
    getWorkspaceMounts: () => [
      { prefix: 'w-alpha', absolutePath: '/workspaces/alpha' },
    ],
    isEnabled,
  }) as Record<string, any>;
}

async function execute(tool: any, input: unknown) {
  return tool.execute(input, {
    toolCallId: 'tool-call-1',
    messages: [],
  });
}

describe('memory note tools', () => {
  it('maps workspace prefixes to trusted absolute scope keys', async () => {
    const service = makeService();
    service.add.mockResolvedValue({
      id: 'ad3c634e-5d2b-4caa-b15a-a6ba587fe6f9',
      scope: 'workspace',
      scopeKey: '/workspaces/alpha',
      title: 'Workspace note',
      content: 'Remember this',
      tags: [],
      sensitivity: 'normal',
      createdAt: 1,
      updatedAt: 1,
    });
    const tools = makeTools(service);

    const result = await execute(tools.addMemory, {
      scope: 'workspace',
      mountPrefix: 'w-alpha',
      title: 'Workspace note',
      content: 'Remember this',
      tags: [],
      sensitivity: 'normal',
    });

    expect(service.add).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          scope: 'workspace',
          scopeKey: '/workspaces/alpha',
        },
      }),
    );
    expect(result.memory.scope).toEqual({
      type: 'workspace',
      mountPrefix: 'w-alpha',
    });
  });

  it('rejects arbitrary or unavailable workspace scope keys', async () => {
    const service = makeService();
    const tools = makeTools(service);

    await expect(
      execute(tools.addMemory, {
        scope: 'workspace',
        mountPrefix: '/arbitrary/path',
        title: 'Invalid',
        content: 'Must not be stored',
        tags: [],
        sensitivity: 'normal',
      }),
    ).rejects.toThrow('not available to this agent');
    expect(service.add).not.toHaveBeenCalled();
  });

  it('lists only global, current-agent, and mounted-workspace scopes', async () => {
    const service = makeService();
    const tools = makeTools(service);

    await execute(tools.listMemories, { limit: 20 });

    expect(service.list).toHaveBeenCalledWith({
      scopes: [
        { scope: 'global', scopeKey: null },
        { scope: 'agent', scopeKey: 'agent-1' },
        { scope: 'workspace', scopeKey: '/workspaces/alpha' },
      ],
      limit: 20,
    });
  });

  it('requires approval for sensitive writes and all deletes', async () => {
    const tools = makeTools(makeService());
    const needsApproval = tools.addMemory.needsApproval;

    expect(
      await needsApproval(
        {
          title: 'Normal',
          content: 'Normal',
          tags: [],
          sensitivity: 'normal',
        },
        { toolCallId: 'normal' },
      ),
    ).toBe(false);
    expect(
      await needsApproval(
        {
          title: 'Sensitive',
          content: 'Sensitive',
          tags: [],
          sensitivity: 'sensitive',
        },
        { toolCallId: 'sensitive' },
      ),
    ).toBe(true);
    expect(tools.deleteMemory.needsApproval).toBe(true);
  });

  it('rechecks the backend feature gate when executing a resolved tool', async () => {
    const service = makeService();
    const tools = makeTools(service, () => false);

    await expect(execute(tools.listMemories, { limit: 20 })).rejects.toThrow(
      'preview feature is disabled',
    );
    expect(service.list).not.toHaveBeenCalled();
  });
});
