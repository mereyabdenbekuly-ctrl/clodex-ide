import { describe, expect, it } from 'vitest';
import {
  AGENT_STATUS_COLOR_CLASSES,
  getTutorialStatusTextColorClass,
} from './agent-status-colors';

describe('agent status colors', () => {
  it.each([
    ['Blue', 'text-info-foreground'],
    ['Green', 'text-success-foreground'],
    ['Yellow', 'text-warning-foreground'],
    ['Red', 'text-error-foreground'],
  ])('keeps tutorial color %s mapped to %s', (label, expectedClass) => {
    expect(getTutorialStatusTextColorClass(label)).toBe(expectedClass);
  });

  it('keeps working status independent from the brand primary color', () => {
    expect(AGENT_STATUS_COLOR_CLASSES.info).toEqual({
      dot: 'bg-info-solid',
      glow: 'bg-info-solid/20',
      foreground: 'text-info-foreground',
      solidText: 'text-info-solid',
    });
  });

  it('falls back to the normal foreground for non-status labels', () => {
    expect(getTutorialStatusTextColorClass('Unknown')).toBe('text-foreground');
  });
});
