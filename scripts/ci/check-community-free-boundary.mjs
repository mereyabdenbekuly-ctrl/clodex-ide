import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

const OPERATIONAL_SCAN_IGNORED_DIRECTORIES = new Set([
  '.codegraph',
  '.git',
  '.next',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'test-results',
]);

const OPERATIONAL_SCAN_EXCLUSIONS = new Set([
  'apps/browser/src/backend/services/model-fabric-policy-publication-cli.test.ts',
  'apps/browser/src/backend/services/model-fabric-policy-publication.test.ts',
  'apps/browser/tsconfig.backend.json',
  'scripts/ci/check-community-free-boundary.mjs',
  'scripts/ci/check-community-free-boundary.test.mjs',
]);

const REFERENCE_MODEL_FABRIC_PUBLICATION_FILES = new Set([
  'apps/browser/scripts/model-fabric-policy-publication.ts',
  'apps/browser/src/backend/services/model-fabric-policy-publication.ts',
]);

const FORBIDDEN_REFERENCE_PUBLICATION_PATTERNS = [
  [
    'network or process execution import',
    /node:(?:child_process|dgram|dns|http|https|net|tls)|\bfrom\s+['"](?:axios|got|undici)['"]/u,
  ],
  ['network request', /\b(?:fetch|WebSocket)\s*\(/u],
  [
    'managed endpoint or credential',
    /https?:\/\/|\bCLODEX_[A-Z0-9_]*(?:KEY|SECRET|TOKEN|URL)\b|\bAuthorization\s*:|\bBearer\s+/u,
  ],
  ['ambient environment access', /\bprocess\.env\b/u],
];

const ALLOWED_REFERENCE_PACKAGE_SCRIPT = {
  path: 'apps/browser/package.json',
  name: 'policy:publication',
  command:
    'tsx --tsconfig tsconfig.backend.json scripts/model-fabric-policy-publication.ts',
};

const FORBIDDEN_MODEL_FABRIC_OPERATIONAL_PATTERNS = [
  ['package publication command', /\bpolicy:publication\b/u],
  [
    'publication CLI entrypoint',
    /(?:^|[\s"'=])(?:apps\/browser\/)?scripts\/model-fabric-policy-publication\.ts\b/mu,
  ],
  [
    'publication service import',
    /(?:^|\/)services\/model-fabric-policy-publication(?:\.ts)?(?=[\s"');]|$)/mu,
  ],
  [
    'publication authority operation',
    /\b(?:authorizeModelFabricPolicyPublication|createModelFabricPublicationApproval|prepareSignedModelFabricPolicySnapshot|signModelFabricPublicationAuthority)\b/u,
  ],
  [
    'release-promotion request',
    /--require-promotion(?:=|\s)+(?:["']?\s*)model-fabric\b/su,
  ],
  [
    'caller-supplied release evidence',
    /--model-fabric-(?:root-public-key|snapshot-root-public-key|state)\b/u,
  ],
  ['publication secret', /\bCLODEX_MODEL_FABRIC_PUBLICATION_[A-Z0-9_]+\b/u],
  ['publisher private-key argument', /--publisher-private-key\b/u],
  [
    'publication state artifact',
    /\bmodel-fabric-publication-state(?:\.json)?\b/u,
  ],
  ['publication root artifact', /\bmodel-fabric-root-public-key(?:\.pem)?\b/u],
];

function read(rootDirectory, path) {
  return readFileSync(join(rootDirectory, path), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function scanOperationalSurfaces(rootDirectory, errors) {
  visitOperationalDirectory(rootDirectory, '', errors);
}

function visitOperationalDirectory(rootDirectory, relativeDirectory, errors) {
  const absoluteDirectory = relativeDirectory
    ? join(rootDirectory, relativeDirectory)
    : rootDirectory;
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (OPERATIONAL_SCAN_IGNORED_DIRECTORIES.has(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      errors.push(
        `${relativePath}: operational-source symlinks are forbidden at the public/private boundary`,
      );
      continue;
    }
    if (entry.isDirectory()) {
      visitOperationalDirectory(rootDirectory, relativePath, errors);
      continue;
    }
    if (!entry.isFile() || !isOperationalSourcePath(relativePath)) {
      continue;
    }

    if (REFERENCE_MODEL_FABRIC_PUBLICATION_FILES.has(relativePath)) {
      checkReferencePublicationSource(
        relativePath,
        read(rootDirectory, relativePath),
        errors,
      );
      continue;
    }
    if (OPERATIONAL_SCAN_EXCLUSIONS.has(relativePath)) continue;

    const source = read(rootDirectory, relativePath);
    if (relativePath.endsWith('/package.json')) {
      checkPackageScripts(rootDirectory, relativePath, errors);
    } else {
      checkOperationalSource(relativePath, source, errors);
    }
  }
}

function isOperationalSourcePath(relativePath) {
  return (
    /\.(?:bash|cjs|js|jsx|mjs|sh|ts|tsx|yaml|yml|zsh)$/u.test(relativePath) ||
    relativePath.endsWith('/package.json') ||
    relativePath === 'package.json' ||
    !/(?:^|\/)[^/]+\.[^/]+$/u.test(relativePath)
  );
}

function checkReferencePublicationSource(label, source, errors) {
  const requiredClassification = label.includes('/scripts/')
    ? 'PUBLIC/FREE local-reference CLI'
    : 'PUBLIC/FREE local-reference tooling';
  if (!source.includes(requiredClassification)) {
    errors.push(`${label}: missing PUBLIC/FREE reference classification`);
  }
  for (const [marker, pattern] of FORBIDDEN_REFERENCE_PUBLICATION_PATTERNS) {
    if (pattern.test(source)) {
      errors.push(
        `${label}: local/reference publication code must remain offline (${marker})`,
      );
    }
  }
}

function checkPackageScripts(rootDirectory, relativePath, errors) {
  let document;
  try {
    document = JSON.parse(read(rootDirectory, relativePath));
  } catch (error) {
    errors.push(
      `${relativePath}: cannot inspect package scripts: ${error instanceof Error ? error.message : 'invalid JSON'}`,
    );
    return;
  }
  for (const [name, command] of Object.entries(document.scripts ?? {})) {
    if (typeof command !== 'string') continue;
    if (
      relativePath === ALLOWED_REFERENCE_PACKAGE_SCRIPT.path &&
      name === ALLOWED_REFERENCE_PACKAGE_SCRIPT.name &&
      command === ALLOWED_REFERENCE_PACKAGE_SCRIPT.command
    ) {
      continue;
    }
    checkOperationalSource(
      `${relativePath}#scripts.${name}`,
      `${name}\n${command}`,
      errors,
    );
  }
}

function checkOperationalSource(label, source, errors) {
  for (const [marker, pattern] of FORBIDDEN_MODEL_FABRIC_OPERATIONAL_PATTERNS) {
    if (pattern.test(source)) {
      errors.push(
        `${label}: operational Model Fabric automation is forbidden (${marker})`,
      );
    }
  }
}

function epicDefinitionBlock(source, epicId) {
  const startMarker = `    id: '${epicId}',`;
  const start = source.indexOf(startMarker);
  if (start === -1) return null;
  const next = source.indexOf("\n  {\n    id: '", start + startMarker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

function epicPromotionContracts(definitionBlock) {
  if (!definitionBlock) return [];
  return [
    ...definitionBlock.matchAll(/^\s{4}promotionContract:\s*'([^']+)',\s*$/gmu),
  ].map((match) => match[1]);
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
  for (const policy of [
    {
      path: 'AGENTS.md',
      requiredText: [
        'permanently available to Community users at source level',
        'Paid entitlements, authorization, metering, and billing must be enforced',
        'Never place managed Gateway',
        'local Guardian, authorization',
      ],
    },
    {
      path: 'docs/COMMUNITY_FREE_PRODUCT_CONTRACT.md',
      requiredText: [
        'local-first desktop IDE',
        'treated as Community-available at',
        'not accepted as a durable paid boundary',
        'metered, and billed by the service',
        'does **not** bundle a configured or operational',
        'operational managed implementation',
        'managed-service connectors are disabled by distribution policy',
        'ambient service endpoint or credential overrides are discarded',
      ],
    },
    {
      path: 'docs/governance/OPEN_CLOSED_BOUNDARY.md',
      requiredText: [
        'Community-available at source level',
        'local license checks are not a durable',
        'enforced by a separately operated managed service',
      ],
    },
    {
      path: 'docs/model-fabric-policy-publication.md',
      requiredText: [
        'PUBLIC CORE / LOCAL REFERENCE TOOLING',
        'not a paid entitlement',
        'former public GitHub Actions publisher was removed',
        'public repository workflow must not materialize a Model Fabric publisher',
      ],
    },
    {
      path: '.release-evidence/README.md',
      requiredText: [
        'PUBLIC/FREE local-reference tooling',
        'operational GitHub publisher workflow was quarantined and removed',
        'evidence only and does not satisfy',
        'caller-supplied state and trust roots cannot make that',
      ],
    },
  ]) {
    const source = read(rootDirectory, policy.path);
    for (const requiredText of policy.requiredText) {
      if (!source.includes(requiredText)) {
        errors.push(
          `${policy.path}: missing product boundary text: ${requiredText}`,
        );
      }
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
  const quarantinedModelFabricWorkflow = join(
    workflowDirectory,
    'model-fabric-publication.yml',
  );
  if (existsSync(quarantinedModelFabricWorkflow)) {
    errors.push(
      '.github/workflows/model-fabric-publication.yml: operational Model Fabric publisher must remain quarantined',
    );
  }
  for (const workflowFile of readdirSync(workflowDirectory)) {
    if (!/\.ya?ml$/u.test(workflowFile)) continue;
    const workflowPath = `.github/workflows/${workflowFile}`;
    const workflowSource = read(rootDirectory, workflowPath);
    if (/CLODEX_MANAGED_SERVICES_ENABLED:\s*["']?true/iu.test(workflowSource)) {
      errors.push(
        `${workflowPath}: public workflows must not enable managed services`,
      );
    }
  }
  scanOperationalSurfaces(rootDirectory, errors);

  const mainPlanManifest = read(
    rootDirectory,
    'apps/browser/src/shared/main-plan-readiness.ts',
  );
  const modelFabricDefinition = epicDefinitionBlock(
    mainPlanManifest,
    'model-fabric',
  );
  const modelFabricPromotionContracts = epicPromotionContracts(
    modelFabricDefinition,
  );
  if (
    modelFabricPromotionContracts.length !== 1 ||
    modelFabricPromotionContracts[0] !== 'not-yet-defined'
  ) {
    errors.push(
      'apps/browser/src/shared/main-plan-readiness.ts: Model Fabric managed promotion contract must remain quarantined',
    );
  }

  const mainPlanCli = read(
    rootDirectory,
    'apps/browser/scripts/check-main-plan-readiness.ts',
  );
  for (const marker of [
    'assessModelFabricPromotion',
    '--model-fabric-state',
    '--model-fabric-root-public-key',
    '--model-fabric-snapshot-root-public-key',
  ]) {
    if (mainPlanCli.includes(marker)) {
      errors.push(
        `apps/browser/scripts/check-main-plan-readiness.ts: caller-controlled Model Fabric promotion input is forbidden: ${marker}`,
      );
    }
  }
  if (!mainPlanCli.includes('Model Fabric managed promotion is quarantined')) {
    errors.push(
      'apps/browser/scripts/check-main-plan-readiness.ts: missing Model Fabric quarantine notice',
    );
  }

  const promotionAssessments = read(
    rootDirectory,
    'apps/browser/src/backend/services/main-plan-promotion-assessments.ts',
  );
  if (promotionAssessments.includes('assessModelFabricPromotion')) {
    errors.push(
      'apps/browser/src/backend/services/main-plan-promotion-assessments.ts: caller-controlled Model Fabric promotion authority is forbidden',
    );
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
