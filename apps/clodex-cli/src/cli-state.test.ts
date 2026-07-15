import { describe, expect, it } from 'vitest';

import { lastAssistantText } from './cli-state.js';

describe('lastAssistantText', () => {
  it('returns all text parts from the last assistant message with text', () => {
    expect(
      lastAssistantText([
        { role: 'assistant', parts: [{ type: 'text', text: 'old' }] },
        { role: 'user', parts: [{ type: 'text', text: 'prompt' }] },
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'hidden' },
            { type: 'text', text: 'line one' },
            { type: 'text', text: 'line two' },
          ],
        },
      ]),
    ).toBe('line one\nline two');
  });

  it('ignores non-string and non-assistant parts and returns an empty fallback', () => {
    expect(
      lastAssistantText([
        { role: 'user', parts: [{ type: 'text', text: 'prompt' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 42 }] },
      ]),
    ).toBe('');
  });
});
