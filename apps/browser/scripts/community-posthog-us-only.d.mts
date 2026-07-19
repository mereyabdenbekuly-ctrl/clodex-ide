export const COMMUNITY_US_POSTHOG_INGESTION_ORIGIN: string;
export const COMMUNITY_US_POSTHOG_ASSET_ORIGIN: string;
export const COMMUNITY_ALLOWED_POSTHOG_HOSTS: readonly string[];

export function findDisallowedCommunityPostHogHosts(source: string): string[];

export function assertCommunityPostHogUsOnly(
  source: string,
  location?: string,
): void;

export function rewriteKnownCommunityPostHogOrigins(source: string): {
  replacements: Array<{ from: string; to: string }>;
  source: string;
};

export function enforceCommunityPostHogUsOnlyInBackend(buildPath: string): {
  backendDirectory: string;
  bytesScanned: number;
  filesScanned: number;
  replacements: Array<{ file: string; from: string; to: string }>;
};
