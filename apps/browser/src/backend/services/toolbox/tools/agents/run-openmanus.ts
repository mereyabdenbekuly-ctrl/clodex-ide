import type { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  OpenManusExecutionRequest,
  OpenManusExecutionResult,
} from '@/agent-host';
import { executeOpenManusRequest } from '@/agent-host/openmanus-runtime';
import type { AuthService } from '@/services/auth';
import { getPluginsPath } from '@/utils/paths';
import type { ModelProvider } from '@shared/karton-contracts/ui/shared-types';
import {
  runOpenManusToolInputSchema,
  type RunOpenManusToolInput,
} from '@shared/karton-contracts/ui/agent/tools/types';
import { tool } from 'ai';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_OPENMANUS_MODEL = 'gpt-5.5';
const DEFAULT_OPENMANUS_MAX_TOKENS = 8192;

type WorkspaceMount = {
  prefix: string;
  path: string;
};

type RunOpenManusDeps = {
  getWorkspaceMounts: () => readonly WorkspaceMount[];
  resolvedEnvPromise: Promise<Record<string, string> | null>;
  authService?: Pick<
    AuthService,
    'ensureModelAccessToken' | 'ensureModelAccessTokenForRoute'
  >;
  spawnProcess?: typeof spawn;
  resolveOpenManusHome?: () => Promise<string | null>;
  isolatedExecution?: {
    isAvailable: () => boolean;
    execute: (
      request: OpenManusExecutionRequest,
      options: { signal?: AbortSignal },
    ) => Promise<OpenManusExecutionResult>;
  };
};

export const DESCRIPTION = `Run OpenManus as an external autonomous agent inside a mounted workspace.

Use this for long autonomous research/execution tasks that benefit from OpenManus' own Python agent loop. Prefer normal Clodex file/edit tools for direct code changes that should become Pending Edits.

Parameters:
- prompt (string, REQUIRED): The task for OpenManus.
- mountPrefix (string, REQUIRED): Workspace mount prefix to run in, e.g. "w48b2".
- timeoutMs (number, optional): Maximum runtime. Defaults to 10 minutes, capped at 30 minutes.

Prerequisites:
- Set OPENMANUS_HOME to a local OpenManus checkout, or place OpenManus at bundled/plugins/openmanus.
- Optionally set OPENMANUS_PYTHON to the Python executable. Defaults to python3.
- Uses the active Clodex IDE model token when available. OPENMANUS_MODEL can override the default model.`;

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveOpenManusHome(): Promise<string | null> {
  const candidates = [
    process.env.OPENMANUS_HOME,
    path.join(getPluginsPath(), 'openmanus'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const mainPath = path.join(candidate, 'main.py');
    if (await exists(mainPath)) return candidate;
  }

  return null;
}

function resolveWorkspacePath(
  mounts: readonly WorkspaceMount[],
  mountPrefix: string,
): string {
  const mount = mounts.find((item) => item.prefix === mountPrefix);
  if (!mount) {
    throw new Error(
      `Workspace mount "${mountPrefix}" not found. Available mounts: ${mounts.map((item) => item.prefix).join(', ') || 'none'}.`,
    );
  }
  return mount.path;
}

function clampTimeoutMs(timeoutMs: number | undefined): number {
  if (!timeoutMs || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1_000, Math.min(Math.round(timeoutMs), MAX_TIMEOUT_MS));
}

function resolveProviderFromModel(modelId: string): ModelProvider {
  const normalized = modelId.toLowerCase();
  if (normalized.startsWith('claude-') || normalized.includes('opus')) {
    return 'anthropic';
  }
  if (normalized.startsWith('gemini-') || normalized.includes('gemini')) {
    return 'google';
  }
  if (normalized.startsWith('kimi-')) return 'moonshotai';
  if (normalized.startsWith('qwen')) return 'alibaba';
  if (normalized.startsWith('deepseek-')) return 'deepseek';
  if (normalized.startsWith('glm-')) return 'z-ai';
  if (normalized.startsWith('minimax-')) return 'minimax';
  if (normalized.startsWith('mimo-')) return 'xiaomi-mimo';
  if (normalized.startsWith('mistral-')) return 'mistral';
  return 'openai';
}

function resolveOpenManusProvider(
  env: Record<string, string | undefined>,
  modelId: string,
): ModelProvider {
  const provider = env.OPENMANUS_PROVIDER?.trim().toLowerCase();
  switch (provider) {
    case 'anthropic':
    case 'openai':
    case 'google':
    case 'moonshotai':
    case 'alibaba':
    case 'deepseek':
    case 'z-ai':
    case 'minimax':
    case 'xiaomi-mimo':
    case 'mistral':
      return provider;
    case 'claude':
      return 'anthropic';
    case 'gemini':
      return 'google';
    default:
      return resolveProviderFromModel(modelId);
  }
}

async function resolveOpenManusApiKey({
  deps,
  env,
  provider,
  modelId,
}: {
  deps: RunOpenManusDeps;
  env: Record<string, string | undefined>;
  provider: ModelProvider;
  modelId: string;
}): Promise<string | undefined> {
  if (env.OPENMANUS_API_KEY) return env.OPENMANUS_API_KEY;

  if (deps.authService) {
    const routeToken = await deps.authService.ensureModelAccessTokenForRoute?.({
      provider,
      modelId,
    });
    if (routeToken) return routeToken;

    if (!deps.authService.ensureModelAccessTokenForRoute) {
      const genericToken = await deps.authService.ensureModelAccessToken();
      if (genericToken) return genericToken;
    }
  }

  return (
    env.CLODEX_IDE_MODEL_TOKEN ||
    env.OPENAI_API_KEY ||
    env.ANTHROPIC_API_KEY ||
    env.GOOGLE_GENERATIVE_AI_API_KEY ||
    env.GOOGLE_API_KEY
  );
}

export async function runOpenManusToolExecute(
  input: RunOpenManusToolInput,
  deps: RunOpenManusDeps,
  signal?: AbortSignal,
) {
  const openManusHome = await (
    deps.resolveOpenManusHome ?? resolveOpenManusHome
  )();
  if (!openManusHome) {
    return {
      message:
        'OpenManus is not installed. Set OPENMANUS_HOME to a local FoundationAgents/OpenManus checkout, or place it at bundled/plugins/openmanus.',
      exitCode: null,
      timedOut: false,
      workspacePath: resolveWorkspacePath(
        deps.getWorkspaceMounts(),
        input.mountPrefix,
      ),
      openManusHome: null,
      stdout: '',
      stderr: '',
    };
  }

  const workspacePath = resolveWorkspacePath(
    deps.getWorkspaceMounts(),
    input.mountPrefix,
  );
  const python = process.env.OPENMANUS_PYTHON || 'python3';
  const timeoutMs = clampTimeoutMs(input.timeoutMs);
  const resolvedEnv = (await deps.resolvedEnvPromise) ?? {};
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...resolvedEnv,
  };
  const modelId = env.OPENMANUS_MODEL || DEFAULT_OPENMANUS_MODEL;
  const provider = resolveOpenManusProvider(env, modelId);
  const baseUrl =
    env.OPENMANUS_BASE_URL ||
    env.CLODEX_LLM_RELAY_URL ||
    env.LLM_PROXY_URL ||
    'https://clodex.xyz/v1';
  const apiKey = await resolveOpenManusApiKey({
    deps,
    env,
    provider,
    modelId,
  });

  if (!apiKey) {
    return {
      message:
        'OpenManus is installed, but no model API key is available. Sign in to Clodex or set OPENMANUS_API_KEY.',
      exitCode: null,
      timedOut: false,
      workspacePath,
      openManusHome,
      stdout: '',
      stderr: '',
    };
  }

  const request: OpenManusExecutionRequest = {
    prompt: input.prompt,
    mountPrefix: input.mountPrefix,
    workspacePath,
    openManusHome,
    pythonExecutable: python,
    timeoutMs,
    modelId,
    baseUrl,
    apiKey,
    maxTokens: DEFAULT_OPENMANUS_MAX_TOKENS,
    environment: createOpenManusChildEnvironment(env),
  };

  if (deps.isolatedExecution) {
    if (!deps.isolatedExecution.isAvailable()) {
      throw new Error(
        'Agent utility process is temporarily unavailable; retry the OpenManus run after it restarts.',
      );
    }
    return await deps.isolatedExecution.execute(request, { signal });
  }
  return await executeOpenManusRequest(request, {
    signal,
    spawnProcess: deps.spawnProcess,
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

const OPENMANUS_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'WINDIR',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'APPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PATHEXT',
  'COMSPEC',
  'VIRTUAL_ENV',
  'PYENV_ROOT',
  'CONDA_PREFIX',
  'CONDA_DEFAULT_ENV',
  'PYTHONIOENCODING',
  'PYTHONUTF8',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);

function createOpenManusChildEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        OPENMANUS_ENV_ALLOWLIST.has(entry[0]) && typeof entry[1] === 'string',
    ),
  );
}
