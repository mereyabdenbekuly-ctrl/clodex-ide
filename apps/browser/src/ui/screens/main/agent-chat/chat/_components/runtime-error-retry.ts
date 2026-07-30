import type { AgentRuntimeError } from '@shared/karton-contracts/ui/agent';

/**
 * Post-step failures can surface after shell/file effects already committed.
 * Those errors explicitly disable replay of the last user turn; every other
 * runtime error keeps the existing retry visibility rules.
 */
export function shouldShowRuntimeErrorRetry(
  error: AgentRuntimeError,
  canRetry: boolean,
  isWorking: boolean,
): boolean {
  if (error.kind === undefined && error.retryable === false) return false;
  return canRetry || !isWorking;
}
