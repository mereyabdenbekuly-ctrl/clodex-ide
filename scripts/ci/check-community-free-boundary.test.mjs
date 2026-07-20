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
const TOKEN_TEMPLATE_PLACEHOLDER = `\${token}`;
const ACCESS_TOKEN_TEMPLATE_PLACEHOLDER = `\${authService.accessToken}`;
const ACCOUNT_ACCESS_TOKEN_TEMPLATE_PLACEHOLDER = `\${accountAccessToken}`;
const TASK_CREDENTIAL_TEMPLATE_PLACEHOLDER = `\${taskCredential}`;
const fixtureFiles = [
  '.github/workflows/community-observed-build.yml',
  '.github/workflows/community-unsigned-build.yml',
  '.release-evidence/README.md',
  'AGENTS.md',
  'apps/browser/build-constants.ts',
  'apps/browser/community-capability-boundary.json',
  'apps/browser/community-free-build-policy.mjs',
  'apps/browser/public-managed-service-entitlement-contract.v1.json',
  'apps/browser/scripts/check-main-plan-readiness.ts',
  'apps/browser/scripts/model-fabric-policy-publication.ts',
  'apps/browser/src/backend/agent-host/cloud-task-control-plane.ts',
  'apps/browser/src/backend/main.ts',
  'apps/browser/src/backend/services/main-plan-promotion-assessments.ts',
  'apps/browser/src/backend/services/model-fabric-policy-publication.ts',
  'apps/browser/src/backend/services/session-continuity/index.ts',
  'apps/browser/src/backend/services/toolbox/index.ts',
  'apps/browser/src/backend/services/toolbox/services/clodex-mcp/community-disabled.ts',
  'apps/browser/src/backend/services/toolbox/services/clodex-mcp/index.ts',
  'apps/browser/src/shared/feature-gates.ts',
  'apps/browser/src/shared/main-plan-readiness.ts',
  'apps/browser/src/backend/startup/phases/cloud-task-runtime.ts',
  'apps/browser/vite.backend.config.ts',
  'docs/COMMUNITY_FREE_PRODUCT_CONTRACT.md',
  'docs/governance/COMMUNITY_CAPABILITY_BOUNDARY.md',
  'docs/governance/OPEN_CLOSED_BOUNDARY.md',
  'docs/model-fabric-policy-publication.md',
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

function replaceInPublicAsyncMethod(root, file, methodName, before, after) {
  const path = join(root, file);
  const source = readFileSync(path, 'utf8');
  const regularMarker = `  public async ${methodName}(`;
  const generatorMarker = `  public async *${methodName}(`;
  const start = Math.max(
    source.indexOf(regularMarker),
    source.indexOf(generatorMarker),
  );
  assert.ok(start >= 0, `${file}: ${methodName} exists`);
  const nextPublic = source.indexOf('\n  public ', start + 1);
  const nextPrivate = source.indexOf('\n  private ', start + 1);
  const boundaries = [nextPublic, nextPrivate].filter((index) => index >= 0);
  const end = boundaries.length > 0 ? Math.min(...boundaries) : source.length;
  const methodSource = source.slice(start, end);
  assert.ok(
    methodSource.includes(before),
    `${file}: ${methodName} mutation target exists`,
  );
  writeFileSync(
    path,
    `${source.slice(0, start)}${methodSource.replace(before, after)}${source.slice(end)}`,
  );
}

function mutateCapabilityManifest(root, mutate) {
  const path = join(root, 'apps/browser/community-capability-boundary.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  mutate(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function mutateEntitlementContract(root, mutate) {
  const path = join(
    root,
    'apps/browser/public-managed-service-entitlement-contract.v1.json',
  );
  const contract = JSON.parse(readFileSync(path, 'utf8'));
  mutate(contract);
  writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`);
}

test('accepts the repository Community Free boundary', () => {
  assert.deepEqual(checkCommunityFreeBoundary(repositoryRoot), []);
});

test('literal feature gate parsing ignores fake gates in comments', () => {
  const root = fixture();
  replace(
    root,
    'apps/browser/src/shared/feature-gates.ts',
    "  'collaboration-presets',\n",
    "  'collaboration-presets',\n  // 'comment-only-fake-gate',\n  /* 'block-comment-fake-gate', */\n",
  );

  assert.deepEqual(checkCommunityFreeBoundary(root), []);
});

test('literal feature gate parsing rejects spread and nonliteral entries', () => {
  const root = fixture();
  replace(
    root,
    'apps/browser/src/shared/feature-gates.ts',
    "  'collaboration-presets',\n",
    "  'collaboration-presets',\n  ...externalFeatureGates,\n",
  );

  assert.ok(
    checkCommunityFreeBoundary(root).some((error) =>
      error.includes(
        'featureGateIds must be a literal string array: array entries must be string literals',
      ),
    ),
  );
});

test('rejects a new undeclared backend CLODEx endpoint even with bearer auth', () => {
  const root = fixture();
  const path = join(root, 'apps/browser/src/backend/main.ts');
  writeFileSync(
    path,
    `${readFileSync(path, 'utf8')}\nvoid fetch(process.env.CLODEX_NEW_PAID_URL!, { headers: { Authorization: \`Bearer \${authService.accessToken}\` } });\n`,
  );

  assert.ok(
    checkCommunityFreeBoundary(root).some((error) =>
      error.includes(
        'unknown CLODEx endpoint environment usage CLODEX_NEW_PAID_URL',
      ),
    ),
  );
});

test('rejects undeclared endpoint syntax variants and unknown CLODEx hosts', () => {
  const cases = [
    {
      source: "void process.env['CLODEX_NEW_PAID_URL'];\n",
      expected: 'unknown CLODEx endpoint environment usage CLODEX_NEW_PAID_URL',
    },
    {
      source: 'void process.env["CLODEX_NEW_PAID_URL"];\n',
      expected: 'unknown CLODEx endpoint environment usage CLODEX_NEW_PAID_URL',
    },
    {
      source: 'void process.env[`CLODEX_NEW_PAID_URL`];\n',
      expected: 'unknown CLODEx endpoint environment usage CLODEX_NEW_PAID_URL',
    },
    {
      source: `void \`\${process.env.CLODEX_NEW_PAID_URL}/v1\`;\n`,
      expected: 'unknown CLODEx endpoint environment usage CLODEX_NEW_PAID_URL',
    },
    {
      source: "void fetch('https://paid.clodex.xyz/v1');\n",
      expected: 'unknown hardcoded CLODEx service hostname paid.clodex.xyz',
    },
    {
      source: 'void `https://paid.clodex.xyz/v1`;\n',
      expected: 'unknown hardcoded CLODEx service hostname paid.clodex.xyz',
    },
  ];

  for (const mutation of cases) {
    const root = fixture();
    const path = join(root, 'apps/browser/src/backend/main.ts');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n${mutation.source}`);
    assert.ok(
      checkCommunityFreeBoundary(root).some((error) =>
        error.includes(mutation.expected),
      ),
      mutation.source,
    );
  }
});

test('endpoint inventory ignores comment-only decoys, including template expressions', () => {
  const root = fixture();
  const path = join(root, 'apps/browser/src/backend/main.ts');
  writeFileSync(
    path,
    `${readFileSync(path, 'utf8')}
// process.env.CLODEX_NEW_PAID_URL https://paid.clodex.xyz
/* process.env['CLODEX_NEW_PAID_URL'] https://paid.clodex.xyz */
void \`${'${'}/* process.env.CLODEX_NEW_PAID_URL https://paid.clodex.xyz */ 'safe'}\`;
`,
  );

  assert.deepEqual(checkCommunityFreeBoundary(root), []);
});

test('rejects canonical and managed endpoint use outside exact implementation paths', () => {
  const cases = [
    {
      file: 'apps/browser/src/backend/rogue-paid.ts',
      source: "void fetch(new URL('/paid', process.env.CLODEX_API_URL));\n",
      expected:
        'endpoint environment usage CLODEX_API_URL is outside its exact public client implementation path inventory',
    },
    {
      file: 'apps/browser/src/backend/rogue-managed.ts',
      source: "void process.env['CLODEX_MCP_GATEWAY_URL'];\n",
      expected:
        'endpoint environment usage CLODEX_MCP_GATEWAY_URL is outside its exact public client implementation path inventory',
    },
    {
      file: 'apps/browser/src/ui/rogue-paid.ts',
      source: 'void fetch(import.meta.env.VITE_CLODEX_NEW_PAID_URL);\n',
      expected:
        'unknown CLODEx endpoint environment usage VITE_CLODEX_NEW_PAID_URL',
    },
    {
      file: 'apps/browser/src/ui/rogue-console.ts',
      source: 'void import.meta.env.VITE_CLODEX_CONSOLE_URL;\n',
      expected:
        'endpoint environment usage VITE_CLODEX_CONSOLE_URL is outside its exact public client implementation path inventory',
    },
    {
      file: 'apps/browser/src/ui/rogue-host.ts',
      source: "void fetch('https://paid.clodex.xyz/v1');\n",
      expected: 'unknown hardcoded CLODEx service hostname paid.clodex.xyz',
    },
  ];

  for (const mutation of cases) {
    const root = fixture();
    const path = join(root, mutation.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, mutation.source);
    assert.ok(
      checkCommunityFreeBoundary(root).some((error) =>
        error.includes(mutation.expected),
      ),
      mutation.file,
    );
  }
});

test('rejects removing bearer authorization from managed connector transports', () => {
  const cases = [
    {
      file: 'apps/browser/src/backend/agent-host/cloud-task-control-plane.ts',
      before: `function bearerJsonHeaders(token: string): Record<string, string> {\n  if (!token?.trim()) throw new Error('Cloud task bearer token is unavailable');\n  return {\n    Authorization: \`Bearer ${TOKEN_TEMPLATE_PLACEHOLDER}\`,`,
      after:
        "function bearerJsonHeaders(token: string): Record<string, string> {\n  if (!token?.trim()) throw new Error('Cloud task bearer token is unavailable');\n  return {\n    Authorization: token,",
      expected:
        'Cloud Task remote operations must construct bearer authorization',
    },
    {
      file: 'apps/browser/src/backend/main.ts',
      before: `Authorization: \`Bearer ${ACCESS_TOKEN_TEMPLATE_PLACEHOLDER}\`,`,
      after: 'Authorization: authService.accessToken,',
      expected:
        'both session-sharing operations must use account bearer authorization',
    },
    {
      file: 'apps/browser/src/backend/services/toolbox/services/clodex-mcp/index.ts',
      before: `Authorization: \`Bearer ${TOKEN_TEMPLATE_PLACEHOLDER}\`,`,
      after: 'Authorization: token,',
      expected: 'hosted MCP transport must require a model access token',
    },
  ];

  for (const mutation of cases) {
    const root = fixture();
    replace(root, mutation.file, mutation.before, mutation.after);
    assert.ok(
      checkCommunityFreeBoundary(root).some((error) =>
        error.includes(mutation.expected),
      ),
      mutation.file,
    );
  }
});

test('rejects removing any reviewed Cloud Task operation authorization site', () => {
  const cloudControlPlane =
    'apps/browser/src/backend/agent-host/cloud-task-control-plane.ts';
  const simpleBindings = [
    ['createUploadSession', 'bearerJsonHeaders(accountAccessToken)'],
    ['issueCredential', 'bearerJsonHeaders(accountAccessToken)'],
    [
      'revokeCredential',
      `Authorization: \`Bearer ${ACCOUNT_ACCESS_TOKEN_TEMPLATE_PLACEHOLDER}\``,
    ],
    ['startExecution', 'bearerJsonHeaders(taskCredential)'],
    ['pushEvidenceMemory', 'bearerJsonHeaders(taskCredential)'],
    ['pullEvidenceMemory', 'bearerJsonHeaders(taskCredential)'],
    ['commitEvidenceMemoryAtomicMerge', 'bearerJsonHeaders(taskCredential)'],
    ['resolveEvidenceMemoryDivergence', 'bearerJsonHeaders(taskCredential)'],
    ['confirmExecutionRestore', 'bearerJsonHeaders(taskCredential)'],
    ['acquireExecutionLease', 'bearerJsonHeaders(taskCredential)'],
    ['renewExecutionLease', 'fencingJsonHeaders(taskCredential, lease)'],
    ['releaseExecutionLease', 'fencingJsonHeaders(taskCredential, lease)'],
    ['suspendExecution', 'fencingJsonHeaders(taskCredential, lease)'],
    ['resumeExecution', 'bearerJsonHeaders(taskCredential)'],
    [
      'downloadArtifact',
      `Authorization: \`Bearer ${TASK_CREDENTIAL_TEMPLATE_PLACEHOLDER}\``,
    ],
  ];
  const optionallyFencedMethods = [
    'streamExecution',
    'getExecutionStatus',
    'cancelExecution',
    'cancelExecutionById',
  ];
  const mutations = [
    ...simpleBindings.map(([methodName, before]) => ({
      methodName,
      before,
      after: before.includes('Authorization:')
        ? 'Authorization: taskCredential'
        : 'Object.create(null)',
    })),
    ...optionallyFencedMethods.flatMap((methodName) => [
      {
        methodName,
        before: 'fencingHeaders(taskCredential, lease)',
        after: 'Object.create(null)',
      },
      {
        methodName,
        before: `Authorization: \`Bearer ${TASK_CREDENTIAL_TEMPLATE_PLACEHOLDER}\``,
        after: 'Authorization: taskCredential',
      },
    ]),
  ];

  assert.equal(mutations.length, 23);
  for (const mutation of mutations) {
    const root = fixture();
    replaceInPublicAsyncMethod(
      root,
      cloudControlPlane,
      mutation.methodName,
      mutation.before,
      mutation.after,
    );
    assert.ok(
      checkCommunityFreeBoundary(root).some((error) =>
        error.includes(
          `${mutation.methodName} must contain exactly one reviewed`,
        ),
      ),
      `${mutation.methodName}: ${mutation.before}`,
    );
  }
});

test('rejects weakening Cloud Task bearer helper composition', () => {
  const cases = [
    {
      before: `function fencingHeaders(
  token: string,
  lease: CloudTaskExecutionLease,
): Record<string, string> {
  if (!token?.trim()) throw new Error('Cloud task bearer token is unavailable');
  return {
    Authorization: \`Bearer ${TOKEN_TEMPLATE_PLACEHOLDER}\``,
      after: `function fencingHeaders(
  token: string,
  lease: CloudTaskExecutionLease,
): Record<string, string> {
  if (!token?.trim()) throw new Error('Cloud task bearer token is unavailable');
  return {
    Authorization: token,`,
      expected:
        'Cloud Task remote operations must construct bearer authorization',
    },
    {
      before: '...fencingHeaders(token, lease),',
      after: 'Authorization: token,',
      expected:
        'fencingJsonHeaders must compose the reviewed bearer fencing headers',
    },
  ];

  for (const mutation of cases) {
    const root = fixture();
    replace(
      root,
      'apps/browser/src/backend/agent-host/cloud-task-control-plane.ts',
      mutation.before,
      mutation.after,
    );
    assert.ok(
      checkCommunityFreeBoundary(root).some((error) =>
        error.includes(mutation.expected),
      ),
      mutation.expected,
    );
  }
});

test('rejects Cloud Task transport inventory drift and bearer on presigned upload', () => {
  const cloudControlPlane =
    'apps/browser/src/backend/agent-host/cloud-task-control-plane.ts';

  const unreviewedMethods = [
    `  public async unreviewedPaidRoute(): Promise<void> {
    await this.fetchFn(new URL('/paid', this.baseUrl));
  }
`,
    `  async unreviewedPaidRoute(): Promise<void> {
    await this.fetchFn(new URL('/paid', this.baseUrl));
  }
`,
    `  public unreviewedPaidRoute(): Promise<Response> {
    return this.fetchFn(new URL('/paid', this.baseUrl));
  }
`,
    `  public unreviewedPaidRoute(): Promise<Response> {
    return this['fetchFn'](new URL('/paid', this.baseUrl));
  }
`,
    `  public unreviewedPaidRoute(): Promise<Response | undefined> {
    return this.fetchFn?.(new URL('/paid', this.baseUrl));
  }
`,
    `  public unreviewedPaidRoute(): Promise<Response> {
    const transport = this.fetchFn;
    return transport(new URL('/paid', this.baseUrl));
  }
`,
    `  public unreviewedPaidRoute(): Promise<Response> {
    const { fetchFn: transport } = this;
    return transport(new URL('/paid', this.baseUrl));
  }
`,
  ];
  for (const declaration of unreviewedMethods) {
    const root = fixture();
    replace(
      root,
      cloudControlPlane,
      '  private async requestJson(',
      `${declaration}
  private async requestJson(`,
    );
    assert.ok(
      checkCommunityFreeBoundary(root).some((error) =>
        error.includes('unreviewed Cloud Task method unreviewedPaidRoute'),
      ),
      declaration,
    );
  }

  {
    const root = fixture();
    replace(
      root,
      cloudControlPlane,
      '  private async requestJson(',
      `  private readonly unreviewedPaidRoute = () =>
    this.fetchFn(new URL('/paid', this.baseUrl));

  private async requestJson(`,
    );
    assert.ok(
      checkCommunityFreeBoundary(root).some(
        (error) =>
          error.includes('reviewed control-plane transport call') ||
          error.includes(
            'every class-level transport call must belong to a reviewed method inventory entry',
          ),
      ),
    );
  }

  {
    const root = fixture();
    replaceInPublicAsyncMethod(
      root,
      cloudControlPlane,
      'uploadSnapshot',
      "headers.set('Content-Type', 'application/octet-stream');",
      `headers.set('Authorization', \`Bearer ${TASK_CREDENTIAL_TEMPLATE_PLACEHOLDER}\`);
    headers.set('Content-Type', 'application/octet-stream');`,
    );
    assert.ok(
      checkCommunityFreeBoundary(root).some((error) =>
        error.includes(
          'uploadSnapshot must remain a sanitized presigned-upload exception',
        ),
      ),
    );
  }
});

test('rejects public entitlement contract drift and connector reference drift', () => {
  const root = fixture();
  mutateEntitlementContract(root, (contract) => {
    contract.decisionAuthority = 'client-authoritative';
    contract.localGrant = 'allowed';
    contract.denialHttpStatuses = [200];
    contract.clientPaywall = 'required';
  });
  mutateCapabilityManifest(root, (manifest) => {
    manifest.managedConnectors[0].entitlementContract =
      'apps/browser/private-entitlement-contract.json';
  });

  const errors = checkCommunityFreeBoundary(root);
  for (const expected of [
    'decisionAuthority must be server-authoritative',
    'localGrant must be forbidden',
    'denialHttpStatuses must be exactly 401, 403',
    'clientPaywall must be forbidden',
    `entitlementContract must be apps/browser/public-managed-service-entitlement-contract.v1.json`,
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected,
    );
  }
});

test('rejects missing, extra, and duplicate feature gate classifications', () => {
  const root = fixture();
  mutateCapabilityManifest(root, (manifest) => {
    const collaboration = manifest.featureGates.find(
      ({ featureGateId }) => featureGateId === 'collaboration-presets',
    );
    manifest.featureGates = manifest.featureGates.filter(
      ({ featureGateId }) => featureGateId !== 'mascot-overlay',
    );
    manifest.featureGates.push(collaboration, {
      featureGateId: 'invented-paid-toggle',
      classification: 'community-local',
    });
  });

  const errors = checkCommunityFreeBoundary(root);
  assert.ok(
    errors.some((error) =>
      error.includes('missing featureGateId mascot-overlay'),
    ),
  );
  assert.ok(
    errors.some((error) =>
      error.includes('extra featureGateId invented-paid-toggle'),
    ),
  );
  assert.ok(
    errors.some((error) =>
      error.includes('duplicate featureGateId collaboration-presets'),
    ),
  );
});

test('rejects changing the exact managed feature gate classification', () => {
  const root = fixture();
  mutateCapabilityManifest(root, (manifest) => {
    manifest.featureGates.find(
      ({ featureGateId }) => featureGateId === 'cloud-tasks',
    ).classification = 'community-local';
    manifest.featureGates.find(
      ({ featureGateId }) => featureGateId === 'automations',
    ).classification = 'managed-connector';
  });

  const errors = checkCommunityFreeBoundary(root);
  assert.ok(
    errors.some((error) =>
      error.includes(
        'featureGateId cloud-tasks must be classified managed-connector',
      ),
    ),
  );
  assert.ok(
    errors.some((error) =>
      error.includes(
        'featureGateId automations must be classified community-local',
      ),
    ),
  );
});

test('rejects missing, extra, and duplicate managed connectors', () => {
  const root = fixture();
  mutateCapabilityManifest(root, (manifest) => {
    const cloudConnector = manifest.managedConnectors.find(
      ({ id }) => id === 'cloud-task-control-plane',
    );
    manifest.managedConnectors = manifest.managedConnectors.filter(
      ({ id }) => id !== 'session-sharing',
    );
    manifest.managedConnectors.push(cloudConnector, {
      ...cloudConnector,
      id: 'client-side-paywall',
    });
  });

  const errors = checkCommunityFreeBoundary(root);
  assert.ok(
    errors.some((error) =>
      error.includes('missing managed connector session-sharing'),
    ),
  );
  assert.ok(
    errors.some((error) =>
      error.includes('extra managed connector client-side-paywall'),
    ),
  );
  assert.ok(
    errors.some((error) =>
      error.includes('duplicate managed connector cloud-task-control-plane'),
    ),
  );
});

test('rejects weakening the managed connector contract', () => {
  const root = fixture();
  mutateCapabilityManifest(root, (manifest) => {
    const connector = manifest.managedConnectors.find(
      ({ id }) => id === 'cloud-task-control-plane',
    );
    connector.buildGate = 'renderer-feature-flag';
    connector.authorization = 'none';
    connector.entitlementAuthority = 'client-authoritative';
  });

  const errors = checkCommunityFreeBoundary(root);
  assert.ok(
    errors.some((error) =>
      error.includes('buildGate must be __APP_MANAGED_SERVICES_ENABLED__'),
    ),
  );
  assert.ok(
    errors.some((error) => error.includes('authorization must be bearer')),
  );
  assert.ok(
    errors.some((error) =>
      error.includes('entitlementAuthority must be server-authoritative'),
    ),
  );
});

test('rejects a connector gate that is absent or Community-local', () => {
  const root = fixture();
  mutateCapabilityManifest(root, (manifest) => {
    const cloudConnector = manifest.managedConnectors.find(
      ({ id }) => id === 'cloud-task-control-plane',
    );
    cloudConnector.featureGateIds = ['not-a-feature-gate'];
    const sessionGate = manifest.featureGates.find(
      ({ featureGateId }) => featureGateId === 'session-continuity',
    );
    sessionGate.classification = 'community-local';
  });

  const errors = checkCommunityFreeBoundary(root);
  assert.ok(
    errors.some((error) =>
      error.includes(
        'connector featureGateId not-a-feature-gate does not exist',
      ),
    ),
  );
  assert.ok(
    errors.some((error) =>
      error.includes(
        'connector featureGateId session-continuity is not classified managed-connector',
      ),
    ),
  );
  assert.ok(
    errors.some((error) =>
      error.includes(
        'managed featureGateId cloud-tasks is not covered by a managed connector',
      ),
    ),
  );
});

test('rejects an endpoint key that Community builds do not discard', () => {
  const root = fixture();
  mutateCapabilityManifest(root, (manifest) => {
    manifest.managedConnectors.find(
      ({ id }) => id === 'session-sharing',
    ).endpointEnvironmentKeys = ['CLODEX_UNFILTERED_PAID_ENDPOINT'];
  });

  assert.ok(
    checkCommunityFreeBoundary(root).some((error) =>
      error.includes(
        'endpoint environment key CLODEX_UNFILTERED_PAID_ENDPOINT is not forbidden in Community builds',
      ),
    ),
  );
});

test('rejects a connector implementation path outside the exact public inventory', () => {
  const root = fixture();
  mutateCapabilityManifest(root, (manifest) => {
    manifest.managedConnectors.find(
      ({ id }) => id === 'clodex-hosted-mcp',
    ).implementationPaths = ['/private/gateway.ts'];
  });

  const errors = checkCommunityFreeBoundary(root);
  assert.ok(
    errors.some((error) =>
      error.includes('implementationPaths: must be exactly'),
    ),
  );
  assert.ok(
    errors.some((error) =>
      error.includes(
        'implementation path must be an existing repository-relative file',
      ),
    ),
  );
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

test('rejects reclassifying public Model Fabric tooling as managed product', () => {
  const root = fixture();
  replace(
    root,
    'docs/model-fabric-policy-publication.md',
    'PUBLIC CORE / LOCAL REFERENCE TOOLING',
    'PRIVATE MANAGED PRODUCT',
  );
  assert.ok(
    checkCommunityFreeBoundary(root).some((error) =>
      error.includes(
        'docs/model-fabric-policy-publication.md: missing product boundary text',
      ),
    ),
  );
});

test('rejects reintroducing an operational Model Fabric publisher workflow', () => {
  const root = fixture();
  writeFileSync(
    join(root, '.github/workflows/model-fabric-publication.yml'),
    `name: forbidden publisher
on: workflow_dispatch
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - env:
          PUBLISHER_PRIVATE_KEY: \${{ secrets.CLODEX_MODEL_FABRIC_PUBLICATION_PUBLISHER_PRIVATE_KEY }}
        run: pnpm --dir apps/browser policy:publication -- publish --publisher-private-key publisher.pem
`,
  );
  const errors = checkCommunityFreeBoundary(root);
  assert.ok(
    errors.some((error) =>
      error.includes(
        'operational Model Fabric publisher must remain quarantined',
      ),
    ),
  );
  assert.ok(
    errors.some((error) =>
      error.includes('operational Model Fabric automation is forbidden'),
    ),
  );
});

test('rejects renamed workflows and wrapper scripts for Model Fabric publication', () => {
  const root = fixture();
  const workflowPath = join(root, '.github/workflows/renamed.yml');
  writeFileSync(
    workflowPath,
    `name: renamed automation
on: workflow_dispatch
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: >-
          pnpm tsx
          apps/browser/scripts/model-fabric-policy-publication.ts
          publish
`,
  );
  const wrapperPath = join(root, 'scripts/release/policy-wrapper.ts');
  mkdirSync(dirname(wrapperPath), { recursive: true });
  writeFileSync(
    wrapperPath,
    `import { authorizeModelFabricPolicyPublication } from '../../apps/browser/src/backend/services/model-fabric-policy-publication';
void authorizeModelFabricPolicyPublication;
`,
  );

  const errors = checkCommunityFreeBoundary(root);
  assert.ok(
    errors.some((error) =>
      error.includes(
        '.github/workflows/renamed.yml: operational Model Fabric automation is forbidden',
      ),
    ),
  );
  assert.ok(
    errors.some((error) =>
      error.includes(
        'scripts/release/policy-wrapper.ts: operational Model Fabric automation is forbidden',
      ),
    ),
  );
});

test('rejects operational wrappers placed at the repository root', () => {
  const root = fixture();
  writeFileSync(
    join(root, 'ship.mjs'),
    `import { authorizeModelFabricPolicyPublication } from './apps/browser/src/backend/services/model-fabric-policy-publication.ts';
void authorizeModelFabricPolicyPublication;
`,
  );
  writeFileSync(
    join(root, '.github/workflows/root-wrapper.yml'),
    `name: root wrapper
on: workflow_dispatch
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - run: node ship.mjs
`,
  );

  assert.ok(
    checkCommunityFreeBoundary(root).some((error) =>
      error.includes(
        'ship.mjs: operational Model Fabric automation is forbidden',
      ),
    ),
  );
});

test('rejects turning the local/reference publisher into a hosted client', () => {
  const root = fixture();
  const cliPath = join(
    root,
    'apps/browser/scripts/model-fabric-policy-publication.ts',
  );
  writeFileSync(
    cliPath,
    `${readFileSync(cliPath, 'utf8')}\nvoid fetch('https://managed.clodex.xyz/publish', { headers: { Authorization: \`Bearer \${process.env.CLODEX_PUBLISHER_TOKEN}\` } });\n`,
  );

  const errors = checkCommunityFreeBoundary(root);
  assert.ok(
    errors.some((error) =>
      error.includes('local/reference publication code must remain offline'),
    ),
  );
});

test('rejects package-script aliases that wrap the reference publication CLI', () => {
  const root = fixture();
  const packagePath = join(root, 'apps/browser/package.json');
  writeFileSync(
    packagePath,
    `${JSON.stringify(
      {
        scripts: {
          'policy:publication':
            'tsx --tsconfig tsconfig.backend.json scripts/model-fabric-policy-publication.ts',
          'release:model-policy': 'pnpm policy:publication -- publish',
        },
      },
      null,
      2,
    )}\n`,
  );

  assert.ok(
    checkCommunityFreeBoundary(root).some((error) =>
      error.includes('apps/browser/package.json#scripts.release:model-policy'),
    ),
  );
});

test('allows workflows to run local/reference publication tests', () => {
  const root = fixture();
  writeFileSync(
    join(root, '.github/workflows/reference-tests.yml'),
    `name: reference tests
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm --dir apps/browser exec vitest run src/backend/services/model-fabric-policy-publication.test.ts
`,
  );

  assert.deepEqual(checkCommunityFreeBoundary(root), []);
});

test('rejects caller-controlled Model Fabric main-plan promotion inputs', () => {
  const root = fixture();
  const cliPath = join(
    root,
    'apps/browser/scripts/check-main-plan-readiness.ts',
  );
  writeFileSync(
    cliPath,
    `${readFileSync(cliPath, 'utf8')}\nconst forbiddenLegacyArgument = '--model-fabric-state';\n`,
  );

  assert.ok(
    checkCommunityFreeBoundary(root).some((error) =>
      error.includes(
        'caller-controlled Model Fabric promotion input is forbidden',
      ),
    ),
  );
});

test('rejects restoring a public Model Fabric promotion contract', () => {
  const root = fixture();
  replace(
    root,
    'apps/browser/src/shared/main-plan-readiness.ts',
    "promotionContract: 'not-yet-defined'",
    "promotionContract: 'authenticated-policy-publication'",
  );
  replace(
    root,
    'apps/browser/src/shared/main-plan-readiness.ts',
    "promotionContract: 'release-readiness-evidence'",
    "promotionContract: 'not-yet-defined'",
  );
  replace(
    root,
    'apps/browser/src/shared/main-plan-readiness.ts',
    "promotionContract: 'authenticated-policy-publication'",
    "// promotionContract: 'not-yet-defined'\n    promotionContract: 'authenticated-policy-publication'",
  );

  assert.ok(
    checkCommunityFreeBoundary(root).some((error) =>
      error.includes(
        'Model Fabric managed promotion contract must remain quarantined',
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
