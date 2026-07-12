import {
  codexMicroActionSchema,
  codexMicroPositionSchema,
  type CodexMicroAction,
  type CodexMicroPosition,
} from '@shared/agent-os';
import type { AgentOsStateStore } from './state-store';
import type { DebugInspectorService } from './debug-inspector';

export class MicroControllerService {
  public constructor(
    private readonly store: AgentOsStateStore,
    private readonly debug: DebugInspectorService,
  ) {}

  public async setEnabled(enabled: boolean): Promise<void> {
    await this.store.update((draft) => {
      draft.micro.enabled = enabled;
      if (!enabled) draft.micro.pushToTalkActive = false;
    });
  }

  public async setActions(actions: CodexMicroAction[]): Promise<void> {
    const parsed = actions.map((action) =>
      codexMicroActionSchema.parse(action),
    );
    await this.store.update((draft) => {
      draft.micro.actions = parsed;
    });
  }

  public async setPosition(position: CodexMicroPosition | null): Promise<void> {
    const parsed =
      position === null ? null : codexMicroPositionSchema.parse(position);
    await this.store.update((draft) => {
      draft.micro.position = parsed;
    });
  }

  public async setExpanded(expanded: boolean): Promise<void> {
    await this.store.update((draft) => {
      draft.micro.expanded = expanded;
    });
  }

  public async triggerAction(actionId: string): Promise<CodexMicroAction> {
    const state = this.store.snapshot().micro;
    if (!state.enabled) throw new Error('Micro controller is disabled');
    const action = state.actions.find((candidate) => candidate.id === actionId);
    if (!action) throw new Error(`Unknown Micro action: ${actionId}`);

    await this.store.update((draft) => {
      draft.micro.lastInputAt = Date.now();
      draft.micro.lastTriggeredActionId = actionId;
      if (action.kind === 'push-to-talk') {
        draft.micro.pushToTalkActive = !draft.micro.pushToTalkActive;
      }
    });
    this.debug.record({
      channel: 'agent',
      level: 'info',
      message: `Micro action triggered: ${action.title}`,
      payload: { actionId: action.id, kind: action.kind },
    });
    return action;
  }

  public async setPushToTalkActive(active: boolean): Promise<void> {
    await this.store.update((draft) => {
      draft.micro.pushToTalkActive = active;
      draft.micro.lastInputAt = Date.now();
    });
  }
}
