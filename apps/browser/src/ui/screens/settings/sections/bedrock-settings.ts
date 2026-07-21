export type BedrockAwsAuthMode = 'access-keys' | 'profile' | 'default-chain';

export type AwsProfileInfo = {
  name: string;
  region?: string;
  /**
   * AWS IAM Identity Center portal region. This is intentionally not used as
   * the Bedrock service region because the two regions are independent.
   */
  ssoRegion?: string;
};

/**
 * Map an AWS service region to the Bedrock cross-region inference profile
 * prefix required by Claude 4.x and Nova.
 */
export function bedrockInferencePrefix(region: string | undefined): string {
  const normalized = region?.trim().toLowerCase();
  if (!normalized) return 'us.';
  if (normalized.startsWith('us-') || normalized.startsWith('ca-')) {
    return 'us.';
  }
  if (normalized.startsWith('eu-')) return 'eu.';
  if (normalized.startsWith('ap-')) return 'apac.';
  return 'us.';
}

/**
 * Resolve the region used for Bedrock model-ID suggestions. This mirrors the
 * backend's visible precedence without treating `sso_region` as a Bedrock
 * service region.
 */
export function resolveEffectiveBedrockRegion(args: {
  regionOverride: string;
  awsAuthMode: BedrockAwsAuthMode;
  awsProfileName: string;
  profiles: AwsProfileInfo[];
  envRegion: string | undefined;
}): string | undefined {
  const override = args.regionOverride.trim();
  if (override) return override;

  if (args.awsAuthMode === 'access-keys') return 'us-east-1';

  const envRegion = args.envRegion?.trim() || undefined;
  if (args.awsAuthMode === 'profile') {
    const profileName = args.awsProfileName.trim();
    if (!profileName) return undefined;
    const profile = args.profiles.find((item) => item.name === profileName);
    return profile?.region?.trim() || envRegion;
  }

  return envRegion;
}

/**
 * Build the suggested built-in-model to Bedrock inference-profile mapping.
 * The 4.6/4.7/4.8 generation intentionally uses the shorter upstream IDs;
 * older models retain their dated/versioned suffixes.
 */
export function buildSuggestedBedrockMapping(prefix: string): string {
  const mapping: Record<string, string> = {
    'claude-opus-4.8': `${prefix}anthropic.claude-opus-4-8`,
    'claude-opus-4.7': `${prefix}anthropic.claude-opus-4-7`,
    'claude-opus-4.6': `${prefix}anthropic.claude-opus-4-6-v1`,
    'claude-sonnet-5': `${prefix}anthropic.claude-sonnet-5`,
    'claude-sonnet-4.6': `${prefix}anthropic.claude-sonnet-4-6`,
    'claude-haiku-4.5': `${prefix}anthropic.claude-haiku-4-5-20251001-v1:0`,
  };
  return JSON.stringify(mapping, null, 2);
}
