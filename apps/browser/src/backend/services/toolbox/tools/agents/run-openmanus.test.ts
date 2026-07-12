import { describe, expect, it, vi } from 'vitest';
import type { OpenManusExecutionRequest } from '@/agent-host';
import { runOpenManusToolExecute } from './run-openmanus';

describe('runOpenManusToolExecute', () => {
  it('returns an installation message when OpenManus is not configured', async () => {
    const result = await runOpenManusToolExecute(
      {
        prompt: 'research the workspace',
        mountPrefix: 'w1234',
      },
      {
        getWorkspaceMounts: () => [
          {
            prefix: 'w1234',
            path: '/workspace/project',
          },
        ],
        resolvedEnvPromise: Promise.resolve({}),
        resolveOpenManusHome: vi.fn(async () => null),
      },
    );

    expect(result).toMatchObject({
      exitCode: null,
      timedOut: false,
      workspacePath: '/workspace/project',
      openManusHome: null,
    });
    expect(result.message).toContain('OpenManus is not installed');
  });

  it('requires a valid workspace mount prefix', async () => {
    await expect(
      runOpenManusToolExecute(
        {
          prompt: 'research the workspace',
          mountPrefix: 'missing',
        },
        {
          getWorkspaceMounts: () => [],
          resolvedEnvPromise: Promise.resolve({}),
          resolveOpenManusHome: vi.fn(async () => null),
        },
      ),
    ).rejects.toThrow('Workspace mount "missing" not found');
  });

  it('dispatches prepared work to the isolated agent host without leaking ambient secrets', async () => {
    const execute = vi.fn(
      async (
        _request: OpenManusExecutionRequest,
        _options: { signal?: AbortSignal },
      ) => ({
        message: 'OpenManus completed.',
        exitCode: 0,
        timedOut: false,
        workspacePath: '/workspace/project',
        openManusHome: '/opt/openmanus',
        stdout: 'done',
        stderr: '',
      }),
    );

    const result = await runOpenManusToolExecute(
      {
        prompt: 'research the workspace',
        mountPrefix: 'w1234',
      },
      {
        getWorkspaceMounts: () => [
          {
            prefix: 'w1234',
            path: '/workspace/project',
          },
        ],
        resolvedEnvPromise: Promise.resolve({
          PATH: '/custom/bin',
          OPENMANUS_MODEL: 'gpt-5.5',
          GITHUB_TOKEN: 'must-not-cross-ipc',
        }),
        authService: {
          ensureModelAccessTokenForRoute: vi.fn(
            async () => 'short-lived-route-token',
          ),
          ensureModelAccessToken: vi.fn(),
        } as any,
        resolveOpenManusHome: vi.fn(async () => '/opt/openmanus'),
        isolatedExecution: {
          isAvailable: () => true,
          execute,
        },
      },
    );

    expect(result.message).toBe('OpenManus completed.');
    expect(execute).toHaveBeenCalledOnce();
    const executionRequest = execute.mock.calls[0]?.[0];
    expect(executionRequest).toMatchObject({
      prompt: 'research the workspace',
      workspacePath: '/workspace/project',
      openManusHome: '/opt/openmanus',
      modelId: 'gpt-5.5',
      apiKey: 'short-lived-route-token',
      environment: {
        PATH: '/custom/bin',
      },
    });
    expect(JSON.stringify(executionRequest?.environment)).not.toContain(
      'must-not-cross-ipc',
    );
  });

  it('does not fall back to main-process execution when the isolated lane is restarting', async () => {
    const spawnProcess = vi.fn();

    await expect(
      runOpenManusToolExecute(
        {
          prompt: 'research the workspace',
          mountPrefix: 'w1234',
        },
        {
          getWorkspaceMounts: () => [
            {
              prefix: 'w1234',
              path: '/workspace/project',
            },
          ],
          resolvedEnvPromise: Promise.resolve({}),
          authService: {
            ensureModelAccessTokenForRoute: vi.fn(
              async () => 'short-lived-route-token',
            ),
            ensureModelAccessToken: vi.fn(),
          } as any,
          resolveOpenManusHome: vi.fn(async () => '/opt/openmanus'),
          spawnProcess: spawnProcess as any,
          isolatedExecution: {
            isAvailable: () => false,
            execute: vi.fn(),
          },
        },
      ),
    ).rejects.toThrow('temporarily unavailable');
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
