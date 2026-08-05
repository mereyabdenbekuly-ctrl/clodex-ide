import { describe, expect, it, vi } from 'vitest';
import type { SandboxService } from '@/services/sandbox';
import type { GuardianAssessment } from '@shared/guardian';
import { DESCRIPTION, executeSandboxJs } from './execute-sandbox-js';

function createSandboxService(): SandboxService {
  return {} as SandboxService;
}

function assessment(
  overrides: Partial<GuardianAssessment> = {},
): GuardianAssessment {
  return {
    kind: 'sandbox',
    summary: 'Run bounded sandbox JavaScript',
    risk: 'low',
    decision: 'approve',
    irreversible: false,
    evidence: ['bounded-scope'],
    explanation: 'Guardian found a bounded reversible action.',
    ...overrides,
  };
}

describe('executeSandboxJs Guardian approval', () => {
  it('does not request approval when Guardian is disabled', async () => {
    const assess = vi.fn(async () => null);
    const tool = executeSandboxJs(createSandboxService(), 'agent-1', {
      assess,
      recordPendingApproval: vi.fn(),
    });

    if (typeof tool.needsApproval !== 'function') {
      throw new Error('Expected executeSandboxJs to define needsApproval');
    }
    await expect(
      tool.needsApproval(
        { explanation: 'Compute value', script: 'return 2 + 2;' },
        { toolCallId: 'tool-1', messages: [] },
      ),
    ).resolves.toBe(false);
  });

  it('escalates sandbox credential access to normal human approval', async () => {
    const recordPendingApproval = vi.fn();
    const tool = executeSandboxJs(createSandboxService(), 'agent-1', {
      assess: vi.fn(async () =>
        assessment({
          risk: 'high',
          decision: 'escalate',
          evidence: ['credential-access'],
          explanation: 'Credential access requires human review.',
        }),
      ),
      recordPendingApproval,
    });

    if (typeof tool.needsApproval !== 'function') {
      throw new Error('Expected executeSandboxJs to define needsApproval');
    }
    await expect(
      tool.needsApproval(
        {
          explanation: 'Read credential',
          script: "await API.getCredential('github-pat');",
        },
        { toolCallId: 'tool-1', messages: [] },
      ),
    ).resolves.toBe(true);
    expect(recordPendingApproval).toHaveBeenCalledWith(
      'tool-1',
      'Credential access requires human review.',
    );
  });

  it('fails closed when Guardian assessment throws', async () => {
    const recordPendingApproval = vi.fn();
    const tool = executeSandboxJs(createSandboxService(), 'agent-1', {
      assess: vi.fn(async () => {
        throw new Error('unavailable');
      }),
      recordPendingApproval,
    });

    if (typeof tool.needsApproval !== 'function') {
      throw new Error('Expected executeSandboxJs to define needsApproval');
    }
    await expect(
      tool.needsApproval(
        { explanation: 'Compute value', script: 'return 2 + 2;' },
        { toolCallId: 'tool-1', messages: [] },
      ),
    ).resolves.toBe(true);
    expect(recordPendingApproval).toHaveBeenCalledWith(
      'tool-1',
      expect.stringContaining('Guardian assessment failed'),
    );
  });

  it('blocks denied sandbox actions', async () => {
    const tool = executeSandboxJs(createSandboxService(), 'agent-1', {
      assess: vi.fn(async () =>
        assessment({
          risk: 'critical',
          decision: 'deny',
          irreversible: true,
          explanation: 'Policy-changing action is blocked.',
        }),
      ),
      recordPendingApproval: vi.fn(),
    });

    if (typeof tool.needsApproval !== 'function') {
      throw new Error('Expected executeSandboxJs to define needsApproval');
    }
    await expect(
      tool.needsApproval(
        { explanation: 'Change policy', script: 'dangerous();' },
        { toolCallId: 'tool-1', messages: [] },
      ),
    ).rejects.toThrow('Guardian denied action');
  });
});

describe('executeSandboxJs execution lifecycle', () => {
  it('advertises the same fail-closed capability boundary as the worker', () => {
    expect(DESCRIPTION).toContain('module imports');
    expect(DESCRIPTION).toContain('filesystem access are disabled');
    expect(DESCRIPTION).toContain('Do not retry importModule()');
    expect(DESCRIPTION).not.toContain('esm.sh');
  });

  it('preserves a capability error and clears transient tool state', async () => {
    const capabilityError = new Error(
      'Remote module imports are disabled. Do not retry importModule().',
    );
    const service = {
      setAgentToolCallId: vi.fn(),
      execute: vi.fn().mockRejectedValueOnce(capabilityError),
      getAndClearFileWriteCount: vi.fn(() => 0),
      clearPendingOutputs: vi.fn(),
      clearAgentToolCallId: vi.fn(),
    } as unknown as SandboxService;
    const sandboxTool = executeSandboxJs(service, 'agent-1');

    if (!sandboxTool.execute) {
      throw new Error('Expected executeSandboxJs to define execute');
    }

    await expect(
      sandboxTool.execute(
        {
          explanation: 'Inspect reference screenshots',
          script:
            "return await importModule('https://example.invalid/module.js');",
        },
        { toolCallId: 'tool-1', messages: [] },
      ),
    ).rejects.toThrow('Do not retry importModule()');

    expect(service.setAgentToolCallId).toHaveBeenCalledWith(
      'agent-1',
      'tool-1',
    );
    expect(service.clearPendingOutputs).toHaveBeenCalledWith(
      'agent-1',
      'tool-1',
    );
    expect(service.clearAgentToolCallId).toHaveBeenCalledWith('agent-1');
  });
});
