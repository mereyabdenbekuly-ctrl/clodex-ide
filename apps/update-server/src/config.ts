import semver from 'semver';
import { matchesChannel, parseVersion } from './version.js';

export type Channel = 'release' | 'nightly' | 'beta' | 'alpha';
export type Platform = 'macos' | 'win' | 'linux';
export type LinuxFormat = 'deb' | 'rpm';

const channels: Channel[] = ['release', 'nightly', 'beta', 'alpha'];

export function parseBlockedVersions(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export function parseChannelPins(
  value: string | undefined,
): Partial<Record<Channel, string>> {
  if (!value?.trim()) return {};
  const pins: Partial<Record<Channel, string>> = {};
  for (const item of value.split(',')) {
    const [rawChannel, rawVersion, ...extra] = item.split('=');
    const channel = rawChannel?.trim() as Channel;
    const version = rawVersion?.trim();
    if (
      extra.length > 0 ||
      !channels.includes(channel) ||
      !version ||
      pins[channel]
    ) {
      throw new Error(
        `Invalid UPDATE_CHANNEL_PINS entry: ${item}. Expected channel=version.`,
      );
    }
    pins[channel] = version;
  }
  return pins;
}

export const config = {
  port: Number.parseInt(process.env.PORT || '3000', 10),
  appName: process.env.APP_NAME || 'clodex',
  githubOrg: process.env.APP_GITHUB_ORG || 'clodex',
  githubRepo: process.env.APP_GITHUB_REPO || 'clodex',
  githubToken: process.env.GITHUB_TOKEN || undefined,
  refreshIntervalMs: 15 * 60 * 1000, // 15 minutes
  // Public-facing base URL of this update server (e.g. https://update.clodex.io).
  // Used when building self-referential proxy URLs inside Squirrel.Windows
  // RELEASES manifests. REQUIRED in production (enforced at startup); in
  // non-production environments we fall back to the request-derived origin.
  publicUrl: process.env.PUBLIC_URL || undefined,
  isProduction: process.env.NODE_ENV === 'production',
  // Emergency rollout controls:
  // UPDATE_BLOCKED_VERSIONS=1.16.0,1.16.1 prevents those releases from being
  // selected for updates or first-time downloads.
  blockedVersions: parseBlockedVersions(process.env.UPDATE_BLOCKED_VERSIONS),
  // UPDATE_CHANNEL_PINS=release=1.15.9,beta=1.16.0-beta003 constrains a
  // channel to one known-good release. This is a rollout hold, not a client
  // downgrade: Electron autoUpdater intentionally remains forward-only.
  channelPins: parseChannelPins(process.env.UPDATE_CHANNEL_PINS),
};

/**
 * Validate runtime configuration. Called at startup so misconfigured
 * deployments fail fast (health check fails → Railway rolls back) instead
 * of serving broken RELEASES manifests to users.
 */
export function validateConfig(): void {
  if (config.isProduction && !config.publicUrl) {
    throw new Error(
      'FATAL: PUBLIC_URL must be set in production. ' +
        'This is required to build self-referential URLs in Squirrel.Windows ' +
        'RELEASES manifests. Example: PUBLIC_URL=https://dl.clodex.io',
    );
  }
  validateReleasePolicy(config.blockedVersions, config.channelPins);
}

export function validateReleasePolicy(
  blockedVersions: readonly string[],
  channelPins: Partial<Record<Channel, string>>,
): void {
  for (const version of blockedVersions) {
    if (!semver.valid(version)) {
      throw new Error(
        `FATAL: UPDATE_BLOCKED_VERSIONS contains an invalid semantic version: ${version}`,
      );
    }
  }
  for (const [channel, version] of Object.entries(channelPins)) {
    const parsed = parseVersion(version);
    if (!parsed) {
      throw new Error(
        `FATAL: UPDATE_CHANNEL_PINS contains an invalid semantic version for ${channel}: ${version}`,
      );
    }
    if (!matchesChannel(parsed, channel as Channel)) {
      throw new Error(
        `FATAL: UPDATE_CHANNEL_PINS version ${version} does not belong to channel ${channel}`,
      );
    }
    if (blockedVersions.includes(version)) {
      throw new Error(
        `FATAL: ${channel} is pinned to blocked version ${version}`,
      );
    }
  }
}
