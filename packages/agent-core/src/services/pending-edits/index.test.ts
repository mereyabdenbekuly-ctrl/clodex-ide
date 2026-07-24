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

  it('applies a proposal at most once when decisions race', async () => {
    const { service, store } = createService();
    const absolutePath = path.join('/workspace', 'src', 'concurrent.ts');
    let releaseApply: (() => void) | undefined;
    const apply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseApply = resolve;
        }),
    );

    const decisionPromise = service.requestApproval({
      toolCallId: 'tc-concurrent-accept',
      lockOwnerId: 'first-owner',
      agentInstanceId: 'agent-1',
      absolutePath,
      relativePath: 'src/concurrent.ts',
      oldContent: 'before',
      newContent: 'after',
      apply,
    });

    const firstAccept = service.acceptEdit('tc-concurrent-accept');
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));

    const repeatedAccept = service.acceptEdit('tc-concurrent-accept');
    service.rejectEdit('tc-concurrent-accept');
    service.abortAgentEdits('agent-1');

    expect(apply).toHaveBeenCalledTimes(1);
    expect(
      store.get().toolbox['agent-1']?.pendingProposedEdits ?? [],
    ).toHaveLength(1);

    const blockedDecision = await service.requestApproval({
      toolCallId: 'tc-concurrent-replacement',
      lockOwnerId: 'second-owner',
      agentInstanceId: 'agent-1',
      absolutePath,
      relativePath: 'src/concurrent.ts',
      oldContent: 'before',
      newContent: 'replacement',
      apply: vi.fn(async () => {}),
    });
    expect(blockedDecision).toMatchObject({ status: 'rejected' });

    releaseApply?.();
    await Promise.all([firstAccept, repeatedAccept]);

    await expect(decisionPromise).resolves.toMatchObject({
      status: 'accepted',
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(store.get().toolbox['agent-1']?.pendingProposedEdits ?? []).toEqual(
      [],
    );
  });

  it('keeps rejection as the first and only decision', async () => {
    const { service } = createService();
    const apply = vi.fn(async () => {});

    const decisionPromise = service.requestApproval({
      toolCallId: 'tc-reject-first',
      agentInstanceId: 'agent-1',
      absolutePath: path.join('/workspace', 'src', 'reject-first.ts'),
      relativePath: 'src/reject-first.ts',
      oldContent: 'before',
      newContent: 'after',
      apply,
    });

    service.rejectEdit('tc-reject-first');
    await service.acceptEdit('tc-reject-first');

    await expect(decisionPromise).resolves.toMatchObject({
      status: 'rejected',
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects a reused proposal ID until its first decision fully resolves', async () => {
    const { service, store } = createService();
    const firstPath = path.join('/workspace', 'src', 'reused-id.ts');
    const replacementPath = path.join(
      '/workspace',
      'src',
      'reused-id-replacement.ts',
    );
    let releaseFirstApply: (() => void) | undefined;

    const firstDecisionPromise = service.requestApproval({
      toolCallId: 'tc-reused-id',
      lockOwnerId: 'first-owner',
      agentInstanceId: 'agent-1',
      absolutePath: firstPath,
      relativePath: 'src/reused-id.ts',
      oldContent: 'before',
      newContent: 'first',
      apply: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstApply = resolve;
          }),
      ),
    });
    const firstAccept = service.acceptEdit('tc-reused-id');
    await vi.waitFor(() => expect(releaseFirstApply).toBeDefined());

    const blockedReplacementDecision = await service.requestApproval({
      toolCallId: 'tc-reused-id',
      lockOwnerId: 'replacement-owner',
      agentInstanceId: 'agent-1',
      absolutePath: replacementPath,
      relativePath: 'src/reused-id-replacement.ts',
      oldContent: 'before',
      newContent: 'replacement',
      apply: vi.fn(async () => {}),
    });
    expect(blockedReplacementDecision).toMatchObject({
      status: 'rejected',
    });
    expect(blockedReplacementDecision.message).toContain(
      'already awaiting resolution',
    );
    expect(store.get().toolbox['agent-1']?.pendingProposedEdits).toHaveLength(
      1,
    );

    releaseFirstApply?.();
    await firstAccept;
    await expect(firstDecisionPromise).resolves.toMatchObject({
      status: 'accepted',
    });
    expect(store.get().toolbox['agent-1']?.pendingProposedEdits ?? []).toEqual(
      [],
    );

    const replacementDecisionPromise = service.requestApproval({
      toolCallId: 'tc-reused-id',
      lockOwnerId: 'replacement-owner',
      agentInstanceId: 'agent-1',
      absolutePath: replacementPath,
      relativePath: 'src/reused-id-replacement.ts',
      oldContent: 'before',
      newContent: 'replacement',
      apply: vi.fn(async () => {}),
    });
    service.rejectEdit('tc-reused-id');
    await expect(replacementDecisionPromise).resolves.toMatchObject({
      status: 'rejected',
    });
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
