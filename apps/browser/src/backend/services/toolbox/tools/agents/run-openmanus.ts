import {
  executeOpenManusRequest,
  type OpenManusOsConfinedAdapter,
} from '@/agent-host/openmanus-runtime';
import type { OpenManusExecutionRequest } from '@/agent-host/protocol';
import {
  runOpenManusToolInputSchema,
  type RunOpenManusToolInput,
} from '@shared/karton-contracts/ui/agent/tools/types';
import { tool } from 'ai';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_OPENMANUS_MAX_TOKENS = 8192;

type WorkspaceMount = {
  prefix: string;
};

type RunOpenManusDeps = {
  getWorkspaceMounts: () => readonly WorkspaceMount[];
  /** Only this fixed, trusted capability may execute OpenManus. */
  confinedExecution?: OpenManusOsConfinedAdapter;
};

export const DESCRIPTION = `Run OpenManus through a trusted OS-confined adapter inside a mounted workspace.

Use this for long autonomous research/execution tasks that benefit from OpenManus' own Python agent loop. Prefer normal Clodex file/edit tools for direct code changes that should become Pending Edits.

Parameters:
- prompt (string, REQUIRED): The task for OpenManus.
- mountPrefix (string, REQUIRED): Workspace mount prefix to run in, e.g. "w48b2".
- timeoutMs (number, optional): Maximum runtime. Defaults to 10 minutes, capped at 30 minutes.

Prerequisites:
- A provisioned adapter must resolve the mount prefix to a trusted object capability.
- Credentials must be brokered inside that adapter; no raw API key crosses a tool or IPC request.
- Network is deny-by-default and selected by the adapter, never by the model or host environment.

Until such an adapter is installed, this tool fails closed.`;

function clampTimeoutMs(timeoutMs: number | undefined): number {
  if (!timeoutMs || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(Math.round(timeoutMs), MAX_TIMEOUT_MS));
}

export async function runOpenManusToolExecute(
  input: RunOpenManusToolInput,
  deps: RunOpenManusDeps,
  signal?: AbortSignal,
) {
  const mounts = deps.getWorkspaceMounts();
  if (!mounts.some((mount) => mount.prefix === input.mountPrefix)) {
    throw new Error(
      `Workspace mount "${input.mountPrefix}" is not available to this agent`,
    );
  }
  const timeoutMs = clampTimeoutMs(input.timeoutMs);

  const request: OpenManusExecutionRequest = {
    prompt: input.prompt,
    mountPrefix: input.mountPrefix,
    timeoutMs,
    maxTokens: DEFAULT_OPENMANUS_MAX_TOKENS,
  };
  return await executeOpenManusRequest(request, {
    signal,
    confinedAdapter: deps.confinedExecution,
  });
}

export const runOpenManus = (deps: RunOpenManusDeps) =>
  tool({
    description: DESCRIPTION,
    inputSchema: runOpenManusToolInputSchema,
    strict: false,
    execute: async (input, options) =>
      runOpenManusToolExecute(input, deps, options.abortSignal),
  });
