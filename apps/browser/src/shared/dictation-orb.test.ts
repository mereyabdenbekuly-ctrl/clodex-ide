import { describe, expect, it } from 'vitest';
import {
  clampDictationOrbPosition,
  getDefaultDictationOrbPosition,
  parseDictationOrbPosition,
} from './dictation-orb';

describe('dictation orb geometry', () => {
  it('clamps the orb inside the viewport margin', () => {
    expect(
      clampDictationOrbPosition(
        { x: -100, y: 900 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ x: 16, y: 528 });
  });

  it('places the default above bottom-right floating controls', () => {
    expect(getDefaultDictationOrbPosition({ width: 800, height: 600 })).toEqual(
      { x: 720, y: 432 },
    );
  });

  it('parses only finite persisted coordinates', () => {
    expect(parseDictationOrbPosition('{"x":120,"y":240}')).toEqual({
      x: 120,
      y: 240,
    });
    expect(parseDictationOrbPosition('{"x":"120","y":240}')).toBeNull();
    expect(parseDictationOrbPosition('invalid')).toBeNull();
  });
});
