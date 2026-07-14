import type { AgentStore } from '@clodex/agent-core';
import { describe, expect, it } from 'vitest';
import {
  MemoryTrustedMcpApprovalPersistence,
  TrustedMcpApprovalBroker,
} from './approval-broker';
import {
  bindTrustedMcpFinalAuthorityToFence,
  createTrustedMcpDescriptorCommitment,
  createTrustedMcpDispatchCommitment,
} from './trusted-dispatch-gateway';

const agentInstanceId = 'agent-1';
const toolCallId = 'tool-call-1';
const aiToolName = 'mcp_test_write';
const approvalId = 'approval-1';
const args = { path: 'README.md', value: 'approved' };
const descriptor = createTrustedMcpDescriptorCommitment({
  domain: 'registry-mcp',
  authorityId: 'registry:test',
  toolName: 'write',
  descriptor: { name: 'write', inputSchema: { type: 'object' } },
  authorityBinding: { serverId: 'test' },
  classification: {
    readOnly: false,
    destructive: true,
    requiresApproval: true,
  },
});
const approvalContextDigest = createTrustedMcpDispatchCommitment(descriptor, {
  generation: 1,
}).digest;
const claimInput = {
  agentInstanceId,
  toolCallId,
  aiToolName,
  arguments: args,
  descriptor,
  approvalContextDigest,
};

function makeAgentStore() {
  const history: Array<{
    role: string;
    parts: Array<Record<string, unknown>>;
  }> = [];
  const store = {
    get: () => ({
      agents: {
        instances: {
          [agentInstanceId]: { state: { history } },
        },
      },
    }),
  } as unknown as AgentStore;
  return { history, store };
}

function recordDecision(
  history: ReturnType<typeof makeAgentStore>['history'],
  approved: boolean,
): void {
  history.push({
    role: 'assistant',
    parts: [
      {
        type: `tool-${aiToolName}`,
        toolCallId,
        state: 'approval-responded',
        input: structuredClone(args),
        approval: { id: approvalId, approved },
      },
    ],
  });
}

async function createBroker(store: AgentStore) {
  return await TrustedMcpApprovalBroker.create(store, {
    claimTtlMs: 10_000,
    now: () => 1_000,
    persistence: new MemoryTrustedMcpApprovalPersistence(),
  });
}

describe('TrustedMcpApprovalBroker', () => {
  it('retains a CLAIMED tombstone when a later lifecycle fence rejects dispatch', async () => {
    const { history, store } = makeAgentStore();
    const broker = await createBroker(store);
    try {
      await broker.stage(claimInput);
      const receipt = await broker.prepareResponse({
        agentInstanceId,
        approvalId,
        toolCallId,
        aiToolName,
        input: args,
        approved: true,
      });
      expect(receipt).not.toBeNull();
      recordDecision(history, true);
      await broker.commitResponse(receipt!);

      const claimed = await broker.claim(claimInput);
      expect(claimed).not.toBeNull();
      expect(broker.list()).toEqual([
        expect.objectContaining({ state: 'CLAIMED', toolCallId }),
      ]);

      await expect(
        broker.invalidateOpen({
          agentInstanceId,
          toolCallIds: [toolCallId],
          includeAllOpenForAgent: true,
          reason: 'user-stop',
        }),
      ).resolves.toBe(0);

      let lifecycleCurrent = true;
      const bound = bindTrustedMcpFinalAuthorityToFence(claimed!, () => {
        if (!lifecycleCurrent) throw new Error('approval lifecycle superseded');
      });
      lifecycleCurrent = false;
      expect(() => bound.prepareFinalCheck()).toThrow(
        'approval lifecycle superseded',
      );
      expect(broker.list()[0]).toEqual(
        expect.objectContaining({ state: 'CLAIMED', toolCallId }),
      );
      await expect(broker.claim(claimInput)).rejects.toThrow(
        'already durably claimed',
      );
    } finally {
      await broker.teardown();
    }
  });

  it('never turns a durable denial into dispatch authority', async () => {
    const { history, store } = makeAgentStore();
    const broker = await createBroker(store);
    try {
      await broker.stage(claimInput);
      const receipt = await broker.prepareResponse({
        agentInstanceId,
        approvalId,
        toolCallId,
        aiToolName,
        input: args,
        approved: false,
      });
      expect(receipt).not.toBeNull();
      recordDecision(history, false);
      await broker.commitResponse(receipt!);

      expect(broker.list()[0]).toEqual(
        expect.objectContaining({ approvalDecision: 'DENY', state: 'DENIED' }),
      );
      await expect(broker.claim(claimInput)).rejects.toThrow(
        'approval was denied',
      );
    } finally {
      await broker.teardown();
    }
  });
});
