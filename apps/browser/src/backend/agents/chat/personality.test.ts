import { describe, expect, it } from 'vitest';
import { buildBrowserSoulPrompt } from './personality';

describe('buildBrowserSoulPrompt', () => {
  it('adds the pragmatic behavior profile', () => {
    const prompt = buildBrowserSoulPrompt('pragmatic');

    expect(prompt).toContain('Active personality: Pragmatic.');
    expect(prompt).toContain('execution-oriented');
    expect(prompt).not.toContain('Active personality: Friendly.');
  });

  it('adds the friendly behavior profile without weakening authorities', () => {
    const prompt = buildBrowserSoulPrompt('friendly');

    expect(prompt).toContain('Active personality: Friendly.');
    expect(prompt).toContain('empathy, collaboration, and team morale');
    expect(prompt).toContain('never overrides safety');
    expect(prompt).not.toContain('Active personality: Pragmatic.');
  });

  it('adds the selected collaboration workflow', () => {
    const prompt = buildBrowserSoulPrompt('pragmatic', 'review');

    expect(prompt).toContain('Active collaboration mode: Review.');
    expect(prompt).toContain('Do not edit files');
  });

  it('does not add a collaboration block for the default mode', () => {
    const prompt = buildBrowserSoulPrompt('pragmatic', 'default');

    expect(prompt).not.toContain('<collaboration-mode>');
  });
});
