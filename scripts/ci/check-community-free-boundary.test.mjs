import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMMUNITY_FORBIDDEN_BACKEND_ENVIRONMENT_KEYS,
  COMMUNITY_PUBLIC_ENDPOINTS,
  findForbiddenCommunityBackendEnvironment,
  resolveBackendBuildEnvironment,
} from '../../apps/browser/community-free-build-policy.mjs';
import { checkCommunityFreeBoundary } from './check-community-free-boundary.mjs';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const fixtureFiles = [
  '.github/workflows/community-observed-build.yml',
  '.github/workflows/community-unsigned-build.yml',
  'AGENTS.md',
  'apps/browser/build-constants.ts',
  'apps/browser/src/backend/main.ts',
  'apps/browser/src/backend/services/toolbox/index.ts',
  'apps/browser/src/backend/services/toolbox/services/clodex-mcp/community-disabled.ts',
  'apps/browser/vite.backend.config.ts',
  'docs/COMMUNITY_FREE_PRODUCT_CONTRACT.md',
  'docs/governance/OPEN_CLOSED_BOUNDARY.md',
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'clodex-community-free-boundary-'));
  for (const file of fixtureFiles) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repositoryRoot, file), target);
  }
  return root;
}

function replace(root, file, before, after) {
  const path = join(root, file);
  const source = readFileSync(path, 'utf8');
  assert.ok(source.includes(before), `${file}: fixture mutation target exists`);
  writeFileSync(path, source.replace(before, after));
}

test('accepts the repository Community Free boundary', () => {
  assert.deepEqual(checkCommunityFreeBoundary(repositoryRoot), []);
});

test('rejects removing the public-client commercial invariant', () => {
  const root = fixture();
  replace(
    root,
    'AGENTS.md',
    'permanently available to Community users at source level',
    'available only when the official client permits it',
  );
  assert.ok(
    checkCommunityFreeBoundary(root).some((error) =>
      error.includes('AGENTS.md: missing product boundary text'),
    ),
  );
});

test('rejects treating client-side gating as a paid boundary', () => {
  const root = fixture();
  replace(
    root,
    'docs/COMMUNITY_FREE_PRODUCT_CONTRACT.md',
    'not accepted as a durable paid boundary',
    'accepted as the paid boundary',
  );
  assert.ok(
    checkCommunityFreeBoundary(root).some((error) =>
      error.includes(
        'docs/COMMUNITY_FREE_PRODUCT_CONTRACT.md: missing product boundary text',
      ),
    ),
  );
});

test('community build environments discard managed endpoints and credentials', () => {
  const hostileEnvironment = Object.fromEntries([
    ...COMMUNITY_FORBIDDEN_BACKEND_ENVIRONMENT_KEYS.map((key) => [
      key,
      `private-${key}`,
    ]),
    ['CLODEX_API_URL', 'https://private.invalid/api'],
    ['CLODEX_ORIGIN', 'https://private.invalid'],
    ['CLODEX_LLM_RELAY_URL', 'https://private.invalid/v1'],
    ['CLODEX_CLOUD_TASKS_KILL_SWITCH', 'false'],
    ['PRIVATE_GATEWAY_TOKEN', 'secret'],
    ['POSTHOG_API_KEY', 'phc_public_project_ingest_key_12345'],
  ]);

  for (const distributionMode of ['community-unsigned', 'community-observed']) {
    const environment = resolveBackendBuildEnvironment({
      authEnabled: distributionMode === 'community-observed',
      autoUpdateEnabled: false,
      distributionMode,
      environment: hostileEnvironment,
      // Defense in depth: even a caller that incorrectly requests managed
      // services cannot make a Community environment retain them.
      managedServicesEnabled: true,
      telemetryEnabled: distributionMode === 'community-observed',
    });
    assert.deepEqual(findForbiddenCommunityBackendEnvironment(environment), []);
    assert.equal(environment.CLODEX_CLOUD_TASKS_KILL_SWITCH, 'true');
    assert.equal(environment.CLODEX_ORIGIN, COMMUNITY_PUBLIC_ENDPOINTS.origin);
    assert.equal(environment.CLODEX_API_URL, COMMUNITY_PUBLIC_ENDPOINTS.api);
    assert.equal(
      environment.CLODEX_LLM_RELAY_URL,
      COMMUNITY_PUBLIC_ENDPOINTS.modelRelay,
    );
    assert.equal(environment.PRIVATE_GATEWAY_TOKEN, undefined);
  }
});

test('official Free builds discard managed configuration by default', () => {
  const environment = resolveBackendBuildEnvironment({
    authEnabled: true,
    autoUpdateEnabled: true,
    distributionMode: 'official',
    environment: {
      CLODEX_CLOUD_TASKS_URL: 'https://managed.example/cloud',
      CLODEX_MCP_GATEWAY_URL: 'https://managed.example/mcp',
      CLODEX_SESSION_SHARING_URL: 'https://managed.example/shares',
    },
    managedServicesEnabled: false,
    telemetryEnabled: true,
  });
  assert.equal(environment.CLODEX_CLOUD_TASKS_URL, undefined);
  assert.equal(environment.CLODEX_MCP_GATEWAY_URL, undefined);
  assert.equal(environment.CLODEX_SESSION_SHARING_URL, undefined);
  assert.equal(environment.CLODEX_CLOUD_TASKS_KILL_SWITCH, 'true');
});

test('managed builds never invent a hosted MCP endpoint', () => {
  const environment = resolveBackendBuildEnvironment({
    authEnabled: true,
    autoUpdateEnabled: true,
    distributionMode: 'official',
    environment: {},
    managedServicesEnabled: true,
    telemetryEnabled: true,
  });
  assert.equal(environment.CLODEX_MCP_GATEWAY_URL, undefined);
});

test('managed builds may retain explicitly supported service configuration', () => {
  const environment = resolveBackendBuildEnvironment({
    authEnabled: true,
    autoUpdateEnabled: true,
    distributionMode: 'official',
    environment: {
      CLODEX_CLOUD_TASKS_KILL_SWITCH: 'false',
      CLODEX_CLOUD_TASKS_RESIDENCY: 'eu',
      CLODEX_CLOUD_TASKS_URL: 'https://managed.example/cloud',
      CLODEX_MCP_GATEWAY_URL: 'https://managed.example/mcp',
      CLODEX_SESSION_SHARING_URL: 'https://managed.example/shares',
      SUPABASE_PUBLISHABLE_KEY: 'public-client-key',
      SUPABASE_URL: 'https://managed.example/database',
    },
    managedServicesEnabled: true,
    telemetryEnabled: true,
  });
  assert.equal(
    environment.CLODEX_CLOUD_TASKS_URL,
    'https://managed.example/cloud',
  );
  assert.equal(
    environment.CLODEX_MCP_GATEWAY_URL,
    'https://managed.example/mcp',
  );
  assert.equal(
    environment.CLODEX_SESSION_SHARING_URL,
    'https://managed.example/shares',
  );
});

test('rejects a managed endpoint added to a Community workflow', () => {
  const root = fixture();
  replace(
    root,
    '.github/workflows/community-unsigned-build.yml',
    '      CLODEX_DISTRIBUTION_MODE: community-unsigned\n',
    '      CLODEX_DISTRIBUTION_MODE: community-unsigned\n      CLODEX_CLOUD_TASKS_URL: https://managed.invalid\n',
  );
  assert.ok(
    checkCommunityFreeBoundary(root).some((error) =>
      error.includes('forbidden managed-service environment key'),
    ),
  );
});

test('rejects an explicit managed-service opt-in in a public workflow', () => {
  const root = fixture();
  replace(
    root,
    '.github/workflows/community-observed-build.yml',
    '      CLODEX_DISTRIBUTION_MODE: community-observed\n',
    '      CLODEX_DISTRIBUTION_MODE: community-observed\n      CLODEX_MANAGED_SERVICES_ENABLED: "true"\n',
  );
  assert.ok(
    checkCommunityFreeBoundary(root).some((error) =>
      error.includes('public workflows must not enable managed services'),
    ),
  );
});

test('rejects removing the managed-service runtime gate', () => {
  const root = fixture();
  replace(
    root,
    'apps/browser/src/backend/main.ts',
    '!__APP_MANAGED_SERVICES_ENABLED__ ||\n    isCloudTaskKillSwitchActive',
    'isCloudTaskKillSwitchActive',
  );
  assert.ok(
    checkCommunityFreeBoundary(root).some((error) =>
      error.includes('missing managed-service gate'),
    ),
  );
});

test('rejects unconditional hosted MCP construction', () => {
  const root = fixture();
  replace(
    root,
    'apps/browser/src/backend/services/toolbox/index.ts',
    'if (__APP_MANAGED_SERVICES_ENABLED__) {',
    'if (true) {',
  );
  assert.ok(
    checkCommunityFreeBoundary(root).some((error) =>
      error.includes('hosted MCP connector is not conditionally instantiated'),
    ),
  );
});

test('rejects removing the Free-build MCP alias', () => {
  const root = fixture();
  replace(
    root,
    'apps/browser/vite.backend.config.ts',
    '!buildConstants.__APP_MANAGED_SERVICES_ENABLED__',
    'false',
  );
  assert.ok(
    checkCommunityFreeBoundary(root).some((error) =>
      error.includes('alias the hosted MCP implementation'),
    ),
  );
});
