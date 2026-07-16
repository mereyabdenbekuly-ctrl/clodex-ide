import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import semver from 'semver';
import {
  resolveAppDistributionMode,
  resolveAppDistributionPolicy,
  resolveAppIdentity,
  type AppReleaseChannel,
} from './src/shared/local-build-identity';

// Release channel: 'dev' | 'prerelease' | 'nightly' | 'release'
export const __APP_RELEASE_CHANNEL__: AppReleaseChannel = (() => {
  switch (process.env.RELEASE_CHANNEL) {
    case 'release':
      return 'release';
    case 'nightly':
      return 'nightly';
    case 'prerelease':
      return 'prerelease';
    case 'dev':
    default:
      return 'dev';
  }
})();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read version from package.json
const packageJson = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
);

export const __APP_DISTRIBUTION_MODE__ = resolveAppDistributionMode(
  process.env.CLODEX_DISTRIBUTION_MODE,
);

const distributionPolicy = resolveAppDistributionPolicy({
  distributionMode: __APP_DISTRIBUTION_MODE__,
  releaseChannel: __APP_RELEASE_CHANNEL__,
});

const appIdentity = resolveAppIdentity({
  distributionMode: __APP_DISTRIBUTION_MODE__,
  releaseChannel: __APP_RELEASE_CHANNEL__,
  localBuildId: process.env.CLODEX_LOCAL_BUILD_ID,
  allowUnsignedLocalBuild:
    process.env.CLODEX_ALLOW_UNSIGNED_LOCAL_BUILD === 'true',
});

export const __APP_LOCAL_BUILD_ID__ = appIdentity.localBuildId;
export const __APP_BASE_NAME__ = appIdentity.baseName;
export const __APP_NAME__ = appIdentity.appName;
export const __APP_BUNDLE_ID__ = appIdentity.bundleId;
export const __APP_BUILD_IDENTIFIER__ = distributionPolicy.buildIdentifier;
export const __APP_AUTH_ENABLED__ = distributionPolicy.authEnabled;
export const __APP_AUTO_UPDATE_ENABLED__ = distributionPolicy.autoUpdateEnabled;
export const __APP_REGISTER_DEFAULT_PROTOCOLS__ =
  distributionPolicy.registerDefaultProtocols;
export const __APP_TELEMETRY_ENABLED__ = distributionPolicy.telemetryEnabled;

export const __APP_VERSION__ = (() => {
  const override = process.env.APP_VERSION_OVERRIDE;
  const version = override || packageJson.version;
  if (typeof version !== 'string') {
    throw new Error('Version not found in package.json');
  }
  if (!semver.valid(version)) {
    throw new Error(
      `Invalid app version${override ? ' override' : ''}: ${version}`,
    );
  }
  return version;
})();

export const __APP_AUTHOR__ = (() => {
  const author = packageJson.author;
  if (typeof author === 'string' && author.trim()) {
    return author;
  }
  if (
    author &&
    typeof author === 'object' &&
    typeof author.name === 'string' &&
    author.name.trim()
  ) {
    return author.name;
  }
  return 'GENERIC_AUTHOR';
})();

const readCliOption = (name: string) => {
  const equalsPrefix = `--${name}=`;
  const equalsArg = process.argv.find((arg) => arg.startsWith(equalsPrefix));
  if (equalsArg) return equalsArg.slice(equalsPrefix.length);

  const optionIndex = process.argv.indexOf(`--${name}`);
  if (optionIndex >= 0) {
    const nextArg = process.argv[optionIndex + 1];
    if (!nextArg || nextArg.startsWith('--')) return undefined;
    return nextArg;
  }

  return undefined;
};

export const __APP_PLATFORM__ =
  process.env.npm_config_platform ||
  readCliOption('platform') ||
  process.platform;
export const __APP_ARCH__ =
  process.env.npm_config_arch || readCliOption('arch') || process.arch;

export const __APP_COPYRIGHT__ = `Copyright © ${new Date().getFullYear()} ${__APP_AUTHOR__}`;

export const __APP_HOMEPAGE__ = (() => {
  const homepage = packageJson.homepage;
  if (typeof homepage === 'string' && homepage.trim()) {
    return homepage;
  }
  return 'https://clodex.xyz';
})();
