import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger';

const persisted = vi.hoisted(() => ({
  values: {
    credentials: {} as Record<string, Record<string, string>>,
    'mcp-custom-credentials': {} as Record<string, unknown>,
    'provider-api-keys': {} as Record<string, { apiKey: string }>,
  },
}));

const writePersistedData = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => undefined),
);

vi.mock('../../utils/persisted-data', () => ({
  readPersistedData: vi.fn(async (name: keyof typeof persisted.values) =>
    structuredClone(persisted.values[name]),
  ),
  writePersistedData: vi.fn(
    async (
      name: keyof typeof persisted.values,
      _schema: unknown,
      value: unknown,
      options: unknown,
    ) => {
      await writePersistedData(name, _schema, value, options);
      persisted.values[name] = structuredClone(value) as never;
    },
  ),
}));

import { CredentialsService } from './index';

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe('CredentialsService custom MCP credentials', () => {
  beforeEach(() => {
    persisted.values.credentials = {};
    persisted.values['mcp-custom-credentials'] = {};
    persisted.values['provider-api-keys'] = {};
    writePersistedData.mockReset();
    writePersistedData.mockResolvedValue(undefined);
  });

  it('stores provider API keys outside preferences-compatible state', async () => {
    const logger = makeLogger();
    const service = await CredentialsService.create(logger);
    const secret = 'release-provider-secret';
    await service.setProviderApiKey('provider.openai-main', secret);

    expect(service.hasProviderApiKey('provider.openai-main')).toBe(true);
    expect(service.getProviderApiKey('provider.openai-main')).toBe(secret);
    expect(writePersistedData).toHaveBeenCalledWith(
      'provider-api-keys',
      expect.anything(),
      {
        'provider.openai-main': { apiKey: secret },
      },
      expect.objectContaining({
        encrypt: true,
        requireEncryption: true,
      }),
    );
    expect(
      JSON.stringify((logger.debug as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toContain(secret);

    await service.deleteProviderApiKey('provider.openai-main');
    expect(service.getProviderApiKey('provider.openai-main')).toBeNull();
    await service.teardown();
  });

  it('does not publish provider-key mutations when encrypted persistence fails', async () => {
    const service = await CredentialsService.create(makeLogger());
    const listener = vi.fn();
    service.addProviderApiKeyListener(listener);

    writePersistedData.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(
      service.setProviderApiKey('provider.openai-main', 'new-secret'),
    ).rejects.toThrow('disk unavailable');
    expect(service.getProviderApiKey('provider.openai-main')).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    await service.setProviderApiKey('provider.openai-main', 'durable-secret');
    listener.mockClear();
    writePersistedData.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(
      service.deleteProviderApiKey('provider.openai-main'),
    ).rejects.toThrow('disk unavailable');
    expect(service.getProviderApiKey('provider.openai-main')).toBe(
      'durable-secret',
    );
    expect(listener).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('serializes copy-on-write provider-key publications without losing updates', async () => {
    const service = await CredentialsService.create(makeLogger());
    let releaseFirstWrite: (() => void) | undefined;
    writePersistedData.mockImplementationOnce(
      async () =>
        await new Promise<undefined>((resolve) => {
          releaseFirstWrite = () => resolve(undefined);
        }),
    );

    const first = service.setProviderApiKey(
      'provider.openai-main',
      'openai-secret',
    );
    await vi.waitFor(() => expect(writePersistedData).toHaveBeenCalledOnce());
    const second = service.setProviderApiKey(
      'provider.anthropic-main',
      'anthropic-secret',
    );

    expect(service.getProviderApiKey('provider.openai-main')).toBeNull();
    expect(service.getProviderApiKey('provider.anthropic-main')).toBeNull();
    releaseFirstWrite?.();
    await Promise.all([first, second]);

    expect(service.getProviderApiKey('provider.openai-main')).toBe(
      'openai-secret',
    );
    expect(service.getProviderApiKey('provider.anthropic-main')).toBe(
      'anthropic-secret',
    );
    await service.teardown();
  });

  it('stores custom MCP secrets encrypted and exposes metadata only', async () => {
    const service = await CredentialsService.create(makeLogger());
    await service.setMcpCustomCredential({
      credentialId: 'mcp-custom.example',
      displayName: 'Example MCP token',
      field: 'token',
      secret: 'top-secret-token',
      allowedOrigins: ['https://mcp.example.com/path'],
    });

    expect(service.listMcpCustomCredentials()).toEqual([
      {
        credentialId: 'mcp-custom.example',
        displayName: 'Example MCP token',
        fields: ['token'],
        allowedOrigins: ['https://mcp.example.com'],
      },
    ]);
    expect(JSON.stringify(service.listMcpCustomCredentials())).not.toContain(
      'top-secret-token',
    );
    expect(writePersistedData).toHaveBeenCalledWith(
      'mcp-custom-credentials',
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        encrypt: true,
        requireEncryption: true,
      }),
    );

    await expect(
      service.resolveSecretField('mcp-custom.example', 'token'),
    ).resolves.toEqual({
      value: 'top-secret-token',
      allowedOrigins: ['https://mcp.example.com'],
    });
    await service.teardown();
  });

  it('rejects non-loopback plaintext origins', async () => {
    const service = await CredentialsService.create(makeLogger());
    await expect(
      service.setMcpCustomCredential({
        credentialId: 'mcp-custom.example',
        displayName: 'Example MCP token',
        field: 'token',
        secret: 'top-secret-token',
        allowedOrigins: ['http://mcp.example.com'],
      }),
    ).rejects.toThrow('must use HTTPS');
    await service.teardown();
  });
});
