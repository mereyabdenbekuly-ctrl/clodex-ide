export type CommunityReleaseStatus = 'unavailable' | 'verified';

export interface CommunityReleaseDownload {
  id: string;
  platform: string;
  architecture: string;
  format: string;
  href: string;
}

export interface CommunityReleaseManifest {
  status: CommunityReleaseStatus;
  name: string;
  version: string | null;
  tag: string | null;
  releaseUrl: string | null;
  checksumsUrl: string | null;
  evidenceUrl: string | null;
  sourceCommit: string | null;
  sourceUrl: string | null;
  buildRunId: string | null;
  buildRunUrl: string | null;
  downloads: readonly CommunityReleaseDownload[];
}

export type ReadyCommunityReleaseManifest = Omit<
  CommunityReleaseManifest,
  | 'status'
  | 'version'
  | 'tag'
  | 'releaseUrl'
  | 'checksumsUrl'
  | 'evidenceUrl'
  | 'sourceCommit'
  | 'sourceUrl'
  | 'buildRunId'
  | 'buildRunUrl'
  | 'downloads'
> & {
  status: 'verified';
  version: string;
  tag: string;
  releaseUrl: string;
  checksumsUrl: string;
  evidenceUrl: string;
  sourceCommit: string;
  sourceUrl: string;
  buildRunId: string;
  buildRunUrl: string;
  downloads: readonly [
    CommunityReleaseDownload,
    CommunityReleaseDownload,
    CommunityReleaseDownload,
    CommunityReleaseDownload,
    CommunityReleaseDownload,
  ];
};

const COMMUNITY_REPOSITORY_URL =
  'https://github.com/mereyabdenbekuly-ctrl/clodex-ide';

function isExactNonEmptyString(value: string | null): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

/**
 * Fail closed unless the manifest is one complete, internally coherent
 * Community Observed release. Consumers must use the returned value instead
 * of checking individual fields independently.
 */
export function getReadyCommunityRelease(
  manifest: CommunityReleaseManifest,
): ReadyCommunityReleaseManifest | null {
  if (
    manifest.status !== 'verified' ||
    !isExactNonEmptyString(manifest.name) ||
    !isExactNonEmptyString(manifest.version) ||
    !isExactNonEmptyString(manifest.tag) ||
    !isExactNonEmptyString(manifest.releaseUrl) ||
    !isExactNonEmptyString(manifest.checksumsUrl) ||
    !isExactNonEmptyString(manifest.evidenceUrl) ||
    !isExactNonEmptyString(manifest.sourceCommit) ||
    !isExactNonEmptyString(manifest.sourceUrl) ||
    !isExactNonEmptyString(manifest.buildRunId) ||
    !isExactNonEmptyString(manifest.buildRunUrl) ||
    !Array.isArray(manifest.downloads) ||
    manifest.downloads.length !== 5
  ) {
    return null;
  }

  const versionMatch = /^(\d+\.\d+\.\d+)-communityobserved([1-9]\d*)$/u.exec(
    manifest.version,
  );
  if (!versionMatch) {
    return null;
  }

  const [, baseVersion, observedNumber] = versionMatch;
  const releaseAssetBase = `${COMMUNITY_REPOSITORY_URL}/releases/download/${manifest.tag}`;
  if (
    manifest.name !== `CLODEx Community Observed ${observedNumber}` ||
    manifest.tag !== `v${manifest.version}` ||
    !/^[0-9a-f]{40}$/u.test(manifest.sourceCommit) ||
    !/^[1-9]\d*$/u.test(manifest.buildRunId) ||
    manifest.releaseUrl !==
      `${COMMUNITY_REPOSITORY_URL}/releases/tag/${manifest.tag}` ||
    manifest.checksumsUrl !== `${releaseAssetBase}/SHA256SUMS.txt` ||
    manifest.evidenceUrl !==
      `${releaseAssetBase}/clodex-community-observed-${manifest.version}-evidence.zip` ||
    manifest.sourceUrl !==
      `${COMMUNITY_REPOSITORY_URL}/commit/${manifest.sourceCommit}` ||
    manifest.buildRunUrl !==
      `${COMMUNITY_REPOSITORY_URL}/actions/runs/${manifest.buildRunId}`
  ) {
    return null;
  }

  const expectedDownloads = [
    {
      id: 'macos-arm64',
      platform: 'macOS',
      architecture: 'Apple Silicon',
      format: 'DMG',
      href: `${releaseAssetBase}/clodex-community-observed-${manifest.version}-arm64.dmg`,
    },
    {
      id: 'macos-x64',
      platform: 'macOS',
      architecture: 'Intel',
      format: 'DMG',
      href: `${releaseAssetBase}/clodex-community-observed-${manifest.version}-x64.dmg`,
    },
    {
      id: 'windows-x64',
      platform: 'Windows',
      architecture: 'x64',
      format: 'EXE',
      href: `${releaseAssetBase}/clodex-community-observed-${manifest.version}-x64-setup.exe`,
    },
    {
      id: 'linux-deb-x64',
      platform: 'Debian / Ubuntu',
      architecture: 'x64',
      format: 'DEB',
      href: `${releaseAssetBase}/clodex-community-observed_${manifest.version}_amd64.deb`,
    },
    {
      id: 'linux-rpm-x64',
      platform: 'Fedora / RHEL',
      architecture: 'x64',
      format: 'RPM',
      href: `${releaseAssetBase}/clodex-community-observed-${baseVersion}.communityobserved${observedNumber}-1.x86_64.rpm`,
    },
  ] as const;

  const hasExactDownloads = expectedDownloads.every((expected, index) => {
    const actual = manifest.downloads[index];
    return (
      actual?.id === expected.id &&
      actual.platform === expected.platform &&
      actual.architecture === expected.architecture &&
      actual.format === expected.format &&
      actual.href === expected.href
    );
  });

  return hasExactDownloads ? (manifest as ReadyCommunityReleaseManifest) : null;
}

/**
 * Current Community Free Technical Preview. Keep this mapping pinned to one
 * exact immutable GitHub prerelease: source, build run, tag, evidence, and all
 * five installer names must move together in one reviewed release-coherence
 * change.
 */
export const COMMUNITY_RELEASE: CommunityReleaseManifest = {
  status: 'verified',
  name: 'CLODEx Community Observed 11',
  version: '1.16.0-communityobserved11',
  tag: 'v1.16.0-communityobserved11',
  releaseUrl:
    'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/tag/v1.16.0-communityobserved11',
  checksumsUrl:
    'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/download/v1.16.0-communityobserved11/SHA256SUMS.txt',
  evidenceUrl:
    'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/download/v1.16.0-communityobserved11/clodex-community-observed-1.16.0-communityobserved11-evidence.zip',
  sourceCommit: 'a2645d0a948a6b2c782edce7b02f4bfde49718ce',
  sourceUrl:
    'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/commit/a2645d0a948a6b2c782edce7b02f4bfde49718ce',
  buildRunId: '29677260054',
  buildRunUrl:
    'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/actions/runs/29677260054',
  downloads: [
    {
      id: 'macos-arm64',
      platform: 'macOS',
      architecture: 'Apple Silicon',
      format: 'DMG',
      href: 'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/download/v1.16.0-communityobserved11/clodex-community-observed-1.16.0-communityobserved11-arm64.dmg',
    },
    {
      id: 'macos-x64',
      platform: 'macOS',
      architecture: 'Intel',
      format: 'DMG',
      href: 'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/download/v1.16.0-communityobserved11/clodex-community-observed-1.16.0-communityobserved11-x64.dmg',
    },
    {
      id: 'windows-x64',
      platform: 'Windows',
      architecture: 'x64',
      format: 'EXE',
      href: 'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/download/v1.16.0-communityobserved11/clodex-community-observed-1.16.0-communityobserved11-x64-setup.exe',
    },
    {
      id: 'linux-deb-x64',
      platform: 'Debian / Ubuntu',
      architecture: 'x64',
      format: 'DEB',
      href: 'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/download/v1.16.0-communityobserved11/clodex-community-observed_1.16.0-communityobserved11_amd64.deb',
    },
    {
      id: 'linux-rpm-x64',
      platform: 'Fedora / RHEL',
      architecture: 'x64',
      format: 'RPM',
      href: 'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/download/v1.16.0-communityobserved11/clodex-community-observed-1.16.0.communityobserved11-1.x86_64.rpm',
    },
  ],
};

/**
 * Historical reference only. Observed 8 predates the enforced Free boundary
 * and must not be advertised as satisfying the current Free Product Contract.
 * Keep users on the release page rather than linking directly to its assets.
 */
export const LEGACY_COMMUNITY_RELEASE = {
  name: 'CLODEx Community Observed 8',
  version: '1.16.0-communityobserved8',
  tag: 'v1.16.0-communityobserved8',
  releaseUrl:
    'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/tag/v1.16.0-communityobserved8',
  sourceCommit: 'a63fc5d79b3c6a3442e6e2a2116e575478cb96ae',
} as const;
