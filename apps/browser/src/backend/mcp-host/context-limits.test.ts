import { describe, expect, it } from 'vitest';
import {
  assertBoundedMcpContextResult,
  MAX_MCP_CONTEXT_RESULT_BYTES,
} from './context-limits';

describe('MCP context result limits', () => {
  it('accepts bounded resource and prompt result envelopes', () => {
    expect(() =>
      assertBoundedMcpContextResult(
        { contents: [{ uri: 'smoke://fixture/readme', text: 'ok' }] },
        'MCP resource result',
      ),
    ).not.toThrow();
  });

  it('rejects resource and prompt results larger than 4 MiB', () => {
    const oversized = 'x'.repeat(MAX_MCP_CONTEXT_RESULT_BYTES);

    expect(() =>
      assertBoundedMcpContextResult(
        { contents: [{ uri: 'smoke://fixture/large', text: oversized }] },
        'MCP resource result',
      ),
    ).toThrow('4194304 byte limit');
    expect(() =>
      assertBoundedMcpContextResult(
        {
          messages: [
            {
              role: 'user',
              content: { type: 'text', text: oversized },
            },
          ],
        },
        'MCP prompt result',
      ),
    ).toThrow('4194304 byte limit');
  });
});
