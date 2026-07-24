import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentStore, createInitialAgentSystemState } from '../../store';
import type { FileEditBatchParticipant } from '../../types/pending-edits';
import { POST_EDIT_VERIFICATION_NUDGE, PendingEditService } from './index';

function createService(
  options: { resolveRealpath?: (absolutePath: string) => Promise<string> } = {},
) {
  const store = new AgentStore(createInitialAgentSystemState());
  const service = new PendingEditService({ store, ...options });
  return { service, store };
}

async function getPendingId(
  store: AgentStore,
  agentInstanceId = 'agent-1',
): Promise<string> {
  await vi.waitFor(() =>
    expect(
      store.get().toolbox[agentInstanceId]?.pendingProposedEdits,
    ).toHaveLength(1),
  );
  return store.get().toolbox[agentInstanceId]!.pendingProposedEdits[0]!.id;
}

function setFileEditApprovalMode(
  store: AgentStore,
  mode: 'manual' | 'autoWorkspace',
): void {
  store.update((draft) => {
    draft.agents.instances['agent-1'] = {
      state: { fileEditApprovalMode: mode },
    } as never;
  });
}

function createBatchParticipant(toolCallId = 'tc-batch') {
  let state: ReturnType<FileEditBatchParticipant['getState']> = 'collecting';
  let resolveRelease!: (result: 'ready' | 'aborted') => void;
  const release = new Promise<'ready' | 'aborted'>((resolve) => {
    resolveRelease = resolve;
  });
  const participant: FileEditBatchParticipant = {
    batchId: 'batch-1',
    memberId: '0',
    toolCallId,
    getState: () => state,
    arriveAsProposal: vi.fn(() => release),
    settle: vi.fn(),
  };
  return {
    participant,
    ready() {
      if (state !== 'collecting') return;
      state = 'ready';
      resolveRelease('ready');
    },
    abort() {
      if (state === 'aborted') return;
      state = 'aborted';
      resolveRelease('aborted');
    },
  };
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

    const pendingEditId = await getPendingId(store);
    const previews = store.get().toolbox['agent-1']?.pendingProposedEdits ?? [];
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      toolCallId: 'tc-write',
      relativePath: 'src/index.ts',
      status: 'pending',
    });
    expect(apply).not.toHaveBeenCalled();

    await service.acceptEdit(pendingEditId);

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

    service.rejectEdit(await getPendingId(store), 'needs a different title');

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

    const pendingEditId = await getPendingId(store);
    const firstAccept = service.acceptEdit(pendingEditId);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));

    const repeatedAccept = service.acceptEdit(pendingEditId);
    service.rejectEdit(pendingEditId);
    service.abortAgentEdits('agent-1');

    expect(apply).toHaveBeenCalledTimes(1);
    expect(store.get().toolbox['agent-1']?.pendingProposedEdits).toMatchObject([
      {
        id: pendingEditId,
        status: 'applying',
      },
    ]);

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
    const { service, store } = createService();
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

    const pendingEditId = await getPendingId(store);
    service.rejectEdit(pendingEditId);
    await service.acceptEdit(pendingEditId);

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
    const firstPendingEditId = await getPendingId(store);
    const firstAccept = service.acceptEdit(firstPendingEditId);
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
    service.rejectEdit(await getPendingId(store));
    await expect(replacementDecisionPromise).resolves.toMatchObject({
      status: 'rejected',
    });
    expect(store.get().toolbox['agent-1']?.pendingProposedEdits ?? []).toEqual(
      [],
    );
  });

  it('locks a file until the pending decision resolves', async () => {
    const { service, store } = createService();
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

    service.rejectEdit(await getPendingId(store));
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

    service.rejectEdit(await getPendingId(store));
    await expect(secondDecisionPromise).resolves.toMatchObject({
      status: 'rejected',
    });
  });

  it('auto-applies an eligible future edit without publishing a preview', async () => {
    const { service, store } = createService();
    setFileEditApprovalMode(store, 'autoWorkspace');
    const apply = vi.fn(async () => {});

    await expect(
      service.requestApproval({
        toolCallId: 'tc-auto',
        agentInstanceId: 'agent-1',
        absolutePath: path.join('/workspace', 'src', 'auto.ts'),
        relativePath: 'src/auto.ts',
        oldContent: 'before',
        newContent: 'after',
        autoApprovalEligible: true,
        apply,
      }),
    ).resolves.toMatchObject({ status: 'accepted' });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ decisionSource: 'auto-policy' });
    expect(store.get().toolbox['agent-1']?.pendingProposedEdits ?? []).toEqual(
      [],
    );
  });

  it('keeps ineligible edits manual even when auto mode is enabled', async () => {
    const { service, store } = createService();
    setFileEditApprovalMode(store, 'autoWorkspace');
    const apply = vi.fn(async () => {});

    const decisionPromise = service.requestApproval({
      toolCallId: 'tc-auto-ineligible',
      agentInstanceId: 'agent-1',
      absolutePath: path.join('/workspace', '.env'),
      relativePath: '.env',
      oldContent: 'before',
      newContent: 'after',
      autoApprovalEligible: false,
      apply,
    });

    const pendingEditId = await getPendingId(store);
    expect(apply).not.toHaveBeenCalled();
    service.rejectEdit(pendingEditId);
    await expect(decisionPromise).resolves.toMatchObject({
      status: 'rejected',
    });
  });

  it('aborts a slow automatic eligibility check and unblocks later proposals', async () => {
    const { service, store } = createService();
    setFileEditApprovalMode(store, 'autoWorkspace');
    const controller = new AbortController();
    const eligibility = vi.fn(
      async () => await new Promise<boolean>(() => undefined),
    );

    const decisionPromise = service.requestApproval({
      toolCallId: 'tc-auto-slow',
      agentInstanceId: 'agent-1',
      absolutePath: path.join('/workspace', 'src', 'slow.ts'),
      relativePath: 'src/slow.ts',
      oldContent: 'before',
      newContent: 'after',
      abortSignal: controller.signal,
      autoApprovalEligible: eligibility,
      apply: vi.fn(async () => {}),
    });
    await vi.waitFor(() => expect(eligibility).toHaveBeenCalledOnce());
    controller.abort();
    await expect(decisionPromise).resolves.toMatchObject({ status: 'aborted' });

    const nextDecisionPromise = service.requestApproval({
      toolCallId: 'tc-auto-after-slow',
      agentInstanceId: 'agent-1',
      absolutePath: path.join('/workspace', 'src', 'next.ts'),
      relativePath: 'src/next.ts',
      oldContent: 'before',
      newContent: 'after',
      autoApprovalEligible: false,
      apply: vi.fn(async () => {}),
    });
    service.rejectEdit(await getPendingId(store));
    await expect(nextDecisionPromise).resolves.toMatchObject({
      status: 'rejected',
    });
  });

  it('aborts a stalled canonical lock lookup and releases the admission queue', async () => {
    const slowPath = path.resolve(
      path.join('/workspace', 'src', 'slow-lock.ts'),
    );
    const nextPath = path.resolve(
      path.join('/workspace', 'src', 'after-slow-lock.ts'),
    );
    let resolveStalledRealpath!: (value: string) => void;
    const stalledRealpath = new Promise<string>((resolve) => {
      resolveStalledRealpath = resolve;
    });
    const resolveRealpath = vi.fn((absolutePath: string) => {
      if (absolutePath === slowPath) return stalledRealpath;
      return Promise.resolve(absolutePath);
    });
    const { service, store } = createService({ resolveRealpath });
    const controller = new AbortController();

    const stalledDecisionPromise = service.requestApproval({
      toolCallId: 'tc-stalled-lock-key',
      agentInstanceId: 'agent-1',
      absolutePath: slowPath,
      relativePath: 'src/slow-lock.ts',
      oldContent: 'before',
      newContent: 'after',
      abortSignal: controller.signal,
      apply: vi.fn(async () => {}),
    });
    await vi.waitFor(() =>
      expect(resolveRealpath).toHaveBeenCalledWith(slowPath),
    );

    const nextDecisionPromise = service.requestApproval({
      toolCallId: 'tc-after-stalled-lock-key',
      agentInstanceId: 'agent-1',
      absolutePath: nextPath,
      relativePath: 'src/after-slow-lock.ts',
      oldContent: 'before',
      newContent: 'after',
      apply: vi.fn(async () => {}),
    });
    await Promise.resolve();
    expect(resolveRealpath).not.toHaveBeenCalledWith(nextPath);

    controller.abort();
    await expect(stalledDecisionPromise).resolves.toMatchObject({
      status: 'aborted',
    });

    const pendingEditId = await getPendingId(store);
    expect(resolveRealpath).toHaveBeenCalledWith(nextPath);
    service.rejectEdit(pendingEditId);
    await expect(nextDecisionPromise).resolves.toMatchObject({
      status: 'rejected',
    });

    resolveStalledRealpath(slowPath);
    await Promise.resolve();
    expect(store.get().toolbox['agent-1']?.pendingProposedEdits ?? []).toEqual(
      [],
    );
  });

  it('keeps an exact-batch proposal non-actionable until every member arrives', async () => {
    const { service, store } = createService();
    const batch = createBatchParticipant('tc-batch-manual');
    const apply = vi.fn(async () => {});
    const decisionPromise = service.requestApproval({
      toolCallId: 'tc-batch-manual',
      agentInstanceId: 'agent-1',
      absolutePath: path.join('/workspace', 'src', 'batch-manual.ts'),
      relativePath: 'src/batch-manual.ts',
      oldContent: 'before',
      newContent: 'after',
      fileEditBatchParticipant: batch.participant,
      apply,
    });

    const pendingEditId = await getPendingId(store);
    expect(
      store.get().toolbox['agent-1']?.pendingProposedEdits[0]?.decisionReady,
    ).toBe(false);
    await expect(service.acceptEdit(pendingEditId)).rejects.toThrow(
      'still being prepared',
    );
    expect(() => service.rejectEdit(pendingEditId)).toThrow(
      'still being prepared',
    );
    expect(apply).not.toHaveBeenCalled();

    batch.ready();
    await vi.waitFor(() =>
      expect(
        store.get().toolbox['agent-1']?.pendingProposedEdits[0]?.decisionReady,
      ).toBe(true),
    );
    await service.acceptEdit(pendingEditId);
    await expect(decisionPromise).resolves.toMatchObject({
      status: 'accepted',
    });
    expect(apply).toHaveBeenCalledOnce();
  });

  it('does not hold the global admission queue while a batch waits for siblings', async () => {
    const { service, store } = createService();
    const batch = createBatchParticipant('tc-batch-waiting');
    const batchDecision = service.requestApproval({
      toolCallId: 'tc-batch-waiting',
      agentInstanceId: 'agent-1',
      absolutePath: path.join('/workspace', 'src', 'batch-waiting.ts'),
      relativePath: 'src/batch-waiting.ts',
      oldContent: 'before',
      newContent: 'after',
      fileEditBatchParticipant: batch.participant,
      apply: vi.fn(async () => {}),
    });
    await getPendingId(store);

    const independentDecision = service.requestApproval({
      toolCallId: 'tc-independent',
      agentInstanceId: 'agent-1',
      absolutePath: path.join('/workspace', 'src', 'independent.ts'),
      relativePath: 'src/independent.ts',
      oldContent: 'before',
      newContent: 'after',
      apply: vi.fn(async () => {}),
    });
    await vi.waitFor(() =>
      expect(store.get().toolbox['agent-1']?.pendingProposedEdits).toHaveLength(
        2,
      ),
    );

    const previews = store.get().toolbox['agent-1']?.pendingProposedEdits ?? [];
    const independentId = previews.find(
      (preview) => preview.toolCallId === 'tc-independent',
    )?.id;
    expect(independentId).toBeTruthy();
    service.rejectEdit(independentId!);
    await expect(independentDecision).resolves.toMatchObject({
      status: 'rejected',
    });

    batch.ready();
    const batchId = (
      store.get().toolbox['agent-1']?.pendingProposedEdits ?? []
    ).find((preview) => preview.toolCallId === 'tc-batch-waiting')?.id;
    expect(batchId).toBeTruthy();
    service.rejectEdit(batchId!);
    await expect(batchDecision).resolves.toMatchObject({ status: 'rejected' });
  });

  it('settles an auto-policy batch member before applying without a preview', async () => {
    const { service, store } = createService();
    setFileEditApprovalMode(store, 'autoWorkspace');
    const batch = createBatchParticipant('tc-batch-auto');
    vi.mocked(batch.participant.settle).mockImplementation(() => batch.ready());
    const apply = vi.fn(async () => {});

    await expect(
      service.requestApproval({
        toolCallId: 'tc-batch-auto',
        agentInstanceId: 'agent-1',
        absolutePath: path.join('/workspace', 'src', 'batch-auto.ts'),
        relativePath: 'src/batch-auto.ts',
        oldContent: 'before',
        newContent: 'after',
        autoApprovalEligible: true,
        fileEditBatchParticipant: batch.participant,
        apply,
      }),
    ).resolves.toMatchObject({ status: 'accepted' });

    expect(batch.participant.settle).toHaveBeenCalledWith('auto-policy');
    expect(apply).toHaveBeenCalledOnce();
    expect(store.get().toolbox['agent-1']?.pendingProposedEdits ?? []).toEqual(
      [],
    );
  });

  it('aborts a staged batch proposal and ignores a late ready release', async () => {
    const { service, store } = createService();
    const batch = createBatchParticipant('tc-batch-abort');
    const apply = vi.fn(async () => {});
    const decisionPromise = service.requestApproval({
      toolCallId: 'tc-batch-abort',
      agentInstanceId: 'agent-1',
      absolutePath: path.join('/workspace', 'src', 'batch-abort.ts'),
      relativePath: 'src/batch-abort.ts',
      oldContent: 'before',
      newContent: 'after',
      fileEditBatchParticipant: batch.participant,
      apply,
    });
    await getPendingId(store);

    batch.abort();
    await expect(decisionPromise).resolves.toMatchObject({ status: 'aborted' });
    batch.ready();
    await Promise.resolve();

    expect(apply).not.toHaveBeenCalled();
    expect(store.get().toolbox['agent-1']?.pendingProposedEdits ?? []).toEqual(
      [],
    );
  });

  it('does not retroactively auto-apply a proposal after the mode changes', async () => {
    const { service, store } = createService();
    const apply = vi.fn(async () => {});

    const decisionPromise = service.requestApproval({
      toolCallId: 'tc-mode-snapshot',
      agentInstanceId: 'agent-1',
      absolutePath: path.join('/workspace', 'src', 'manual.ts'),
      relativePath: 'src/manual.ts',
      oldContent: 'before',
      newContent: 'after',
      autoApprovalEligible: true,
      apply,
    });

    const pendingEditId = await getPendingId(store);
    setFileEditApprovalMode(store, 'autoWorkspace');
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();

    service.rejectEdit(pendingEditId);
    await expect(decisionPromise).resolves.toMatchObject({
      status: 'rejected',
    });
  });

  it('aborts a waiting proposal and keeps a stale accept from applying it', async () => {
    const { service, store } = createService();
    const controller = new AbortController();
    const absolutePath = path.join('/workspace', 'src', 'aborted.ts');
    const apply = vi.fn(async () => {});

    const decisionPromise = service.requestApproval({
      toolCallId: 'tc-abort',
      lockOwnerId: 'first-owner',
      agentInstanceId: 'agent-1',
      absolutePath,
      relativePath: 'src/aborted.ts',
      oldContent: 'before',
      newContent: 'after',
      abortSignal: controller.signal,
      apply,
    });
    const stalePendingEditId = await getPendingId(store);

    controller.abort();
    await expect(decisionPromise).resolves.toMatchObject({ status: 'aborted' });
    await service.acceptEdit(stalePendingEditId);
    expect(apply).not.toHaveBeenCalled();
    expect(store.get().toolbox['agent-1']?.pendingProposedEdits ?? []).toEqual(
      [],
    );

    const nextDecisionPromise = service.requestApproval({
      toolCallId: 'tc-after-abort',
      lockOwnerId: 'second-owner',
      agentInstanceId: 'agent-1',
      absolutePath,
      relativePath: 'src/aborted.ts',
      oldContent: 'before',
      newContent: 'replacement',
      apply: vi.fn(async () => {}),
    });
    service.rejectEdit(await getPendingId(store));
    await expect(nextDecisionPromise).resolves.toMatchObject({
      status: 'rejected',
    });
  });

  it('does not let the same owner overwrite its own live file lease', async () => {
    const { service, store } = createService();
    const absolutePath = path.join('/workspace', 'src', 'same-owner.ts');
    const firstDecisionPromise = service.requestApproval({
      toolCallId: 'tc-same-owner-a',
      lockOwnerId: 'shared-owner',
      agentInstanceId: 'agent-1',
      absolutePath,
      relativePath: 'src/same-owner.ts',
      oldContent: 'before',
      newContent: 'first',
      apply: vi.fn(async () => {}),
    });
    const firstPendingEditId = await getPendingId(store);

    await expect(
      service.requestApproval({
        toolCallId: 'tc-same-owner-b',
        lockOwnerId: 'shared-owner',
        agentInstanceId: 'agent-1',
        absolutePath,
        relativePath: 'src/same-owner.ts',
        oldContent: 'before',
        newContent: 'second',
        apply: vi.fn(async () => {}),
      }),
    ).resolves.toMatchObject({ status: 'rejected' });

    service.rejectEdit(firstPendingEditId);
    await expect(firstDecisionPromise).resolves.toMatchObject({
      status: 'rejected',
    });
  });
});
