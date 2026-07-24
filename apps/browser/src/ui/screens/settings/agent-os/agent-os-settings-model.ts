import {
  HOST_WIRED_HOOK_TRIGGERS,
  isHookAutomaticallyRunnable,
  type ChronicleEvent,
  type HookDefinition,
  type HookRunRecord,
} from '@shared/agent-os';

export type HookExecutionAvailability = {
  canEnable: boolean;
  canTest: boolean;
  explanation: string | null;
};

export function getHookExecutionAvailability(
  hook: Pick<HookDefinition, 'trigger' | 'kind'>,
  helperAgentRunnerConfigured: boolean,
  activeAgentAvailable = true,
): HookExecutionAvailability {
  const canEnable = isHookAutomaticallyRunnable(
    hook,
    helperAgentRunnerConfigured,
  );

  if (hook.kind === 'agent' && !helperAgentRunnerConfigured) {
    return {
      canEnable: false,
      canTest: false,
      explanation:
        'Inactive: this build has no trusted helper-agent runner configured.',
    };
  }

  if (hook.kind === 'agent' && hook.trigger === 'before-turn') {
    return {
      canEnable: false,
      canTest: activeAgentAvailable,
      explanation: activeAgentAvailable
        ? 'Manual test only: Before turn helper-agent hooks do not run automatically; use a Before turn prompt hook to affect the admitted message.'
        : 'Manual test only: Before turn helper-agent hooks do not run automatically. Open an agent chat to test this hook.',
    };
  }

  if (hook.kind === 'agent' && !activeAgentAvailable) {
    return {
      canEnable,
      canTest: false,
      explanation:
        'Open an agent chat before testing this helper hook manually.',
    };
  }

  if (hook.kind === 'command') {
    return {
      canEnable: false,
      canTest: false,
      explanation:
        'Unavailable: command hooks require a backend-issued one-shot approval that is not implemented in this build.',
    };
  }

  if (!HOST_WIRED_HOOK_TRIGGERS.some((trigger) => trigger === hook.trigger)) {
    return {
      canEnable: false,
      canTest: true,
      explanation:
        'Manual test only: this lifecycle trigger has no automatic producer in this build.',
    };
  }

  if (hook.kind === 'prompt' && hook.trigger !== 'before-turn') {
    return {
      canEnable: false,
      canTest: true,
      explanation:
        'Manual test only: only Before turn prompt output is injected into model context.',
    };
  }

  return { canEnable, canTest: true, explanation: null };
}

export function getHookRunDisplay(run: HookRunRecord): {
  summary: string;
  detail: string | null;
  detailKind: 'error' | 'output' | null;
} {
  const durationMs = Math.max(0, run.finishedAt - run.startedAt);
  const detail = run.error ?? run.output ?? null;
  return {
    summary: `${run.status === 'skipped' ? 'not run' : run.status} · ${durationMs} ms`,
    detail,
    detailKind: run.error ? 'error' : run.output ? 'output' : null,
  };
}

export function createChronicleContext(events: ChronicleEvent[]): string {
  const context = events
    .map(
      (event) => `- ${new Date(event.capturedAt).toISOString()}: ${event.text}`,
    )
    .join('\n');
  return `<chronicle-context>\n${context}\n</chronicle-context>\n\n`;
}

export function schedulePrefillWhenChatReady(options: {
  isReady: () => boolean;
  requestPrefill: () => void;
  scheduleFrame: (callback: () => void) => void;
  maxWaitFrames?: number;
}): void {
  const maxWaitFrames = Math.max(0, options.maxWaitFrames ?? 10);
  let waitedFrames = 0;
  const attempt = () => {
    if (options.isReady() || waitedFrames >= maxWaitFrames) {
      options.requestPrefill();
      return;
    }
    waitedFrames += 1;
    options.scheduleFrame(attempt);
  };
  options.scheduleFrame(attempt);
}

export type SkillDropDataTransfer<TFile> = {
  files: ArrayLike<TFile>;
  getData: (format: string) => string;
};

export function resolveDroppedSkillPath<TFile>(
  dataTransfer: SkillDropDataTransfer<TFile>,
  getPathForFile: (file: TFile) => string | null | undefined,
): string | null {
  const file = dataTransfer.files[0];
  if (file !== undefined) {
    const nativePath = getPathForFile(file);
    if (nativePath) return nativePath;
  }

  const uri = dataTransfer
    .getData('text/uri-list')
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate && !candidate.startsWith('#'));
  if (!uri) return null;

  try {
    const parsed = new URL(uri);
    if (
      parsed.protocol !== 'file:' ||
      (parsed.hostname && parsed.hostname !== 'localhost')
    ) {
      return null;
    }
    const decodedPath = decodeURIComponent(parsed.pathname);
    return /^\/[A-Za-z]:\//.test(decodedPath)
      ? decodedPath.slice(1)
      : decodedPath;
  } catch {
    return null;
  }
}
