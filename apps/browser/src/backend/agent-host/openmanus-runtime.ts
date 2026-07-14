import type {
  OpenManusExecutionRequest,
  OpenManusExecutionResult,
} from './protocol';

export const OPENMANUS_OS_CONFINED_ADAPTER_PROFILE = Object.freeze({
  kind: 'clodex.openmanus-os-confined-adapter',
  version: 1,
  workspaceAuthority: 'trusted-object-capability',
  credentialAuthority: 'brokered-no-raw-secret',
  networkAuthority: 'adapter-owned-deny-by-default',
  hostWorkspaceAccess: false,
  hostProcessExecution: false,
} as const);

export class OpenManusConfinementUnavailableError extends Error {
  public constructor(
    message = 'OpenManus execution is disabled until an OS-confined, brokered adapter is installed',
  ) {
    super(message);
    this.name = 'OpenManusConfinementUnavailableError';
  }
}

/**
 * Trusted execution boundary for OpenManus.
 *
 * The adapter owns workspace capability resolution, credential brokering,
 * network policy, executable/image identity, resource limits, and final
 * dispatch fencing. None of those authorities may be selected through the IPC
 * request. In particular, raw credentials, host paths, argv, environment, or
 * network endpoints are intentionally absent from `OpenManusExecutionRequest`.
 */
export interface OpenManusOsConfinedAdapter {
  readonly profile: typeof OPENMANUS_OS_CONFINED_ADAPTER_PROFILE;
  execute(
    request: OpenManusExecutionRequest,
    options: { signal?: AbortSignal },
  ): Promise<OpenManusExecutionResult>;
}

export interface OpenManusRuntimeOptions {
  signal?: AbortSignal;
  confinedAdapter?: OpenManusOsConfinedAdapter;
}

/**
 * Execute only through a trusted OS-confined adapter.
 *
 * The former host `spawn()` path deliberately no longer exists. A plain
 * Electron utility process is a fault boundary, not an OS sandbox, and must
 * never receive a raw API key or a host-workspace path. Production currently
 * injects no confined adapter, so this function fails closed.
 */
export async function executeOpenManusRequest(
  request: OpenManusExecutionRequest,
  options: OpenManusRuntimeOptions = {},
): Promise<OpenManusExecutionResult> {
  throwIfAborted(options.signal);
  validateRequest(request);

  const adapter = options.confinedAdapter;
  if (!adapter || adapter.profile !== OPENMANUS_OS_CONFINED_ADAPTER_PROFILE) {
    throw new OpenManusConfinementUnavailableError();
  }

  return await adapter.execute(Object.freeze({ ...request }), {
    signal: options.signal,
  });
}

function validateRequest(request: OpenManusExecutionRequest): void {
  if (
    !request ||
    typeof request !== 'object' ||
    Object.getPrototypeOf(request) !== Object.prototype ||
    Object.getOwnPropertySymbols(request).length !== 0
  ) {
    throw new OpenManusConfinementUnavailableError(
      'OpenManus request must be a closed data object',
    );
  }
  const keys = Object.keys(request).sort();
  const expected = ['maxTokens', 'mountPrefix', 'prompt', 'timeoutMs'];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new OpenManusConfinementUnavailableError(
      'OpenManus request contains ambient host authority',
    );
  }
  if (
    typeof request.prompt !== 'string' ||
    request.prompt.length === 0 ||
    typeof request.mountPrefix !== 'string' ||
    request.mountPrefix.length === 0 ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    !Number.isSafeInteger(request.maxTokens) ||
    request.maxTokens <= 0
  ) {
    throw new OpenManusConfinementUnavailableError(
      'OpenManus request is invalid',
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('OpenManus execution was aborted', 'AbortError');
  }
}
