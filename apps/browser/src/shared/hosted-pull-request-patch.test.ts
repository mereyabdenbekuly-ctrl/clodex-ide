import { describe, expect, it } from 'vitest';
import {
  isHostedPullRequestPatchTarget,
  parseHostedPullRequestPatch,
} from './hosted-pull-request-patch';

describe('parseHostedPullRequestPatch', () => {
  it('tracks old and new line numbers across multiple hunks', () => {
    const lines = parseHostedPullRequestPatch(
      [
        '@@ -2,3 +2,4 @@',
        ' context',
        '-old',
        '+new',
        '+extra',
        ' tail',
        '@@ -20,2 +21,2 @@',
        '-removed',
        '+replacement',
        ' final',
      ].join('\n'),
    );

    expect(
      lines.map(({ kind, oldLine, newLine, commentTarget }) => ({
        kind,
        oldLine,
        newLine,
        commentTarget,
      })),
    ).toEqual([
      {
        kind: 'hunk-header',
        oldLine: null,
        newLine: null,
        commentTarget: null,
      },
      {
        kind: 'context',
        oldLine: 2,
        newLine: 2,
        commentTarget: { line: 2, side: 'RIGHT' },
      },
      {
        kind: 'deletion',
        oldLine: 3,
        newLine: null,
        commentTarget: { line: 3, side: 'LEFT' },
      },
      {
        kind: 'addition',
        oldLine: null,
        newLine: 3,
        commentTarget: { line: 3, side: 'RIGHT' },
      },
      {
        kind: 'addition',
        oldLine: null,
        newLine: 4,
        commentTarget: { line: 4, side: 'RIGHT' },
      },
      {
        kind: 'context',
        oldLine: 4,
        newLine: 5,
        commentTarget: { line: 5, side: 'RIGHT' },
      },
      {
        kind: 'hunk-header',
        oldLine: null,
        newLine: null,
        commentTarget: null,
      },
      {
        kind: 'deletion',
        oldLine: 20,
        newLine: null,
        commentTarget: { line: 20, side: 'LEFT' },
      },
      {
        kind: 'addition',
        oldLine: null,
        newLine: 21,
        commentTarget: { line: 21, side: 'RIGHT' },
      },
      {
        kind: 'context',
        oldLine: 21,
        newLine: 22,
        commentTarget: { line: 22, side: 'RIGHT' },
      },
    ]);
  });

  it('accepts only real comment targets on the requested side', () => {
    const patch = '@@ -1,2 +1,2 @@\n context\n-old\n+new';

    expect(isHostedPullRequestPatchTarget(patch, 1, 'LEFT')).toBe(true);
    expect(isHostedPullRequestPatchTarget(patch, 1, 'RIGHT')).toBe(true);
    expect(isHostedPullRequestPatchTarget(patch, 2, 'LEFT')).toBe(true);
    expect(isHostedPullRequestPatchTarget(patch, 2, 'RIGHT')).toBe(true);
    expect(isHostedPullRequestPatchTarget(patch, 3, 'RIGHT')).toBe(false);
    expect(isHostedPullRequestPatchTarget(patch, 0, 'RIGHT')).toBe(false);
  });

  it('does not assign a line number to patch metadata', () => {
    const lines = parseHostedPullRequestPatch(
      '@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file',
    );

    expect(lines.at(-1)).toMatchObject({
      kind: 'meta',
      oldLine: null,
      newLine: null,
      commentTarget: null,
    });
  });
});
