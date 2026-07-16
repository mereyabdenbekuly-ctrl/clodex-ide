export type AppReleaseChannel = 'dev' | 'prerelease' | 'nightly' | 'release';

export type AppDistributionMode = 'official' | 'community-unsigned';

export interface AppDistributionPolicy {
  authEnabled: boolean;
  autoUpdateEnabled: boolean;
  buildIdentifier: AppReleaseChannel | 'community-unsigned';
  registerDefaultProtocols: boolean;
  telemetryEnabled: boolean;
}

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

const COMMUNITY_UNSIGNED_IDENTITY: Omit<AppIdentity, 'localBuildId'> = {
  baseName: 'clodex-community-unsigned',
  appName: 'Clodex Agentic IDE (Community Unsigned)',
  bundleId: 'xyz.clodex.agentic-ide.community-unsigned',
};

export function resolveAppDistributionMode(
  value: string | undefined,
): AppDistributionMode {
  const normalized = value?.trim() ?? '';
  if (!normalized || normalized === 'official') return 'official';
  if (normalized === 'community-unsigned') return 'community-unsigned';
  throw new Error(`Unsupported CLODEX_DISTRIBUTION_MODE: ${normalized}`);
}

export function resolveAppDistributionPolicy(options: {
  distributionMode: AppDistributionMode;
  releaseChannel: AppReleaseChannel;
}): AppDistributionPolicy {
  if (options.distributionMode === 'community-unsigned') {
    if (options.releaseChannel !== 'release') {
      throw new Error(
        'community-unsigned distribution requires RELEASE_CHANNEL=release',
      );
    }
    return {
      authEnabled: false,
      autoUpdateEnabled: false,
      buildIdentifier: 'community-unsigned',
      registerDefaultProtocols: false,
      telemetryEnabled: false,
    };
  }

  return {
    authEnabled: true,
    autoUpdateEnabled: true,
    buildIdentifier: options.releaseChannel,
    registerDefaultProtocols: true,
    telemetryEnabled: true,
  };
}

/**
 * Gives an ad-hoc local package its own app, bundle, profile and Keychain
 * namespace while preserving canonical identities for normal builds.
 */
export function resolveAppIdentity(options: {
  distributionMode?: AppDistributionMode;
  releaseChannel: AppReleaseChannel;
  localBuildId?: string;
  allowUnsignedLocalBuild: boolean;
}): AppIdentity {
  const distributionMode = options.distributionMode ?? 'official';
  const localBuildId = options.localBuildId?.trim() ?? '';
  if (distributionMode === 'community-unsigned') {
    if (options.releaseChannel !== 'release') {
      throw new Error(
        'community-unsigned distribution requires RELEASE_CHANNEL=release',
      );
    }
    if (localBuildId || options.allowUnsignedLocalBuild) {
      throw new Error(
        'community-unsigned distribution cannot use unsigned local-build overrides',
      );
    }
    return { localBuildId: '', ...COMMUNITY_UNSIGNED_IDENTITY };
  }

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
