import type { UpdateChannel } from '@shared/karton-contracts/ui/shared-types';

export type AppReleaseChannel = 'dev' | 'prerelease' | 'nightly' | 'release';
export type UpdatePlatform = 'macos' | 'win' | 'linux';
export type UpdateArchitecture = 'arm64' | 'x64';

export function resolveUpdatePlatform(platform: string): UpdatePlatform {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'win';
  return 'linux';
}

export function resolveUpdateArchitecture(
  architecture: string,
): UpdateArchitecture {
  return architecture === 'arm64' ? 'arm64' : 'x64';
}

export function inferPrereleaseUpdateChannel(
  version: string,
): UpdateChannel | null {
  if (/^\d+\.\d+\.\d+-alpha(?:\.?\d+)$/u.test(version)) return 'alpha';
  if (/^\d+\.\d+\.\d+-beta(?:\.?\d+)$/u.test(version)) return 'beta';
  return null;
}

export function isTechnicalPreviewVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-preview\.[1-9]\d*$/u.test(version);
}

export function resolveUpdateChannel(options: {
  releaseChannel: AppReleaseChannel;
  version: string;
  preference?: UpdateChannel;
}): 'release' | 'nightly' | UpdateChannel | null {
  switch (options.releaseChannel) {
    case 'release':
      return 'release';
    case 'nightly':
      return 'nightly';
    case 'prerelease':
      if (isTechnicalPreviewVersion(options.version)) return null;
      return (
        options.preference ?? inferPrereleaseUpdateChannel(options.version)
      );
    default:
      return 'alpha';
  }
}

export function buildUpdateFeedURL(options: {
  origin: string | undefined;
  appName?: string;
  releaseChannel: AppReleaseChannel;
  version: string;
  platform: string;
  architecture: string;
  preference?: UpdateChannel;
}): string | null {
  // Technical previews are distributed as manually installed GitHub
  // prereleases. They must never silently inherit the beta feed: preview.1
  // has no compatible updater artifacts to serve as a rollback target.
  if (
    options.releaseChannel === 'prerelease' &&
    isTechnicalPreviewVersion(options.version)
  ) {
    return null;
  }

  const rawOrigin = options.origin?.trim();
  if (!rawOrigin) return null;

  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    return null;
  }

  const base = origin.toString().replace(/\/+$/, '');
  const channel = resolveUpdateChannel(options);
  if (!channel) return null;
  const platform = resolveUpdatePlatform(options.platform);
  const architecture = resolveUpdateArchitecture(options.architecture);
  const appName = options.appName ?? 'clodex';
  const segments = [
    'update',
    appName,
    channel,
    platform,
    architecture,
    options.version,
  ].map(encodeURIComponent);

  return `${base}/${segments.join('/')}`;
}
