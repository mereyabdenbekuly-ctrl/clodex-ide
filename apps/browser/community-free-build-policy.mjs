const COMMUNITY_DISTRIBUTION_MODES = new Set([
  'community-unsigned',
  'community-observed',
]);

export const COMMUNITY_PUBLIC_ENDPOINTS = Object.freeze({
  api: 'https://clodex.xyz/api',
  console: 'https://clodex.xyz',
  login: 'https://clodex.xyz/login',
  modelRelay: 'https://clodex.xyz/v1',
  origin: 'https://clodex.xyz',
  posthog: 'https://us.i.posthog.com',
});

export const COMMUNITY_FORBIDDEN_BACKEND_ENVIRONMENT_KEYS = Object.freeze([
  'CLODEX_CLOUD_TASKS_RESIDENCY',
  'CLODEX_CLOUD_TASKS_URL',
  'CLODEX_MCP_GATEWAY_URL',
  'CLODEX_SESSION_SHARING_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_URL',
]);

function value(environment, key) {
  const candidate = environment[key];
  return typeof candidate === 'string' && candidate.trim()
    ? candidate.trim()
    : undefined;
}

function withoutUndefined(entries) {
  return Object.fromEntries(
    Object.entries(entries).filter(([, entry]) => entry !== undefined),
  );
}

export function isCommunityDistributionMode(distributionMode) {
  return COMMUNITY_DISTRIBUTION_MODES.has(distributionMode);
}

/**
 * Resolve the only environment values that may be embedded into the Electron
 * backend bundle.
 *
 * Community artifacts deliberately use canonical public account/model-relay
 * endpoints and discard every managed execution, hosted MCP, session-sharing,
 * and service credential override. Adding a new ambient environment variable
 * does not make it into a community artifact unless it is reviewed and added
 * here explicitly.
 */
export function resolveBackendBuildEnvironment({
  authEnabled,
  autoUpdateEnabled,
  distributionMode,
  environment,
  managedServicesEnabled,
  telemetryEnabled,
}) {
  const community = isCommunityDistributionMode(distributionMode);
  const managed = !community && managedServicesEnabled === true;
  const observed = distributionMode === 'community-observed';
  const origin = community
    ? COMMUNITY_PUBLIC_ENDPOINTS.origin
    : (value(environment, 'CLODEX_ORIGIN') ??
      COMMUNITY_PUBLIC_ENDPOINTS.origin);
  const api = community
    ? COMMUNITY_PUBLIC_ENDPOINTS.api
    : (value(environment, 'CLODEX_API_URL') ??
      value(environment, 'API_URL') ??
      COMMUNITY_PUBLIC_ENDPOINTS.api);
  const llmProxy = community
    ? COMMUNITY_PUBLIC_ENDPOINTS.modelRelay
    : (value(environment, 'LLM_PROXY_URL') ??
      value(environment, 'CLODEX_LLM_RELAY_URL') ??
      COMMUNITY_PUBLIC_ENDPOINTS.modelRelay);
  const modelRelay = community
    ? COMMUNITY_PUBLIC_ENDPOINTS.modelRelay
    : (value(environment, 'CLODEX_LLM_RELAY_URL') ??
      COMMUNITY_PUBLIC_ENDPOINTS.modelRelay);

  return withoutUndefined({
    BUILD_MODE: value(environment, 'BUILD_MODE') ?? 'production',
    NODE_ENV: value(environment, 'NODE_ENV') ?? 'production',
    POSTHOG_API_KEY: telemetryEnabled
      ? value(environment, 'POSTHOG_API_KEY')
      : undefined,
    POSTHOG_HOST: community
      ? COMMUNITY_PUBLIC_ENDPOINTS.posthog
      : (value(environment, 'POSTHOG_HOST') ??
        COMMUNITY_PUBLIC_ENDPOINTS.posthog),
    CLODEX_CONSOLE_URL: community
      ? COMMUNITY_PUBLIC_ENDPOINTS.console
      : (value(environment, 'CLODEX_CONSOLE_URL') ?? origin),
    API_URL: api,
    LLM_PROXY_URL: llmProxy,
    CLODEX_ORIGIN: origin,
    CLODEX_LOGIN_URL: community
      ? COMMUNITY_PUBLIC_ENDPOINTS.login
      : (value(environment, 'CLODEX_LOGIN_URL') ??
        COMMUNITY_PUBLIC_ENDPOINTS.login),
    CLODEX_API_URL: api,
    CLODEX_LLM_RELAY_URL: modelRelay,
    CLODEX_MCP_GATEWAY_URL: community
      ? undefined
      : managed
        ? value(environment, 'CLODEX_MCP_GATEWAY_URL')
        : undefined,
    CLODEX_AUTH_CALLBACK_SCHEME: community
      ? 'clodex-ide'
      : (value(environment, 'CLODEX_AUTH_CALLBACK_SCHEME') ?? 'clodex-ide'),
    CLODEX_IDE_CLIENT_ID: observed
      ? 'clodex-community-observed'
      : community
        ? 'clodex-community-unsigned'
        : (value(environment, 'CLODEX_IDE_CLIENT_ID') ?? 'clodex-ide'),
    CLODEX_AUTH_ENABLED: observed
      ? 'true'
      : authEnabled
        ? (value(environment, 'CLODEX_AUTH_ENABLED') ?? 'true')
        : 'false',
    CLODEX_DISABLE_ISOLATED_AGENT_RUNTIME: value(
      environment,
      'CLODEX_DISABLE_ISOLATED_AGENT_RUNTIME',
    ),
    UPDATE_SERVER_ORIGIN: autoUpdateEnabled
      ? value(environment, 'UPDATE_SERVER_ORIGIN')
      : undefined,
    CLODEX_CLOUD_TASKS_KILL_SWITCH:
      community || !managed
        ? 'true'
        : value(environment, 'CLODEX_CLOUD_TASKS_KILL_SWITCH'),
    CLODEX_CLOUD_TASKS_URL: managed
      ? value(environment, 'CLODEX_CLOUD_TASKS_URL')
      : undefined,
    CLODEX_CLOUD_TASKS_RESIDENCY: managed
      ? value(environment, 'CLODEX_CLOUD_TASKS_RESIDENCY')
      : undefined,
    CLODEX_SESSION_SHARING_URL: managed
      ? value(environment, 'CLODEX_SESSION_SHARING_URL')
      : undefined,
    SUPABASE_URL: managed ? value(environment, 'SUPABASE_URL') : undefined,
    SUPABASE_PUBLISHABLE_KEY: managed
      ? value(environment, 'SUPABASE_PUBLISHABLE_KEY')
      : undefined,
  });
}

export function findForbiddenCommunityBackendEnvironment(environment) {
  return COMMUNITY_FORBIDDEN_BACKEND_ENVIRONMENT_KEYS.filter((key) =>
    Object.hasOwn(environment, key),
  );
}
