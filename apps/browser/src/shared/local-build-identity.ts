export type AppReleaseChannel = 'dev' | 'prerelease' | 'nightly' | 'release';

export interface AppIdentity {
  localBuildId: string;
  baseName: string;
  appName: string;
  bundleId: string;
}

const CHANNEL_IDENTITIES: Record<
  AppReleaseChannel,
  Omit<AppIdentity, 'localBuildId'>
> = {
  dev: {
    baseName: 'clodex-dev',
    appName: 'Clodex Agentic IDE (Dev-Build)',
    bundleId: 'xyz.clodex.agentic-ide.dev',
  },
  prerelease: {
    baseName: 'clodex-prerelease',
    appName: 'Clodex Agentic IDE (Pre-Release)',
    bundleId: 'xyz.clodex.agentic-ide.prerelease',
  },
  nightly: {
    baseName: 'clodex-nightly',
    appName: 'Clodex Agentic IDE Nightly',
    bundleId: 'xyz.clodex.agentic-ide.nightly',
  },
  release: {
    baseName: 'clodex',
    appName: 'Clodex Agentic IDE',
    bundleId: 'xyz.clodex.agentic-ide',
  },
};

/**
 * Gives an ad-hoc local package its own app, bundle, profile and Keychain
 * namespace while preserving canonical identities for normal builds.
 */
export function resolveAppIdentity(options: {
  releaseChannel: AppReleaseChannel;
  localBuildId?: string;
  allowUnsignedLocalBuild: boolean;
}): AppIdentity {
  const localBuildId = options.localBuildId?.trim() ?? '';
  if (localBuildId && !options.allowUnsignedLocalBuild) {
    throw new Error(
      'CLODEX_LOCAL_BUILD_ID requires CLODEX_ALLOW_UNSIGNED_LOCAL_BUILD=true',
    );
  }
  if (localBuildId && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(localBuildId)) {
    throw new Error(
      'CLODEX_LOCAL_BUILD_ID must be 1-40 lowercase letters, numbers, or hyphens',
    );
  }

  const channelIdentity = CHANNEL_IDENTITIES[options.releaseChannel];
  if (!localBuildId) {
    return { localBuildId, ...channelIdentity };
  }

  return {
    localBuildId,
    baseName: `${channelIdentity.baseName}-local-${localBuildId}`,
    appName: `${channelIdentity.appName} [Local ${localBuildId}]`,
    bundleId: `${channelIdentity.bundleId}.local.${localBuildId}`,
  };
}
