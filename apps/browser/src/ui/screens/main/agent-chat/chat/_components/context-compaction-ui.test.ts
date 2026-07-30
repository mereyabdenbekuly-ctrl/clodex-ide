import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextCompactionMarker } from './context-compaction-marker';
import {
  calculateContextUsedPercentage,
  shouldShowContextUsageRing,
} from './context-usage-display';
import { ContextUsageRing } from './context-usage-ring';

describe('context compaction UI', () => {
  it('keeps the occupancy ring visible at zero usage when a window is known', () => {
    expect(shouldShowContextUsageRing(200_000)).toBe(true);
    expect(calculateContextUsedPercentage(0, 200_000)).toBe(0);

    const markup = renderToStaticMarkup(
      createElement(ContextUsageRing, {
        percentage: 0,
        usedKb: 0,
        maxKb: 200,
      }),
    );

    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-label="Context usage: 0%"');
    expect(markup).toContain('aria-valuenow="0"');
  });

  it('shows an explicit status while compaction is awaited', () => {
    const markup = renderToStaticMarkup(
      createElement(ContextUsageRing, {
        percentage: 73,
        usedKb: 146,
        maxKb: 200,
        isCompressing: true,
      }),
    );

    expect(markup).toContain('data-context-compaction-status="true"');
    expect(markup).toContain('Compressing context…');
  });

  it('renders a reusable boundary marker for either message role', () => {
    const markup = renderToStaticMarkup(createElement(ContextCompactionMarker));

    expect(markup).toContain('data-context-compaction-boundary="true"');
    expect(markup).toContain('Compressed previous conversation');
  });

  it('clamps provider occupancy anomalies to a safe percentage', () => {
    expect(calculateContextUsedPercentage(240_000, 200_000)).toBe(100);
    expect(calculateContextUsedPercentage(-1, 200_000)).toBe(0);
    expect(shouldShowContextUsageRing(undefined)).toBe(false);
  });
});
