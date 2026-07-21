import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBedrockProvider,
  type CreateBedrockProviderOptions,
} from './bedrock-provider';

const AWS_ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_EC2_METADATA_DISABLED',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_SDK_LOAD_CONFIG',
] as const;

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: string;
}

const originalAwsEnvironment = new Map<string, string | undefined>();
const temporaryDirectories: string[] = [];

beforeEach(() => {
  originalAwsEnvironment.clear();
  for (const key of AWS_ENV_KEYS) {
    originalAwsEnvironment.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.AWS_EC2_METADATA_DISABLED = 'true';
  process.env.AWS_SDK_LOAD_CONFIG = '1';
});

afterEach(() => {
  for (const key of AWS_ENV_KEYS) {
    const value = originalAwsEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createAwsFiles(config: string, credentials: string) {
  const directory = mkdtempSync(join(tmpdir(), 'clodex-bedrock-'));
  temporaryDirectories.push(directory);
  const configFilepath = join(directory, 'config');
  const credentialsFilepath = join(directory, 'credentials');
  writeFileSync(configFilepath, config, { mode: 0o600 });
  writeFileSync(credentialsFilepath, credentials, { mode: 0o600 });
  return { configFilepath, credentialsFilepath };
}

function createOfflineFetch(
  requests: CapturedRequest[],
): NonNullable<CreateBedrockProviderOptions['fetch']> {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const headers = new Headers(request?.headers);
    new Headers(init?.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    const body =
      typeof init?.body === 'string'
        ? init.body
        : request
          ? await request.clone().text()
          : '';
    requests.push({
      url:
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      headers,
      body,
    });
    return new Response(
      JSON.stringify({
        output: {
          message: { role: 'assistant', content: [{ text: 'ok' }] },
        },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

async function invokeSmoke(
  options: CreateBedrockProviderOptions,
): Promise<CapturedRequest> {
  const requests: CapturedRequest[] = [];
  const provider = createBedrockProvider({
    ...options,
    baseURL: 'https://bedrock.offline.test',
    fetch: createOfflineFetch(requests),
  });
  await provider('anthropic.claude-3-haiku-20240307-v1:0').doGenerate({
    prompt: [
      { role: 'user', content: [{ type: 'text', text: 'offline smoke' }] },
    ],
  });
  expect(requests).toHaveLength(1);
  return requests[0] as CapturedRequest;
}

function expectSigV4(
  request: CapturedRequest,
  accessKeyId: string,
  region: string,
) {
  expect(request.url).toBe(
    'https://bedrock.offline.test/model/' +
      'anthropic.claude-3-haiku-20240307-v1%3A0/converse',
  );
  expect(request.headers.get('authorization')).toMatch(
    new RegExp(
      `Credential=${accessKeyId}/\\d{8}/${region}/bedrock/aws4_request`,
    ),
  );
  expect(request.headers.get('x-amz-date')).toMatch(/^\d{8}T\d{6}Z$/u);
  expect(JSON.parse(request.body)).toMatchObject({
    messages: [{ role: 'user', content: [{ text: 'offline smoke' }] }],
  });
}

describe('createBedrockProvider runtime smoke', () => {
  it('uses the trimmed explicit profile instead of conflicting AWS_PROFILE', async () => {
    const files = createAwsFiles(
      [
        '[profile selected]',
        'region = eu-west-1',
        '[profile conflicting]',
        'region = ap-south-1',
      ].join('\n'),
      [
        '[selected]',
        'aws_access_key_id = SELECTEDKEY',
        'aws_secret_access_key = selected-secret',
        'aws_session_token = selected-session',
        '[conflicting]',
        'aws_access_key_id = CONFLICTINGKEY',
        'aws_secret_access_key = conflicting-secret',
      ].join('\n'),
    );
    process.env.AWS_PROFILE = 'conflicting';
    process.env.AWS_REGION = 'us-west-2';
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'must-not-replace-sigv4';

    const request = await invokeSmoke({
      authMode: 'profile',
      profileName: '  selected  ',
      ...files,
    });

    expectSigV4(request, 'SELECTEDKEY', 'eu-west-1');
    expect(request.headers.get('x-amz-security-token')).toBe(
      'selected-session',
    );
  });

  it('lets an explicit region override win over the profile region', async () => {
    const files = createAwsFiles(
      '[profile selected]\nregion = eu-west-1\n',
      [
        '[selected]',
        'aws_access_key_id = OVERRIDEKEY',
        'aws_secret_access_key = override-secret',
      ].join('\n'),
    );

    const request = await invokeSmoke({
      authMode: 'profile',
      profileName: 'selected',
      regionOverride: '  ca-central-1  ',
      ...files,
    });

    expectSigV4(request, 'OVERRIDEKEY', 'ca-central-1');
  });

  it('uses default-chain environment credentials with AWS_DEFAULT_REGION', async () => {
    const files = createAwsFiles('', '');
    process.env.AWS_ACCESS_KEY_ID = 'ENVIRONMENTKEY';
    process.env.AWS_SECRET_ACCESS_KEY = 'environment-secret';
    process.env.AWS_SESSION_TOKEN = 'environment-session';
    process.env.AWS_DEFAULT_REGION = 'us-west-1';

    const request = await invokeSmoke({
      authMode: 'default-chain',
      ...files,
    });

    expectSigV4(request, 'ENVIRONMENTKEY', 'us-west-1');
    expect(request.headers.get('x-amz-security-token')).toBe(
      'environment-session',
    );
  });

  it('falls back to the selected shared profile in default-chain mode', async () => {
    const files = createAwsFiles(
      '[profile shared]\nregion = ap-southeast-2\n',
      [
        '[shared]',
        'aws_access_key_id = SHAREDKEY',
        'aws_secret_access_key = shared-secret',
        'aws_session_token = shared-session',
      ].join('\n'),
    );
    process.env.AWS_PROFILE = 'shared';

    const request = await invokeSmoke({
      authMode: 'default-chain',
      ...files,
    });

    expectSigV4(request, 'SHAREDKEY', 'ap-southeast-2');
    expect(request.headers.get('x-amz-security-token')).toBe('shared-session');
  });

  it('fails closed for a missing profile or region before fetch', () => {
    const files = createAwsFiles('', '');
    const fetch = vi.fn(createOfflineFetch([]));

    expect(() =>
      createBedrockProvider({
        authMode: 'profile',
        profileName: 'missing',
        ...files,
        baseURL: 'https://bedrock.offline.test',
        fetch,
      }),
    ).toThrow(/profile "missing" was not found/u);
    expect(() =>
      createBedrockProvider({
        authMode: 'default-chain',
        ...files,
        baseURL: 'https://bedrock.offline.test',
        fetch,
      }),
    ).toThrow(/region resolution failed/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed for missing default-chain credentials before fetch', async () => {
    const files = createAwsFiles('[default]\nregion = us-east-2\n', '');
    const fetch = vi.fn(createOfflineFetch([]));
    const provider = createBedrockProvider({
      authMode: 'default-chain',
      ...files,
      baseURL: 'https://bedrock.offline.test',
      fetch,
    });

    await expect(
      provider('anthropic.claude-3-haiku-20240307-v1:0').doGenerate({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'must fail' }] },
        ],
      }),
    ).rejects.toThrow(/credential provider failed/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps access-keys static and preserves the us-east-1 fallback', async () => {
    const files = createAwsFiles(
      '[profile conflicting]\nregion = ap-northeast-1\n',
      [
        '[conflicting]',
        'aws_access_key_id = CONFLICTINGKEY',
        'aws_secret_access_key = conflicting-secret',
      ].join('\n'),
    );
    process.env.AWS_ACCESS_KEY_ID = 'ENVIRONMENTKEY';
    process.env.AWS_SECRET_ACCESS_KEY = 'environment-secret';
    process.env.AWS_SESSION_TOKEN = 'environment-session';
    process.env.AWS_PROFILE = 'conflicting';
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'must-not-replace-sigv4';

    const request = await invokeSmoke({
      authMode: 'access-keys',
      accessKeyId: '  STATICKEY  ',
      secretAccessKey: '  static-secret  ',
      ...files,
    });

    expectSigV4(request, 'STATICKEY', 'us-east-1');
    expect(request.headers.has('x-amz-security-token')).toBe(false);
  });
});
