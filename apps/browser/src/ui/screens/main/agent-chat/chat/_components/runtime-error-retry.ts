import type { AgentRuntimeError } from '@shared/karton-contracts/ui/agent';

type UpstreamDisconnectedError = Extract<
  AgentRuntimeError,
  { kind: 'upstream-disconnected' }
>;

export type UpstreamDisconnectedPresentation = {
  readonly heading: string;
  readonly description: string;
};

/**
 * Post-step failures can surface after shell/file effects already committed.
 * Those errors explicitly disable replay of the last user turn. Upstream
 * disconnects additionally use their phase-aware resume mode; every other
 * runtime error keeps the existing retry visibility rules.
 */
export function shouldShowRuntimeErrorRetry(
  error: AgentRuntimeError,
  canRetry: boolean,
  isWorking: boolean,
): boolean {
  if (error.kind === 'upstream-disconnected') {
    return error.resumeMode !== 'blocked' && !isWorking;
  }
  if (error.kind === undefined && error.retryable === false) return false;
  return canRetry || !isWorking;
}

/**
 * Returns public, content-free copy for an upstream disconnect card.
 *
 * Provider messages and endpoint identifiers intentionally stay out of the
 * visible card. They are available only through the explicit diagnostic-copy
 * action formatted by {@link formatUpstreamDisconnectedErrorReport}.
 */
export function getUpstreamDisconnectedPresentation(
  error: UpstreamDisconnectedError,
): UpstreamDisconnectedPresentation {
  if (error.resumeMode === 'blocked') {
    if (error.phase === 'unknown-tool-outcome') {
      return {
        heading: 'Reconnect stopped for safety',
        description:
          'A tool was dispatched, but CLODEx could not confirm its final result. Reconnect is blocked to avoid repeating a possible file, shell, or other external effect. Review the workspace before continuing manually.',
      };
    }
    return {
      heading: 'Reconnect stopped for safety',
      description:
        'The external execution route disconnected before a trusted resume point was recorded. Automatic reconnect is blocked because CLODEx cannot safely replay this step.',
    };
  }

  if (error.resumeMode === 'continue') {
    return {
      heading: 'Model connection interrupted',
      description:
        'The upstream connection closed after progress was saved. Reconnect to continue from the preserved response and completed tool results without repeating completed actions.',
    };
  }

  return {
    heading: 'Model connection interrupted',
    description:
      'The upstream connection closed before the model returned output. Reconnect to retry this step.',
  };
}

/** Formats full, explicitly requested diagnostics for clipboard export. */
export function formatUpstreamDisconnectedErrorReport(
  error: UpstreamDisconnectedError,
): string {
  return [
    'CLODEx upstream disconnect diagnostics',
    `Message: ${error.message}`,
    `Resume mode: ${error.resumeMode}`,
    `Phase: ${error.phase}`,
    `Reconnect attempts: ${error.attempts}`,
    `Model ID: ${error.modelId ?? 'not available'}`,
    `Endpoint ID: ${error.endpointId ?? 'not available'}`,
    '',
    'Original upstream error:',
    error.originalMessage,
    '',
    'Stack trace:',
    error.stack ?? 'not available',
  ].join('\n');
}
