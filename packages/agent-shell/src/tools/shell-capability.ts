import type {
  CreateShellSessionToolInput,
  ExecuteShellCommandToolInput,
} from '../schemas';

export type ShellCapabilityOperation =
  | 'create'
  | 'command'
  | 'stdin'
  | 'kill'
  | 'poll';

/**
 * Canonical, content-bearing shell action used only inside the trusted host.
 * Audit sinks should persist the derived action hash, not this raw payload.
 */
export interface ShellCapabilityAction {
  operation: ShellCapabilityOperation;
  sessionId: string;
  command: string;
  cwdPrefix: string;
  /** Exact host path committed for a `create` action. Never exposed to agents. */
  resolvedCwd?: string;
  waitUntil: {
    timeoutMs: number | null;
    exited: boolean | null;
    outputPattern: string | null;
    idleMs: number | null;
  };
}

export type ShellCapabilityAuthorization = 'policy-approved' | 'human-required';

export interface StageShellCapabilityInput {
  agentInstanceId: string;
  toolCallId: string;
  /** Host-owned scope for one agent step / approval continuation chain. */
  scopeId: string;
  action: ShellCapabilityAction;
  authorization: ShellCapabilityAuthorization;
}

export interface ConsumeShellCapabilityInput {
  agentInstanceId: string;
  toolCallId: string;
  scopeId: string;
  /** Trusted host evidence that this exact call was affirmatively approved. */
  humanApprovalEvidence: boolean;
  action: ShellCapabilityAction;
}

/**
 * Trusted host-side capability broker. When configured, every shell
 * effect must first be staged during `needsApproval` and consumed exactly
 * once immediately before a PTY is spawned or receives bytes.
 */
export interface ShellCapabilitySecurityDeps {
  /** Returns the effective fail-closed authorization after restaging. */
  stage(
    input: StageShellCapabilityInput,
  ): ShellCapabilityAuthorization | Promise<ShellCapabilityAuthorization>;
  consume(input: ConsumeShellCapabilityInput): void | Promise<void>;
}

export function createShellSessionCapabilityAction(
  input: CreateShellSessionToolInput,
  resolvedCwd: string,
): ShellCapabilityAction {
  return {
    operation: 'create',
    sessionId: '',
    command: '',
    cwdPrefix: input.cwd,
    resolvedCwd,
    waitUntil: {
      timeoutMs: null,
      exited: null,
      outputPattern: null,
      idleMs: null,
    },
  };
}

export function createShellCapabilityAction(
  input: ExecuteShellCommandToolInput,
  cwdPrefix: string,
): ShellCapabilityAction {
  const operation: ShellCapabilityOperation = input.kill
    ? 'kill'
    : input.stdin !== undefined
      ? 'stdin'
      : (input.command ?? '') === ''
        ? 'poll'
        : 'command';

  return {
    operation,
    sessionId: input.session_id ?? '',
    command:
      operation === 'stdin'
        ? expandShellCapabilityEscapes(input.stdin ?? '')
        : operation === 'command'
          ? (input.command ?? '')
          : '',
    cwdPrefix,
    waitUntil: {
      timeoutMs: input.wait_until?.timeout_ms ?? null,
      exited: input.wait_until?.exited ?? null,
      outputPattern: input.wait_until?.output_pattern ?? null,
      idleMs: input.wait_until?.idle_ms ?? null,
    },
  };
}

/**
 * Mirrors execute-shell-command's byte normalization so approval is bound to
 * the exact stdin bytes delivered to the PTY rather than the JSON spelling.
 */
function expandShellCapabilityEscapes(value: string): string {
  const escapes: Record<string, string> = {
    r: '\r',
    n: '\n',
    t: '\t',
    a: '\x07',
    b: '\b',
    '\\': '\\',
  };
  return value.replace(
    /\\(x[0-9a-fA-F]{2}|r|n|t|a|b|\\)/g,
    (match, sequence: string) => {
      if (sequence.startsWith('x')) {
        return String.fromCharCode(Number.parseInt(sequence.slice(1), 16));
      }
      return escapes[sequence] ?? match;
    },
  );
}
