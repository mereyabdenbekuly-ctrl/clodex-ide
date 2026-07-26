import { describe, expect, it, vi } from 'vitest';
import {
  createShellSession,
  executeShellCommand,
  type GuardianApprovalDeps,
  type SmartApprovalDeps,
} from './execute-shell-command';
import type { ShellCapabilitySecurityDeps } from './shell-capability';
import type { ShellService } from '../engine';

const createSmartApprovalDeps = (): SmartApprovalDeps => ({
  classify: vi.fn(async () => ({
    needsApproval: false,
    explanation: 'safe',
  })),
  recordPendingApproval: vi.fn(),
});

const createGuardianApprovalDeps = (
  result: Awaited<ReturnType<GuardianApprovalDeps['assess']>>,
): GuardianApprovalDeps => ({
  assess: vi.fn(async () => result),
  recordPendingApproval: vi.fn(),
});

const createShellService = (): ShellService =>
  ({
    getRecentOutputForClassifier: vi.fn(() => ''),
    getSessionCurrentCwd: vi.fn(() => '/tmp'),
  }) as unknown as ShellService;

const capabilityContext = {
  experimental_context: {
    toolCapabilityCurrentScopeId: 'a'.repeat(64),
    toolCapabilityApprovalOriginScopeId: null,
  },
};

describe('executeShellCommand approval', () => {
  it('includes current 16-hex workspace prefixes in unknown-cwd diagnostics', async () => {
    const currentPrefix = 'w2c9ed34e414edf8e';
    const tool = createShellSession(
      createShellService(),
      'agent-1',
      () =>
        new Map([
          [currentPrefix, '/tmp'],
          ['att', '/tmp/attachments'],
        ]),
      {
        stage: vi.fn(async ({ authorization }) => authorization),
        consume: vi.fn(async () => undefined),
      },
    );
    if (typeof tool.needsApproval !== 'function') {
      throw new Error('Expected createShellSession to define needsApproval');
    }

    await expect(
      tool.needsApproval(
        { cwd: 'wmissing' },
        { toolCallId: 'tool-1', messages: [] },
      ),
    ).rejects.toThrow(`Available: ${currentPrefix}, att.`);
  });

  it('stages and consumes the exact action before PTY execution', async () => {
    const shellService = createShellService();
    const executeInSession = vi.fn(async () => ({
      sessionId: 'session-1',
      output: 'ok',
      exitCode: 0,
      sessionExited: false,
      timedOut: false,
      resolvedBy: 'exit' as const,
    }));
    const clearPendingOutputs = vi.fn();
    Object.assign(shellService, { executeInSession, clearPendingOutputs });
    const security: ShellCapabilitySecurityDeps = {
      stage: vi.fn(async ({ authorization }) => authorization),
      consume: vi.fn(async () => undefined),
    };
    const tool = executeShellCommand(
      shellService,
      'agent-1',
      () => 'alwaysAllow',
      () => new Map([['wtest', '/tmp']]),
      createSmartApprovalDeps(),
      undefined,
      security,
    );
    if (
      typeof tool.needsApproval !== 'function' ||
      typeof tool.execute !== 'function'
    ) {
      throw new Error('Expected executable shell tool with approval hook');
    }
    const input = {
      explanation: 'Run tests',
      session_id: 'session-1',
      command: 'pnpm test',
    };
    const options = {
      toolCallId: 'tool-1',
      messages: [],
      ...capabilityContext,
    };

    await expect(tool.needsApproval(input, options)).resolves.toBe(false);
    await tool.execute(input, options);

    expect(security.stage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        authorization: 'policy-approved',
        action: expect.objectContaining({
          operation: 'command',
          command: 'pnpm test',
          cwdPrefix: 'wtest',
        }),
      }),
    );
    expect(security.consume).toHaveBeenCalledWith(
      expect.objectContaining({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        scopeId: 'a'.repeat(64),
        action: expect.objectContaining({
          operation: 'command',
          command: 'pnpm test',
          cwdPrefix: 'wtest',
        }),
      }),
    );
    expect(
      vi.mocked(security.consume).mock.invocationCallOrder[0],
    ).toBeLessThan(executeInSession.mock.invocationCallOrder[0]!);
  });

  it('keeps the effective human requirement when a restage strengthens authorization', async () => {
    const shellService = createShellService();
    const security: ShellCapabilitySecurityDeps = {
      stage: vi.fn(async () => 'human-required'),
      consume: vi.fn(async () => undefined),
    };
    const tool = executeShellCommand(
      shellService,
      'agent-1',
      () => 'alwaysAllow',
      () => new Map([['wtest', '/tmp']]),
      createSmartApprovalDeps(),
      undefined,
      security,
    );
    if (typeof tool.needsApproval !== 'function') {
      throw new Error('Expected executeShellCommand to define needsApproval');
    }

    await expect(
      tool.needsApproval(
        {
          explanation: 'Inspect status',
          session_id: 'session-1',
          command: 'git status',
        },
        {
          toolCallId: 'tool-1',
          messages: [],
          ...capabilityContext,
        },
      ),
    ).resolves.toBe(true);
  });

  it('fails closed when the trusted capability scope is missing', async () => {
    const security: ShellCapabilitySecurityDeps = {
      stage: vi.fn(async ({ authorization }) => authorization),
      consume: vi.fn(async () => undefined),
    };
    const tool = executeShellCommand(
      createShellService(),
      'agent-1',
      () => 'alwaysAllow',
      () => new Map([['wtest', '/tmp']]),
      createSmartApprovalDeps(),
      undefined,
      security,
    );
    if (typeof tool.needsApproval !== 'function') {
      throw new Error('Expected executeShellCommand to define needsApproval');
    }

    await expect(
      tool.needsApproval(
        {
          explanation: 'Inspect status',
          session_id: 'session-1',
          command: 'git status',
        },
        { toolCallId: 'tool-1', messages: [] },
      ),
    ).rejects.toThrow('scope unavailable');
  });

  it('uses approval origin scope only for the approved old call', async () => {
    const shellService = createShellService();
    Object.assign(shellService, {
      executeInSession: vi.fn(async () => ({
        sessionId: 'session-1',
        output: 'ok',
        exitCode: 0,
        sessionExited: false,
        timedOut: false,
        resolvedBy: 'exit' as const,
      })),
      clearPendingOutputs: vi.fn(),
    });
    const security: ShellCapabilitySecurityDeps = {
      stage: vi.fn(async ({ authorization }) => authorization),
      consume: vi.fn(async () => undefined),
    };
    const tool = executeShellCommand(
      shellService,
      'agent-1',
      () => 'alwaysAllow',
      () => new Map([['wtest', '/tmp']]),
      createSmartApprovalDeps(),
      undefined,
      security,
    );
    if (
      typeof tool.needsApproval !== 'function' ||
      typeof tool.execute !== 'function'
    ) {
      throw new Error('Expected executable shell tool with approval hook');
    }

    const input = {
      explanation: 'Run tests',
      session_id: 'session-1',
      command: 'pnpm test',
    };
    const approvalMessages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'tool-1',
            toolName: 'executeShellCommand',
            input,
          },
          {
            type: 'tool-approval-request',
            approvalId: 'approval-1',
            toolCallId: 'tool-1',
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-approval-response',
            approvalId: 'approval-1',
            approved: true,
          },
        ],
      },
    ];
    const continuationContext = {
      experimental_context: {
        toolCapabilityCurrentScopeId: 'c'.repeat(64),
        toolCapabilityApprovalOriginScopeId: 'b'.repeat(64),
      },
    };

    await tool.execute(input, {
      toolCallId: 'tool-1',
      messages: approvalMessages,
      ...continuationContext,
    } as never);
    expect(security.consume).toHaveBeenLastCalledWith(
      expect.objectContaining({ scopeId: 'b'.repeat(64) }),
    );

    const messagesAfterApprovedResult = [
      ...approvalMessages,
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-1',
            toolName: 'executeShellCommand',
            output: { type: 'text', value: 'ok' },
          },
        ],
      },
    ];
    await tool.needsApproval(input, {
      toolCallId: 'tool-1',
      messages: messagesAfterApprovedResult,
      ...continuationContext,
    } as never);
    await tool.execute(input, {
      toolCallId: 'tool-1',
      messages: messagesAfterApprovedResult,
      ...continuationContext,
    } as never);

    expect(security.stage).toHaveBeenLastCalledWith(
      expect.objectContaining({ scopeId: 'c'.repeat(64) }),
    );
    expect(security.consume).toHaveBeenLastCalledWith(
      expect.objectContaining({ scopeId: 'c'.repeat(64) }),
    );
  });

  it('blocks conflicting approval bindings when a provider reuses a tool call id', async () => {
    const shellService = createShellService();
    const executeInSession = vi.fn(async () => ({
      sessionId: 'session-1',
      output: 'should not run',
      exitCode: 0,
      sessionExited: false,
      timedOut: false,
      resolvedBy: 'exit' as const,
    }));
    Object.assign(shellService, {
      executeInSession,
      clearPendingOutputs: vi.fn(),
    });
    const security: ShellCapabilitySecurityDeps = {
      stage: vi.fn(async ({ authorization }) => authorization),
      consume: vi.fn(async () => undefined),
    };
    const tool = executeShellCommand(
      shellService,
      'agent-1',
      () => 'alwaysAsk',
      () => new Map([['wtest', '/tmp']]),
      createSmartApprovalDeps(),
      undefined,
      security,
    );
    if (typeof tool.execute !== 'function') {
      throw new Error('Expected executable shell tool');
    }

    const shellInput = {
      explanation: 'Run tests',
      session_id: 'session-1',
      command: 'pnpm test',
    };
    const conflictingApprovalMessages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'reused-tool-call',
            toolName: 'executeShellCommand',
            input: shellInput,
          },
          {
            type: 'tool-approval-request',
            approvalId: 'shell-approval',
            toolCallId: 'reused-tool-call',
          },
          {
            type: 'tool-call',
            toolCallId: 'reused-tool-call',
            toolName: 'read',
            input: { path: 'README.md' },
          },
          {
            type: 'tool-approval-request',
            approvalId: 'read-approval',
            toolCallId: 'reused-tool-call',
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-approval-response',
            approvalId: 'read-approval',
            approved: true,
          },
          {
            type: 'tool-approval-response',
            approvalId: 'shell-approval',
            approved: false,
          },
        ],
      },
    ];

    await expect(
      tool.execute(shellInput, {
        toolCallId: 'reused-tool-call',
        messages: conflictingApprovalMessages,
        experimental_context: {
          toolCapabilityCurrentScopeId: 'c'.repeat(64),
          toolCapabilityApprovalOriginScopeId: 'b'.repeat(64),
        },
      } as never),
    ).rejects.toThrow('approval evidence is ambiguous or denied');
    expect(security.consume).not.toHaveBeenCalled();
    expect(executeInSession).not.toHaveBeenCalled();
  });

  it('blocks execution when the session cwd changes after authorization', async () => {
    const shellService = createShellService();
    const executeInSession = vi.fn();
    Object.assign(shellService, {
      executeInSession,
      clearPendingOutputs: vi.fn(),
    });
    let stagedAction: unknown;
    const security: ShellCapabilitySecurityDeps = {
      stage: vi.fn(async ({ action }) => {
        stagedAction = action;
        return 'policy-approved';
      }),
      consume: vi.fn(async ({ action }) => {
        if (JSON.stringify(action) !== JSON.stringify(stagedAction)) {
          throw new Error('Shell action changed after authorization');
        }
      }),
    };
    const tool = executeShellCommand(
      shellService,
      'agent-1',
      () => 'alwaysAllow',
      () =>
        new Map([
          ['wtest', '/tmp'],
          ['wother', '/other'],
        ]),
      createSmartApprovalDeps(),
      undefined,
      security,
    );
    if (
      typeof tool.needsApproval !== 'function' ||
      typeof tool.execute !== 'function'
    ) {
      throw new Error('Expected executable shell tool with approval hook');
    }
    const input = {
      explanation: 'Run tests',
      session_id: 'session-1',
      command: 'pnpm test',
    };
    const options = {
      toolCallId: 'tool-1',
      messages: [],
      ...capabilityContext,
    };

    await expect(tool.needsApproval(input, options)).resolves.toBe(false);
    vi.mocked(shellService.getSessionCurrentCwd).mockReturnValue('/other');

    await expect(tool.execute(input, options)).rejects.toThrow(
      'changed after authorization',
    );
    expect(executeInSession).not.toHaveBeenCalled();
  });

  it('always allows kill calls even when approval mode is alwaysAsk', async () => {
    const shellService = createShellService();
    const smartApproval = createSmartApprovalDeps();
    const tool = executeShellCommand(
      shellService,
      'agent-1',
      () => 'alwaysAsk',
      () => new Map([['wtest', '/tmp']]),
      smartApproval,
    );

    expect(typeof tool.needsApproval).toBe('function');
    if (typeof tool.needsApproval !== 'function') {
      throw new Error('Expected executeShellCommand to define needsApproval');
    }

    const needsApproval = await tool.needsApproval(
      {
        explanation: 'Close terminal',
        session_id: 'session-1',
        kill: true,
      },
      { toolCallId: 'tool-1', messages: [] },
    );

    expect(needsApproval).toBe(false);
    expect(smartApproval.classify).not.toHaveBeenCalled();
    expect(smartApproval.recordPendingApproval).not.toHaveBeenCalled();
  });

  it('lets Guardian escalation override alwaysAllow', async () => {
    const shellService = createShellService();
    const smartApproval = createSmartApprovalDeps();
    const security: ShellCapabilitySecurityDeps = {
      stage: vi.fn(async ({ authorization }) => authorization),
      consume: vi.fn(async () => undefined),
    };
    const guardian = createGuardianApprovalDeps({
      decision: 'escalate',
      risk: 'high',
      irreversible: true,
      explanation: 'Remote destructive action requires approval.',
    });
    const tool = executeShellCommand(
      shellService,
      'agent-1',
      () => 'alwaysAllow',
      () => new Map([['wtest', '/tmp']]),
      smartApproval,
      guardian,
      security,
    );

    if (typeof tool.needsApproval !== 'function') {
      throw new Error('Expected executeShellCommand to define needsApproval');
    }
    await expect(
      tool.needsApproval(
        {
          explanation: 'Force push',
          session_id: 'session-1',
          command: 'git push --force origin main',
        },
        { toolCallId: 'tool-1', messages: [], ...capabilityContext },
      ),
    ).resolves.toBe(true);
    expect(guardian.recordPendingApproval).toHaveBeenCalledWith(
      'tool-1',
      'Remote destructive action requires approval.',
    );
    expect(security.stage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentInstanceId: 'agent-1',
        toolCallId: 'tool-1',
        authorization: 'human-required',
      }),
    );
    expect(smartApproval.classify).not.toHaveBeenCalled();
  });

  it('uses low-risk Guardian approval instead of the smart classifier', async () => {
    const shellService = createShellService();
    const smartApproval = createSmartApprovalDeps();
    const guardian = createGuardianApprovalDeps({
      decision: 'approve',
      risk: 'low',
      irreversible: false,
      explanation: 'Bounded read-only command.',
    });
    const tool = executeShellCommand(
      shellService,
      'agent-1',
      () => 'smart',
      () => new Map([['wtest', '/tmp']]),
      smartApproval,
      guardian,
    );

    if (typeof tool.needsApproval !== 'function') {
      throw new Error('Expected executeShellCommand to define needsApproval');
    }
    await expect(
      tool.needsApproval(
        {
          explanation: 'List files',
          session_id: 'session-1',
          command: 'ls',
        },
        { toolCallId: 'tool-1', messages: [] },
      ),
    ).resolves.toBe(false);
    expect(smartApproval.classify).not.toHaveBeenCalled();
  });

  it('does not let Guardian approval override alwaysAsk', async () => {
    const guardian = createGuardianApprovalDeps({
      decision: 'approve',
      risk: 'low',
      irreversible: false,
      explanation: 'Bounded read-only command.',
    });
    const tool = executeShellCommand(
      createShellService(),
      'agent-1',
      () => 'alwaysAsk',
      () => new Map([['wtest', '/tmp']]),
      createSmartApprovalDeps(),
      guardian,
    );

    if (typeof tool.needsApproval !== 'function') {
      throw new Error('Expected executeShellCommand to define needsApproval');
    }
    await expect(
      tool.needsApproval(
        {
          explanation: 'List files',
          session_id: 'session-1',
          command: 'ls',
        },
        { toolCallId: 'tool-1', messages: [] },
      ),
    ).resolves.toBe(true);
  });

  it('blocks a Guardian deny decision before execution', async () => {
    const guardian = createGuardianApprovalDeps({
      decision: 'deny',
      risk: 'critical',
      irreversible: true,
      explanation: 'Unbounded host deletion is blocked.',
    });
    const tool = executeShellCommand(
      createShellService(),
      'agent-1',
      () => 'alwaysAllow',
      () => new Map([['wtest', '/tmp']]),
      createSmartApprovalDeps(),
      guardian,
    );

    if (typeof tool.needsApproval !== 'function') {
      throw new Error('Expected executeShellCommand to define needsApproval');
    }
    await expect(
      tool.needsApproval(
        {
          explanation: 'Delete root',
          session_id: 'session-1',
          command: 'rm -rf /',
        },
        { toolCallId: 'tool-1', messages: [] },
      ),
    ).rejects.toThrow('Guardian denied action');
  });

  it('preserves the existing mode when Guardian is disabled', async () => {
    const guardian = createGuardianApprovalDeps(null);
    const smartApproval = createSmartApprovalDeps();
    const tool = executeShellCommand(
      createShellService(),
      'agent-1',
      () => 'alwaysAllow',
      () => new Map([['wtest', '/tmp']]),
      smartApproval,
      guardian,
    );

    if (typeof tool.needsApproval !== 'function') {
      throw new Error('Expected executeShellCommand to define needsApproval');
    }
    await expect(
      tool.needsApproval(
        {
          explanation: 'Run command',
          session_id: 'session-1',
          command: 'custom-command',
        },
        { toolCallId: 'tool-1', messages: [] },
      ),
    ).resolves.toBe(false);
    expect(smartApproval.classify).not.toHaveBeenCalled();
  });
});
