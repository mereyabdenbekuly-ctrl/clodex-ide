import { describe, expect, it } from 'vitest';
import { getNextAutomationRunAt, parseCronExpression } from './schedule';

describe('automation schedule', () => {
  it('calculates one-time and interval schedules', () => {
    const now = Date.parse('2026-07-11T10:00:00.000Z');
    expect(
      getNextAutomationRunAt(
        { kind: 'once', runAt: '2026-07-11T10:05:00.000Z' },
        now,
      ),
    ).toBe(Date.parse('2026-07-11T10:05:00.000Z'));
    expect(
      getNextAutomationRunAt(
        {
          kind: 'interval',
          everyMs: 5 * 60_000,
          anchorAt: '2026-07-11T09:58:00.000Z',
        },
        now,
      ),
    ).toBe(Date.parse('2026-07-11T10:03:00.000Z'));
  });

  it('supports lists, ranges, steps, and Sunday alias', () => {
    const parsed = parseCronExpression('*/15 9-17 * * 1,3,7');
    expect(parsed.minute.values.has(45)).toBe(true);
    expect(parsed.hour.values.has(18)).toBe(false);
    expect(parsed.dayOfWeek.values).toEqual(new Set([1, 3, 0]));
  });

  it('calculates cron schedules in the selected timezone', () => {
    const after = Date.parse('2026-07-11T08:59:30.000Z');
    expect(
      getNextAutomationRunAt(
        { kind: 'cron', expression: '0 15 * * *', timezone: 'Asia/Almaty' },
        after,
      ),
    ).toBe(Date.parse('2026-07-11T10:00:00.000Z'));
  });

  it('rejects malformed cron expressions', () => {
    expect(() => parseCronExpression('* * *')).toThrow('exactly five fields');
    expect(() => parseCronExpression('60 * * * *')).toThrow('between 0 and 59');
  });
});
