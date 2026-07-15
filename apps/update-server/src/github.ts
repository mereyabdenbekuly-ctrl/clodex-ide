import { config } from './config.js';
import {
  parseVersion,
  extractVersionFromTag,
  compareVersions,
  type ParsedVersion,
} from './version.js';

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  assets: GitHubAsset[];
}

export interface Release {
  tag: string;
  version: string;
  parsedVersion: ParsedVersion;
  name: string;
  notes: string;
  publishedAt: string;
  assets: GitHubAsset[];
}

let cachedReleases: Release[] = [];
let lastFetch = 0;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalPublishedAt(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    return false;
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return false;
  const canonical = instant.toISOString();
  return value === canonical || value === canonical.replace('.000Z', 'Z');
}

function parsePublishedRelease(value: unknown): GitHubRelease | null {
  if (!isObject(value)) return null;
  if (typeof value.draft !== 'boolean' || value.draft) return null;
  if (typeof value.prerelease !== 'boolean') return null;
  if (!isCanonicalPublishedAt(value.published_at)) return null;
  if (
    typeof value.tag_name !== 'string' ||
    !Array.isArray(value.assets) ||
    !value.assets.every(
      (asset) =>
        isObject(asset) &&
        typeof asset.name === 'string' &&
        typeof asset.browser_download_url === 'string' &&
        Number.isSafeInteger(asset.size) &&
        Number(asset.size) >= 0,
    )
  ) {
    return null;
  }
  if (value.name !== null && typeof value.name !== 'string') return null;
  if (value.body !== null && typeof value.body !== 'string') return null;

  return value as unknown as GitHubRelease;
}

export async function fetchReleases(): Promise<Release[]> {
  const url = `https://api.github.com/repos/${config.githubOrg}/${config.githubRepo}/releases?per_page=100`;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'update-server',
  };

  if (config.githubToken) {
    headers.Authorization = `Bearer ${config.githubToken}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText}`,
    );
  }

  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error('GitHub API returned an invalid release list');
  }
  const releases: Release[] = [];

  for (const value of data) {
    const release = parsePublishedRelease(value);
    if (!release) continue;
    const version = extractVersionFromTag(release.tag_name, config.appName);
    if (!version) continue;

    const parsedVersion = parseVersion(version);
    if (!parsedVersion) continue;

    releases.push({
      tag: release.tag_name,
      version,
      parsedVersion,
      name: release.name || version,
      notes: release.body || '',
      publishedAt: release.published_at,
      assets: release.assets,
    });
  }

  // Sort releases by version (newest first)
  releases.sort((a, b) => compareVersions(b.version, a.version));

  return releases;
}

export async function getReleases(): Promise<Release[]> {
  const now = Date.now();

  if (
    cachedReleases.length === 0 ||
    now - lastFetch > config.refreshIntervalMs
  ) {
    try {
      cachedReleases = await fetchReleases();
      lastFetch = now;
      console.log(`Fetched ${cachedReleases.length} releases from GitHub`);
    } catch (error) {
      console.error('Failed to fetch releases:', error);
      if (cachedReleases.length === 0) {
        throw error;
      }
      // Keep using cached releases if fetch fails
    }
  }

  return cachedReleases;
}

export function startRefreshInterval(): void {
  setInterval(async () => {
    try {
      cachedReleases = await fetchReleases();
      lastFetch = Date.now();
      console.log(`Refreshed: ${cachedReleases.length} releases`);
    } catch (error) {
      console.error('Failed to refresh releases:', error);
    }
  }, config.refreshIntervalMs);
}
