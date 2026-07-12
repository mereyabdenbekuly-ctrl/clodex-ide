import type { AutomationSchedule } from '@shared/automations';

const MINUTE_MS = 60_000;
const MAX_CRON_SEARCH_MINUTES = 2 * 366 * 24 * 60;

interface ZonedDateParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

interface CronField {
  any: boolean;
  values: Set<number>;
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseNumber(value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid cron value "${value}"`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Cron value "${value}" must be between ${min} and ${max}`);
  }
  return parsed;
}

function addRange(
  target: Set<number>,
  start: number,
  end: number,
  step: number,
): void {
  if (end < start) throw new Error('Cron range end must not precede start');
  for (let value = start; value <= end; value += step) target.add(value);
}

function parseCronField(
  source: string,
  min: number,
  max: number,
  normalize?: (value: number) => number,
): CronField {
  const values = new Set<number>();
  const any = source === '*';

  for (const rawPart of source.split(',')) {
    const part = rawPart.trim();
    if (!part) throw new Error('Cron fields may not contain empty list items');

    const [rangeSource, stepSource] = part.split('/');
    if (part.split('/').length > 2)
      throw new Error(`Invalid cron field "${part}"`);
    const step =
      stepSource === undefined ? 1 : parseNumber(stepSource, 1, max - min + 1);

    if (rangeSource === '*') {
      addRange(values, min, max, step);
      continue;
    }

    const rangeParts = rangeSource.split('-');
    if (rangeParts.length === 1) {
      const value = parseNumber(rangeParts[0] ?? '', min, max);
      values.add(normalize?.(value) ?? value);
      continue;
    }
    if (rangeParts.length !== 2) {
      throw new Error(`Invalid cron range "${rangeSource}"`);
    }
    const start = parseNumber(rangeParts[0] ?? '', min, max);
    const end = parseNumber(rangeParts[1] ?? '', min, max);
    const expanded = new Set<number>();
    addRange(expanded, start, end, step);
    for (const value of expanded) values.add(normalize?.(value) ?? value);
  }

  return { any, values };
}

export function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('Cron expression must contain exactly five fields');
  }

  return {
    minute: parseCronField(fields[0] ?? '', 0, 59),
    hour: parseCronField(fields[1] ?? '', 0, 23),
    dayOfMonth: parseCronField(fields[2] ?? '', 1, 31),
    month: parseCronField(fields[3] ?? '', 1, 12),
    dayOfWeek: parseCronField(fields[4] ?? '', 0, 7, (value) =>
      value === 7 ? 0 : value,
    ),
  };
}

function getZonedDateParts(date: Date, timezone: string): ZonedDateParts {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      minute: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      day: '2-digit',
      month: '2-digit',
      weekday: 'short',
    });
  } catch {
    throw new Error(`Unknown automation timezone "${timezone}"`);
  }

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    parts.weekday ?? '',
  );
  if (weekday < 0) throw new Error('Unable to resolve cron weekday');

  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek: weekday,
  };
}

function cronMatches(cron: ParsedCron, parts: ZonedDateParts): boolean {
  if (!cron.minute.values.has(parts.minute)) return false;
  if (!cron.hour.values.has(parts.hour)) return false;
  if (!cron.month.values.has(parts.month)) return false;

  const dayOfMonthMatches = cron.dayOfMonth.values.has(parts.dayOfMonth);
  const dayOfWeekMatches = cron.dayOfWeek.values.has(parts.dayOfWeek);
  const dayMatches =
    cron.dayOfMonth.any && cron.dayOfWeek.any
      ? true
      : cron.dayOfMonth.any
        ? dayOfWeekMatches
        : cron.dayOfWeek.any
          ? dayOfMonthMatches
          : dayOfMonthMatches || dayOfWeekMatches;
  return dayMatches;
}

function nextCronRun(
  expression: string,
  timezone: string,
  afterMs: number,
): number {
  const cron = parseCronExpression(expression);
  let candidate =
    Math.floor(Math.max(0, afterMs) / MINUTE_MS) * MINUTE_MS + MINUTE_MS;

  for (let index = 0; index < MAX_CRON_SEARCH_MINUTES; index += 1) {
    if (cronMatches(cron, getZonedDateParts(new Date(candidate), timezone))) {
      return candidate;
    }
    candidate += MINUTE_MS;
  }

  throw new Error(
    'Cron expression has no run within the supported search window',
  );
}

export function getNextAutomationRunAt(
  schedule: AutomationSchedule,
  afterMs: number,
): number | null {
  switch (schedule.kind) {
    case 'once': {
      const runAt = Date.parse(schedule.runAt);
      return Number.isFinite(runAt) && runAt > afterMs ? runAt : null;
    }
    case 'interval': {
      const anchor = schedule.anchorAt
        ? Date.parse(schedule.anchorAt)
        : Math.max(0, afterMs);
      if (!Number.isFinite(anchor)) throw new Error('Invalid interval anchor');
      if (anchor > afterMs) return anchor;
      const elapsed = afterMs - anchor;
      return (
        anchor + (Math.floor(elapsed / schedule.everyMs) + 1) * schedule.everyMs
      );
    }
    case 'cron':
      return nextCronRun(schedule.expression, schedule.timezone, afterMs);
  }
}
