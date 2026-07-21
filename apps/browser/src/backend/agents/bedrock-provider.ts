import {
  createAmazonBedrock,
  type AmazonBedrockProvider,
  type AmazonBedrockProviderSettings,
} from '@ai-sdk/amazon-bedrock';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { resolveBedrockRegionSync } from '../utils/aws-profiles';

export type BedrockAuthMode = 'access-keys' | 'profile' | 'default-chain';

type BedrockEnvironment = Readonly<Record<string, string | undefined>>;

export interface CreateBedrockProviderOptions {
  authMode?: BedrockAuthMode;
  regionOverride?: string;
  profileName?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  env?: BedrockEnvironment;
  configFilepath?: string;
  credentialsFilepath?: string;
  baseURL?: string;
  fetch?: AmazonBedrockProviderSettings['fetch'];
}

function nonempty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Construct the Bedrock AI SDK provider while keeping authentication and
 * region selection explicit. In particular, passing an empty `apiKey`
 * disables the AI SDK's ambient `AWS_BEARER_TOKEN_BEDROCK` fallback so the
 * selected SigV4 authentication mode cannot be silently replaced.
 */
export function createBedrockProvider(
  options: CreateBedrockProviderOptions,
): AmazonBedrockProvider {
  const authMode = options.authMode ?? 'access-keys';
  const profileName = nonempty(options.profileName);
  const region = resolveBedrockRegionSync({
    authMode,
    regionOverride: options.regionOverride,
    profileName,
    env: options.env,
    configFilepath: options.configFilepath,
    credentialsFilepath: options.credentialsFilepath,
  });
  const common = {
    apiKey: '',
    region,
    baseURL: options.baseURL,
    fetch: options.fetch,
  } satisfies AmazonBedrockProviderSettings;

  if (authMode === 'profile') {
    // resolveBedrockRegionSync rejects a blank or missing profile first.
    // Keeping this guard makes the invariant visible to TypeScript as well.
    if (!profileName) {
      throw new Error(
        'AWS profile name is required when awsAuthMode is "profile".',
      );
    }
    return createAmazonBedrock({
      ...common,
      credentialProvider: fromIni({
        profile: profileName,
        filepath: options.credentialsFilepath,
        configFilepath: options.configFilepath,
      }),
    });
  }

  if (authMode === 'default-chain') {
    return createAmazonBedrock({
      ...common,
      credentialProvider: fromNodeProviderChain({
        filepath: options.credentialsFilepath,
        configFilepath: options.configFilepath,
      }),
    });
  }

  const accessKeyId = nonempty(options.accessKeyId);
  const secretAccessKey = nonempty(options.secretAccessKey);
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'AWS access key ID and secret access key are required when awsAuthMode is "access-keys".',
    );
  }
  return createAmazonBedrock({
    ...common,
    accessKeyId,
    secretAccessKey,
  });
}
