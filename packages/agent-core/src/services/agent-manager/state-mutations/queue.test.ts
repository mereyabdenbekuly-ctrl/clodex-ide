import { describe, expect, it } from 'vitest';
import { AgentStore } from '../../../store/agent-store';
import type { AgentSystemState } from '../../../store/state';
import {
  AgentTypes,
  type AgentMessage,
  type AgentState,
} from '../../../types/agent';
import { upsertAgentInstance, type AgentInstanceEnvelope } from './instances';
import {
  enqueueUserMessage,
  flushQueueIntoHistory,
  removeQueuedMessage,
  replaceQueuedMessage,
  restoreQueuedMessages,
} from './queue';

function emptySystemState(): AgentSystemState {
  return { agents: { instances: {} }, toolbox: {} };
}

function minimalState(): AgentState {
  return {
    title: 'queue test',
    isWorking: true,
    history: [],
    queuedMessages: [],
    activeModelId: 'model-1',
    toolApprovalMode: 'alwaysAsk',
    fileEditApprovalMode: 'manual',
    pendingApprovals: {},
    inputState: '',
    usedTokens: 0,
  };
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

function userMessage(
  id: string,
  text: string,
): AgentMessage & { role: 'user' } {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
    metadata: {
      createdAt: new Date('2026-07-27T00:00:00.000Z'),
      partsMetadata: [],
      swarmMode: true,
      swarmModeVariant: 'battle',
    },
  };
}

function createStore() {
  const store = new AgentStore(emptySystemState());
  upsertAgentInstance(store, 'a1', makeEnvelope(minimalState()));
  return store;
}

describe('state-mutations/queue', () => {
  it('flushes every queued message once in exact FIFO order', () => {
    const store = createStore();
    enqueueUserMessage(store, 'a1', { message: userMessage('first', 'first') });
    enqueueUserMessage(store, 'a1', { message: userMessage('dot', '.') });
    enqueueUserMessage(store, 'a1', { message: userMessage('third', 'third') });

    flushQueueIntoHistory(store, 'a1');
    flushQueueIntoHistory(store, 'a1');

    const state = store.get().agents.instances.a1!.state;
    expect(state.queuedMessages).toEqual([]);
    expect(state.history.map((message) => message.id)).toEqual([
      'first',
      'dot',
      'third',
    ]);
  });

  it('replaces one queued message without changing its id, position, or metadata', () => {
    const store = createStore();
    const first = userMessage('first', 'first');
    const second = userMessage('second', 'before');
    enqueueUserMessage(store, 'a1', { message: first });
    enqueueUserMessage(store, 'a1', { message: second });

    const result = replaceQueuedMessage(store, 'a1', {
      messageId: 'second',
      message: {
        ...second,
        id: 'renderer-id-must-not-win',
        parts: [{ type: 'text', text: 'after' }],
      },
    });

    expect(result).toBe('updated');
    const queue = store.get().agents.instances.a1!.state.queuedMessages;
    expect(queue.map((message) => message.id)).toEqual(['first', 'second']);
    expect(queue[1]?.parts).toEqual([{ type: 'text', text: 'after' }]);
    expect(queue[1]?.metadata).toEqual(second.metadata);
  });

  it('returns not-found without mutating or notifying for an admitted message', () => {
    const store = createStore();
    const listenerCalls: AgentSystemState[] = [];
    store.subscribe((state) => listenerCalls.push(state));

    expect(
      replaceQueuedMessage(store, 'a1', {
        messageId: 'missing',
        message: userMessage('missing', 'replacement'),
      }),
    ).toBe('not-found');
    expect(listenerCalls).toHaveLength(0);
  });

  it('removes only the selected id and can restore an exact rollback snapshot', () => {
    const store = createStore();
    const before = [userMessage('first', 'one'), userMessage('second', 'two')];
    for (const message of before) enqueueUserMessage(store, 'a1', { message });

    removeQueuedMessage(store, 'a1', { messageId: 'first' });
    expect(
      store.get().agents.instances.a1!.state.queuedMessages.map(({ id }) => id),
    ).toEqual(['second']);

    restoreQueuedMessages(store, 'a1', { messages: before });
    expect(store.get().agents.instances.a1!.state.queuedMessages).toEqual(
      before,
    );
  });
});
