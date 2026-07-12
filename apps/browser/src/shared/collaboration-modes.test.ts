import { describe, expect, it } from 'vitest';
import {
  buildCollaborationModePrompt,
  getCollaborationModeDefinition,
} from './collaboration-modes';

describe('collaboration modes', () => {
  it('keeps the default mode prompt-neutral', () => {
    expect(buildCollaborationModePrompt('default')).toBe('');
  });

  it('builds an implementation workflow prompt', () => {
    const prompt = buildCollaborationModePrompt('implement');

    expect(prompt).toContain('Active collaboration mode: Implement.');
    expect(prompt).toContain('concrete code changes');
    expect(prompt).toContain('never overrides safety');
  });

  it('exposes user-facing metadata', () => {
    expect(getCollaborationModeDefinition('write-tests')).toMatchObject({
      name: 'Write tests',
      shortName: 'Tests',
    });
  });
});
