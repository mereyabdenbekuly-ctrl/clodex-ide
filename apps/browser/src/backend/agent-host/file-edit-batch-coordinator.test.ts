import { describe, expect, it } from 'vitest';
import { FileEditBatchCoordinator } from './file-edit-batch-coordinator';

function metadata(
  memberId: string,
  toolCallIds: readonly string[] = ['tool-1', 'tool-2'],
) {
  return {
    batchId: 'batch-1',
    memberId,
    members: toolCallIds.map((toolCallId, index) => ({
      memberId: String(index),
      toolCallId,
    })),
  };
}

describe('FileEditBatchCoordinator', () => {
  it('keeps a proposal non-ready until a slow sibling reports a no-op', async () => {
    const coordinator = new FileEditBatchCoordinator();
    const proposal = coordinator.getParticipant(metadata('0'));
    const sibling = coordinator.getParticipant(metadata('1'));

    let released = false;
    const release = proposal.arriveAsProposal().then((result) => {
      released = true;
      return result;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(proposal.getState()).toBe('collecting');

    sibling.settle('skipped');
    await expect(release).resolves.toBe('ready');
    expect(proposal.getState()).toBe('ready');
  });

  it('treats an error as a terminal arrival and keeps first-wins semantics', async () => {
    const coordinator = new FileEditBatchCoordinator();
    const proposal = coordinator.getParticipant(metadata('0'));
    const sibling = coordinator.getParticipant(metadata('1'));

    const release = proposal.arriveAsProposal();
    proposal.settle('error');
    sibling.settle('error');

    await expect(release).resolves.toBe('ready');
    expect(proposal.getState()).toBe('ready');
  });

  it('tracks duplicate provider tool-call IDs by positional member ID', async () => {
    const coordinator = new FileEditBatchCoordinator();
    const duplicateIds = ['duplicate', 'duplicate'];
    const first = coordinator.getParticipant(metadata('0', duplicateIds));
    const second = coordinator.getParticipant(metadata('1', duplicateIds));

    const release = first.arriveAsProposal();
    second.settle('skipped');

    await expect(release).resolves.toBe('ready');
    expect(first.memberId).toBe('0');
    expect(second.memberId).toBe('1');
  });

  it('aborts waiters and ignores late sibling arrivals', async () => {
    const coordinator = new FileEditBatchCoordinator();
    const first = coordinator.getParticipant(metadata('0'));
    const second = coordinator.getParticipant(metadata('1'));

    const release = first.arriveAsProposal();
    coordinator.abort(first.batchId);
    await expect(release).resolves.toBe('aborted');

    second.settle('skipped');
    expect(first.getState()).toBe('aborted');
  });

  it('keeps an aborted tombstone when a bad first member precedes a sibling', async () => {
    const coordinator = new FileEditBatchCoordinator();
    const first = coordinator.getParticipant(metadata('0'));
    coordinator.abort(first.batchId);

    const sibling = coordinator.getParticipant(metadata('1'));
    await expect(sibling.arriveAsProposal()).resolves.toBe('aborted');
    expect(sibling.getState()).toBe('aborted');
  });
});
