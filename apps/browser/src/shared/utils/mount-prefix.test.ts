import { describe, expect, it } from 'vitest';
import { stripWorkspaceMountPrefix } from './mount-prefix';

describe('stripWorkspaceMountPrefix', () => {
  it('strips legacy 4-hex and current 16-hex workspace prefixes', () => {
    expect(stripWorkspaceMountPrefix('wda51/src/index.ts')).toBe(
      'src/index.ts',
    );
    expect(stripWorkspaceMountPrefix('w2c9ed34e414edf8e/src/index.ts')).toBe(
      'src/index.ts',
    );
    expect(stripWorkspaceMountPrefix('wda51')).toBe('');
    expect(stripWorkspaceMountPrefix('w2c9ed34e414edf8e')).toBe('');
  });

  it('does not strip unsupported or partial workspace-like prefixes', () => {
    expect(stripWorkspaceMountPrefix('w12345678/src/index.ts')).toBe(
      'w12345678/src/index.ts',
    );
    expect(stripWorkspaceMountPrefix('w2c9ed34e414edf8eff/src/index.ts')).toBe(
      'w2c9ed34e414edf8eff/src/index.ts',
    );
    expect(stripWorkspaceMountPrefix('widget/src/index.ts')).toBe(
      'widget/src/index.ts',
    );
  });
});
