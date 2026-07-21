/**
 * Helpers for reading AWS named profiles from the local ini files
 * (`~/.aws/config` and `~/.aws/credentials`).
 *
 * Runs in the Electron main process only — the ini loader performs
 * filesystem access.
 */

import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AwsProfileInfo {
  name: string;
  /** Value of `region = ...` in the profile. */
  region?: string;
  /** Value of `sso_region = ...` in the profile (SSO-configured profiles). */
  ssoRegion?: string;
}

export interface ListAwsProfilesResult {
  profiles: AwsProfileInfo[];
  /**
   * `AWS_REGION` (preferred) or `AWS_DEFAULT_REGION` as seen by the
   * Electron main process. Useful as a hint for `default-chain` mode,
   * where the profile files have no region to read.
   *
   * Note: apps launched from Finder/Dock on macOS do not inherit shell
   * env vars, so this is often empty in GUI launches even when the
   * user has exported `AWS_REGION` in their shell config.
   */
  envRegion?: string;
  /** Truncated error message if reading the ini files failed. */
  error?: string;
}

type BedrockAuthMode = 'access-keys' | 'profile' | 'default-chain';

type RegionEnvironment = Readonly<Record<string, string | undefined>>;

interface ProfileRegion {
  found: boolean;
  region?: string;
}

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1).trim()
    : value;
}

function stripInlineComment(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (
      (character === '#' || character === ';') &&
      (index === 0 || /\s/.test(value[index - 1] ?? ''))
    ) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function readProfileRegionSync(
  filepath: string,
  profileName: string,
  fileKind: 'config' | 'credentials',
): ProfileRegion {
  let contents: string;
  try {
    contents = readFileSync(filepath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { found: false };
    }
    throw new Error(
      `Bedrock region resolution failed: unable to read the AWS ${fileKind} file.`,
      { cause: error },
    );
  }

  let inSelectedProfile = false;
  let found = false;
  let region: string | undefined;

  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = /^\[([^\]]+)\](?:\s*[#;].*)?$/u.exec(line);
    if (sectionMatch) {
      let sectionName = sectionMatch[1]?.trim() ?? '';
      if (fileKind === 'config' && sectionName !== 'default') {
        const profileMatch = /^profile\s+(.+)$/iu.exec(sectionName);
        sectionName = profileMatch
          ? stripMatchingQuotes(profileMatch[1]?.trim() ?? '')
          : '';
      } else {
        sectionName = stripMatchingQuotes(sectionName);
      }
      inSelectedProfile = sectionName === profileName;
      found ||= inSelectedProfile;
      continue;
    }

    if (!inSelectedProfile) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 0) continue;
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    if (key !== 'region') continue;
    region = nonempty(
      stripMatchingQuotes(stripInlineComment(line.slice(separatorIndex + 1))),
    );
  }

  return { found, region };
}

function sharedAwsFilepaths(
  env: RegionEnvironment,
  configFilepath: string | undefined,
  credentialsFilepath: string | undefined,
): { config: string; credentials: string } {
  return {
    config:
      nonempty(configFilepath) ??
      nonempty(env.AWS_CONFIG_FILE) ??
      join(homedir(), '.aws', 'config'),
    credentials:
      nonempty(credentialsFilepath) ??
      nonempty(env.AWS_SHARED_CREDENTIALS_FILE) ??
      join(homedir(), '.aws', 'credentials'),
  };
}

function profileRegionSync(args: {
  profileName: string;
  env: RegionEnvironment;
  configFilepath?: string;
  credentialsFilepath?: string;
  presenceOnly?: boolean;
}): ProfileRegion {
  const paths = sharedAwsFilepaths(
    args.env,
    args.configFilepath,
    args.credentialsFilepath,
  );
  const config = readProfileRegionSync(
    paths.config,
    args.profileName,
    'config',
  );
  if (config.region || (args.presenceOnly && config.found)) return config;
  const credentials = readProfileRegionSync(
    paths.credentials,
    args.profileName,
    'credentials',
  );
  return {
    found: config.found || credentials.found,
    region: config.region ?? credentials.region,
  };
}

/**
 * Resolve the service region used by the Bedrock provider without relying on
 * the asynchronous AWS credential chain. Only the `region` key is read from
 * shared ini files; `sso_region` is deliberately not a service-region
 * fallback.
 */
export function resolveBedrockRegionSync(args: {
  authMode: BedrockAuthMode;
  regionOverride?: string;
  profileName?: string;
  env?: RegionEnvironment;
  configFilepath?: string;
  credentialsFilepath?: string;
}): string {
  const override = nonempty(args.regionOverride);
  if (args.authMode === 'access-keys') return override ?? 'us-east-1';
  if (args.authMode !== 'profile' && args.authMode !== 'default-chain') {
    throw new Error(
      'Bedrock region resolution failed: unsupported AWS authentication mode.',
    );
  }

  const env = args.env ?? process.env;
  if (args.authMode === 'profile') {
    const profileName = nonempty(args.profileName);
    if (!profileName) {
      throw new Error(
        'Bedrock region resolution failed: profile mode requires a non-empty AWS profile name.',
      );
    }

    const profile = profileRegionSync({
      profileName,
      env,
      configFilepath: args.configFilepath,
      credentialsFilepath: args.credentialsFilepath,
      presenceOnly: Boolean(override),
    });
    if (!profile.found) {
      throw new Error(
        `Bedrock region resolution failed: AWS profile "${profileName}" was not found in the shared config or credentials file.`,
      );
    }

    const region =
      override ??
      profile.region ??
      nonempty(env.AWS_REGION) ??
      nonempty(env.AWS_DEFAULT_REGION);
    if (region) return region;
    throw new Error(
      `Bedrock region resolution failed: AWS profile "${profileName}" has no service region and AWS_REGION/AWS_DEFAULT_REGION are unset.`,
    );
  }

  if (override) return override;

  const envRegion =
    nonempty(env.AWS_REGION) ?? nonempty(env.AWS_DEFAULT_REGION);
  if (envRegion) return envRegion;

  const profileName = nonempty(env.AWS_PROFILE) ?? 'default';
  const profile = profileRegionSync({
    profileName,
    env,
    configFilepath: args.configFilepath,
    credentialsFilepath: args.credentialsFilepath,
  });
  if (profile.region) return profile.region;
  if (!profile.found) {
    throw new Error(
      `Bedrock region resolution failed: AWS profile "${profileName}" was not found and no environment region is set.`,
    );
  }
  throw new Error(
    `Bedrock region resolution failed: AWS profile "${profileName}" has no service region and no environment region is set.`,
  );
}

/**
 * Merge `region` / `sso_region` from the config and credentials maps,
 * preferring whichever value exists and treating empty strings as
 * missing. Profiles in `~/.aws/config` use the prefix `profile <name>`
 * except for `default`; `loadSharedConfigFiles` strips that prefix so
 * both maps key by the raw profile name.
 */
function pickRegion(
  ...sections: Array<Record<string, string | undefined> | undefined>
): string | undefined {
  for (const s of sections) {
    const v = s?.region;
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function pickSsoRegion(
  ...sections: Array<Record<string, string | undefined> | undefined>
): string | undefined {
  for (const s of sections) {
    const v = s?.sso_region;
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Enumerate profiles declared in `~/.aws/config` and
 * `~/.aws/credentials`. Returns each profile's declared region (and
 * sso_region, if any) so callers can compute the correct Bedrock
 * cross-region inference profile prefix without a separate round-trip.
 * Names are deduplicated and sorted.
 */
export async function listAwsProfiles(): Promise<ListAwsProfilesResult> {
  const envRegion =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined;
  try {
    const { configFile, credentialsFile } = await loadSharedConfigFiles();
    const names = new Set<string>([
      ...Object.keys(configFile ?? {}),
      ...Object.keys(credentialsFile ?? {}),
    ]);
    const profiles: AwsProfileInfo[] = [...names].sort().map((name) => {
      const cfg = configFile?.[name];
      const creds = credentialsFile?.[name];
      return {
        name,
        region: pickRegion(cfg, creds),
        ssoRegion: pickSsoRegion(cfg, creds),
      };
    });
    return { profiles, envRegion };
  } catch (err) {
    return {
      profiles: [],
      envRegion,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
