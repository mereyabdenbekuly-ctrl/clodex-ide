import { describe, expect, it } from 'vitest';
import {
  hashRecoverySemanticState,
  parseSessionRecoveryAcceptancePhase,
} from './session-recovery-acceptance';

describe('packaged session recovery acceptance internals', () => {
  it('accepts only the two bounded packaged phases', () => {
    expect(parseSessionRecoveryAcceptancePhase('seed')).toBe('seed');
    expect(parseSessionRecoveryAcceptancePhase('verify')).toBe('verify');
    expect(() => parseSessionRecoveryAcceptancePhase('')).toThrow(
      'must be "seed" or "verify"',
    );
    expect(() => parseSessionRecoveryAcceptancePhase('delete')).toThrow(
      'must be "seed" or "verify"',
    );
  });

  it('hashes semantic state canonically without depending on key order', () => {
    const left = {
      title: 'marker',
      goal: { status: 'blocked', objective: 'recover' },
      counts: [0, 0, 0],
    };
    const right = {
      counts: [0, 0, 0],
      goal: { objective: 'recover', status: 'blocked' },
      title: 'marker',
    };

    expect(hashRecoverySemanticState(left)).toBe(
      hashRecoverySemanticState(right),
    );
    expect(hashRecoverySemanticState({ ...right, title: 'changed' })).not.toBe(
      hashRecoverySemanticState(left),
    );
  });
});
