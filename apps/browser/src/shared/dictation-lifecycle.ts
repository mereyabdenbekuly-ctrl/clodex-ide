import type { DictationState } from './dictation';

export interface DictationLifecycleOperation {
  id: number;
  sessionKey?: string;
}

/**
 * Owns the authority to mutate a draft for one dictation operation.
 *
 * The guard is deliberately independent from React so lifecycle races can be
 * covered deterministically. A stale operation, a session-key change, or a
 * duplicate completion can never obtain delivery authority.
 */
export class DictationLifecycleGuard {
  private generation = 0;
  private active:
    | {
        operation: DictationLifecycleOperation;
        transcriptDelivered: boolean;
      }
    | undefined;

  public begin(sessionKey?: string): DictationLifecycleOperation | null {
    if (this.active) return null;
    const operation = {
      id: ++this.generation,
      sessionKey,
    };
    this.active = {
      operation,
      transcriptDelivered: false,
    };
    return operation;
  }

  public isActive(): boolean {
    return this.active !== undefined;
  }

  public isCurrent(
    operation: DictationLifecycleOperation,
    currentSessionKey?: string,
  ): boolean {
    return (
      this.active?.operation.id === operation.id &&
      operation.sessionKey === currentSessionKey
    );
  }

  public claimTranscriptDelivery(
    operation: DictationLifecycleOperation,
    currentSessionKey?: string,
  ): boolean {
    if (!this.isCurrent(operation, currentSessionKey)) return false;
    if (!this.active || this.active.transcriptDelivered) return false;
    this.active.transcriptDelivered = true;
    return true;
  }

  public finish(operation: DictationLifecycleOperation): void {
    if (this.active?.operation.id === operation.id) {
      this.active = undefined;
    }
  }

  public invalidate(): void {
    this.generation += 1;
    this.active = undefined;
  }
}

export function shouldCancelDictationForVisibility(
  visibilityState: DocumentVisibilityState,
  status: DictationState['status'],
): boolean {
  return (
    visibilityState === 'hidden' &&
    (status === 'requesting-permission' ||
      status === 'recording' ||
      status === 'transcribing')
  );
}
