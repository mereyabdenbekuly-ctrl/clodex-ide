import { describe, expect, it, vi } from 'vitest';
import { collectWorkspaceLastUsedAtByPath } from '@clodex/agent-core/agent-persistence';
import type {
  AgentStepExecution,
  AgentStepExecutionRequest,
} from '@clodex/agent-core/agents';
import { createAutomaticSwarmStepExecutor } from './agent-manager';

function createStepRequest(
  executionTarget: 'local' | 'cloud' = 'local',
): AgentStepExecutionRequest {
  return {
    context: {
      agentInstanceId: 'agent-1',
      agentType: 'chat',
      traceId: 'trace-1',
      requestedModelId: 'gpt-5.6-sol',
      resolvedModelId: 'gpt-5.6-sol',
      isApprovalContinuation: false,
      executionTarget,
      metadata: {},
    },
    options: {
      model: {} as AgentStepExecutionRequest['options']['model'],
      messages: [],
    },
  } as AgentStepExecutionRequest;
}

describe('createAutomaticSwarmStepExecutor', () => {
  const automaticExecution = {
    consumeStream: vi.fn(),
    toUIMessageStream: vi.fn(),
  } as unknown as AgentStepExecution;
  const ordinaryExecution = {
    consumeStream: vi.fn(),
    toUIMessageStream: vi.fn(),
  } as unknown as AgentStepExecution;

  it('returns the admitted automatic execution without starting a normal model turn', async () => {
    const handler = vi.fn(async () => automaticExecution);
    const delegate = { execute: vi.fn(async () => ordinaryExecution) };
    const executor = createAutomaticSwarmStepExecutor({
      delegate,
      getHandler: () => handler,
    });
    const request = createStepRequest();

    await expect(executor.execute(request)).resolves.toBe(automaticExecution);
    expect(handler).toHaveBeenCalledWith(request);
    expect(delegate.execute).not.toHaveBeenCalled();
  });

  it('delegates exactly once when automatic Ultra declines the admitted turn', async () => {
    const handler = vi.fn(async () => null);
    const delegate = { execute: vi.fn(async () => ordinaryExecution) };
    const executor = createAutomaticSwarmStepExecutor({
      delegate,
      getHandler: () => handler,
    });
    const request = createStepRequest();

    await expect(executor.execute(request)).resolves.toBe(ordinaryExecution);
    expect(handler).toHaveBeenCalledWith(request);
    expect(delegate.execute).toHaveBeenCalledOnce();
    expect(delegate.execute).toHaveBeenCalledWith(request);
  });

  it('never lets local automatic Ultra intercept a cloud execution', async () => {
    const handler = vi.fn(async () => automaticExecution);
    const delegate = { execute: vi.fn(async () => ordinaryExecution) };
    const executor = createAutomaticSwarmStepExecutor({
      delegate,
      getHandler: () => handler,
    });
    const request = createStepRequest('cloud');

    await expect(executor.execute(request)).resolves.toBe(ordinaryExecution);
    expect(handler).not.toHaveBeenCalled();
    expect(delegate.execute).toHaveBeenCalledOnce();
  });
});

describe('collectWorkspaceLastUsedAtByPath', () => {
  it('matches stored symlink workspace paths to canonical target paths', async () => {
    const resolveUsagePath = vi.fn(async (workspacePath: string) => {
      if (workspacePath === '/link/worktree') return '/real/worktree';
      return workspacePath;
    });

    const usage = await collectWorkspaceLastUsedAtByPath(
      ['/real/worktree'],
      [
        {
          lastMessageAt: new Date(1_000),
          mountedWorkspaces: [{ path: '/link/worktree' }],
        },
      ],
      resolveUsagePath,
    );

    expect(usage.get('/real/worktree')).toBe(1_000);
  });

  it('keeps the latest usage timestamp across aliases', async () => {
    const resolveUsagePath = vi.fn(async (workspacePath: string) => {
      if (workspacePath === '/link/worktree') return '/real/worktree';
      return workspacePath;
    });

    const usage = await collectWorkspaceLastUsedAtByPath(
      ['/real/worktree'],
      [
        {
          lastMessageAt: new Date(1_000),
          mountedWorkspaces: [{ path: '/real/worktree' }],
        },
        {
          lastMessageAt: new Date(2_000),
          mountedWorkspaces: [{ path: '/link/worktree' }],
        },
      ],
      resolveUsagePath,
    );

    expect(usage.get('/real/worktree')).toBe(2_000);
  });
});
