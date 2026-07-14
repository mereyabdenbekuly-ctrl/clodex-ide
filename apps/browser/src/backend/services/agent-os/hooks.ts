import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import {
  AGENT_OS_LIMITS,
  hookDefinitionSchema,
  hookTriggerSchema,
  type HookDefinition,
  type HookRunRecord,
  type HookRunResult,
  type HookTrigger,
} from '@shared/agent-os';
import type { AgentOsStateStore } from './state-store';
import type { DebugInspectorService } from './debug-inspector';
import { redactSensitiveText } from './privacy';

export type HookRunContext = {
  workspacePath?: string;
  commandApproved?: boolean;
  workspaceTrusted?: boolean;
  values?: Record<string, unknown>;
};

const TASKKILL_WATCHDOG_MS = 2_000;
const TERMINATION_FALLBACK_MS = 3_000;

function createSafeEnv(): NodeJS.ProcessEnv {
  const allowed = [
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
  ];
  if (process.platform === 'win32') {
    allowed.push('SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT');
  }
  return Object.fromEntries(
    allowed
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function appendCapped(current: string, chunk: Buffer | string): string {
  if (Buffer.byteLength(current) >= AGENT_OS_LIMITS.maxHookOutputBytes) {
    return current;
  }
  const next = `${current}${chunk.toString()}`;
  if (Buffer.byteLength(next) <= AGENT_OS_LIMITS.maxHookOutputBytes) {
    return next;
  }
  return Buffer.from(next)
    .subarray(0, AGENT_OS_LIMITS.maxHookOutputBytes)
    .toString('utf-8');
}

function killDirectChild(child: ChildProcess): void {
  try {
    child.kill('SIGKILL');
  } catch {
    // The process already exited or can no longer be signalled.
  }
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminateOwnedProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    killDirectChild(child);
    return;
  }

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      killDirectChild(child);
    }
    return;
  }

  if (hasChildExited(child)) return;

  const systemRoot = process.env.SYSTEMROOT ?? process.env.WINDIR;
  const taskkill =
    systemRoot && path.win32.isAbsolute(systemRoot)
      ? path.win32.join(systemRoot, 'System32', 'taskkill.exe')
      : 'taskkill.exe';

  await new Promise<void>((resolve) => {
    // Node does not expose a Job Object handle here. Re-check the process
    // handle immediately before taskkill to reduce the best-effort PID reuse
    // window, then bound taskkill itself so timeout handling cannot hang.
    if (hasChildExited(child)) {
      resolve();
      return;
    }

    let killer: ChildProcess;
    try {
      killer = spawn(taskkill, ['/pid', String(pid), '/t', '/f'], {
        env: createSafeEnv(),
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      killDirectChild(child);
      resolve();
      return;
    }

    let finished = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const finish = (fallbackToDirectKill: boolean): void => {
      if (finished) return;
      finished = true;
      if (watchdog) clearTimeout(watchdog);
      if (fallbackToDirectKill) killDirectChild(child);
      resolve();
    };
    watchdog = setTimeout(() => {
      killDirectChild(killer);
      finish(true);
    }, TASKKILL_WATCHDOG_MS);
    killer.once('error', () => finish(true));
    killer.once('close', (code) => finish(code !== 0));
  });
}

export class HooksService {
  public constructor(
    private readonly store: AgentOsStateStore,
    private readonly debug: DebugInspectorService,
  ) {}

  public async create(
    input: Omit<HookDefinition, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<HookDefinition> {
    const now = Date.now();
    const hook = hookDefinitionSchema.parse({
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
    await this.store.update((draft) => {
      draft.hooks.push(hook);
    });
    return hook;
  }

  public async update(
    hookId: string,
    patch: Partial<
      Pick<
        HookDefinition,
        'name' | 'trigger' | 'kind' | 'body' | 'enabled' | 'timeoutMs'
      >
    >,
  ): Promise<HookDefinition> {
    const existing = this.store
      .snapshot()
      .hooks.find((hook) => hook.id === hookId);
    if (!existing) throw new Error(`Unknown hook: ${hookId}`);
    const updated = hookDefinitionSchema.parse({
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    });
    await this.store.update((draft) => {
      const index = draft.hooks.findIndex((hook) => hook.id === hookId);
      if (index >= 0) draft.hooks[index] = updated;
    });
    return updated;
  }

  public async delete(hookId: string): Promise<void> {
    await this.store.update((draft) => {
      draft.hooks = draft.hooks.filter((hook) => hook.id !== hookId);
    });
  }

  public async run(
    triggerValue: HookTrigger,
    context: HookRunContext = {},
  ): Promise<HookRunResult> {
    const trigger = hookTriggerSchema.parse(triggerValue);
    const hooks = this.store
      .snapshot()
      .hooks.filter((hook) => hook.enabled && hook.trigger === trigger);
    const runs: HookRunRecord[] = [];
    const prompts: string[] = [];

    for (const hook of hooks) {
      const run = await this.runHook(hook, context);
      runs.push(run);
      if (hook.kind === 'prompt' && run.status === 'succeeded' && run.output) {
        prompts.push(run.output);
      }
    }

    if (runs.length > 0) {
      await this.store.update((draft) => {
        draft.hookRuns.push(...runs);
        if (draft.hookRuns.length > AGENT_OS_LIMITS.maxHookRuns) {
          draft.hookRuns.splice(
            0,
            draft.hookRuns.length - AGENT_OS_LIMITS.maxHookRuns,
          );
        }
      });
    }

    return { promptText: prompts.join('\n\n'), runs };
  }

  private async runHook(
    hook: HookDefinition,
    context: HookRunContext,
  ): Promise<HookRunRecord> {
    const startedAt = Date.now();
    this.debug.record({
      channel: 'hook',
      level: 'info',
      message: `Running hook: ${hook.name}`,
      payload: { hookId: hook.id, trigger: hook.trigger, kind: hook.kind },
    });

    try {
      let output: string;
      if (hook.kind === 'prompt') {
        output = hook.body;
      } else if (hook.kind === 'command') {
        if (!context.commandApproved || !context.workspaceTrusted) {
          return this.finishRun({
            hook,
            startedAt,
            status: 'skipped',
            error:
              'Command hooks require explicit approval and a trusted workspace',
          });
        }
        output = await this.runCommand(hook, context.workspacePath);
      } else {
        return this.finishRun({
          hook,
          startedAt,
          status: 'skipped',
          error: 'Agent hook runner is not configured in this MVP',
        });
      }

      return this.finishRun({
        hook,
        startedAt,
        status: 'succeeded',
        output: redactSensitiveText(output),
      });
    } catch (error) {
      return this.finishRun({
        hook,
        startedAt,
        status: 'failed',
        error: redactSensitiveText(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
  }

  private async runCommand(
    hook: HookDefinition,
    workspacePath?: string,
  ): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const isWindows = process.platform === 'win32';
      const command = isWindows
        ? (process.env.COMSPEC ?? 'cmd.exe')
        : '/bin/sh';
      // cmd /s needs an outer quote pair around the complete command. Letting
      // libuv quote it again makes a quoted executable name a literal token.
      const args = isWindows
        ? ['/d', '/s', '/c', `"${hook.body}"`]
        : ['-lc', hook.body];
      const child = spawn(command, args, {
        cwd: workspacePath,
        detached: !isWindows,
        env: createSafeEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: isWindows,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      let terminationFinished = true;
      let terminationFallback: ReturnType<typeof setTimeout> | undefined;
      let spawnError: Error | undefined;
      let closeResult:
        | { code: number | null; signal: NodeJS.Signals | null }
        | undefined;

      const settle = (): void => {
        if (
          settled ||
          closeResult === undefined ||
          (timedOut && !terminationFinished)
        ) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (terminationFallback) clearTimeout(terminationFallback);
        if (timedOut) {
          reject(new Error(`Hook timed out after ${hook.timeoutMs}ms`));
          return;
        }
        if (spawnError) {
          reject(spawnError);
          return;
        }
        if (closeResult.code === 0) {
          resolve(stdout.trim());
          return;
        }
        reject(
          new Error(
            `Hook exited with ${closeResult.signal ?? closeResult.code ?? 'unknown'}${
              stderr.trim() ? `: ${stderr.trim()}` : ''
            }`,
          ),
        );
      };

      const timeout = setTimeout(() => {
        if (settled || timedOut) return;
        timedOut = true;
        terminationFinished = false;
        terminationFallback = setTimeout(() => {
          if (settled) return;
          // Without a Windows Job Object there is no stronger terminal fence.
          // Bound the best-effort cleanup and release our pipes so a missing
          // child `close` event cannot hang the hook runner indefinitely.
          killDirectChild(child);
          child.stdout.destroy();
          child.stderr.destroy();
          terminationFinished = true;
          closeResult ??= {
            code: child.exitCode,
            signal: child.signalCode,
          };
          settle();
        }, TERMINATION_FALLBACK_MS);
        const finishTermination = (): void => {
          terminationFinished = true;
          settle();
        };
        void terminateOwnedProcessTree(child).then(
          finishTermination,
          finishTermination,
        );
      }, hook.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout = appendCapped(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = appendCapped(stderr, chunk);
      });
      child.on('error', (error) => {
        spawnError = error;
      });
      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        closeResult = { code, signal };
        settle();
      });
    });
  }

  private finishRun(input: {
    hook: HookDefinition;
    startedAt: number;
    status: HookRunRecord['status'];
    output?: string;
    error?: string;
  }): HookRunRecord {
    const run: HookRunRecord = {
      id: randomUUID(),
      hookId: input.hook.id,
      trigger: input.hook.trigger,
      startedAt: input.startedAt,
      finishedAt: Date.now(),
      status: input.status,
      output: input.output,
      error: input.error,
    };
    this.debug.record({
      channel: 'hook',
      level: run.status === 'failed' ? 'error' : 'info',
      message: `Hook ${input.hook.name}: ${run.status}`,
      payload: {
        hookId: input.hook.id,
        durationMs: run.finishedAt - run.startedAt,
        error: run.error,
      },
    });
    return run;
  }
}
