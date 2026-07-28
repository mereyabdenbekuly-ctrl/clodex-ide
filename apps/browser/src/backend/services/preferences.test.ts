import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Patch } from 'immer';
import {
  defaultUserPreferences,
  type ProviderProfile,
} from '@shared/karton-contracts/ui/shared-types';
import { PreferencesService } from './preferences';

vi.hoisted(() => {
  vi.stubGlobal('__APP_BASE_NAME__', 'clodex-test');
  vi.stubGlobal('__APP_NAME__', 'clodex-test');
  vi.stubGlobal('__APP_BUNDLE_ID__', 'xyz.clodex.agentic-ide.test');
  vi.stubGlobal('__APP_VERSION__', '0.0.0-test');
  vi.stubGlobal('__APP_PLATFORM__', 'darwin');
  vi.stubGlobal('__APP_RELEASE_CHANNEL__', 'test');
  vi.stubGlobal('__APP_AUTHOR__', 'Clodex Labs');
  vi.stubGlobal('__APP_COPYRIGHT__', 'Copyright © 2025 Clodex Labs');
  vi.stubGlobal('__APP_HOMEPAGE__', 'https://clodex.xyz');
  vi.stubGlobal('__APP_ARCH__', 'arm64');
});

const electronMock = vi.hoisted(() => ({
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
  decryptString: vi.fn((buffer: Buffer) =>
    buffer.toString('utf-8').replace(/^encrypted:/, ''),
  ),
  isEncryptionAvailable: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  safeStorage: electronMock,
}));

const persistedDataMock = vi.hoisted(() => ({
  readPersistedData: vi.fn(),
  writePersistedData: vi.fn(),
}));

vi.mock('../utils/persisted-data', () => persistedDataMock);

const validationMock = vi.hoisted(() => ({
  validateApiKeys: vi.fn(),
  validateCodingPlanApiKey: vi.fn(),
}));

vi.mock('../utils/validate-api-keys', () => validationMock);

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
};

function cloneDefaultPreferences() {
  return structuredClone(defaultUserPreferences);
}

function createClodexAccountProviderProfile(): ProviderProfile {
  return {
    id: 'clodex-account',
    providerType: 'clodex',
    displayName: 'Clodex Cloud',
    baseUrl: 'https://clodex.xyz/v1',
    apiKeyReference: 'provider.clodex-account',
    protocol: 'openai-responses',
    customHeaders: {},
    enabled: true,
  };
}

async function createServiceWithPreferences(
  preferences = cloneDefaultPreferences(),
) {
  persistedDataMock.readPersistedData.mockResolvedValueOnce(preferences);
  const service = await PreferencesService.create(logger as any);
  return service;
}

describe('PreferencesService coding plan connection state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistedDataMock.writePersistedData.mockResolvedValue(undefined);
    validationMock.validateApiKeys.mockResolvedValue({
      anthropic: null,
      openai: null,
      google: null,
      moonshotai: null,
      alibaba: null,
      deepseek: null,
      'z-ai': { success: true },
      minimax: null,
    });
    validationMock.validateCodingPlanApiKey.mockResolvedValue({
      success: true,
    });
  });

  it('connectCodingPlan validates against the plan and stores the plan id', async () => {
    const service = await createServiceWithPreferences();

    const result = await service.connectCodingPlan(
      'glm-coding-plan',
      'glm-key',
    );

    expect(result).toEqual({ success: true });
    expect(validationMock.validateCodingPlanApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'glm-coding-plan',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
        validationBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
        validationModelId: 'glm-5.2',
      }),
      'glm-key',
    );
    expect(validationMock.validateApiKeys).not.toHaveBeenCalled();

    const prefs = service.get();
    expect(prefs.providerConfigs['z-ai']).toMatchObject({
      mode: 'official',
      encryptedApiKey: Buffer.from('encrypted:glm-key').toString('base64'),
      connectedCodingPlanId: 'glm-coding-plan',
    });
  });

  it('does not mutate preferences when coding-plan validation fails', async () => {
    validationMock.validateCodingPlanApiKey.mockResolvedValueOnce({
      success: false,
      error: 'invalid key',
    });
    const service = await createServiceWithPreferences();

    const result = await service.connectCodingPlan(
      'glm-coding-plan',
      'bad-key',
    );

    expect(result).toEqual({ success: false, error: 'invalid key' });
    expect(service.get().providerConfigs['z-ai']).toEqual(
      defaultUserPreferences.providerConfigs['z-ai'],
    );
    expect(persistedDataMock.writePersistedData).not.toHaveBeenCalled();
  });

  it('connectProvider clears stale coding-plan routing state', async () => {
    const preferences = cloneDefaultPreferences();
    preferences.providerConfigs['z-ai'] = {
      ...preferences.providerConfigs['z-ai'],
      mode: 'official',
      encryptedApiKey: 'old-encrypted-key',
      connectedCodingPlanId: 'glm-coding-plan',
    };
    const service = await createServiceWithPreferences(preferences);

    const result = await service.connectProvider('z-ai', 'normal-zai-key');

    expect(result).toEqual({ success: true });
    expect(validationMock.validateApiKeys).toHaveBeenCalledWith({
      'z-ai': 'normal-zai-key',
    });
    expect(service.get().providerConfigs['z-ai']).toMatchObject({
      mode: 'official',
      encryptedApiKey: Buffer.from('encrypted:normal-zai-key').toString(
        'base64',
      ),
      connectedCodingPlanId: undefined,
    });
  });

  it('setProviderApiKey clears stale coding-plan routing state', async () => {
    const preferences = cloneDefaultPreferences();
    preferences.providerConfigs['z-ai'] = {
      ...preferences.providerConfigs['z-ai'],
      mode: 'official',
      encryptedApiKey: 'old-encrypted-key',
      connectedCodingPlanId: 'glm-coding-plan',
    };
    const service = await createServiceWithPreferences(preferences);

    await service.setProviderApiKey('z-ai', 'manual-key');

    expect(service.get().providerConfigs['z-ai']).toMatchObject({
      mode: 'official',
      encryptedApiKey: Buffer.from('encrypted:manual-key').toString('base64'),
      connectedCodingPlanId: undefined,
    });
  });

  it('disconnectProvider clears stale coding-plan routing state', async () => {
    const preferences = cloneDefaultPreferences();
    preferences.providerConfigs['z-ai'] = {
      ...preferences.providerConfigs['z-ai'],
      mode: 'official',
      encryptedApiKey: 'old-encrypted-key',
      connectedCodingPlanId: 'glm-coding-plan',
    };
    const service = await createServiceWithPreferences(preferences);

    await service.disconnectProvider('z-ai');

    expect(service.get().providerConfigs['z-ai']).toMatchObject({
      mode: 'official',
      encryptedApiKey: undefined,
      connectedCodingPlanId: undefined,
    });
  });
});

describe('PreferencesService provider profile migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistedDataMock.writePersistedData.mockResolvedValue(undefined);
  });

  it('creates, selects, and deletes a provider profile with an external secret', async () => {
    const service = await createServiceWithPreferences();
    const stored = new Map<string, string>();
    const credentials = {
      setProviderApiKey: vi.fn(async (reference: string, value: string) => {
        stored.set(reference, value);
      }),
      getProviderApiKey: vi.fn((reference: string) => stored.get(reference)),
      hasProviderApiKey: vi.fn((reference: string) => stored.has(reference)),
      deleteProviderApiKey: vi.fn(async (reference: string) => {
        stored.delete(reference);
      }),
    };
    await service.migrateProviderProfiles(credentials as any);

    await service.saveProviderProfile({
      id: 'openrouter-main',
      providerType: 'openrouter',
      displayName: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'or-secret',
      protocol: 'openai-chat',
      customHeaders: { 'HTTP-Referer': 'https://example.test' },
      enabled: true,
    });

    expect(service.get().providerProfiles).toContainEqual({
      id: 'openrouter-main',
      providerType: 'openrouter',
      displayName: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyReference: 'provider.openrouter-main',
      protocol: 'openai-chat',
      customHeaders: { 'HTTP-Referer': 'https://example.test' },
      enabled: true,
    });
    expect(JSON.stringify(service.get())).not.toContain('or-secret');
    expect(service.get().defaultProviderProfileId).toBe('openrouter-main');

    await service.deleteProviderProfile('openrouter-main');
    expect(service.get().providerProfiles).toEqual([]);
    expect(service.get().defaultProviderProfileId).toBeUndefined();
    expect(credentials.deleteProviderApiKey).toHaveBeenCalledWith(
      'provider.openrouter-main',
    );
  });

  it('moves an official OpenAI key to a credential reference', async () => {
    const preferences = cloneDefaultPreferences();
    preferences.providerConfigs.openai = {
      mode: 'official',
      encryptedApiKey: Buffer.from('encrypted:sk-openai').toString('base64'),
    };
    const service = await createServiceWithPreferences(preferences);
    const credentials = {
      setProviderApiKey: vi.fn(async () => undefined),
    };

    await service.migrateProviderProfiles(credentials as any);

    expect(credentials.setProviderApiKey).toHaveBeenCalledWith(
      'provider.official-openai',
      'sk-openai',
    );
    expect(service.get().providerProfiles).toContainEqual(
      expect.objectContaining({
        id: 'official-openai',
        providerType: 'openai',
        apiKeyReference: 'provider.official-openai',
      }),
    );
    expect(
      service.get().providerConfigs.openai.encryptedApiKey,
    ).toBeUndefined();
    expect(service.get().defaultProviderProfileId).toBe('official-openai');
  });

  it.each([
    'openai',
    'anthropic',
  ] as const)('connects and disconnects official %s through the encrypted credential store', async (provider) => {
    const service = await createServiceWithPreferences();
    const stored = new Map<string, string>();
    const credentials = {
      setProviderApiKey: vi.fn(async (reference: string, value: string) => {
        stored.set(reference, value);
      }),
      getProviderApiKey: vi.fn((reference: string) => stored.get(reference)),
      hasProviderApiKey: vi.fn((reference: string) => stored.has(reference)),
      deleteProviderApiKey: vi.fn(async (reference: string) => {
        stored.delete(reference);
      }),
    };
    await service.migrateProviderProfiles(credentials as any);
    const secret = `release-${provider}-credential`;
    validationMock.validateApiKeys.mockResolvedValueOnce({
      anthropic: provider === 'anthropic' ? { success: true } : null,
      openai: provider === 'openai' ? { success: true } : null,
      google: null,
      moonshotai: null,
      alibaba: null,
      deepseek: null,
      'z-ai': null,
      minimax: null,
      'xiaomi-mimo': null,
      mistral: null,
    });

    await expect(service.connectProvider(provider, secret)).resolves.toEqual({
      success: true,
    });

    const reference = `provider.official-${provider}`;
    expect(credentials.setProviderApiKey).toHaveBeenCalledWith(
      reference,
      secret,
    );
    expect(service.get().providerConfigs[provider]).toMatchObject({
      mode: 'official',
      encryptedApiKey: undefined,
    });
    expect(service.get().providerProfiles).toContainEqual(
      expect.objectContaining({
        id: `official-${provider}`,
        providerType: provider,
        apiKeyReference: reference,
        enabled: true,
      }),
    );
    expect(JSON.stringify(service.get())).not.toContain(secret);
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(secret);

    await service.disconnectProvider(provider);
    expect(credentials.deleteProviderApiKey).toHaveBeenCalledWith(reference);
    expect(service.get().providerProfiles).not.toContainEqual(
      expect.objectContaining({ id: `official-${provider}` }),
    );
    expect(stored.has(reference)).toBe(false);
  });

  it('does not create a Clodex profile for a fresh unconfigured user', async () => {
    const service = await createServiceWithPreferences();
    const credentials = {
      setProviderApiKey: vi.fn(async () => undefined),
    };

    await service.migrateProviderProfiles(credentials as any);

    expect(service.get().providerProfiles).toEqual([]);
    expect(credentials.setProviderApiKey).not.toHaveBeenCalled();
  });

  it.each(['create', 'modify', 'remove', 'duplicate'] as const)(
    'rejects attempts to %s the reserved account profile through generic patches',
    async (mutation) => {
      const preferences = cloneDefaultPreferences();
      const managedProfile = createClodexAccountProviderProfile();
      if (mutation !== 'create') {
        preferences.providerProfiles = [managedProfile];
      }
      const service = await createServiceWithPreferences(preferences);
      let patches: Patch[] = [];

      switch (mutation) {
        case 'create':
          patches = [
            {
              op: 'add',
              path: ['providerProfiles', 0],
              value: managedProfile,
            },
          ];
          break;
        case 'modify':
          patches = [
            {
              op: 'replace',
              path: ['providerProfiles', 0, 'baseUrl'],
              value: 'https://attacker.example.test/v1',
            },
          ];
          break;
        case 'remove':
          patches = [{ op: 'remove', path: ['providerProfiles', 0] }];
          break;
        case 'duplicate':
          patches = [
            {
              op: 'add',
              path: ['providerProfiles', 1],
              value: managedProfile,
            },
          ];
          break;
      }

      await expect(service.update(patches)).rejects.toThrow(
        'managed by the authenticated session',
      );
      expect(service.get().providerProfiles).toEqual(
        preferences.providerProfiles,
      );
      expect(persistedDataMock.writePersistedData).not.toHaveBeenCalled();
    },
  );

  it('rejects a non-reserved profile that aliases the reserved account credential', async () => {
    const preferences = cloneDefaultPreferences();
    preferences.providerProfiles = [createClodexAccountProviderProfile()];
    const service = await createServiceWithPreferences(preferences);

    await expect(
      service.update([
        {
          op: 'add',
          path: ['providerProfiles', 1],
          value: {
            id: 'hostile-relay',
            providerType: 'openai-compatible',
            displayName: 'Hostile relay',
            baseUrl: 'https://attacker.example.test/v1',
            apiKeyReference: ' provider.clodex-account ',
            protocol: 'openai-responses',
            customHeaders: {},
            enabled: true,
          },
        },
      ]),
    ).rejects.toThrow('cannot reference the reserved Clodex account credential');
    expect(service.get().providerProfiles).toEqual(
      preferences.providerProfiles,
    );
    expect(persistedDataMock.writePersistedData).not.toHaveBeenCalled();
  });

  it('rejects public mutation of the reserved account profile but allows session cleanup', async () => {
    const preferences = cloneDefaultPreferences();
    preferences.providerProfiles = [
      {
        ...createClodexAccountProviderProfile(),
        baseUrl: 'https://attacker.example.test/v1',
      },
    ];
    preferences.defaultProviderProfileId = 'clodex-account';
    const service = await createServiceWithPreferences(preferences);
    const credentials = {
      setProviderApiKey: vi.fn(async () => undefined),
      hasProviderApiKey: vi.fn(() => true),
      deleteProviderApiKey: vi.fn(async () => undefined),
    };
    await service.migrateProviderProfiles(credentials as any);

    await expect(
      service.saveProviderProfile({
        id: 'clodex-account',
        providerType: 'clodex',
        displayName: 'Redirected account',
        baseUrl: 'https://attacker.example.test/v1',
        apiKey: 'exfiltrate-me',
        protocol: 'openai-responses',
        customHeaders: {},
        enabled: true,
      }),
    ).rejects.toThrow('managed by the authenticated session');
    await expect(
      service.deleteProviderProfile('clodex-account'),
    ).rejects.toThrow('managed by the authenticated session');

    expect(credentials.setProviderApiKey).not.toHaveBeenCalled();
    expect(credentials.deleteProviderApiKey).not.toHaveBeenCalled();
    expect(service.get().providerProfiles).toEqual(preferences.providerProfiles);

    await service.syncClodexAccountProfile(credentials as any, undefined);

    expect(service.get().providerProfiles).toEqual([]);
    expect(service.get().defaultProviderProfileId).toBeUndefined();
    expect(credentials.deleteProviderApiKey).toHaveBeenCalledWith(
      'provider.clodex-account',
    );
  });
});
