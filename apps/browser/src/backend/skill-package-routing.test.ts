import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSkillInstallUrl,
  extractSkillPackagePaths,
  extractUrlsFromArgs,
  isSkillPackagePath,
} from './skill-package-routing';

describe('skill package routing', () => {
  it('recognizes local skill packages and SKILL.md files', () => {
    expect(isSkillPackagePath('/tmp/example.skill')).toBe(true);
    expect(isSkillPackagePath('/tmp/example.clodex-skill')).toBe(true);
    expect(isSkillPackagePath('/tmp/SKILL.md')).toBe(true);
    expect(isSkillPackagePath('/tmp/readme.md')).toBe(false);
  });

  it('never treats supported URLs as filesystem packages', () => {
    const deepLink = 'clodex://skill/install?path=/tmp/agent-os-deeplink.skill';

    expect(isSkillPackagePath(deepLink)).toBe(false);
    expect(isSkillPackagePath('https://example.com/package.skill')).toBe(false);
    expect(extractSkillPackagePaths(['electron', '.', deepLink])).toEqual([]);
    expect(extractUrlsFromArgs(['electron', '.', deepLink])).toEqual([
      deepLink,
    ]);
  });

  it('creates an absolute encoded install deep link', () => {
    const sourcePath = './fixtures/example skill.skill';
    const url = new URL(createSkillInstallUrl(sourcePath));

    expect(`${url.hostname}${url.pathname}`).toBe('skill/install');
    expect(url.searchParams.get('path')).toBe(path.resolve(sourcePath));
  });

  it('ignores command-line flags while extracting package paths', () => {
    expect(
      extractSkillPackagePaths([
        '--inspect=/tmp/debug.skill',
        '/tmp/install.skill',
      ]),
    ).toEqual([path.resolve('/tmp/install.skill')]);
  });
});
