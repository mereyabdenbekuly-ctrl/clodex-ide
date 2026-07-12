import { describe, expect, it } from 'vitest';
import { activateMountedFlag } from './codex-micro-lifecycle';

describe('activateMountedFlag', () => {
  it('restores the mounted state after a StrictMode effect replay', () => {
    const flag = { current: true };

    const firstCleanup = activateMountedFlag(flag);
    firstCleanup();
    expect(flag.current).toBe(false);

    const secondCleanup = activateMountedFlag(flag);
    expect(flag.current).toBe(true);

    secondCleanup();
    expect(flag.current).toBe(false);
  });
});
