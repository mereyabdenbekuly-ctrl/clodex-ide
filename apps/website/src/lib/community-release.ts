export type CommunityReleaseStatus = 'pending-verification' | 'verified';

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
  downloads: readonly CommunityReleaseDownload[];
}

/**
 * Direct downloads stay empty until a build from canonical main passes the
 * Community Free boundary and packaged-byte verification. Publishing a new
 * release is intentionally a manifest-only follow-up change.
 */
export const COMMUNITY_RELEASE: CommunityReleaseManifest = {
  status: 'pending-verification',
  name: 'Next verified CLODEx Community Free build',
  version: null,
  tag: null,
  releaseUrl: null,
  checksumsUrl: null,
  evidenceUrl: null,
  sourceCommit: null,
  downloads: [],
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
