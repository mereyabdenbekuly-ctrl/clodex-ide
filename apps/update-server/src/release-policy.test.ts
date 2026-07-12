import { describe, expect, it } from 'vitest';
import type { Release } from './github.js';
import {
  getEligibleReleases,
  selectMacOSUpdateAsset,
  transformReleasesContent,
  type ReleasePolicy,
} from './releases.js';
import { parseVersion } from './version.js';

function release(version: string): Release {
  const parsedVersion = parseVersion(version);
  if (!parsedVersion) throw new Error(`Invalid fixture version: ${version}`);
  return {
    tag: `clodex@${version}`,
    version,
    parsedVersion,
    name: `Clodex ${version}`,
    notes: `Release ${version}`,
    publishedAt: '2026-07-11T00:00:00.000Z',
    assets: [
      {
        name: `clodex-darwin-arm64-${version}.zip`,
        browser_download_url: `https://example.test/clodex-darwin-arm64-${version}.zip`,
        size: 123,
      },
      {
        name: `clodex-${version}-x64-full.nupkg`,
        browser_download_url: `https://example.test/clodex-${version}-x64-full.nupkg`,
        size: 456,
      },
    ],
  };
}

const openPolicy: ReleasePolicy = {
  blockedVersions: [],
  channelPins: {},
};

describe('release rollout and rollback policy', () => {
  const releases = [release('1.16.1'), release('1.16.0'), release('1.15.9')];

  it('selects the newest channel release during a normal rollout', () => {
    expect(
      selectMacOSUpdateAsset(releases, 'release', 'arm64', '1.15.9', openPolicy)
        ?.release.version,
    ).toBe('1.16.1');
  });

  it('skips a blocked bad release and falls back to the known-good release', () => {
    const policy: ReleasePolicy = {
      blockedVersions: ['1.16.1'],
      channelPins: {},
    };
    expect(
      selectMacOSUpdateAsset(releases, 'release', 'arm64', '1.15.9', policy)
        ?.release.version,
    ).toBe('1.16.0');
  });

  it('never offers a downgrade to a client already on the blocked release', () => {
    const policy: ReleasePolicy = {
      blockedVersions: ['1.16.1'],
      channelPins: {},
    };
    expect(
      selectMacOSUpdateAsset(releases, 'release', 'arm64', '1.16.1', policy),
    ).toBeNull();
  });

  it('pins a channel to one known-good release', () => {
    const policy: ReleasePolicy = {
      blockedVersions: [],
      channelPins: { release: '1.16.0' },
    };
    expect(
      getEligibleReleases(releases, 'release', policy).map(
        (candidate) => candidate.version,
      ),
    ).toEqual(['1.16.0']);
  });

  it('rewrites Windows full-package URLs without an architecture suffix', () => {
    const current = releases[0];
    const content =
      '0123456789abcdef0123456789abcdef01234567 clodex-1.16.1-x64-full.nupkg 456';
    expect(
      transformReleasesContent(
        content,
        current,
        'https://updates.clodex.xyz/',
        'release',
        'x64',
      ),
    ).toBe(
      '0123456789abcdef0123456789abcdef01234567 https://updates.clodex.xyz/update/clodex/release/win/x64/nupkg/clodex-1.16.1-full.nupkg 456',
    );
  });
});
