import { normalizePath } from '@shared/path-utils';

export interface FooterDiffArtifactIdentity {
  path: string;
  baselineOid: string | null;
  currentOid: string | null;
}

export interface FooterProposedEditIdentity {
  fileDiff: FooterDiffArtifactIdentity;
}

export interface ProposedEditDecisionReadiness {
  id: string;
  /** Absent previews predate batch barriers and remain actionable. */
  decisionReady?: boolean;
}

/**
 * A batch must not expose aggregate decisions until every staged proposal is
 * actionable. `undefined` intentionally preserves the legacy single-edit
 * behavior for previews created before batch readiness was introduced.
 */
export function areProposedEditDecisionsReady(
  proposedEdits: readonly ProposedEditDecisionReadiness[],
): boolean {
  return proposedEdits.every((edit) => edit.decisionReady !== false);
}

function getDiffArtifactIdentityKey(
  artifact: FooterDiffArtifactIdentity,
): string {
  return JSON.stringify([
    normalizePath(artifact.path),
    artifact.baselineOid,
    artifact.currentOid,
  ]);
}

/**
 * During proposal acceptance the pre-apply preview and diff-history service can
 * briefly publish the same change at once. Hide only those exact duplicates;
 * unrelated pending changes must remain actionable instead of being suppressed
 * merely because some proposal exists.
 */
export function removeProposalDuplicateDiffArtifacts<
  TArtifact extends FooterDiffArtifactIdentity,
>({
  proposedEdits,
  pendingDiffs,
  diffSummary,
}: {
  proposedEdits: FooterProposedEditIdentity[];
  pendingDiffs: TArtifact[];
  diffSummary: TArtifact[];
}): { pendingDiffs: TArtifact[]; diffSummary: TArtifact[] } {
  if (proposedEdits.length === 0) return { pendingDiffs, diffSummary };

  const proposedArtifactKeys = new Set(
    proposedEdits.map((edit) => getDiffArtifactIdentityKey(edit.fileDiff)),
  );
  const isProposalDuplicate = (artifact: TArtifact) =>
    proposedArtifactKeys.has(getDiffArtifactIdentityKey(artifact));

  return {
    pendingDiffs: pendingDiffs.filter(
      (artifact) => !isProposalDuplicate(artifact),
    ),
    diffSummary: diffSummary.filter(
      (artifact) => !isProposalDuplicate(artifact),
    ),
  };
}
