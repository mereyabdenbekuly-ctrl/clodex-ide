import { describe, expect, it } from 'vitest';
import { renderEvidenceSummaryModelInput } from './evidence-memory-model-summarizer';

describe('renderEvidenceSummaryModelInput', () => {
  it('redacts sensitive text before provider dispatch', () => {
    const rendered = renderEvidenceSummaryModelInput({
      tier: '10m',
      windowStartedAt: 0,
      windowEndedAt: 600_000,
      entries: [
        {
          id: 'event-1',
          timestamp: 1,
          type: 'tool_completed',
          text: 'token=abcdefghijklmnopqrstuvwxyz123456 alice@example.com',
          sourceEventIds: ['event-1'],
        },
      ],
    });

    expect(rendered).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(rendered).not.toContain('alice@example.com');
    expect(rendered).toContain('[REDACTED]');
    expect(rendered).toContain('[REDACTED_EMAIL]');
  });
});
