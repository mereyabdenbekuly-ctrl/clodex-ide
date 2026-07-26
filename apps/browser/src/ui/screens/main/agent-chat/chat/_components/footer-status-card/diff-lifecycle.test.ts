import { describe, expect, it } from 'vitest';
import {
  areProposedEditDecisionsReady,
  removeProposalDuplicateDiffArtifacts,
} from './diff-lifecycle';

type TestArtifact = {
  id: string;
  path: string;
  baselineOid: string | null;
  currentOid: string | null;
};

function artifact(
  id: string,
  path: string,
  baselineOid: string | null,
  currentOid: string | null,
): TestArtifact {
  return { id, path, baselineOid, currentOid };
}

describe('removeProposalDuplicateDiffArtifacts', () => {
  it('hides only exact pending and summary duplicates of a proposal', () => {
    const duplicatePending = artifact(
      'duplicate-pending',
      'C:\\workspace\\src\\same.ts',
      'before',
      'after',
    );
    const unrelatedPending = artifact(
      'unrelated-pending',
      'C:/workspace/src/other.ts',
      'before-other',
      'after-other',
    );
    const duplicateSummary = {
      ...duplicatePending,
      id: 'duplicate-summary',
      path: 'C:/workspace/src/same.ts',
    };
    const unrelatedSummary = artifact(
      'unrelated-summary',
      'C:/workspace/src/accepted.ts',
      'before-accepted',
      'after-accepted',
    );

    const result = removeProposalDuplicateDiffArtifacts({
      proposedEdits: [
        {
          fileDiff: artifact(
            'proposal',
            'C:/workspace/src/same.ts',
            'before',
            'after',
          ),
        },
      ],
      pendingDiffs: [duplicatePending, unrelatedPending],
      diffSummary: [duplicateSummary, unrelatedSummary],
    });

    expect(result.pendingDiffs).toEqual([unrelatedPending]);
    expect(result.diffSummary).toEqual([unrelatedSummary]);
  });

  it('keeps an artifact on the same path when its content identity differs', () => {
    const earlierPending = artifact(
      'earlier-pending',
      '/workspace/src/same.ts',
      'initial',
      'earlier-change',
    );

    const result = removeProposalDuplicateDiffArtifacts({
      proposedEdits: [
        {
          fileDiff: artifact(
            'proposal',
            '/workspace/src/same.ts',
            'earlier-change',
            'proposed-change',
          ),
        },
      ],
      pendingDiffs: [earlierPending],
      diffSummary: [],
    });

    expect(result.pendingDiffs).toEqual([earlierPending]);
  });

  it('preserves the original arrays when there are no proposals', () => {
    const pendingDiffs = [
      artifact('pending', '/workspace/src/file.ts', 'before', 'after'),
    ];
    const diffSummary = [
      artifact('summary', '/workspace/src/other.ts', 'before', 'after'),
    ];

    const result = removeProposalDuplicateDiffArtifacts({
      proposedEdits: [],
      pendingDiffs,
      diffSummary,
    });

    expect(result.pendingDiffs).toBe(pendingDiffs);
    expect(result.diffSummary).toBe(diffSummary);
  });
});

describe('areProposedEditDecisionsReady', () => {
  it('keeps legacy previews without readiness metadata actionable', () => {
    expect(
      areProposedEditDecisionsReady([
        { id: 'legacy' },
        { id: 'ready', decisionReady: true },
      ]),
    ).toBe(true);
  });

  it('blocks aggregate decisions while any proposal is still collecting', () => {
    expect(
      areProposedEditDecisionsReady([
        { id: 'ready', decisionReady: true },
        { id: 'collecting', decisionReady: false },
      ]),
    ).toBe(false);
  });
});
