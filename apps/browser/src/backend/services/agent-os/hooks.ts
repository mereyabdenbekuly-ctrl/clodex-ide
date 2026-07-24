import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { ModelWithOptions } from '@clodex/agent-core/host';
import {
  AGENT_OS_LIMITS,
  hookDefinitionSchema,
  hookTriggerSchema,
  isHookAutomaticallyRunnable,
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
  /**
   * Backend-only provenance captured at a lifecycle boundary. This field is
   * intentionally absent from Karton contracts and must never be persisted.
   */
  trustedLifecycle?: {
    readonly modelId: string;
    readonly modelWithOptions: ModelWithOptions | null;
    readonly snapshot: string;
  };
  /** Run exactly this hook, including when it is disabled (Settings > Test). */
  manualHookId?: string;
};

export type HelperAgentHookRunner = (input: {
  hook: HookDefinition;
  mode: 'automatic' | 'manual';
  context: Omit<HookRunContext, 'manualHookId'>;
}) => Promise<string | undefined>;

type AutomaticHelperSlot = {
  running: Promise<HookRunRecord>;
  pending: {
    hook: HookDefinition;
    context: HookRunContext;
    resolve: (run: HookRunRecord | null) => void;
    reject: (error: unknown) => void;
  } | null;
};

/** Strip every renderer-supplied field that could be mistaken for authority. */
export function sanitizeRendererHookRunContext(
  context: HookRunContext | undefined,
): HookRunContext {
  const agentInstanceId = context?.values?.agentInstanceId;
  return {
    manualHookId:
      typeof context?.manualHookId === 'string'
        ? context.manualHookId
        : undefined,
    values:
      typeof agentInstanceId === 'string' && agentInstanceId.trim()
        ? { agentInstanceId }
        : undefined,
  };
}

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
  private helperAgentRunner: HelperAgentHookRunner | null = null;
  private readonly automaticHelperSlots = new Map<
    string,
    AutomaticHelperSlot
  >();
  private readonly hookMutationFences = new Map<string, number>();
  private readonly hookMutationTails = new Map<string, Promise<void>>();
  private createMutationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly store: AgentOsStateStore,
    private readonly debug: DebugInspectorService,
    private readonly isAutomaticExecutionEnabled: () => boolean = () => true,
  ) {}

  /**
   * Installs the trusted composition-root seam for helper-agent hooks.
   * Merely persisting an `agent` hook never grants this capability.
   */
  public async setHelperAgentRunner(
    runner: HelperAgentHookRunner | null,
  ): Promise<void> {
    if (runner !== this.helperAgentRunner) this.cancelPendingAutomaticRuns();
    this.helperAgentRunner = runner;
    await this.store.update((draft) => {
      draft.hookRuntime.helperAgentRunnerConfigured = runner !== null;
    });
  }

  public async create(
    input: Omit<HookDefinition, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<HookDefinition> {
    return await this.withCreateMutation(async () => {
      if (this.store.snapshot().hooks.length >= AGENT_OS_LIMITS.maxHooks) {
        throw new Error(
          `Cannot create more than ${AGENT_OS_LIMITS.maxHooks} Agent OS hooks`,
        );
      }
      const now = Date.now();
      const hook = hookDefinitionSchema.parse({
        ...input,
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
      });
      this.assertCanEnable(hook);
      await this.store.update((draft) => {
        draft.hooks.push(hook);
      });
      return hook;
    });
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
    return await this.withHookMutation(hookId, async () => {
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
      this.assertCanEnable(updated);
      await this.store.update((draft) => {
        const index = draft.hooks.findIndex((hook) => hook.id === hookId);
        if (index >= 0) draft.hooks[index] = updated;
      });
      return updated;
    });
  }

  public async delete(hookId: string): Promise<void> {
    await this.withHookMutation(hookId, async () => {
      await this.store.update((draft) => {
        draft.hooks = draft.hooks.filter((hook) => hook.id !== hookId);
      });
    });
  }

  public async run(
    triggerValue: HookTrigger,
    context: HookRunContext = {},
  ): Promise<HookRunResult> {
    const trigger = hookTriggerSchema.parse(triggerValue);
    if (!context.manualHookId && !this.isAutomaticExecutionEnabled()) {
      return { promptText: '', runs: [] };
    }
    const snapshot = this.store.snapshot();
    let hooks: HookDefinition[];
    if (context.manualHookId) {
      const hook = snapshot.hooks.find(
        (candidate) => candidate.id === context.manualHookId,
      );
      if (!hook) throw new Error(`Unknown hook: ${context.manualHookId}`);
      if (this.isHookMutationFenced(hook.id)) {
        throw new Error(`Hook ${hook.id} is being updated`);
      }
      if (hook.trigger !== trigger) {
        throw new Error(
          `Hook ${hook.id} is registered for ${hook.trigger}, not ${trigger}`,
        );
      }
      if (hook.kind === 'agent' && !this.helperAgentRunner) {
        throw new Error(
          'Helper-agent hook runner is not configured in this build',
        );
      }
      hooks = [hook];
    } else {
      hooks = snapshot.hooks
        .filter(
          (hook) =>
            !this.isHookMutationFenced(hook.id) &&
            hook.enabled &&
            hook.trigger === trigger &&
            // An unavailable/unwired executor is not a hook attempt. Do not
            // manufacture `skipped · 0 ms` records on every lifecycle event.
            isHookAutomaticallyRunnable(hook, this.helperAgentRunner !== null),
        )
        .slice(0, AGENT_OS_LIMITS.maxHooks);
    }
    const runs: HookRunRecord[] = [];
    const prompts: string[] = [];

    const completedRuns = await Promise.all(
      hooks.map((hook) =>
        hook.kind === 'agent' && !context.manualHookId
          ? this.runAutomaticHelper(hook, context)
          : this.runHook(hook, context),
      ),
    );
    for (let index = 0; index < hooks.length; index += 1) {
      const hook = hooks[index]!;
      const run = completedRuns[index]!;
      if (!run) continue;
      runs.push(run);
      if (hook.kind === 'prompt' && run.status === 'succeeded' && run.output) {
        prompts.push(run.output);
      }
    }

    await this.persistRuns(runs);

    return { promptText: prompts.join('\n\n'), runs };
  }

  private async persistRuns(runs: HookRunRecord[]): Promise<void> {
    if (runs.length === 0) return;
    await this.store.update((draft) => {
      const existingIds = new Set(draft.hookRuns.map((run) => run.id));
      draft.hookRuns.push(...runs.filter((run) => !existingIds.has(run.id)));
      if (draft.hookRuns.length > AGENT_OS_LIMITS.maxHookRuns) {
        draft.hookRuns.splice(
          0,
          draft.hookRuns.length - AGENT_OS_LIMITS.maxHookRuns,
        );
      }
    });
  }

  private runAutomaticHelper(
    hook: HookDefinition,
    context: HookRunContext,
  ): Promise<HookRunRecord | null> {
    const agentId =
      typeof context.values?.agentInstanceId === 'string'
        ? context.values.agentInstanceId
        : 'unknown';
    const key = `${hook.id}:${agentId}`;
    if (
      !this.isAutomaticExecutionEnabled() ||
      this.isHookMutationFenced(hook.id)
    ) {
      return Promise.resolve(null);
    }
    const existing = this.automaticHelperSlots.get(key);
    if (existing) {
      existing.pending?.resolve(null);
      let resolve!: (run: HookRunRecord | null) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<HookRunRecord | null>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      existing.pending = {
        hook: structuredClone(hook),
        context: this.cloneRunContext(context),
        resolve,
        reject,
      };
      return promise;
    }
    if (
      this.automaticHelperSlots.size >= AGENT_OS_LIMITS.maxConcurrentHelperRuns
    ) {
      return Promise.resolve(null);
    }

    const run = this.runHook(hook, context);
    const slot: AutomaticHelperSlot = { running: run, pending: null };
    this.automaticHelperSlots.set(key, slot);
    this.armAutomaticHelperAdvance(key, slot, run);
    return run;
  }

  private armAutomaticHelperAdvance(
    key: string,
    slot: AutomaticHelperSlot,
    running: Promise<HookRunRecord>,
  ): void {
    const advance = (): void => {
      if (this.automaticHelperSlots.get(key) !== slot) return;
      const pending = slot.pending;
      if (!pending) {
        this.automaticHelperSlots.delete(key);
        return;
      }
      slot.pending = null;

      const current = this.store
        .snapshot()
        .hooks.find((candidate) => candidate.id === pending.hook.id);
      const lifecycleBinding =
        pending.context.trustedLifecycle?.modelWithOptions;
      const routeStillValid = pending.context.trustedLifecycle
        ? lifecycleBinding?.routeLease?.isValid() === true
        : true;
      if (
        !this.isAutomaticExecutionEnabled() ||
        this.isHookMutationFenced(pending.hook.id) ||
        !current?.enabled ||
        current.updatedAt !== pending.hook.updatedAt ||
        current.kind !== pending.hook.kind ||
        current.trigger !== pending.hook.trigger ||
        !isHookAutomaticallyRunnable(
          current,
          this.helperAgentRunner !== null,
        ) ||
        !routeStillValid
      ) {
        pending.resolve(null);
        this.automaticHelperSlots.delete(key);
        return;
      }

      const nextRun = this.runHook(current, pending.context);
      slot.running = nextRun;
      void nextRun.then(pending.resolve, pending.reject);
      this.armAutomaticHelperAdvance(key, slot, nextRun);
    };
    void running.then(advance, advance);
  }

  private cloneRunContext(context: HookRunContext): HookRunContext {
    return {
      ...context,
      values: context.values ? structuredClone(context.values) : undefined,
      trustedLifecycle: context.trustedLifecycle
        ? {
            modelId: context.trustedLifecycle.modelId,
            modelWithOptions: context.trustedLifecycle.modelWithOptions,
            snapshot: context.trustedLifecycle.snapshot,
          }
        : undefined,
    };
  }

  public cancelPendingAutomaticRuns(): void {
    for (const slot of this.automaticHelperSlots.values()) {
      slot.pending?.resolve(null);
      slot.pending = null;
    }
  }

  private beginHookMutation(hookId: string): void {
    for (const [key, slot] of this.automaticHelperSlots) {
      if (!key.startsWith(`${hookId}:`) || !slot.pending) continue;
      slot.pending.resolve(null);
      slot.pending = null;
    }
    this.hookMutationFences.set(
      hookId,
      (this.hookMutationFences.get(hookId) ?? 0) + 1,
    );
  }

  private endHookMutation(hookId: string): void {
    const remaining = (this.hookMutationFences.get(hookId) ?? 1) - 1;
    if (remaining <= 0) this.hookMutationFences.delete(hookId);
    else this.hookMutationFences.set(hookId, remaining);
  }

  private isHookMutationFenced(hookId: string): boolean {
    return (this.hookMutationFences.get(hookId) ?? 0) > 0;
  }

  private async withHookMutation<T>(
    hookId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    this.beginHookMutation(hookId);
    const previous = this.hookMutationTails.get(hookId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.hookMutationTails.set(hookId, tail);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.hookMutationTails.get(hookId) === tail) {
        this.hookMutationTails.delete(hookId);
      }
      this.endHookMutation(hookId);
    }
  }

  private async withCreateMutation<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.createMutationTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.createMutationTail = tail;

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.createMutationTail === tail) {
        this.createMutationTail = Promise.resolve();
      }
    }
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
        const helperAgentRunner = this.helperAgentRunner;
        if (!helperAgentRunner) {
          throw new Error(
            'Helper-agent hook runner is not configured in this build',
          );
        }
        output =
          (await helperAgentRunner({
            hook,
            mode: context.manualHookId ? 'manual' : 'automatic',
            context: {
              workspacePath: context.workspacePath,
              commandApproved: context.commandApproved,
              workspaceTrusted: context.workspaceTrusted,
              values: context.values,
              trustedLifecycle: context.trustedLifecycle,
            },
          })) ?? '';
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

  private assertCanEnable(hook: HookDefinition): void {
    if (
      hook.enabled &&
      !isHookAutomaticallyRunnable(hook, this.helperAgentRunner !== null)
    ) {
      throw new Error(
        hook.kind === 'agent' && !this.helperAgentRunner
          ? 'Cannot enable helper-agent hook: no trusted runner is configured'
          : `Cannot enable ${hook.kind} hook for ${hook.trigger}: this build has no safe automatic executor for that combination`,
      );
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
