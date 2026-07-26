import { describe, expect, it } from 'vitest';
import {
  getFileEditApprovalVisualState,
  hasPendingFileEditApproval,
  retainApplyingVisualState,
} from './file-edit-approval-state';

describe('hasPendingFileEditApproval', () => {
  it('matches only a pending proposal from the same tool call', () => {
    const proposedEdits = [
      { toolCallId: 'write-1', status: 'accepted' as const },
      { toolCallId: 'write-2', status: 'pending' as const },
    ];

    expect(hasPendingFileEditApproval(proposedEdits, 'write-1')).toBe(false);
    expect(hasPendingFileEditApproval(proposedEdits, 'write-2')).toBe(true);
    expect(hasPendingFileEditApproval(proposedEdits, 'write-3')).toBe(false);
    expect(hasPendingFileEditApproval(proposedEdits, undefined)).toBe(false);
  });

  it('exposes applying separately without matching another tool call', () => {
    const proposedEdits = [
      { toolCallId: 'write-1', status: 'pending' as const },
      { toolCallId: 'write-2', status: 'applying' as const },
    ];

    expect(getFileEditApprovalVisualState(proposedEdits, 'write-1')).toBe(
      'waiting',
    );
    expect(getFileEditApprovalVisualState(proposedEdits, 'write-2')).toBe(
      'applying',
    );
    expect(getFileEditApprovalVisualState(proposedEdits, 'write-3')).toBeNull();
    expect(getFileEditApprovalVisualState(proposedEdits, undefined)).toBeNull();
  });

  it('retains applying until the tool publishes a terminal output', () => {
    expect(retainApplyingVisualState(null, 'applying', 'input-available')).toBe(
      'applying',
    );
    expect(
      retainApplyingVisualState(null, 'applying', 'output-available'),
    ).toBeNull();
    expect(
      retainApplyingVisualState(null, 'applying', 'output-error'),
    ).toBeNull();
  });
});
