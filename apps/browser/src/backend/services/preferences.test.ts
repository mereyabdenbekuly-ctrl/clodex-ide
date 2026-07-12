import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultUserPreferences } from '@shared/karton-contracts/ui/shared-types';
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

  it('does not create a Clodex profile for a fresh unconfigured user', async () => {
    const service = await createServiceWithPreferences();
    const credentials = {
      setProviderApiKey: vi.fn(async () => undefined),
    };

    await service.migrateProviderProfiles(credentials as any);

    expect(service.get().providerProfiles).toEqual([]);
    expect(credentials.setProviderApiKey).not.toHaveBeenCalled();
  });
});
