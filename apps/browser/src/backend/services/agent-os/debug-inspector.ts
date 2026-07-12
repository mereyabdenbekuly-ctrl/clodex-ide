import { randomUUID } from 'node:crypto';
import {
  AGENT_OS_LIMITS,
  debugInspectorEventSchema,
  type DebugInspectorEvent,
} from '@shared/agent-os';
import type { AgentOsStateStore } from './state-store';
import { sanitizeDebugPayload, redactSensitiveText } from './privacy';

export class DebugInspectorService {
  public constructor(private readonly store: AgentOsStateStore) {}

  public async setEnabled(enabled: boolean): Promise<void> {
    await this.store.update((draft) => {
      draft.debugInspector.enabled = enabled;
      if (!enabled) draft.debugInspector.paused = false;
    });
  }

  public async setPaused(paused: boolean): Promise<void> {
    await this.store.update((draft) => {
      draft.debugInspector.paused = paused;
    });
  }

  public async clear(): Promise<void> {
    await this.store.update((draft) => {
      draft.debugInspector.events = [];
    });
  }

  public exportJson(): string {
    return JSON.stringify(this.store.snapshot().debugInspector.events, null, 2);
  }

  public record(
    event: Omit<DebugInspectorEvent, 'id' | 'createdAt'> &
      Partial<Pick<DebugInspectorEvent, 'id' | 'createdAt'>>,
  ): void {
    const state = this.store.snapshot().debugInspector;
    if (!state.enabled || state.paused) return;

    const parsed = debugInspectorEventSchema.parse({
      ...event,
      id: event.id ?? randomUUID(),
      createdAt: event.createdAt ?? Date.now(),
      message: redactSensitiveText(event.message),
      payload: sanitizeDebugPayload(event.payload),
    });

    void this.store.update((draft) => {
      if (!draft.debugInspector.enabled || draft.debugInspector.paused) {
        return;
      }
      draft.debugInspector.events.push(parsed);
      if (draft.debugInspector.events.length > AGENT_OS_LIMITS.maxDebugEvents) {
        draft.debugInspector.events.splice(
          0,
          draft.debugInspector.events.length - AGENT_OS_LIMITS.maxDebugEvents,
        );
      }
    });
  }
}
