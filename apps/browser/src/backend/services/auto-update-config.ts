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

export function inferPrereleaseUpdateChannel(version: string): UpdateChannel {
  return version.includes('-alpha') ? 'alpha' : 'beta';
}

export function resolveUpdateChannel(options: {
  releaseChannel: AppReleaseChannel;
  version: string;
  preference?: UpdateChannel;
}): 'release' | 'nightly' | UpdateChannel {
  switch (options.releaseChannel) {
    case 'release':
      return 'release';
    case 'nightly':
      return 'nightly';
    case 'prerelease':
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
