import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentStore, createInitialAgentSystemState } from '../../store';
import { POST_EDIT_VERIFICATION_NUDGE, PendingEditService } from './index';

function createService() {
  const store = new AgentStore(createInitialAgentSystemState());
  const service = new PendingEditService({ store });
  return { service, store };
}

describe('PendingEditService', () => {
  it('publishes a preview and waits for accept before applying changes', async () => {
    const { service, store } = createService();
    const apply = vi.fn(async () => {});

    const decisionPromise = service.requestApproval({
      toolCallId: 'tc-write',
      agentInstanceId: 'agent-1',
      absolutePath: path.join('/workspace', 'src', 'index.ts'),
      relativePath: 'src/index.ts',
      oldContent: 'export const value = 1;\n',
      newContent: 'export const value = 2;\n',
      apply,
    });

    const previews = store.get().toolbox['agent-1']?.pendingProposedEdits ?? [];
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      id: 'tc-write',
      relativePath: 'src/index.ts',
      status: 'pending',
    });
    expect(apply).not.toHaveBeenCalled();

    await service.acceptEdit('tc-write');

    await expect(decisionPromise).resolves.toMatchObject({
      status: 'accepted',
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(store.get().toolbox['agent-1']?.pendingProposedEdits ?? []).toEqual(
      [],
    );

    const decision = await decisionPromise;
    expect(decision.message).toContain(POST_EDIT_VERIFICATION_NUDGE);
  });

  it('removes the preview without applying when rejected', async () => {
    const { service, store } = createService();
    const apply = vi.fn(async () => {});

    const decisionPromise = service.requestApproval({
      toolCallId: 'tc-reject',
      agentInstanceId: 'agent-1',
      absolutePath: path.join('/workspace', 'README.md'),
      relativePath: 'README.md',
      oldContent: '# Before\n',
      newContent: '# After\n',
      apply,
    });

    service.rejectEdit('tc-reject', 'needs a different title');

    await expect(decisionPromise).resolves.toMatchObject({
      status: 'rejected',
      message: 'Action rejected by user. Feedback: needs a different title',
    });
    expect(apply).not.toHaveBeenCalled();
    expect(store.get().toolbox['agent-1']?.pendingProposedEdits ?? []).toEqual(
      [],
    );
  });

  it('locks a file until the pending decision resolves', async () => {
    const { service } = createService();
    const absolutePath = path.join('/workspace', 'shared.ts');

    const firstDecisionPromise = service.requestApproval({
      toolCallId: 'tc-lock-a',
      lockOwnerId: 'coder-a',
      agentInstanceId: 'agent-1',
      absolutePath,
      relativePath: 'shared.ts',
      oldContent: 'before',
      newContent: 'after-a',
      apply: vi.fn(async () => {}),
    });

    const blockedDecision = await service.requestApproval({
      toolCallId: 'tc-lock-b',
      lockOwnerId: 'coder-b',
      agentInstanceId: 'agent-1',
      absolutePath,
      relativePath: 'shared.ts',
      oldContent: 'before',
      newContent: 'after-b',
      apply: vi.fn(async () => {}),
    });

    expect(blockedDecision).toMatchObject({ status: 'rejected' });
    expect(blockedDecision.message).toContain('currently locked');

    service.rejectEdit('tc-lock-a');
    await expect(firstDecisionPromise).resolves.toMatchObject({
      status: 'rejected',
    });

    const secondDecisionPromise = service.requestApproval({
      toolCallId: 'tc-lock-c',
      lockOwnerId: 'coder-b',
      agentInstanceId: 'agent-1',
      absolutePath,
      relativePath: 'shared.ts',
      oldContent: 'before',
      newContent: 'after-b',
      apply: vi.fn(async () => {}),
    });

    service.rejectEdit('tc-lock-c');
    await expect(secondDecisionPromise).resolves.toMatchObject({
      status: 'rejected',
    });
  });
});
