import { describe, expect, it } from 'vitest';
import { sanitizeClodexRequestBody } from './clodex-provider';

describe('sanitizeClodexRequestBody', () => {
  it('removes unsupported reasoning.enabled from the serialized request', () => {
    const body = sanitizeClodexRequestBody(
      JSON.stringify({
        model: 'gpt-5.6-sol',
        reasoning: { enabled: true, effort: 'high' },
        messages: [],
      }),
    );

    expect(JSON.parse(String(body))).toEqual({
      model: 'gpt-5.6-sol',
      reasoning: { effort: 'high' },
      messages: [],
    });
  });

  it('removes an empty reasoning object after stripping enabled', () => {
    const body = sanitizeClodexRequestBody(
      JSON.stringify({
        model: 'gpt-5.6-sol',
        reasoning: { enabled: false },
      }),
    );

    expect(JSON.parse(String(body))).toEqual({
      model: 'gpt-5.6-sol',
    });
  });

  it('leaves unrelated and non-string bodies unchanged', () => {
    const json = JSON.stringify({
      model: 'gpt-5.6-sol',
      reasoning: { effort: 'medium' },
    });
    const binary = new Uint8Array([1, 2, 3]);

    expect(sanitizeClodexRequestBody(json)).toBe(json);
    expect(sanitizeClodexRequestBody(binary)).toBe(binary);
  });
});
