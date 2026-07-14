import { describe, expect, it, vi } from 'vitest';
import type {
  OpenManusExecutionRequest,
  OpenManusExecutionResult,
} from './protocol';
import {
  executeOpenManusRequest,
  OPENMANUS_OS_CONFINED_ADAPTER_PROFILE,
  OpenManusConfinementUnavailableError,
  type OpenManusOsConfinedAdapter,
} from './openmanus-runtime';

const request: OpenManusExecutionRequest = {
  prompt: 'Inspect the workspace',
  mountPrefix: 'w1234',
  timeoutMs: 60_000,
  maxTokens: 8_192,
};

const result: OpenManusExecutionResult = {
  message: 'OpenManus completed.',
  exitCode: 0,
  timedOut: false,
  mountPrefix: 'w1234',
  runtimeId: 'confined-runtime-1',
  stdout: 'done',
  stderr: '',
};

function createAdapter() {
  const execute = vi.fn(
    async (
      _request: OpenManusExecutionRequest,
      _options: { signal?: AbortSignal },
    ) => result,
  );
  const adapter: OpenManusOsConfinedAdapter = {
    profile: OPENMANUS_OS_CONFINED_ADAPTER_PROFILE,
    execute,
  };
  return { adapter, execute };
}

describe('executeOpenManusRequest', () => {
  it('fails closed when no OS-confined adapter is installed', async () => {
    await expect(executeOpenManusRequest(request)).rejects.toBeInstanceOf(
      OpenManusConfinementUnavailableError,
    );
  });

  it('dispatches only the closed capability request to the trusted adapter', async () => {
    const { adapter, execute } = createAdapter();
    const controller = new AbortController();

    await expect(
      executeOpenManusRequest(request, {
        signal: controller.signal,
        confinedAdapter: adapter,
      }),
    ).resolves.toEqual(result);

    expect(execute).toHaveBeenCalledWith(expect.objectContaining(request), {
      signal: controller.signal,
    });
    const dispatched = execute.mock.calls[0]?.[0];
    expect(Object.keys(dispatched ?? {}).sort()).toEqual([
      'maxTokens',
      'mountPrefix',
      'prompt',
      'timeoutMs',
    ]);
    expect(Object.isFrozen(dispatched)).toBe(true);
  });

  it('rejects ambient host authority before the adapter can run', async () => {
    const { adapter, execute } = createAdapter();
    const unsafeRequest = {
      ...request,
      workspacePath: '/workspace/project',
    } as unknown as OpenManusExecutionRequest;

    await expect(
      executeOpenManusRequest(unsafeRequest, { confinedAdapter: adapter }),
    ).rejects.toThrow('ambient host authority');
    expect(execute).not.toHaveBeenCalled();
  });
});
