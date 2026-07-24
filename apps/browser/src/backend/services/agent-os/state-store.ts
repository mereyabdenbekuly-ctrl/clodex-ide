import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  agentOsStateSchema,
  createDefaultAgentOsState,
  type AgentOsState,
} from '@shared/agent-os';

type StateListener = (state: AgentOsState) => void;

function createTemporaryPath(filePath: string): string {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}

async function writeAtomically(
  filePath: string,
  state: AgentOsState,
): Promise<void> {
  const temporaryPath = createTemporaryPath(filePath);
  const persistedState = structuredClone(state);
  persistedState.desktopAutomation.active = false;
  persistedState.desktopAutomation.sessionId = null;
  persistedState.desktopAutomation.currentApp = null;
  persistedState.desktopAutomation.pendingApprovals = [];
  persistedState.desktopAutomation.killSwitchRegistered = false;
  persistedState.hookRuntime.helperAgentRunnerConfigured = false;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(persistedState, null, 2)}\n`,
      {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      },
    );
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class AgentOsStateStore {
  private state: AgentOsState = createDefaultAgentOsState();
  private updateQueue = Promise.resolve();
  private readonly listeners = new Set<StateListener>();

  private constructor(private readonly filePath: string) {}

  public static async create(filePath: string): Promise<AgentOsStateStore> {
    const store = new AgentOsStateStore(filePath);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      store.state = agentOsStateSchema.parse(JSON.parse(content));
    } catch {
      store.state = createDefaultAgentOsState();
    }

    store.state.chronicle.recording = false;
    store.state.browserUse.pendingApprovals = [];
    store.state.desktopAutomation.active = false;
    store.state.desktopAutomation.sessionId = null;
    store.state.desktopAutomation.currentApp = null;
    store.state.desktopAutomation.pendingApprovals = [];
    store.state.desktopAutomation.killSwitchRegistered = false;
    // A persisted boolean must never manufacture an executable helper-agent
    // capability. The composition root has to install the runner again for
    // every process lifetime.
    store.state.hookRuntime.helperAgentRunnerConfigured = false;
    store.state.remoteControl.pendingApprovals = [];
    store.state.remoteControl.serverUrl = null;
    store.state.remoteControl.pairingUrl = null;
    store.state.remoteControl.pairingQrDataUrl = null;
    if (
      store.state.remoteControl.pairingExpiresAt !== null &&
      store.state.remoteControl.pairingExpiresAt <= Date.now()
    ) {
      store.state.remoteControl.pairingCode = null;
      store.state.remoteControl.pairingExpiresAt = null;
    }
    await writeAtomically(filePath, store.state);
    return store;
  }

  public snapshot(): AgentOsState {
    return structuredClone(this.state);
  }

  public subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async update(
    mutator: (draft: AgentOsState) => void,
  ): Promise<AgentOsState> {
    let result = this.snapshot();
    this.updateQueue = this.updateQueue.then(async () => {
      const draft = this.snapshot();
      mutator(draft);
      this.state = agentOsStateSchema.parse(draft);
      result = this.snapshot();
      for (const listener of this.listeners) listener(result);
      await writeAtomically(this.filePath, this.state);
    });
    await this.updateQueue;
    return result;
  }

  public async flush(): Promise<void> {
    await this.updateQueue;
  }
}
