import {
  OPENMANUS_OS_CONFINED_ADAPTER_PROFILE,
  type OpenManusOsConfinedAdapter,
} from '@/agent-host/openmanus-runtime';
import type {
  OpenManusExecutionRequest,
  OpenManusExecutionResult,
} from '@/agent-host/protocol';
import { describe, expect, it, vi } from 'vitest';
import { runOpenManusToolExecute } from './run-openmanus';

function createConfinedAdapter() {
  const result: OpenManusExecutionResult = {
    message: 'OpenManus completed.',
    exitCode: 0,
    timedOut: false,
    mountPrefix: 'w1234',
    runtimeId: 'confined-runtime-1',
    stdout: 'done',
    stderr: '',
  };
  const execute = vi.fn(
    async (
      _request: OpenManusExecutionRequest,
      _options: { signal?: AbortSignal },
    ) => result,
  );
  const confinedExecution: OpenManusOsConfinedAdapter = {
    profile: OPENMANUS_OS_CONFINED_ADAPTER_PROFILE,
    execute,
  };
  return { confinedExecution, execute, result };
}

describe('runOpenManusToolExecute', () => {
  it('requires a valid workspace mount prefix', async () => {
    await expect(
      runOpenManusToolExecute(
        {
          prompt: 'research the workspace',
          mountPrefix: 'missing',
        },
        { getWorkspaceMounts: () => [] },
      ),
    ).rejects.toThrow('Workspace mount "missing" is not available');
  });

  it('fails closed when no confined execution adapter is installed', async () => {
    await expect(
      runOpenManusToolExecute(
        {
          prompt: 'research the workspace',
          mountPrefix: 'w1234',
        },
        { getWorkspaceMounts: () => [{ prefix: 'w1234' }] },
      ),
    ).rejects.toThrow('OS-confined, brokered adapter');
  });

  it('dispatches only prompt, mount capability, and bounded runtime limits', async () => {
    const { confinedExecution, execute, result } = createConfinedAdapter();
    const controller = new AbortController();

    await expect(
      runOpenManusToolExecute(
        {
          prompt: 'research the workspace',
          mountPrefix: 'w1234',
          timeoutMs: 90_000,
        },
        {
          getWorkspaceMounts: () => [{ prefix: 'w1234' }],
          confinedExecution,
        },
        controller.signal,
      ),
    ).resolves.toEqual(result);

    expect(execute).toHaveBeenCalledWith(
      {
        prompt: 'research the workspace',
        mountPrefix: 'w1234',
        timeoutMs: 90_000,
        maxTokens: 8_192,
      },
      { signal: controller.signal },
    );
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).not.toMatch(
      /apiKey|environment|workspacePath|openManusHome|pythonExecutable/,
    );
  });

  it('rejects an already-aborted request before adapter dispatch', async () => {
    const { confinedExecution, execute } = createConfinedAdapter();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runOpenManusToolExecute(
        {
          prompt: 'research the workspace',
          mountPrefix: 'w1234',
        },
        {
          getWorkspaceMounts: () => [{ prefix: 'w1234' }],
          confinedExecution,
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).not.toHaveBeenCalled();
  });
});
