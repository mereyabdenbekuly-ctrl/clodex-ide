import { describe, expect, it, vi } from 'vitest';
import { createTestAgentHost } from '../../host/test-utils';
import { ChatAgent } from './chat';

/**
 * Tests for {@link ChatAgent}'s tool-resolution contract.
 *
 * `ChatAgent` is the host-agnostic baseline: it requests universal file ops,
 * optional explicit memory-note tools, and the `updateWorkspaceMd` spawn tool.
 * Host-specific tools (browser, shell, sandbox, ...) arrive via the
 * `getAdditionalTools` template hook, which subclasses override.
 *
 * We bypass `BaseAgent`'s heavy constructor here by stubbing the few
 * fields `getTools` actually touches (`instanceId`, `toolbox`,
 * `getSpawnChildAgentTool`). This keeps the test focused on the
 * contract without re-instantiating the whole agent runtime.
 */

interface ChatAgentInternals {
  instanceId: string;
  toolbox: { getTool: ReturnType<typeof vi.fn> };
  host: { workspaceMdRelativePath: () => string };
  domainAdapterRegistry: unknown;
  getSpawnChildAgentTool: () => unknown;
  getTools: () => Promise<Record<string, unknown>>;
  getAdditionalTools: () => Promise<Record<string, unknown>>;
  getSystemPrompt: () => string;
  getActiveModelId: () => string;
  getCurrentStepModelId: () => string;
}

function makeStubAgent<T extends ChatAgent>(
  ctor: new (...args: never[]) => T,
  toolboxImpl: { getTool: ReturnType<typeof vi.fn> },
): ChatAgentInternals {
  const instance = Object.create(ctor.prototype) as ChatAgentInternals;
  instance.instanceId = 'test-agent';
  instance.toolbox = toolboxImpl;
  // Use a default-configured AgentHost so the tool-description path
  // reads `workspaceMdRelativePath()` without ceremony.
  instance.host = createTestAgentHost();
  instance.domainAdapterRegistry = {
    listSorted: () => [],
  };
  instance.getActiveModelId = () => 'gpt-5.5';
  instance.getCurrentStepModelId = () => instance.getActiveModelId();
  instance.getSpawnChildAgentTool = () => ({ kind: 'spawn-child' });
  return instance;
}

describe('ChatAgent', () => {
  it('getAdditionalTools defaults to an empty record', async () => {
    const stub = makeStubAgent(ChatAgent, {
      getTool: vi.fn().mockResolvedValue({}),
    });
    const extra = await stub.getAdditionalTools();
    expect(extra).toEqual({});
  });

  it('getTools returns universal file ops, optional memory tools, and updateWorkspaceMd', async () => {
    const getTool = vi.fn().mockResolvedValue({});
    const stub = makeStubAgent(ChatAgent, { getTool });
    const tools = await stub.getTools();

    expect(Object.keys(tools).sort()).toEqual([
      'addMemory',
      'copy',
      'delete',
      'deleteMemory',
      'getFileSkeleton',
      'getSymbolBody',
      'glob',
      'grepSearch',
      'listMemories',
      'multiEdit',
      'read',
      'readMemory',
      'searchMemories',
      'searchProjectSymbols',
      'updateWorkspaceMd',
      'write',
    ]);
  });

  it('getTools never requests host-specific tools from the toolbox', async () => {
    const getTool = vi.fn().mockResolvedValue({});
    const stub = makeStubAgent(ChatAgent, { getTool });
    await stub.getTools();

    const requestedNames = getTool.mock.calls.map(([name]) => name);
    expect(requestedNames).not.toContain('executeSandboxJs');
    expect(requestedNames).not.toContain('executeShellCommand');
    expect(requestedNames).not.toContain('listLibraryDocs');
    expect(requestedNames).not.toContain('searchInLibraryDocs');
    expect(requestedNames).not.toContain('getLintingDiagnostics');
    expect(requestedNames).not.toContain('readConsoleLogs');
    expect(requestedNames).not.toContain('askUserQuestions');
  });

  it('getTools filters out null entries returned by the toolbox', async () => {
    const getTool = vi
      .fn()
      .mockImplementation(async (name: string) =>
        name === 'delete' || name === 'copy' || name === 'addMemory'
          ? null
          : {},
      );
    const stub = makeStubAgent(ChatAgent, { getTool });
    const tools = await stub.getTools();

    expect(tools).not.toHaveProperty('delete');
    expect(tools).not.toHaveProperty('copy');
    expect(tools).not.toHaveProperty('addMemory');
    expect(tools).toHaveProperty('read');
    expect(tools).toHaveProperty('write');
    expect(tools).toHaveProperty('updateWorkspaceMd');
  });

  it('subclass overrides of getAdditionalTools are merged into getTools', async () => {
    class SubChatAgent extends ChatAgent {
      protected async getAdditionalTools(): Promise<Record<string, unknown>> {
        return {
          customHostTool: { kind: 'host-tool' },
        } as Record<string, never>;
      }
    }
    const getTool = vi.fn().mockResolvedValue({});
    const stub = makeStubAgent(SubChatAgent, { getTool });
    const tools = await stub.getTools();

    expect(tools).toHaveProperty('customHostTool');
    expect(tools.read).toBeDefined();
  });

  it('subclass-provided null entries are filtered out alongside baseline nulls', async () => {
    class SubChatAgent extends ChatAgent {
      protected async getAdditionalTools(): Promise<Record<string, unknown>> {
        return {
          missingHostTool: null,
          presentHostTool: { kind: 'host-tool' },
        } as Record<string, never>;
      }
    }
    const getTool = vi.fn().mockResolvedValue({});
    const stub = makeStubAgent(SubChatAgent, { getTool });
    const tools = await stub.getTools();

    expect(tools).not.toHaveProperty('missingHostTool');
    expect(tools).toHaveProperty('presentHostTool');
  });

  it('system prompt identifies Clodex IDE and exposes the selected model identity', () => {
    const stub = makeStubAgent(ChatAgent, {
      getTool: vi.fn().mockResolvedValue({}),
    });
    stub.getActiveModelId = () => 'claude-opus-4-7';
    stub.getCurrentStepModelId = () => 'claude-opus-4-7';
    const prompt = stub.getSystemPrompt();

    expect(prompt).toContain('Clodex IDE');
    expect(prompt).toContain('<clodex-runtime>');
    expect(prompt).toContain('searchProjectSymbols');
    expect(prompt).toContain('getFileSkeleton');
    expect(prompt).toContain('getSymbolBody');
    expect(prompt).toContain('After accepted code edits');
    expect(prompt).toContain('smallest relevant verification');
    expect(prompt).toContain(
      'Selected chat model: Opus 4.7 (`claude-opus-4-7`).',
    );
    expect(prompt).toContain(
      'Current routed request model: Opus 4.7 (`claude-opus-4-7`).',
    );
    expect(prompt).toContain(
      'The current routed model name and ID are not confidential.',
    );
    expect(prompt).toContain(
      'English: "I\'m Opus 4.7 (`claude-opus-4-7`), running in Clodex IDE."',
    );
    expect(prompt).toContain(
      'Russian: "Я модель Opus 4.7 (`claude-opus-4-7`), работающая в среде Clodex IDE."',
    );
    expect(prompt).toContain('Do not refuse model identity questions.');
    expect(prompt).toContain(
      'Do not say that you cannot disclose the underlying model.',
    );
    expect(prompt).not.toContain('You are **stage**');
  });

  it('system prompt distinguishes the selected model from the routed request model', () => {
    const stub = makeStubAgent(ChatAgent, {
      getTool: vi.fn().mockResolvedValue({}),
    });
    stub.getActiveModelId = () => 'claude-opus-4-7';
    stub.getCurrentStepModelId = () => 'gemini-3.5-flash';
    const prompt = stub.getSystemPrompt();

    expect(prompt).toContain(
      'Selected chat model: Opus 4.7 (`claude-opus-4-7`).',
    );
    expect(prompt).toContain(
      'Current routed request model: gemini-3.5-flash (`gemini-3.5-flash`).',
    );
    expect(prompt).toContain(
      'English: "I\'m gemini-3.5-flash (`gemini-3.5-flash`), running in Clodex IDE."',
    );
  });
});
