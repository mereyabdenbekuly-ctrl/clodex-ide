import { describe, expect, it } from 'vitest';
import {
  normalizeIdeTokenExpiresAt,
  parseIdeTokenExpiresAt,
} from './token-expiry';

describe('parseIdeTokenExpiresAt', () => {
  it('treats small numeric values as a relative TTL in seconds', () => {
    expect(parseIdeTokenExpiresAt('3600', 1_700_000_000_000)).toBe(
      1_700_003_600_000,
    );
  });

  it('treats Unix seconds and milliseconds as absolute expirations', () => {
    expect(parseIdeTokenExpiresAt('1893456000', 1_700_000_000_000)).toBe(
      1_893_456_000_000,
    );
    expect(parseIdeTokenExpiresAt('1893456000000', 1_700_000_000_000)).toBe(
      1_893_456_000_000,
    );
  });

  it('parses ISO timestamps and ignores invalid or non-positive values', () => {
    expect(parseIdeTokenExpiresAt('2030-01-01T00:00:00.000Z')).toBe(
      1_893_456_000_000,
    );
    expect(parseIdeTokenExpiresAt('0')).toBeNull();
    expect(parseIdeTokenExpiresAt('not-a-date')).toBeNull();
  });

  it('normalizes supported expiration formats to stable ISO timestamps', () => {
    expect(normalizeIdeTokenExpiresAt('3600', 1_700_000_000_000)).toBe(
      '2023-11-14T23:13:20.000Z',
    );
    expect(normalizeIdeTokenExpiresAt('1893456000')).toBe(
      '2030-01-01T00:00:00.000Z',
    );
    expect(normalizeIdeTokenExpiresAt('not-a-date')).toBe('not-a-date');
  });
});
