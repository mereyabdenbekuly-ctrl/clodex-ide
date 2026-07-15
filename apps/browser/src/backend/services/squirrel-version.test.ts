import { describe, expect, it } from 'vitest';
import { toSquirrelInternalVersion } from '../../../etc/squirrel-version.mjs';

describe('Squirrel internal version conversion', () => {
  it.each([
    ['1.16.0', '1.16.0'],
    ['1.16.0-alpha001', '1.16.0-alpha001'],
    ['1.16.0-beta001', '1.16.0-beta001'],
    ['1.16.0-preview.2', '1.16.0-preview2'],
    ['1.16.0-preview.2+build.7', '1.16.0-preview2'],
  ])('converts %s to %s', (input, expected) => {
    expect(toSquirrelInternalVersion(input)).toBe(expected);
  });
});
