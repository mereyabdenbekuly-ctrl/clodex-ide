import { describe, expect, it } from 'vitest';
import { AgentStore } from '../../../store/agent-store';
import type { AgentSystemState } from '../../../store/state';
import {
  AgentTypes,
  type AgentMessage,
  type AgentState,
} from '../../../types/agent';
import { removeTransportOnlyAssistantTail } from './history';
import { upsertAgentInstance, type AgentInstanceEnvelope } from './instances';

function emptySystemState(): AgentSystemState {
  return { agents: { instances: {} }, toolbox: {} };
}

function makeEnvelope(state: AgentState): AgentInstanceEnvelope {
  return {
    type: AgentTypes.CHAT,
    canSelectModel: true,
    requiredModelCapabilities: {},
    allowUserInput: true,
    parentAgentInstanceId: null,
    state,
  };
}

function baseState(history: AgentMessage[]): AgentState {
  return {
    title: '',
    isWorking: true,
    history,
    queuedMessages: [
      {
        id: 'queued-user',
        role: 'user',
        parts: [{ type: 'text', text: 'new requirement' }],
      },
    ],
    activeModelId: 'model-1',
    toolApprovalMode: 'alwaysAsk',
    fileEditApprovalMode: 'manual',
    pendingApprovals: {},
    inputState: '',
    usedTokens: 0,
  };
}

describe('state-mutations/history reconnect cleanup', () => {
  it('removes only a transport-only assistant tail and preserves the queue', () => {
    const baseline: AgentMessage = {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }],
    };
    const transportTail: AgentMessage = {
      id: 'assistant-empty',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'reasoning', text: '', state: 'streaming' },
      ],
      metadata: { createdAt: new Date(), partsMetadata: [] },
    };
    const store = new AgentStore(emptySystemState());
    upsertAgentInstance(
      store,
      'a1',
      makeEnvelope(baseState([baseline, transportTail])),
    );

    expect(
      removeTransportOnlyAssistantTail(store, 'a1', {
        baselineMessageIds: ['user-1'],
      }),
    ).toEqual({ status: 'removed' });
    const state = store.get().agents.instances.a1!.state;
    expect(state.history).toEqual([baseline]);
    expect(state.queuedMessages).toHaveLength(1);
    expect(state.queuedMessages[0]?.id).toBe('queued-user');
  });

  it('distinguishes an exact baseline with no appended tail', () => {
    const user: AgentMessage = {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }],
    };
    const store = new AgentStore(emptySystemState());
    upsertAgentInstance(store, 'a1', makeEnvelope(baseState([user])));

    expect(
      removeTransportOnlyAssistantTail(store, 'a1', {
        baselineMessageIds: ['user-1'],
      }),
    ).toEqual({ status: 'no-tail' });
    expect(store.get().agents.instances.a1!.state.history).toEqual([user]);
    expect(store.get().agents.instances.a1!.state.queuedMessages[0]?.id).toBe(
      'queued-user',
    );
  });

  it('reports a conflict when the appended tail contains model output', () => {
    const user: AgentMessage = {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }],
    };
    const output: AgentMessage = {
      id: 'assistant-output',
      role: 'assistant',
      parts: [{ type: 'text', text: 'partial', state: 'streaming' }],
    };
    const store = new AgentStore(emptySystemState());
    upsertAgentInstance(store, 'a1', makeEnvelope(baseState([user, output])));

    expect(
      removeTransportOnlyAssistantTail(store, 'a1', {
        baselineMessageIds: ['user-1'],
      }),
    ).toEqual({ status: 'conflict', reason: 'non-transport-tail' });
    expect(store.get().agents.instances.a1!.state.history).toEqual([
      user,
      output,
    ]);
  });

  it('reports a conflict when the live history no longer matches the baseline', () => {
    const user: AgentMessage = {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }],
    };
    const store = new AgentStore(emptySystemState());
    upsertAgentInstance(store, 'a1', makeEnvelope(baseState([user])));

    expect(
      removeTransportOnlyAssistantTail(store, 'a1', {
        baselineMessageIds: ['different-user'],
      }),
    ).toEqual({ status: 'conflict', reason: 'baseline-mismatch' });
    expect(
      removeTransportOnlyAssistantTail(store, 'a1', {
        baselineMessageIds: ['user-1', 'missing-assistant'],
      }),
    ).toEqual({ status: 'conflict', reason: 'baseline-mismatch' });
    expect(store.get().agents.instances.a1!.state.history).toEqual([user]);
  });
});
