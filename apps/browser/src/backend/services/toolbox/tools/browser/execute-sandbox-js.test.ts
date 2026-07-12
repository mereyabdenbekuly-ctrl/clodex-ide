import { describe, expect, it, vi } from 'vitest';
import type { SandboxService } from '@/services/sandbox';
import type { GuardianAssessment } from '@shared/guardian';
import { executeSandboxJs } from './execute-sandbox-js';

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
