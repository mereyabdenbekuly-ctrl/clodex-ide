import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMUNITY_FORBIDDEN_BACKEND_ENVIRONMENT_KEYS,
  COMMUNITY_PUBLIC_ENDPOINTS,
  findForbiddenCommunityBackendEnvironment,
  resolveBackendBuildEnvironment,
} from '../../apps/browser/community-free-build-policy.mjs';

const COMMUNITY_WORKFLOWS = [
  {
    file: '.github/workflows/community-unsigned-build.yml',
    distributionMode: 'community-unsigned',
  },
  {
    file: '.github/workflows/community-observed-build.yml',
    distributionMode: 'community-observed',
  },
];

function read(rootDirectory, path) {
  return readFileSync(join(rootDirectory, path), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function checkWorkflow(rootDirectory, policy, errors) {
  const source = read(rootDirectory, policy.file);
  const build = /^ {2}build:\s*$([\s\S]*)/mu.exec(source)?.[1];
  if (!build) {
    errors.push(`${policy.file}: missing build job`);
    return;
  }
  const buildEnvironment =
    /^ {4}env:\s*$([\s\S]*?)(?=^ {4}[a-zA-Z0-9_-]+:\s*$)/mu.exec(build)?.[1];
  if (!buildEnvironment) {
    errors.push(`${policy.file}: build job is missing its environment block`);
    return;
  }

  const hasEnvironmentValue = (key, value) =>
    new RegExp(
      `^      ${escapeRegExp(key)}:\\s*["']?${escapeRegExp(value)}["']?\\s*$`,
      'mu',
    ).test(buildEnvironment);

  if (
    !hasEnvironmentValue('CLODEX_DISTRIBUTION_MODE', policy.distributionMode)
  ) {
    errors.push(
      `${policy.file}: build must set CLODEX_DISTRIBUTION_MODE=${policy.distributionMode}`,
    );
  }
  if (!hasEnvironmentValue('RELEASE_CHANNEL', 'release')) {
    errors.push(
      `${policy.file}: Community builds require RELEASE_CHANNEL=release`,
    );
  }
  if (!hasEnvironmentValue('CLODEX_CLOUD_TASKS_KILL_SWITCH', 'true')) {
    errors.push(
      `${policy.file}: build must force CLODEX_CLOUD_TASKS_KILL_SWITCH=true`,
    );
  }

  for (const key of COMMUNITY_FORBIDDEN_BACKEND_ENVIRONMENT_KEYS) {
    if (new RegExp(`^\\s*${escapeRegExp(key)}:`, 'mu').test(source)) {
      errors.push(
        `${policy.file}: forbidden managed-service environment key ${key}`,
      );
    }
  }

  if (!/^\s*run:\s*pnpm check:community-free-boundary\s*$/mu.test(source)) {
    errors.push(
      `${policy.file}: workflow must run pnpm check:community-free-boundary`,
    );
  }
}

function checkResolvedCommunityEnvironment(errors) {
  const hostileEnvironment = {
    API_URL: 'https://private.invalid/api',
    BUILD_MODE: 'production',
    CLODEX_API_URL: 'https://private.invalid/api',
    CLODEX_AUTH_CALLBACK_SCHEME: 'private-callback',
    CLODEX_CLOUD_TASKS_KILL_SWITCH: 'false',
    CLODEX_CLOUD_TASKS_RESIDENCY: 'private-region',
    CLODEX_CLOUD_TASKS_URL: 'https://private.invalid/cloud',
    CLODEX_CONSOLE_URL: 'https://private.invalid/console',
    CLODEX_IDE_CLIENT_ID: 'private-client',
    CLODEX_LLM_RELAY_URL: 'https://private.invalid/relay',
    CLODEX_LOGIN_URL: 'https://private.invalid/login',
    CLODEX_MCP_GATEWAY_URL: 'https://private.invalid/mcp',
    CLODEX_ORIGIN: 'https://private.invalid',
    CLODEX_SESSION_SHARING_URL: 'https://private.invalid/shares',
    PRIVATE_GATEWAY_TOKEN: 'must-not-be-embedded',
    SUPABASE_PUBLISHABLE_KEY: 'must-not-be-embedded',
    SUPABASE_URL: 'https://private.invalid/database',
  };

  for (const distributionMode of ['community-unsigned', 'community-observed']) {
    const environment = resolveBackendBuildEnvironment({
      authEnabled: distributionMode === 'community-observed',
      autoUpdateEnabled: false,
      distributionMode,
      environment: hostileEnvironment,
      managedServicesEnabled: true,
      telemetryEnabled: distributionMode === 'community-observed',
    });
    const forbidden = findForbiddenCommunityBackendEnvironment(environment);
    if (forbidden.length > 0) {
      errors.push(
        `${distributionMode}: backend environment retained ${forbidden.join(', ')}`,
      );
    }
    if (Object.hasOwn(environment, 'PRIVATE_GATEWAY_TOKEN')) {
      errors.push(
        `${distributionMode}: unknown ambient credentials were retained`,
      );
    }
    if (environment.CLODEX_CLOUD_TASKS_KILL_SWITCH !== 'true') {
      errors.push(
        `${distributionMode}: cloud task kill switch is not forced on`,
      );
    }
    if (
      environment.CLODEX_ORIGIN !== COMMUNITY_PUBLIC_ENDPOINTS.origin ||
      environment.CLODEX_API_URL !== COMMUNITY_PUBLIC_ENDPOINTS.api ||
      environment.CLODEX_LLM_RELAY_URL !== COMMUNITY_PUBLIC_ENDPOINTS.modelRelay
    ) {
      errors.push(`${distributionMode}: public endpoints are not canonical`);
    }
  }
}

export function checkCommunityFreeBoundary(rootDirectory) {
  const errors = [];
  const contractPath = 'docs/COMMUNITY_FREE_PRODUCT_CONTRACT.md';
  const contract = read(rootDirectory, contractPath);
  for (const requiredText of [
    'local-first desktop IDE',
    'does **not** bundle a configured or operational',
    'operational managed implementation',
    'managed-service connectors are disabled by distribution policy',
    'ambient service endpoint or credential overrides are discarded',
  ]) {
    if (!contract.includes(requiredText)) {
      errors.push(
        `${contractPath}: missing product boundary text: ${requiredText}`,
      );
    }
  }

  for (const workflow of COMMUNITY_WORKFLOWS) {
    checkWorkflow(rootDirectory, workflow, errors);
  }

  const backendVite = read(
    rootDirectory,
    'apps/browser/vite.backend.config.ts',
  );
  if (!backendVite.includes('resolveBackendBuildEnvironment')) {
    errors.push(
      'apps/browser/vite.backend.config.ts: backend environment must use the Community policy resolver',
    );
  }
  if (
    !backendVite.includes(
      "'process.env': JSON.stringify(backendBuildEnvironment)",
    )
  ) {
    errors.push(
      'apps/browser/vite.backend.config.ts: Vite must embed only the resolved backend environment',
    );
  }
  if (
    !backendVite.includes('community-disabled.ts') ||
    !backendVite.includes('!buildConstants.__APP_MANAGED_SERVICES_ENABLED__') ||
    !backendVite.includes('find: /^\\.\\/services\\/clodex-mcp$/u')
  ) {
    errors.push(
      'apps/browser/vite.backend.config.ts: Free builds must alias the hosted MCP implementation to the disabled service',
    );
  }

  const buildConstants = read(rootDirectory, 'apps/browser/build-constants.ts');
  if (!buildConstants.includes('__APP_MANAGED_SERVICES_ENABLED__')) {
    errors.push(
      'apps/browser/build-constants.ts: missing managed-service distribution constant',
    );
  }
  if (
    !buildConstants.includes(
      "process.env.CLODEX_MANAGED_SERVICES_ENABLED === 'true'",
    )
  ) {
    errors.push(
      'apps/browser/build-constants.ts: managed services must require an explicit build-time opt-in',
    );
  }

  const workflowDirectory = join(rootDirectory, '.github/workflows');
  for (const workflowFile of readdirSync(workflowDirectory)) {
    if (!/\.ya?ml$/u.test(workflowFile)) continue;
    const workflowPath = `.github/workflows/${workflowFile}`;
    if (
      /CLODEX_MANAGED_SERVICES_ENABLED:\s*["']?true/iu.test(
        read(rootDirectory, workflowPath),
      )
    ) {
      errors.push(
        `${workflowPath}: public workflows must not enable managed services`,
      );
    }
  }

  const main = read(rootDirectory, 'apps/browser/src/backend/main.ts');
  for (const [label, pattern] of [
    [
      'cloud-task kill switch',
      /const cloudTaskKillSwitchActive\s*=\s*!__APP_MANAGED_SERVICES_ENABLED__\s*\|\|\s*isCloudTaskKillSwitchActive/su,
    ],
    [
      'cloud-task endpoint',
      /baseUrl:\s*__APP_MANAGED_SERVICES_ENABLED__\s*\?\s*process\.env\.CLODEX_CLOUD_TASKS_URL\s*:\s*undefined/su,
    ],
    [
      'cloud-task feature gate',
      /isFeatureEnabled:\s*\(\)\s*=>\s*__APP_MANAGED_SERVICES_ENABLED__\s*&&\s*isClodexCloudEnabled\(\)/su,
    ],
    [
      'session-sharing endpoint',
      /const sessionSharingBaseUrl\s*=\s*__APP_MANAGED_SERVICES_ENABLED__\s*\?\s*process\.env\.CLODEX_SESSION_SHARING_URL\?\.trim\(\)\s*:\s*undefined/su,
    ],
    [
      'cloud availability',
      /isCloudAvailable:\s*\(\)\s*=>\s*__APP_MANAGED_SERVICES_ENABLED__\s*&&\s*isClodexCloudEnabled\(\)/su,
    ],
    [
      'managed rollout telemetry',
      /if\s*\(__APP_MANAGED_SERVICES_ENABLED__\)\s*\{[\s\S]*?telemetryService\.capture\('cloud-task-rollout-observed'/u,
    ],
  ]) {
    if (!pattern.test(main)) {
      errors.push(
        `apps/browser/src/backend/main.ts: missing managed-service gate for ${label}`,
      );
    }
  }

  const toolbox = read(
    rootDirectory,
    'apps/browser/src/backend/services/toolbox/index.ts',
  );
  if (
    !/if\s*\(\s*__APP_MANAGED_SERVICES_ENABLED__\s*\)\s*\{[\s\S]*?this\.clodexMcpService\s*=\s*new ClodexMcpService\(/u.test(
      toolbox,
    ) ||
    !/\}\s*else\s*\{\s*this\.clodexMcpService\s*=\s*null\s*;/u.test(toolbox)
  ) {
    errors.push(
      'apps/browser/src/backend/services/toolbox/index.ts: hosted MCP connector is not conditionally instantiated',
    );
  }

  const disabledMcp = read(
    rootDirectory,
    'apps/browser/src/backend/services/toolbox/services/clodex-mcp/community-disabled.ts',
  );
  if (
    !disabledMcp.includes("state: 'unavailable'") ||
    /@modelcontextprotocol|tools-gateway|CLODEX_MCP_GATEWAY_URL|process\.env/iu.test(
      disabledMcp,
    )
  ) {
    errors.push(
      'apps/browser/src/backend/services/toolbox/services/clodex-mcp/community-disabled.ts: disabled service must remain endpoint-free and fail closed',
    );
  }

  checkResolvedCommunityEnvironment(errors);
  return errors;
}

function main() {
  const rootDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  const errors = checkCommunityFreeBoundary(rootDirectory);
  if (errors.length > 0) {
    for (const error of errors)
      console.error(`community-free-boundary: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('Community Free product boundary: PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
