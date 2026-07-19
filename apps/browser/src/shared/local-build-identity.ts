export type AppReleaseChannel = 'dev' | 'prerelease' | 'nightly' | 'release';

export type AppDistributionMode =
  | 'official'
  | 'community-unsigned'
  | 'community-observed';

export type AppTelemetryMode =
  | 'standard'
  | 'disabled'
  | 'anonymous-backend-only';

export interface AppDistributionPolicy {
  authEnabled: boolean;
  autoUpdateEnabled: boolean;
  buildIdentifier:
    | AppReleaseChannel
    | 'community-unsigned'
    | 'community-observed';
  exceptionTelemetryEnabled: boolean;
  managedServicesEnabled: boolean;
  modelTracingEnabled: boolean;
  registerDefaultProtocols: boolean;
  rendererTelemetryEnabled: boolean;
  telemetryEnabled: boolean;
  telemetryMode: AppTelemetryMode;
  telemetryPrivacyMode: boolean;
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

const COMMUNITY_OBSERVED_IDENTITY: Omit<AppIdentity, 'localBuildId'> = {
  baseName: 'clodex-community-observed',
  appName: 'Clodex Agentic IDE (Community Observed)',
  bundleId: 'xyz.clodex.agentic-ide.community-observed',
};

export function isCommunityDistributionMode(
  distributionMode: AppDistributionMode,
): distributionMode is 'community-unsigned' | 'community-observed' {
  return (
    distributionMode === 'community-unsigned' ||
    distributionMode === 'community-observed'
  );
}

export function resolveAppDistributionMode(
  value: string | undefined,
): AppDistributionMode {
  const normalized = value?.trim() ?? '';
  if (!normalized || normalized === 'official') return 'official';
  if (normalized === 'community-unsigned') return 'community-unsigned';
  if (normalized === 'community-observed') return 'community-observed';
  throw new Error(`Unsupported CLODEX_DISTRIBUTION_MODE: ${normalized}`);
}

export function resolveAppDistributionPolicy(options: {
  distributionMode: AppDistributionMode;
  managedServicesEnabled?: boolean;
  releaseChannel: AppReleaseChannel;
}): AppDistributionPolicy {
  if (isCommunityDistributionMode(options.distributionMode)) {
    if (options.managedServicesEnabled) {
      throw new Error(
        `${options.distributionMode} distribution cannot enable managed services`,
      );
    }
    if (options.releaseChannel !== 'release') {
      throw new Error(
        `${options.distributionMode} distribution requires RELEASE_CHANNEL=release`,
      );
    }
    if (options.distributionMode === 'community-observed') {
      return {
        authEnabled: true,
        autoUpdateEnabled: false,
        buildIdentifier: 'community-observed',
        exceptionTelemetryEnabled: false,
        managedServicesEnabled: false,
        modelTracingEnabled: false,
        registerDefaultProtocols: false,
        rendererTelemetryEnabled: false,
        telemetryEnabled: true,
        telemetryMode: 'anonymous-backend-only',
        telemetryPrivacyMode: true,
      };
    }
    return {
      authEnabled: false,
      autoUpdateEnabled: false,
      buildIdentifier: 'community-unsigned',
      exceptionTelemetryEnabled: false,
      managedServicesEnabled: false,
      modelTracingEnabled: false,
      registerDefaultProtocols: false,
      rendererTelemetryEnabled: false,
      telemetryEnabled: false,
      telemetryMode: 'disabled',
      telemetryPrivacyMode: true,
    };
  }

  return {
    authEnabled: true,
    autoUpdateEnabled: true,
    buildIdentifier: options.releaseChannel,
    exceptionTelemetryEnabled: true,
    managedServicesEnabled: options.managedServicesEnabled === true,
    modelTracingEnabled: true,
    registerDefaultProtocols: true,
    rendererTelemetryEnabled: true,
    telemetryEnabled: true,
    telemetryMode: 'standard',
    telemetryPrivacyMode: false,
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
  if (isCommunityDistributionMode(distributionMode)) {
    if (options.releaseChannel !== 'release') {
      throw new Error(
        `${distributionMode} distribution requires RELEASE_CHANNEL=release`,
      );
    }
    if (localBuildId || options.allowUnsignedLocalBuild) {
      throw new Error(
        `${distributionMode} distribution cannot use unsigned local-build overrides`,
      );
    }
    return {
      localBuildId: '',
      ...(distributionMode === 'community-observed'
        ? COMMUNITY_OBSERVED_IDENTITY
        : COMMUNITY_UNSIGNED_IDENTITY),
    };
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
