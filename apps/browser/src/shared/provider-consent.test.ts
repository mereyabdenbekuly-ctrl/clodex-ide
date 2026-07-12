import { describe, expect, it } from 'vitest';
import { isClodexCloudSelected } from './provider-consent';

describe('Clodex network consent', () => {
  it('is disabled before the user selects any provider', () => {
    expect(
      isClodexCloudSelected({
        providerProfiles: [],
        defaultProviderProfileId: undefined,
      }),
    ).toBe(false);
  });

  it('does not enable Clodex for a selected BYOK or local profile', () => {
    expect(
      isClodexCloudSelected({
        providerProfiles: [
          {
            id: 'ollama-local',
            providerType: 'ollama',
            displayName: 'Ollama',
            baseUrl: 'http://localhost:11434',
            protocol: 'ollama',
            customHeaders: {},
            enabled: true,
          },
        ],
        defaultProviderProfileId: 'ollama-local',
      }),
    ).toBe(false);
  });

  it('enables Clodex only for the explicitly selected Clodex profile', () => {
    expect(
      isClodexCloudSelected({
        providerProfiles: [
          {
            id: 'clodex-cloud',
            providerType: 'clodex',
            displayName: 'Clodex Cloud',
            protocol: 'openai-responses',
            customHeaders: {},
            enabled: true,
          },
        ],
        defaultProviderProfileId: 'clodex-cloud',
      }),
    ).toBe(true);
  });
});
