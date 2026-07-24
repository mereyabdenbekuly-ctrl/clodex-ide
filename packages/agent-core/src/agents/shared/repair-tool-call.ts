import { NoSuchToolError, type Tool } from 'ai';

export type ToolCallRecoveryKind =
  | 'truncated-input'
  | 'invalid-input'
  | 'unknown-tool';

export type ToolCallRecoverySignal = {
  readonly kind: ToolCallRecoveryKind;
  readonly toolNames: readonly string[];
};

const TOOL_CALL_RECOVERY_KIND_PROPERTY = 'clodexToolCallRecoveryKind';
const TOOL_CALL_RECOVERY_MESSAGE_PREFIX = 'Recoverable tool call rejection';
const MAX_RECOVERY_TOOL_NAME_CHARS = 128;
const localRecoveryKinds = new WeakMap<object, ToolCallRecoveryKind>();

/**
 * Shape we actually consume from a zod validation issue. Kept structural so
 * the helper doesn't depend on a specific zod major/minor version.
 */
type StructuralZodIssue = {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
};

/**
 * Format zod issues into a compact, LLM-facing bullet list. Each line is one
 * issue: `- <dot-path>: <message>`. Root-level issues use `(root)`. The list
 * is capped in both the number of issues and per-message length to keep the
 * resulting error text bounded (zod can emit kilobyte-sized messages for
 * discriminated-union failures).
 */
const MAX_ISSUES = 20;
const MAX_MESSAGE_CHARS = 200;

function formatZodIssues(issues: readonly StructuralZodIssue[]): string {
  const lines = issues.slice(0, MAX_ISSUES).map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : '(root)';
    const message =
      issue.message.length > MAX_MESSAGE_CHARS
        ? `${issue.message.slice(0, MAX_MESSAGE_CHARS)}…`
        : issue.message;
    return `- ${path}: ${message}`;
  });
  if (issues.length > MAX_ISSUES) {
    lines.push(`- ...${issues.length - MAX_ISSUES} more issues omitted.`);
  }
  return lines.join('\n');
}

export type RepairToolCallArgs = {
  toolCall: { toolName: string; input: string };
  tools: Record<string, Tool>;
  error: unknown;
};

function annotateRecoverableError(
  error: unknown,
  kind: ToolCallRecoveryKind,
  message: string,
): null {
  if (error && typeof error === 'object') {
    // WeakMap classification survives frozen/provider-owned Error objects
    // without mutating them. Remote executors fall back to the message or to
    // the generic invalid-input classification.
    localRecoveryKinds.set(error, kind);
  }
  if (error instanceof Error) {
    try {
      error.message = `${TOOL_CALL_RECOVERY_MESSAGE_PREFIX} (${kind}): ${message}`;
      Object.defineProperty(error, TOOL_CALL_RECOVERY_KIND_PROPERTY, {
        configurable: true,
        enumerable: false,
        value: kind,
      });
    } catch {
      // Returning null is the safety boundary. Never turn a provider-owned or
      // frozen parse error into a fatal ToolCallRepairError merely because its
      // diagnostic message could not be annotated.
    }
  }
  return null;
}

function parseRecoveryKind(value: unknown): ToolCallRecoveryKind | null {
  if (
    value === 'truncated-input' ||
    value === 'invalid-input' ||
    value === 'unknown-tool'
  ) {
    return value;
  }
  return null;
}

function recoveryKindFromError(error: unknown): ToolCallRecoveryKind | null {
  let current: unknown = error;
  const seen = new Set<unknown>();

  // AI SDK and remote step executors may wrap/serialize the original error.
  // Walk a small, fixed cause chain and support both the private property and
  // the bounded human-readable message. Never inspect tool input here.
  for (let depth = 0; depth < 4; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);

    if (typeof current === 'string') {
      const match = current.match(
        /^Recoverable tool call rejection \(([^)]+)\):/,
      );
      return parseRecoveryKind(match?.[1]);
    }

    if (!current || typeof current !== 'object') break;
    const record = current as Record<string, unknown>;
    const localKind = localRecoveryKinds.get(current);
    if (localKind) return localKind;
    const propertyKind = parseRecoveryKind(
      record[TOOL_CALL_RECOVERY_KIND_PROPERTY],
    );
    if (propertyKind) return propertyKind;

    const message = record.message;
    if (typeof message === 'string') {
      const match = message.match(
        /^Recoverable tool call rejection \(([^)]+)\):/,
      );
      const messageKind = parseRecoveryKind(match?.[1]);
      if (messageKind) return messageKind;
    }

    current = record.cause;
  }

  return null;
}

/**
 * Finds invalid tool-call parts that are safe to retry because the rejected
 * call was never executed. The returned signal is intentionally tiny: it
 * contains no model-generated input or names and is safe for
 * logs/telemetry/prompts.
 */
export function findToolCallRecoverySignal(
  content: readonly unknown[],
): ToolCallRecoverySignal | null {
  let selectedKind: ToolCallRecoveryKind | null = null;

  for (const value of content) {
    if (!value || typeof value !== 'object') continue;
    const part = value as Record<string, unknown>;
    if (part.type !== 'tool-call' || part.invalid !== true) continue;

    const kind = recoveryKindFromError(part.error) ?? 'invalid-input';

    // Truncation gets priority because it needs an explicit compact/chunk
    // instruction. Otherwise retain the first concrete classification.
    if (kind === 'truncated-input' || selectedKind === null) {
      selectedKind = kind;
    }
  }

  return selectedKind ? { kind: selectedKind, toolNames: ['unknown'] } : null;
}

/**
 * Handler passed to `streamText({ experimental_repairToolCall })`.
 *
 * This callback deliberately never reconstructs or executes a partial call:
 * completing truncated JSON could turn an incomplete file/shell operation
 * into an unintended effect. Instead it annotates the SDK's original parse
 * error and returns `null`. AI SDK then records a non-executed invalid tool
 * result, and BaseAgent performs a bounded model retry with compact/chunking
 * instructions through the normal approval pipeline.
 */
export async function repairToolCall({
  toolCall,
  tools,
  error,
}: RepairToolCallArgs): Promise<null> {
  // Model hallucinated a tool name. Do not guess a replacement: publish a
  // non-executed rejection and let the bounded next-step recovery choose from
  // the tools actually advertised to the model.
  if (NoSuchToolError.isInstance(error)) {
    return annotateRecoverableError(
      error,
      'unknown-tool',
      'The requested tool is not available. Retry using one of the tools currently provided by the host.',
    );
  }

  const verifiedToolName = Object.hasOwn(tools, toolCall.toolName)
    ? toolCall.toolName.slice(0, MAX_RECOVERY_TOOL_NAME_CHARS)
    : 'unknown';
  const inputLen = toolCall.input?.length ?? 0;
  let parsed: unknown;
  let jsonValid = false;
  try {
    parsed = JSON.parse(toolCall.input);
    jsonValid = true;
  } catch {
    // JSON is unparseable
  }

  if (!jsonValid) {
    // Distinguish empty/tiny input from genuinely truncated long input.
    if (inputLen < 10) {
      return annotateRecoverableError(
        error,
        'invalid-input',
        `The call to "${verifiedToolName}" was not executed because its arguments were empty or malformed. Regenerate one complete, schema-valid JSON object.`,
      );
    }
    return annotateRecoverableError(
      error,
      'truncated-input',
      `The call to "${verifiedToolName}" was not executed because its JSON arguments were incomplete, usually after exceeding the model output limit. Retry with smaller independent calls and split large edits into chunks.`,
    );
  }

  // JSON is valid — re-validate against the tool's own schema so we can
  // surface the *specific* zod issues. Without this, the model retries
  // against an opaque "schema mismatch" message and loops with the same
  // malformed payload.
  const targetTool = tools?.[toolCall.toolName];
  const schema = targetTool?.inputSchema as
    | { safeParse?: (input: unknown) => unknown }
    | undefined;
  if (schema && typeof schema.safeParse === 'function') {
    let result:
      | {
          success: boolean;
          error?: { issues: readonly StructuralZodIssue[] };
        }
      | undefined;
    try {
      result = schema.safeParse(parsed) as typeof result;
    } catch {
      // Defensive: a schema with async refinements (or any future
      // non-synchronous validator) causes zod to throw inside safeParse.
      // Fall through to the generic fallback so the repair handler itself
      // never produces an unhandled error inside the AI SDK.
      result = undefined;
    }
    if (result && !result.success && result.error) {
      return annotateRecoverableError(
        error,
        'invalid-input',
        `Schema validation failed for "${verifiedToolName}":\n${formatZodIssues(
          result.error.issues,
        )}\nReview the tool's parameter requirements and retry with corrected input.`,
      );
    }
  }

  // Schema says the input is valid but AI SDK still flagged it — extremely
  // rare. Fall back to the original generic error.
  return annotateRecoverableError(
    error,
    'invalid-input',
    `Inputs for "${verifiedToolName}" did not match the expected schema. Check the parameter requirements and retry with a smaller valid input.`,
  );
}
