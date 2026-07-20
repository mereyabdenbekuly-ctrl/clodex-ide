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

const COMMUNITY_CAPABILITY_BOUNDARY_MANIFEST =
  'apps/browser/community-capability-boundary.json';
const PUBLIC_MANAGED_ENTITLEMENT_CONTRACT =
  'apps/browser/public-managed-service-entitlement-contract.v1.json';
const FEATURE_GATE_SOURCE = 'apps/browser/src/shared/feature-gates.ts';
const CANONICAL_PUBLIC_BACKEND_ENDPOINT_PATHS = Object.freeze({
  CLODEX_API_URL: Object.freeze([
    'apps/browser/community-free-build-policy.mjs',
    'apps/browser/src/backend/services/asset-cache/index.ts',
    'apps/browser/src/backend/services/auth/clodex.ts',
    'apps/browser/src/backend/services/auth/index.ts',
    'apps/browser/src/backend/services/auth/server-interop.ts',
  ]),
  CLODEX_CONSOLE_URL: Object.freeze([
    'apps/browser/community-free-build-policy.mjs',
    'apps/browser/src/backend/services/window-layout/index.ts',
    'apps/browser/src/web-content-preload/index.ts',
    'apps/browser/vite.web-content-preload.config.ts',
  ]),
  CLODEX_HOME_URL: Object.freeze([
    'apps/browser/src/ui/components/auth/sign-in-options-panel.tsx',
  ]),
  CLODEX_LLM_RELAY_URL: Object.freeze([
    'apps/browser/community-free-build-policy.mjs',
    'apps/browser/src/backend/agents/model-provider.ts',
    'apps/browser/src/backend/agents/providers/built-in-adapters.ts',
    'apps/browser/src/backend/services/auth/clodex.ts',
    'apps/browser/src/backend/services/preferences.ts',
  ]),
  CLODEX_LOGIN_URL: Object.freeze([
    'apps/browser/community-free-build-policy.mjs',
  ]),
  CLODEX_ORIGIN: Object.freeze([
    'apps/browser/community-free-build-policy.mjs',
    'apps/browser/src/backend/services/auth/clodex.ts',
    'apps/browser/src/backend/services/auth/index.ts',
    'apps/browser/src/backend/services/window-layout/index.ts',
  ]),
  CLODEX_REGISTER_URL: Object.freeze([
    'apps/browser/src/ui/components/auth/sign-in-options-panel.tsx',
  ]),
  VITE_CLODEX_CONSOLE_URL: Object.freeze([
    'apps/browser/src/ui/screens/main/agent-chat/chat/_components/message-runtime-error.tsx',
    'apps/browser/src/ui/screens/settings/sections/account-section.tsx',
    'apps/browser/src/ui/screens/settings/sections/models-providers-section.tsx',
  ]),
  VITE_CLODEX_ORIGIN: Object.freeze([
    'apps/browser/src/ui/components/auth/sign-in-options-panel.tsx',
    'apps/browser/src/ui/screens/main/agent-chat/chat/_components/message-runtime-error.tsx',
    'apps/browser/src/ui/screens/settings/sections/account-section.tsx',
    'apps/browser/src/ui/screens/settings/sections/models-providers-section.tsx',
  ]),
});
const CANONICAL_PUBLIC_BACKEND_ENDPOINT_KEYS = new Set(
  Object.keys(CANONICAL_PUBLIC_BACKEND_ENDPOINT_PATHS),
);
const CANONICAL_CLODEX_HOSTS = new Set(
  [
    COMMUNITY_PUBLIC_ENDPOINTS.api,
    COMMUNITY_PUBLIC_ENDPOINTS.console,
    COMMUNITY_PUBLIC_ENDPOINTS.login,
    COMMUNITY_PUBLIC_ENDPOINTS.modelRelay,
    COMMUNITY_PUBLIC_ENDPOINTS.origin,
  ].map((value) => new URL(value).hostname.toLowerCase()),
);
const RUNTIME_ENDPOINT_SCAN_ROOTS = ['apps/browser/src'];
const BACKEND_BUILD_ENDPOINT_SCAN_FILES = [
  'apps/browser/build-constants.ts',
  'apps/browser/community-free-build-policy.mjs',
  'apps/browser/vite.backend.config.ts',
  'apps/browser/vite.web-content-preload.config.ts',
];
const CAPABILITY_CLASSIFICATIONS = new Set([
  'community-local',
  'managed-connector',
]);
const MANAGED_FEATURE_GATE_IDS = new Set(['cloud-tasks', 'session-continuity']);
const MANAGED_CONNECTOR_CONTRACT = Object.freeze({
  authorization: 'bearer',
  buildGate: '__APP_MANAGED_SERVICES_ENABLED__',
  entitlementContract: PUBLIC_MANAGED_ENTITLEMENT_CONTRACT,
  entitlementAuthority: 'server-authoritative',
});
const EXPECTED_MANAGED_CONNECTORS = Object.freeze({
  'cloud-task-control-plane': Object.freeze({
    endpointEnvironmentKeys: Object.freeze(['CLODEX_CLOUD_TASKS_URL']),
    featureGateIds: Object.freeze(['cloud-tasks']),
    implementationPaths: Object.freeze([
      'apps/browser/src/backend/agent-host/cloud-task-control-plane.ts',
      'apps/browser/src/backend/startup/phases/cloud-task-runtime.ts',
      'apps/browser/src/backend/main.ts',
      'apps/browser/community-free-build-policy.mjs',
    ]),
    managedConfigurationKeys: Object.freeze(['CLODEX_CLOUD_TASKS_RESIDENCY']),
  }),
  'session-sharing': Object.freeze({
    endpointEnvironmentKeys: Object.freeze(['CLODEX_SESSION_SHARING_URL']),
    featureGateIds: Object.freeze(['session-continuity']),
    implementationPaths: Object.freeze([
      'apps/browser/src/backend/services/session-continuity/index.ts',
      'apps/browser/src/backend/main.ts',
      'apps/browser/community-free-build-policy.mjs',
    ]),
    managedConfigurationKeys: Object.freeze([]),
  }),
  'clodex-hosted-mcp': Object.freeze({
    endpointEnvironmentKeys: Object.freeze(['CLODEX_MCP_GATEWAY_URL']),
    featureGateIds: Object.freeze([]),
    implementationPaths: Object.freeze([
      'apps/browser/src/backend/services/toolbox/services/clodex-mcp/index.ts',
      'apps/browser/src/backend/services/toolbox/index.ts',
      'apps/browser/vite.backend.config.ts',
      'apps/browser/src/backend/services/toolbox/services/clodex-mcp/community-disabled.ts',
      'apps/browser/community-free-build-policy.mjs',
    ]),
    managedConfigurationKeys: Object.freeze([]),
  }),
});
const PUBLIC_MANAGED_ENTITLEMENT_CONTRACT_FIELDS = [
  'clientPaywall',
  'contractId',
  'contractVersion',
  'decisionAuthority',
  'denialHttpStatuses',
  'localGrant',
];
const CAPABILITY_MANIFEST_ROOT_FIELDS = [
  'featureGates',
  'managedConnectors',
  'schemaVersion',
];
const CAPABILITY_MANIFEST_FEATURE_GATE_FIELDS = [
  'classification',
  'featureGateId',
];
const CAPABILITY_MANIFEST_CONNECTOR_FIELDS = [
  'authorization',
  'buildGate',
  'endpointEnvironmentKeys',
  'entitlementAuthority',
  'entitlementContract',
  'featureGateIds',
  'id',
  'implementationPaths',
  'managedConfigurationKeys',
];
const CLOUD_TASK_AUTHORIZATION_BINDINGS = Object.freeze({
  createUploadSession: Object.freeze([
    Object.freeze({
      label: 'account bearerJsonHeaders',
      pattern: /headers:\s*bearerJsonHeaders\(\s*accountAccessToken\s*\)/u,
    }),
  ]),
  issueCredential: Object.freeze([
    Object.freeze({
      label: 'account bearerJsonHeaders',
      pattern: /headers:\s*bearerJsonHeaders\(\s*accountAccessToken\s*\)/u,
    }),
  ]),
  revokeCredential: Object.freeze([
    Object.freeze({
      label: 'direct account bearer',
      pattern: /Authorization:\s*`Bearer \$\{accountAccessToken\}`/u,
    }),
  ]),
  startExecution: Object.freeze([
    Object.freeze({
      label: 'task bearerJsonHeaders',
      pattern: /headers:\s*bearerJsonHeaders\(\s*taskCredential\s*\)/u,
    }),
  ]),
  pushEvidenceMemory: Object.freeze([
    Object.freeze({
      label: 'task bearerJsonHeaders',
      pattern: /headers:\s*bearerJsonHeaders\(\s*taskCredential\s*\)/u,
    }),
  ]),
  pullEvidenceMemory: Object.freeze([
    Object.freeze({
      label: 'task bearerJsonHeaders',
      pattern: /headers:\s*bearerJsonHeaders\(\s*taskCredential\s*\)/u,
    }),
  ]),
  commitEvidenceMemoryAtomicMerge: Object.freeze([
    Object.freeze({
      label: 'task bearerJsonHeaders',
      pattern: /\.\.\.bearerJsonHeaders\(\s*taskCredential\s*\)/u,
    }),
  ]),
  resolveEvidenceMemoryDivergence: Object.freeze([
    Object.freeze({
      label: 'task bearerJsonHeaders',
      pattern: /headers:\s*bearerJsonHeaders\(\s*taskCredential\s*\)/u,
    }),
  ]),
  confirmExecutionRestore: Object.freeze([
    Object.freeze({
      label: 'task bearerJsonHeaders',
      pattern: /headers:\s*bearerJsonHeaders\(\s*taskCredential\s*\)/u,
    }),
  ]),
  acquireExecutionLease: Object.freeze([
    Object.freeze({
      label: 'task bearerJsonHeaders',
      pattern: /headers:\s*bearerJsonHeaders\(\s*taskCredential\s*\)/u,
    }),
  ]),
  renewExecutionLease: Object.freeze([
    Object.freeze({
      label: 'fenced task JSON headers',
      pattern:
        /headers:\s*fencingJsonHeaders\(\s*taskCredential\s*,\s*lease\s*\)/u,
    }),
  ]),
  releaseExecutionLease: Object.freeze([
    Object.freeze({
      label: 'fenced task JSON headers',
      pattern:
        /headers:\s*fencingJsonHeaders\(\s*taskCredential\s*,\s*lease\s*\)/u,
    }),
  ]),
  suspendExecution: Object.freeze([
    Object.freeze({
      label: 'fenced task JSON headers',
      pattern:
        /headers:\s*fencingJsonHeaders\(\s*taskCredential\s*,\s*lease\s*\)/u,
    }),
  ]),
  resumeExecution: Object.freeze([
    Object.freeze({
      label: 'task bearerJsonHeaders',
      pattern: /headers:\s*bearerJsonHeaders\(\s*taskCredential\s*\)/u,
    }),
  ]),
  streamExecution: Object.freeze([
    Object.freeze({
      label: 'optional lease fencing headers',
      pattern: /fencingHeaders\(\s*taskCredential\s*,\s*lease\s*\)/u,
    }),
    Object.freeze({
      label: 'unleased direct task bearer',
      pattern: /Authorization:\s*`Bearer \$\{taskCredential\}`/u,
    }),
  ]),
  getExecutionStatus: Object.freeze([
    Object.freeze({
      label: 'optional lease fencing headers',
      pattern: /fencingHeaders\(\s*taskCredential\s*,\s*lease\s*\)/u,
    }),
    Object.freeze({
      label: 'unleased direct task bearer',
      pattern: /Authorization:\s*`Bearer \$\{taskCredential\}`/u,
    }),
  ]),
  cancelExecution: Object.freeze([
    Object.freeze({
      label: 'optional lease fencing headers',
      pattern: /fencingHeaders\(\s*taskCredential\s*,\s*lease\s*\)/u,
    }),
    Object.freeze({
      label: 'unleased direct task bearer',
      pattern: /Authorization:\s*`Bearer \$\{taskCredential\}`/u,
    }),
  ]),
  cancelExecutionById: Object.freeze([
    Object.freeze({
      label: 'optional lease fencing headers',
      pattern: /fencingHeaders\(\s*taskCredential\s*,\s*lease\s*\)/u,
    }),
    Object.freeze({
      label: 'unleased direct task bearer',
      pattern: /Authorization:\s*`Bearer \$\{taskCredential\}`/u,
    }),
  ]),
  downloadArtifact: Object.freeze([
    Object.freeze({
      label: 'direct task bearer',
      pattern: /Authorization:\s*`Bearer \$\{taskCredential\}`/u,
    }),
  ]),
});
const EXPECTED_CLOUD_TASK_PUBLIC_ASYNC_METHODS = new Set([
  ...Object.keys(CLOUD_TASK_AUTHORIZATION_BINDINGS),
  'uploadSnapshot',
]);
const CLOUD_TASK_TRANSPORT_REFERENCE_PATTERN =
  /this(?:\.(?:fetchFn|requestJson)|\?\.(?:fetchFn|requestJson)|(?:\?\.)?\[\s*(['"`])(?:fetchFn|requestJson)\1\s*\])/u;
const CLOUD_TASK_TRANSPORT_CALL_PATTERN =
  /this(?:\.(?:fetchFn|requestJson)|\?\.(?:fetchFn|requestJson)|(?:\?\.)?\[\s*(['"`])(?:fetchFn|requestJson)\1\s*\])\s*(?:\?\.)?\s*\(/u;
const CLOUD_TASK_FETCH_FN_CALL_PATTERN =
  /this(?:\.fetchFn|\?\.fetchFn|(?:\?\.)?\[\s*(['"`])fetchFn\1\s*\])\s*(?:\?\.)?\s*\(/u;
const CLOUD_TASK_REQUEST_JSON_CALL_PATTERN =
  /this(?:\.requestJson|\?\.requestJson|(?:\?\.)?\[\s*(['"`])requestJson\1\s*\])\s*(?:\?\.)?\s*\(/u;
const CLOUD_TASK_TRANSPORT_TOKEN_PATTERN = /\b(?:fetchFn|requestJson)\b/u;

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

function parseJson(rootDirectory, path, errors) {
  try {
    return JSON.parse(read(rootDirectory, path));
  } catch (error) {
    errors.push(
      `${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkExactFields(value, expectedFields, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label}: expected an object`);
    return false;
  }
  const actualFields = Object.keys(value).sort();
  if (
    actualFields.length !== expectedFields.length ||
    actualFields.some((field, index) => field !== expectedFields[index])
  ) {
    errors.push(
      `${label}: fields must be exactly ${expectedFields.join(', ')}`,
    );
    return false;
  }
  return true;
}

function checkExactStringArray(actual, expected, label, errors) {
  if (
    !Array.isArray(actual) ||
    actual.some((value) => typeof value !== 'string')
  ) {
    errors.push(`${label}: expected an array of strings`);
    return [];
  }
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    errors.push(
      `${label}: must be exactly ${expected.join(', ') || '(empty)'}`,
    );
  }
  return actual;
}

function maskCommentsAndStrings(source) {
  const output = [...source];
  let state = 'code';
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (character === '\n' || character === '\r') {
        state = 'code';
      } else {
        output[index] = ' ';
      }
      continue;
    }
    if (state === 'block-comment') {
      output[index] =
        character === '\n' || character === '\r' ? character : ' ';
      if (character === '*' && next === '/') {
        output[index + 1] = ' ';
        index += 1;
        state = 'code';
      }
      continue;
    }
    if (state === 'string') {
      output[index] =
        character === '\n' || character === '\r' ? character : ' ';
      if (character === '\\') {
        if (index + 1 < source.length) {
          output[index + 1] = next === '\n' || next === '\r' ? next : ' ';
          index += 1;
        }
      } else if (character === quote) {
        state = 'code';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      state = 'line-comment';
      continue;
    }
    if (character === '/' && next === '*') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      state = 'block-comment';
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      output[index] = ' ';
      quote = character;
      state = 'string';
    }
  }
  return output.join('');
}

function maskCommentsPreservingStrings(source) {
  const output = [...source];
  let state = 'code';
  let quote = '';
  const templateExpressionDepths = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'line-comment') {
      if (character === '\n' || character === '\r') {
        state = 'code';
      } else {
        output[index] = ' ';
      }
      continue;
    }
    if (state === 'block-comment') {
      output[index] =
        character === '\n' || character === '\r' ? character : ' ';
      if (character === '*' && next === '/') {
        output[index + 1] = ' ';
        index += 1;
        state = 'code';
      }
      continue;
    }
    if (state === 'string') {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        state = 'code';
      }
      continue;
    }
    if (state === 'template') {
      if (character === '\\') {
        index += 1;
      } else if (character === '`') {
        state = 'code';
      } else if (character === '$' && next === '{') {
        templateExpressionDepths.push(1);
        index += 1;
        state = 'code';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      state = 'line-comment';
      continue;
    }
    if (character === '/' && next === '*') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      state = 'block-comment';
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      state = 'string';
      continue;
    }
    if (character === '`') {
      state = 'template';
      continue;
    }
    if (templateExpressionDepths.length > 0) {
      const last = templateExpressionDepths.length - 1;
      if (character === '{') {
        templateExpressionDepths[last] += 1;
      } else if (character === '}') {
        templateExpressionDepths[last] -= 1;
        if (templateExpressionDepths[last] === 0) {
          templateExpressionDepths.pop();
          state = 'template';
        }
      }
    }
  }
  return output.join('');
}

function skipLiteralArrayTrivia(source, startIndex) {
  let index = startIndex;
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && next === '/') {
      index += 2;
      while (
        index < source.length &&
        source[index] !== '\n' &&
        source[index] !== '\r'
      ) {
        index += 1;
      }
      continue;
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw new Error('unterminated block comment');
      index = end + 2;
      continue;
    }
    break;
  }
  return index;
}

function parseStringLiteral(source, startIndex) {
  const quote = source[startIndex];
  if (quote !== "'" && quote !== '"') {
    throw new Error('array entries must be string literals');
  }
  let value = '';
  let index = startIndex + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === quote) {
      return { nextIndex: index + 1, value };
    }
    if (character === '\n' || character === '\r') {
      throw new Error('unterminated string literal');
    }
    if (character !== '\\') {
      value += character;
      index += 1;
      continue;
    }
    const escaped = source[index + 1];
    if (escaped === undefined) throw new Error('unterminated escape sequence');
    const simpleEscapes = {
      0: '\0',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      "'": "'",
      '"': '"',
      '\\': '\\',
    };
    if (Object.hasOwn(simpleEscapes, escaped)) {
      value += simpleEscapes[escaped];
      index += 2;
      continue;
    }
    if (escaped === 'x') {
      const digits = source.slice(index + 2, index + 4);
      if (!/^[0-9A-Fa-f]{2}$/u.test(digits)) {
        throw new Error('invalid hexadecimal string escape');
      }
      value += String.fromCodePoint(Number.parseInt(digits, 16));
      index += 4;
      continue;
    }
    if (escaped === 'u') {
      const braced = source[index + 2] === '{';
      const end = braced ? source.indexOf('}', index + 3) : index + 6;
      if (end < 0) throw new Error('invalid Unicode string escape');
      const digits = braced
        ? source.slice(index + 3, end)
        : source.slice(index + 2, end);
      if (!/^[0-9A-Fa-f]{1,6}$/u.test(digits)) {
        throw new Error('invalid Unicode string escape');
      }
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint > 0x10ffff) {
        throw new Error('Unicode string escape is out of range');
      }
      value += String.fromCodePoint(codePoint);
      index = braced ? end + 1 : end;
      continue;
    }
    throw new Error(`unsupported string escape \\${escaped}`);
  }
  throw new Error('unterminated string literal');
}

function consumeLiteralArrayKeyword(source, startIndex, keyword) {
  const index = skipLiteralArrayTrivia(source, startIndex);
  if (
    source.slice(index, index + keyword.length) !== keyword ||
    /[A-Za-z0-9_$]/u.test(source[index + keyword.length] ?? '')
  ) {
    throw new Error(`expected ${keyword}`);
  }
  return index + keyword.length;
}

function parseLiteralStringArrayDeclaration(source) {
  const marker = 'export const featureGateIds';
  const declarationIndex = maskCommentsAndStrings(source).indexOf(marker);
  if (declarationIndex < 0) throw new Error('declaration not found');
  let index = skipLiteralArrayTrivia(source, declarationIndex + marker.length);
  if (source[index] !== '=') throw new Error('expected = after declaration');
  index = skipLiteralArrayTrivia(source, index + 1);
  if (source[index] !== '[') throw new Error('expected a literal array');
  index += 1;

  const values = [];
  let needsValue = true;
  while (index < source.length) {
    index = skipLiteralArrayTrivia(source, index);
    if (source[index] === ']') {
      index += 1;
      break;
    }
    if (!needsValue) {
      if (source[index] !== ',') {
        throw new Error('only string literals and commas are allowed');
      }
      index += 1;
      needsValue = true;
      continue;
    }
    if (source[index] === ',') {
      throw new Error('array holes are forbidden');
    }
    const literal = parseStringLiteral(source, index);
    values.push(literal.value);
    index = literal.nextIndex;
    needsValue = false;
  }
  if (index >= source.length) throw new Error('unterminated literal array');
  index = consumeLiteralArrayKeyword(source, index, 'as');
  index = consumeLiteralArrayKeyword(source, index, 'const');
  index = skipLiteralArrayTrivia(source, index);
  if (source[index] !== ';') throw new Error('expected ; after as const');
  return values;
}

function extractFeatureGateIds(rootDirectory, errors) {
  const source = read(rootDirectory, FEATURE_GATE_SOURCE);
  let ids;
  try {
    ids = parseLiteralStringArrayDeclaration(source);
  } catch (error) {
    errors.push(
      `${FEATURE_GATE_SOURCE}: featureGateIds must be a literal string array: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    errors.push(`${FEATURE_GATE_SOURCE}: featureGateIds contains duplicates`);
  }
  return ids;
}

function checkPublicManagedEntitlementContract(rootDirectory, errors) {
  const contract = parseJson(
    rootDirectory,
    PUBLIC_MANAGED_ENTITLEMENT_CONTRACT,
    errors,
  );
  if (
    !checkExactFields(
      contract,
      PUBLIC_MANAGED_ENTITLEMENT_CONTRACT_FIELDS,
      PUBLIC_MANAGED_ENTITLEMENT_CONTRACT,
      errors,
    )
  ) {
    return;
  }
  for (const [field, expected] of Object.entries({
    clientPaywall: 'forbidden',
    contractId: 'clodex-public-managed-service-entitlement',
    contractVersion: 1,
    decisionAuthority: 'server-authoritative',
    localGrant: 'forbidden',
  })) {
    if (contract[field] !== expected) {
      errors.push(
        `${PUBLIC_MANAGED_ENTITLEMENT_CONTRACT}: ${field} must be ${expected}`,
      );
    }
  }
  if (
    !Array.isArray(contract.denialHttpStatuses) ||
    contract.denialHttpStatuses.length !== 2 ||
    contract.denialHttpStatuses[0] !== 401 ||
    contract.denialHttpStatuses[1] !== 403
  ) {
    errors.push(
      `${PUBLIC_MANAGED_ENTITLEMENT_CONTRACT}: denialHttpStatuses must be exactly 401, 403`,
    );
  }
}

function visitBackendEndpointSources(
  rootDirectory,
  relativeDirectory,
  sourceFiles,
  errors,
) {
  const absoluteDirectory = join(rootDirectory, relativeDirectory);
  if (!existsSync(absoluteDirectory)) return;
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      errors.push(
        `${relativePath}: backend endpoint scan does not permit symbolic links`,
      );
      continue;
    }
    if (entry.isDirectory()) {
      visitBackendEndpointSources(
        rootDirectory,
        relativePath,
        sourceFiles,
        errors,
      );
      continue;
    }
    if (
      !entry.isFile() ||
      /(?:^|\/)[^/]+\.(?:spec|test|stories)\.[^/]+$/u.test(relativePath) ||
      !/\.[cm]?[jt]sx?$/u.test(relativePath)
    ) {
      continue;
    }
    sourceFiles.push(relativePath);
  }
}

function checkBackendEndpointInventory(
  rootDirectory,
  managedEndpointImplementationPaths,
  errors,
) {
  const sourceFiles = [];
  for (const scanRoot of RUNTIME_ENDPOINT_SCAN_ROOTS) {
    visitBackendEndpointSources(rootDirectory, scanRoot, sourceFiles, errors);
  }
  for (const path of BACKEND_BUILD_ENDPOINT_SCAN_FILES) {
    if (existsSync(join(rootDirectory, path))) sourceFiles.push(path);
  }
  const allowedEndpointKeys = new Set([
    ...CANONICAL_PUBLIC_BACKEND_ENDPOINT_KEYS,
    ...managedEndpointImplementationPaths.keys(),
  ]);
  for (const path of [...new Set(sourceFiles)].sort()) {
    const source = maskCommentsPreservingStrings(read(rootDirectory, path));
    const endpointEnvironmentKeys = new Set(
      [
        ...source.matchAll(
          /\b((?:VITE_)?CLODEX_(?:ORIGIN|[A-Z0-9_]+_(?:URL|ENDPOINT)))\b/gu,
        ),
      ].map((match) => match[1]),
    );
    for (const endpointEnvironmentKey of endpointEnvironmentKeys) {
      if (!allowedEndpointKeys.has(endpointEnvironmentKey)) {
        errors.push(
          `${path}: unknown CLODEx endpoint environment usage ${endpointEnvironmentKey}; classify it as canonical public or declare it in the exact managed connector inventory`,
        );
        continue;
      }
      const allowedPaths = Object.hasOwn(
        CANONICAL_PUBLIC_BACKEND_ENDPOINT_PATHS,
        endpointEnvironmentKey,
      )
        ? CANONICAL_PUBLIC_BACKEND_ENDPOINT_PATHS[endpointEnvironmentKey]
        : managedEndpointImplementationPaths.get(endpointEnvironmentKey);
      if (!allowedPaths?.includes(path)) {
        errors.push(
          `${path}: endpoint environment usage ${endpointEnvironmentKey} is outside its exact public client implementation path inventory`,
        );
      }
    }
    const hardcodedClodexHosts = new Set(
      [
        ...source.matchAll(
          /(?<![A-Za-z0-9.-])((?:[A-Za-z0-9-]+\.)*clodex\.xyz)(?![A-Za-z0-9.-])/giu,
        ),
      ].map((match) => match[1].toLowerCase()),
    );
    for (const hostname of hardcodedClodexHosts) {
      if (!CANONICAL_CLODEX_HOSTS.has(hostname)) {
        errors.push(
          `${path}: unknown hardcoded CLODEx service hostname ${hostname}; use a canonical public endpoint or an inventoried managed connector`,
        );
      }
    }
  }
}

function checkCommunityCapabilityBoundaryManifest(rootDirectory, errors) {
  const sourceFeatureGateIds = extractFeatureGateIds(rootDirectory, errors);
  const sourceFeatureGateIdSet = new Set(sourceFeatureGateIds);
  const manifest = parseJson(
    rootDirectory,
    COMMUNITY_CAPABILITY_BOUNDARY_MANIFEST,
    errors,
  );
  if (
    !checkExactFields(
      manifest,
      CAPABILITY_MANIFEST_ROOT_FIELDS,
      COMMUNITY_CAPABILITY_BOUNDARY_MANIFEST,
      errors,
    )
  ) {
    return;
  }
  if (manifest.schemaVersion !== 1) {
    errors.push(
      `${COMMUNITY_CAPABILITY_BOUNDARY_MANIFEST}: schemaVersion must be 1`,
    );
  }

  const featureGates = Array.isArray(manifest.featureGates)
    ? manifest.featureGates
    : [];
  if (!Array.isArray(manifest.featureGates)) {
    errors.push(
      `${COMMUNITY_CAPABILITY_BOUNDARY_MANIFEST}: featureGates must be an array`,
    );
  }
  const classificationByFeatureGateId = new Map();
  for (const [index, featureGate] of featureGates.entries()) {
    const label = `${COMMUNITY_CAPABILITY_BOUNDARY_MANIFEST}: featureGates[${index}]`;
    if (
      !checkExactFields(
        featureGate,
        CAPABILITY_MANIFEST_FEATURE_GATE_FIELDS,
        label,
        errors,
      )
    ) {
      continue;
    }
    if (
      typeof featureGate.featureGateId !== 'string' ||
      featureGate.featureGateId.length === 0
    ) {
      errors.push(`${label}: featureGateId must be a non-empty string`);
      continue;
    }
    if (!CAPABILITY_CLASSIFICATIONS.has(featureGate.classification)) {
      errors.push(
        `${label}: classification must be community-local or managed-connector`,
      );
      continue;
    }
    if (classificationByFeatureGateId.has(featureGate.featureGateId)) {
      errors.push(
        `${COMMUNITY_CAPABILITY_BOUNDARY_MANIFEST}: duplicate featureGateId ${featureGate.featureGateId}`,
      );
      continue;
    }
    classificationByFeatureGateId.set(
      featureGate.featureGateId,
      featureGate.classification,
    );
  }

  for (const featureGateId of sourceFeatureGateIds) {
    if (!classificationByFeatureGateId.has(featureGateId)) {
      errors.push(
        `${COMMUNITY_CAPABILITY_BOUNDARY_MANIFEST}: missing featureGateId ${featureGateId}`,
      );
      continue;
    }
    const expectedClassification = MANAGED_FEATURE_GATE_IDS.has(featureGateId)
      ? 'managed-connector'
      : 'community-local';
    const actualClassification =
      classificationByFeatureGateId.get(featureGateId);
    if (actualClassification !== expectedClassification) {
      errors.push(
        `${COMMUNITY_CAPABILITY_BOUNDARY_MANIFEST}: featureGateId ${featureGateId} must be classified ${expectedClassification}`,
      );
    }
  }
  for (const featureGateId of classificationByFeatureGateId.keys()) {
    if (!sourceFeatureGateIdSet.has(featureGateId)) {
      errors.push(
        `${COMMUNITY_CAPABILITY_BOUNDARY_MANIFEST}: extra featureGateId ${featureGateId}`,
      );
    }
  }

  const managedConnectors = Array.isArray(manifest.managedConnectors)
    ? manifest.managedConnectors
    : [];
  if (!Array.isArray(manifest.managedConnectors)) {
    errors.push(
      `${COMMUNITY_CAPABILITY_BOUNDARY_MANIFEST}: managedConnectors must be an array`,
    );
  }
  const connectorById = new Map();
  const connectorFeatureGateIds = new Set();
  const managedEndpointImplementationPaths = new Map();
  for (const [index, connector] of managedConnectors.entries()) {
    const label = `${COMMUNITY_CAPABILITY_BOUNDARY_MANIFEST}: managedConnectors[${index}]`;
    if (
      !checkExactFields(
        connector,
        CAPABILITY_MANIFEST_CONNECTOR_FIELDS,
        label,
        errors,
      )
    ) {
      continue;
    }
    if (typeof connector.id !== 'string' || connector.id.length === 0) {
      errors.push(`${label}: id must be a non-empty string`);
      continue;
    }
    if (connectorById.has(connector.id)) {
      errors.push(
        `${COMMUNITY_CAPABILITY_BOUNDARY_MANIFEST}: duplicate managed connector ${connector.id}`,
      );
      continue;
    }
    connectorById.set(connector.id, connector);

    for (const [field, expected] of Object.entries(
      MANAGED_CONNECTOR_CONTRACT,
    )) {
      if (connector[field] !== expected) {
        errors.push(`${label}: ${field} must be ${expected}`);
      }
    }

    const expectedConnector = EXPECTED_MANAGED_CONNECTORS[connector.id];
    const featureGateIds = checkExactStringArray(
      connector.featureGateIds,
      expectedConnector?.featureGateIds ?? [],
      `${label}.featureGateIds`,
      errors,
    );
    const endpointEnvironmentKeys = checkExactStringArray(
      connector.endpointEnvironmentKeys,
      expectedConnector?.endpointEnvironmentKeys ?? [],
      `${label}.endpointEnvironmentKeys`,
      errors,
    );
    const implementationPaths = checkExactStringArray(
      connector.implementationPaths,
      expectedConnector?.implementationPaths ?? [],
      `${label}.implementationPaths`,
      errors,
    );
    const managedConfigurationKeys = checkExactStringArray(
      connector.managedConfigurationKeys,
      expectedConnector?.managedConfigurationKeys ?? [],
      `${label}.managedConfigurationKeys`,
      errors,
    );

    for (const featureGateId of featureGateIds) {
      connectorFeatureGateIds.add(featureGateId);
      if (!sourceFeatureGateIdSet.has(featureGateId)) {
        errors.push(
          `${label}: connector featureGateId ${featureGateId} does not exist`,
        );
      } else if (
        classificationByFeatureGateId.get(featureGateId) !== 'managed-connector'
      ) {
        errors.push(
          `${label}: connector featureGateId ${featureGateId} is not classified managed-connector`,
        );
      }
    }
    for (const endpointEnvironmentKey of endpointEnvironmentKeys) {
      if (managedEndpointImplementationPaths.has(endpointEnvironmentKey)) {
        errors.push(
          `${label}: endpoint environment key ${endpointEnvironmentKey} is owned by more than one managed connector`,
        );
      } else {
        managedEndpointImplementationPaths.set(
          endpointEnvironmentKey,
          implementationPaths,
        );
      }
      if (
        !COMMUNITY_FORBIDDEN_BACKEND_ENVIRONMENT_KEYS.includes(
          endpointEnvironmentKey,
        )
      ) {
        errors.push(
          `${label}: endpoint environment key ${endpointEnvironmentKey} is not forbidden in Community builds`,
        );
      }
    }
    for (const managedConfigurationKey of managedConfigurationKeys) {
      if (
        !COMMUNITY_FORBIDDEN_BACKEND_ENVIRONMENT_KEYS.includes(
          managedConfigurationKey,
        )
      ) {
        errors.push(
          `${label}: managed configuration key ${managedConfigurationKey} is not forbidden in Community builds`,
        );
      }
    }
    for (const implementationPath of implementationPaths) {
      if (
        implementationPath.startsWith('/') ||
        implementationPath.includes('..') ||
        !existsSync(join(rootDirectory, implementationPath))
      ) {
        errors.push(
          `${label}: implementation path must be an existing repository-relative file: ${implementationPath}`,
        );
      }
    }
  }

  const expectedConnectorIds = Object.keys(EXPECTED_MANAGED_CONNECTORS);
  for (const connectorId of expectedConnectorIds) {
    if (!connectorById.has(connectorId)) {
      errors.push(
        `${COMMUNITY_CAPABILITY_BOUNDARY_MANIFEST}: missing managed connector ${connectorId}`,
      );
    }
  }
  for (const connectorId of connectorById.keys()) {
    if (!Object.hasOwn(EXPECTED_MANAGED_CONNECTORS, connectorId)) {
      errors.push(
        `${COMMUNITY_CAPABILITY_BOUNDARY_MANIFEST}: extra managed connector ${connectorId}`,
      );
    }
  }
  for (const featureGateId of MANAGED_FEATURE_GATE_IDS) {
    if (!connectorFeatureGateIds.has(featureGateId)) {
      errors.push(
        `${COMMUNITY_CAPABILITY_BOUNDARY_MANIFEST}: managed featureGateId ${featureGateId} is not covered by a managed connector`,
      );
    }
  }
  checkBackendEndpointInventory(
    rootDirectory,
    managedEndpointImplementationPaths,
    errors,
  );
}

function extractClassMethods(source, className) {
  const structuralSource = maskCommentsAndStrings(source);
  const classMarker = `class ${className}`;
  const classStart = structuralSource.indexOf(classMarker);
  if (classStart < 0) return { classSource: '', methods: new Map() };
  const classOpen = structuralSource.indexOf(
    '{',
    classStart + classMarker.length,
  );
  if (classOpen < 0) return { classSource: '', methods: new Map() };

  let classClose = -1;
  let depth = 1;
  const depthAt = new Uint16Array(structuralSource.length - classOpen);
  for (let index = classOpen + 1; index < structuralSource.length; index += 1) {
    depthAt[index - classOpen] = depth;
    if (structuralSource[index] === '{') {
      depth += 1;
    } else if (structuralSource[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        classClose = index;
        break;
      }
    }
  }
  if (classClose < 0) return { classSource: '', methods: new Map() };

  const declarationPattern =
    /^[ \t]*(?:(?:public|private|protected|static|abstract|override|declare|async|get|set)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>{}\n]*>)?\s*\(/gmu;
  declarationPattern.lastIndex = classOpen + 1;
  const declarations = [];
  for (const declaration of structuralSource.matchAll(declarationPattern)) {
    if (declaration.index >= classClose) break;
    if (depthAt[declaration.index - classOpen] !== 1) continue;
    declarations.push(declaration);
  }
  const methods = new Map();
  for (const [index, declaration] of declarations.entries()) {
    const start = declaration.index;
    const end = declarations[index + 1]?.index ?? classClose;
    methods.set(declaration[1], source.slice(start, end));
  }
  return {
    classSource: source.slice(classOpen + 1, classClose),
    methods,
  };
}

function extractNamedFunctionSource(source, functionName) {
  const marker = `function ${functionName}(`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const nextFunction = source.indexOf('\nfunction ', start + marker.length);
  return source.slice(start, nextFunction < 0 ? source.length : nextFunction);
}

function countPattern(source, pattern) {
  const flags = pattern.flags.includes('g')
    ? pattern.flags
    : `${pattern.flags}g`;
  return [...source.matchAll(new RegExp(pattern.source, flags))].length;
}

function checkManagedConnectorSourceBindings(rootDirectory, errors) {
  const cloudControlPlanePath =
    'apps/browser/src/backend/agent-host/cloud-task-control-plane.ts';
  const cloudControlPlane = read(rootDirectory, cloudControlPlanePath);
  const {
    classSource: cloudControlPlaneClass,
    methods: cloudControlPlaneMethods,
  } = extractClassMethods(cloudControlPlane, 'HttpCloudTaskControlPlane');
  if (!cloudControlPlaneClass) {
    errors.push(
      `${cloudControlPlanePath}: HttpCloudTaskControlPlane is missing`,
    );
  }
  for (const methodName of EXPECTED_CLOUD_TASK_PUBLIC_ASYNC_METHODS) {
    if (!cloudControlPlaneMethods.has(methodName)) {
      errors.push(
        `${cloudControlPlanePath}: reviewed public Cloud Task operation ${methodName} is missing`,
      );
    }
  }
  let methodTransportCallCount = 0;
  let methodTransportReferenceCount = 0;
  let methodTransportTokenCount = 0;
  for (const [methodName, methodSource] of cloudControlPlaneMethods) {
    const structuralSource = maskCommentsAndStrings(methodSource);
    const transportSource = maskCommentsPreservingStrings(methodSource);
    const reviewedTransportCallCount = countPattern(
      transportSource,
      CLOUD_TASK_TRANSPORT_CALL_PATTERN,
    );
    const reviewedTransportReferenceCount = countPattern(
      transportSource,
      CLOUD_TASK_TRANSPORT_REFERENCE_PATTERN,
    );
    const reviewedTransportTokenCount = countPattern(
      transportSource,
      CLOUD_TASK_TRANSPORT_TOKEN_PATTERN,
    );
    const directFetchCallCount = countPattern(
      structuralSource,
      /\bfetch\s*\(/u,
    );
    methodTransportCallCount +=
      reviewedTransportCallCount + directFetchCallCount;
    methodTransportReferenceCount += reviewedTransportReferenceCount;
    methodTransportTokenCount += reviewedTransportTokenCount;
    if (EXPECTED_CLOUD_TASK_PUBLIC_ASYNC_METHODS.has(methodName)) {
      if (
        reviewedTransportCallCount === 1 &&
        reviewedTransportReferenceCount === 1 &&
        reviewedTransportTokenCount === 1 &&
        directFetchCallCount === 0
      ) {
        continue;
      }
      errors.push(
        `${cloudControlPlanePath}: ${methodName} must contain exactly one reviewed control-plane transport call`,
      );
      continue;
    }
    if (methodName === 'requestJson') {
      if (
        countPattern(transportSource, CLOUD_TASK_FETCH_FN_CALL_PATTERN) !== 1 ||
        countPattern(transportSource, CLOUD_TASK_REQUEST_JSON_CALL_PATTERN) !==
          0 ||
        reviewedTransportReferenceCount !== 1 ||
        reviewedTransportTokenCount !== 2 ||
        directFetchCallCount !== 0
      ) {
        errors.push(
          `${cloudControlPlanePath}: requestJson must remain the single reviewed internal fetch wrapper`,
        );
      }
      continue;
    }
    if (methodName === 'constructor') {
      if (
        reviewedTransportCallCount !== 0 ||
        directFetchCallCount !== 0 ||
        reviewedTransportReferenceCount !== 1 ||
        reviewedTransportTokenCount !== 1 ||
        !/this\.fetchFn\s*=\s*options\.fetch\s*\?\?\s*fetch/u.test(
          structuralSource,
        )
      ) {
        errors.push(
          `${cloudControlPlanePath}: constructor must only bind the injected fetch implementation`,
        );
      }
      continue;
    }
    if (
      reviewedTransportReferenceCount > 0 ||
      reviewedTransportCallCount > 0 ||
      reviewedTransportTokenCount > 0 ||
      directFetchCallCount > 0
    ) {
      errors.push(
        `${cloudControlPlanePath}: unreviewed Cloud Task method ${methodName} is outside the authenticated transport inventory`,
      );
    }
  }
  const cloudControlPlaneClassStructure = maskCommentsAndStrings(
    cloudControlPlaneClass,
  );
  const cloudControlPlaneClassTransport = maskCommentsPreservingStrings(
    cloudControlPlaneClass,
  );
  const classTransportCallCount =
    countPattern(
      cloudControlPlaneClassTransport,
      CLOUD_TASK_TRANSPORT_CALL_PATTERN,
    ) + countPattern(cloudControlPlaneClassStructure, /\bfetch\s*\(/u);
  if (classTransportCallCount !== methodTransportCallCount) {
    errors.push(
      `${cloudControlPlanePath}: every class-level transport call must belong to a reviewed method inventory entry`,
    );
  }
  const classTransportReferenceCount = countPattern(
    cloudControlPlaneClassTransport,
    CLOUD_TASK_TRANSPORT_REFERENCE_PATTERN,
  );
  if (classTransportReferenceCount !== methodTransportReferenceCount) {
    errors.push(
      `${cloudControlPlanePath}: every class-level transport reference must belong to a reviewed method inventory entry`,
    );
  }
  const classTransportTokenCount = countPattern(
    cloudControlPlaneClassTransport,
    CLOUD_TASK_TRANSPORT_TOKEN_PATTERN,
  );
  if (
    classTransportTokenCount !== methodTransportTokenCount + 1 ||
    !/private\s+readonly\s+fetchFn\s*:\s*typeof\s+fetch\s*;/u.test(
      cloudControlPlaneClassStructure,
    )
  ) {
    errors.push(
      `${cloudControlPlanePath}: transport member declarations and aliases must remain exactly inventoried`,
    );
  }
  for (const [methodName, bindings] of Object.entries(
    CLOUD_TASK_AUTHORIZATION_BINDINGS,
  )) {
    const methodSource = cloudControlPlaneMethods.get(methodName);
    if (!methodSource) continue;
    const structuralSource = maskCommentsPreservingStrings(methodSource);
    for (const binding of bindings) {
      if (countPattern(structuralSource, binding.pattern) !== 1) {
        errors.push(
          `${cloudControlPlanePath}: ${methodName} must contain exactly one reviewed ${binding.label} authorization binding`,
        );
      }
    }
  }

  const uploadSnapshot = cloudControlPlaneMethods.get('uploadSnapshot');
  if (
    uploadSnapshot &&
    (!/sanitizeUploadHeaders\(\s*session\.uploadHeaders\s*\)/u.test(
      maskCommentsAndStrings(uploadSnapshot),
    ) ||
      /\bAuthorization\b|bearerJsonHeaders|fencingHeaders|fencingJsonHeaders/iu.test(
        maskCommentsPreservingStrings(uploadSnapshot),
      ))
  ) {
    errors.push(
      `${cloudControlPlanePath}: uploadSnapshot must remain a sanitized presigned-upload exception without control-plane bearer authorization`,
    );
  }

  const tokenTemplatePlaceholder = `\${token}`;
  const helperSources = {
    bearerJsonHeaders: extractNamedFunctionSource(
      cloudControlPlane,
      'bearerJsonHeaders',
    ),
    fencingHeaders: extractNamedFunctionSource(
      cloudControlPlane,
      'fencingHeaders',
    ),
    fencingJsonHeaders: extractNamedFunctionSource(
      cloudControlPlane,
      'fencingJsonHeaders',
    ),
  };
  const bearerJsonHeaders = helperSources.bearerJsonHeaders
    ? maskCommentsPreservingStrings(helperSources.bearerJsonHeaders)
    : null;
  const fencingHeaders = helperSources.fencingHeaders
    ? maskCommentsPreservingStrings(helperSources.fencingHeaders)
    : null;
  if (
    !bearerJsonHeaders?.includes(
      `function bearerJsonHeaders(token: string): Record<string, string> {\n  if (!token?.trim()) throw new Error('Cloud task bearer token is unavailable');\n  return {\n    Authorization: \`Bearer ${tokenTemplatePlaceholder}\``,
    ) ||
    !fencingHeaders?.includes(
      `function fencingHeaders(\n  token: string,\n  lease: CloudTaskExecutionLease,\n): Record<string, string> {\n  if (!token?.trim()) throw new Error('Cloud task bearer token is unavailable');\n  return {\n    Authorization: \`Bearer ${tokenTemplatePlaceholder}\``,
    )
  ) {
    errors.push(
      `${cloudControlPlanePath}: Cloud Task remote operations must construct bearer authorization in both header helpers`,
    );
  }
  if (
    !helperSources.fencingJsonHeaders ||
    countPattern(
      maskCommentsPreservingStrings(helperSources.fencingJsonHeaders),
      /\.\.\.fencingHeaders\(\s*token\s*,\s*lease\s*\)/u,
    ) !== 1
  ) {
    errors.push(
      `${cloudControlPlanePath}: fencingJsonHeaders must compose the reviewed bearer fencing headers`,
    );
  }
  if (!/if\s*\(\s*!response\.ok/u.test(cloudControlPlane)) {
    errors.push(
      `${cloudControlPlanePath}: Cloud Task transport must reject non-ok responses`,
    );
  }

  const cloudStartupPath =
    'apps/browser/src/backend/startup/phases/cloud-task-runtime.ts';
  const cloudStartup = read(rootDirectory, cloudStartupPath);
  for (const [label, pattern] of [
    [
      'kill switch',
      /if\s*\(input\.killSwitchActive\)\s*\{[\s\S]*?return null;/u,
    ],
    [
      'missing endpoint',
      /const baseUrl\s*=\s*input\.baseUrl\?\.trim\(\);[\s\S]*?if\s*\(\s*!baseUrl\s*\)\s*\{[\s\S]*?return null;/u,
    ],
    [
      'control-plane construction',
      /new HttpCloudTaskControlPlane\(\{ baseUrl \}\)/u,
    ],
  ]) {
    if (!pattern.test(cloudStartup)) {
      errors.push(
        `${cloudStartupPath}: Cloud Task startup must remain fail closed for ${label}`,
      );
    }
  }

  const mainPath = 'apps/browser/src/backend/main.ts';
  const main = read(rootDirectory, mainPath);
  const sessionBlockStart = main.indexOf('const sessionSharingBaseUrl');
  const sessionBlockEnd = main.indexOf(
    'const sessionContinuityService',
    sessionBlockStart,
  );
  if (sessionBlockStart < 0 || sessionBlockEnd < 0) {
    errors.push(`${mainPath}: session-sharing connector block is missing`);
  } else {
    const sessionBlock = main.slice(sessionBlockStart, sessionBlockEnd);
    const bearerHeaderCount = [
      ...sessionBlock.matchAll(
        /Authorization:\s*`Bearer \$\{authService\.accessToken\}`/gu,
      ),
    ].length;
    const nonOkCount = [...sessionBlock.matchAll(/if\s*\(\s*!response\.ok/gu)]
      .length;
    if (bearerHeaderCount !== 2) {
      errors.push(
        `${mainPath}: both session-sharing operations must use account bearer authorization`,
      );
    }
    if (nonOkCount !== 2) {
      errors.push(
        `${mainPath}: both session-sharing operations must deny non-ok server responses`,
      );
    }
    if (
      !/const sessionSharingBaseUrl\s*=\s*__APP_MANAGED_SERVICES_ENABLED__\s*\?\s*process\.env\.CLODEX_SESSION_SHARING_URL\?\.trim\(\)\s*:\s*undefined/u.test(
        sessionBlock,
      ) ||
      !/new URL\(sessionSharingBaseUrl\)\.protocol === 'https:'/u.test(
        sessionBlock,
      )
    ) {
      errors.push(
        `${mainPath}: session-sharing endpoint must require the managed build gate and HTTPS`,
      );
    }
  }

  const sessionServicePath =
    'apps/browser/src/backend/services/session-continuity/index.ts';
  const sessionService = read(rootDirectory, sessionServicePath);
  if (
    !/private assertEnabled\(\): void\s*\{\s*if \(!this\.options\.isFeatureEnabled\(\)\)/u.test(
      sessionService,
    ) ||
    !/if \(!adapter\?\.available\(\)\)\s*\{\s*throw new Error\('Session sharing adapter is unavailable'\)/u.test(
      sessionService,
    )
  ) {
    errors.push(
      `${sessionServicePath}: session continuity must fail closed when its feature or sharing adapter is unavailable`,
    );
  }

  const hostedMcpPath =
    'apps/browser/src/backend/services/toolbox/services/clodex-mcp/index.ts';
  const hostedMcp = read(rootDirectory, hostedMcpPath);
  if (
    !/const token\s*=\s*await this\.authService\.ensureModelAccessToken\(\);[\s\S]*?if \(!token\)/u.test(
      hostedMcp,
    ) ||
    !/new SSEClientTransport\(new URL\(this\.gatewayUrl\),\s*\{[\s\S]*?Authorization:\s*`Bearer \$\{token\}`/u.test(
      hostedMcp,
    )
  ) {
    errors.push(
      `${hostedMcpPath}: hosted MCP transport must require a model access token and bind it as bearer authorization`,
    );
  }
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
      path: 'docs/governance/COMMUNITY_CAPABILITY_BOUNDARY.md',
      requiredText: [
        'normative data-only inventory',
        'value-bearing implementation is Community-available',
        'Community-available/public-client boundary, not an offline-only',
        'user-controlled remote services',
        'server-authoritative entitlement decision',
        'local entitlement grant is forbidden',
        'HTTP 401',
        'client paywall is forbidden',
        'Hosted MCP intentionally has no feature gate',
        'CLODEX_CLOUD_TASKS_RESIDENCY',
        'does not authorize or implement a paid service',
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

  checkPublicManagedEntitlementContract(rootDirectory, errors);
  checkCommunityCapabilityBoundaryManifest(rootDirectory, errors);
  checkManagedConnectorSourceBindings(rootDirectory, errors);

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
