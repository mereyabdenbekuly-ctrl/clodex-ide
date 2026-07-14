import { describe, expect, it } from 'vitest';
import {
  legacyMountPrefixForPath,
  mountPrefixForPath,
} from '../mount-manager/mount-registry';
import { migrateLegacyMountPrefixes } from './mount-prefix-migration';

describe('persisted mount-prefix migration', () => {
  it('rewrites legacy mounted paths recursively without matching longer tokens', () => {
    const workspacePath = '/tmp/clodex-prefix-migration';
    const legacyPrefix = legacyMountPrefixForPath(workspacePath);
    const currentPrefix = mountPrefixForPath(workspacePath);
    const persisted = {
      text: `Read ${legacyPrefix}/src/index.ts and (${legacyPrefix}\\README.md)`,
      tool: { input: { path: `${legacyPrefix}/package.json` } },
      unrelated: `x${legacyPrefix}/not-a-mounted-token`,
      current: `${currentPrefix}/already-current.ts`,
    };

    expect(
      migrateLegacyMountPrefixes(persisted, [{ path: workspacePath }]),
    ).toEqual({
      text: `Read ${currentPrefix}/src/index.ts and (${currentPrefix}\\README.md)`,
      tool: { input: { path: `${currentPrefix}/package.json` } },
      unrelated: `x${legacyPrefix}/not-a-mounted-token`,
      current: `${currentPrefix}/already-current.ts`,
    });
  });

  it('leaves an ambiguous legacy prefix untouched', () => {
    const first = '/tmp/clodex-mount-collision-181';
    const second = '/tmp/clodex-mount-collision-501';
    const legacyPrefix = legacyMountPrefixForPath(first);

    expect(legacyMountPrefixForPath(second)).toBe(legacyPrefix);
    expect(
      migrateLegacyMountPrefixes(`${legacyPrefix}/src/index.ts`, [
        { path: first },
        { path: second },
      ]),
    ).toBe(`${legacyPrefix}/src/index.ts`);
  });
});
