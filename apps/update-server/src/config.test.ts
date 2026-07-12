import { describe, expect, it } from 'vitest';
import {
  parseBlockedVersions,
  parseChannelPins,
  validateReleasePolicy,
} from './config.js';

describe('update rollout environment parsing', () => {
  it('deduplicates blocked release versions', () => {
    expect(parseBlockedVersions('1.16.1, 1.16.0,1.16.1')).toEqual([
      '1.16.1',
      '1.16.0',
    ]);
  });

  it('parses per-channel pins', () => {
    expect(parseChannelPins('release=1.16.0,beta=1.17.0-beta003')).toEqual({
      release: '1.16.0',
      beta: '1.17.0-beta003',
    });
  });

  it('rejects malformed and duplicate channel pins', () => {
    expect(() => parseChannelPins('release')).toThrow(
      'Expected channel=version',
    );
    expect(() => parseChannelPins('release=1.16.0,release=1.15.9')).toThrow(
      'Expected channel=version',
    );
  });

  it('rejects invalid, cross-channel, and blocked pins', () => {
    expect(() => validateReleasePolicy(['invalid'], {})).toThrow(
      'invalid semantic version',
    );
    expect(() =>
      validateReleasePolicy([], { release: '1.17.0-beta003' }),
    ).toThrow('does not belong to channel release');
    expect(() =>
      validateReleasePolicy(['1.16.0'], { release: '1.16.0' }),
    ).toThrow('pinned to blocked version');
  });
});
