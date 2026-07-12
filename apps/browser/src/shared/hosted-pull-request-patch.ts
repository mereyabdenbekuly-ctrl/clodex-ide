import type { HostedPullRequestCommentSide } from './hosted-pull-request';

export type HostedPullRequestPatchLineKind =
  | 'file-header'
  | 'hunk-header'
  | 'addition'
  | 'deletion'
  | 'context'
  | 'meta';

export type HostedPullRequestPatchCommentTarget = {
  line: number;
  side: HostedPullRequestCommentSide;
};

export type HostedPullRequestPatchLine = {
  index: number;
  text: string;
  kind: HostedPullRequestPatchLineKind;
  oldLine: number | null;
  newLine: number | null;
  commentTarget: HostedPullRequestPatchCommentTarget | null;
};

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseHunkStart(line: string): {
  oldLine: number;
  newLine: number;
} | null {
  const match = HUNK_HEADER_PATTERN.exec(line);
  if (!match) return null;
  const oldLine = Number.parseInt(match[1] ?? '', 10);
  const newLine = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isSafeInteger(oldLine) || !Number.isSafeInteger(newLine)) {
    return null;
  }
  return { oldLine, newLine };
}

export function parseHostedPullRequestPatch(
  patch: string,
): HostedPullRequestPatchLine[] {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  return patch.split('\n').map((text, index) => {
    const hunkStart = parseHunkStart(text);
    if (hunkStart) {
      oldLine = hunkStart.oldLine;
      newLine = hunkStart.newLine;
      inHunk = true;
      return {
        index,
        text,
        kind: 'hunk-header',
        oldLine: null,
        newLine: null,
        commentTarget: null,
      };
    }

    if (!inHunk || text.startsWith('+++') || text.startsWith('---')) {
      return {
        index,
        text,
        kind: 'file-header',
        oldLine: null,
        newLine: null,
        commentTarget: null,
      };
    }

    if (text.startsWith('\\')) {
      return {
        index,
        text,
        kind: 'meta',
        oldLine: null,
        newLine: null,
        commentTarget: null,
      };
    }

    if (text.startsWith('+')) {
      const line = newLine++;
      return {
        index,
        text,
        kind: 'addition',
        oldLine: null,
        newLine: line,
        commentTarget: line > 0 ? { line, side: 'RIGHT' } : null,
      };
    }

    if (text.startsWith('-')) {
      const line = oldLine++;
      return {
        index,
        text,
        kind: 'deletion',
        oldLine: line,
        newLine: null,
        commentTarget: line > 0 ? { line, side: 'LEFT' } : null,
      };
    }

    const currentOldLine = oldLine++;
    const currentNewLine = newLine++;
    return {
      index,
      text,
      kind: 'context',
      oldLine: currentOldLine,
      newLine: currentNewLine,
      commentTarget:
        currentNewLine > 0 ? { line: currentNewLine, side: 'RIGHT' } : null,
    };
  });
}

export function isHostedPullRequestPatchTarget(
  patch: string,
  line: number,
  side: HostedPullRequestCommentSide,
): boolean {
  if (!Number.isSafeInteger(line) || line <= 0) return false;

  return parseHostedPullRequestPatch(patch).some((patchLine) => {
    if (side === 'LEFT') {
      return (
        patchLine.oldLine === line &&
        (patchLine.kind === 'deletion' || patchLine.kind === 'context')
      );
    }
    return (
      patchLine.newLine === line &&
      (patchLine.kind === 'addition' || patchLine.kind === 'context')
    );
  });
}
