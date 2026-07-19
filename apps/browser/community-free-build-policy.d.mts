import type { AppDistributionMode } from './src/shared/local-build-identity';

export const COMMUNITY_PUBLIC_ENDPOINTS: Readonly<{
  api: string;
  console: string;
  login: string;
  modelRelay: string;
  origin: string;
  posthog: string;
}>;

export const COMMUNITY_FORBIDDEN_BACKEND_ENVIRONMENT_KEYS: readonly string[];

export function isCommunityDistributionMode(
  distributionMode: string,
): distributionMode is 'community-unsigned' | 'community-observed';

export function resolveBackendBuildEnvironment(options: {
  authEnabled: boolean;
  autoUpdateEnabled: boolean;
  distributionMode: AppDistributionMode;
  environment: Record<string, string | undefined>;
  managedServicesEnabled: boolean;
  telemetryEnabled: boolean;
}): Record<string, string>;

export function findForbiddenCommunityBackendEnvironment(
  environment: Record<string, string>,
): string[];
