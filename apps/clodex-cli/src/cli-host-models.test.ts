import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createAnthropicMock, selectModelMock } = vi.hoisted(() => ({
  createAnthropicMock: vi.fn(),
  selectModelMock: vi.fn(),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: createAnthropicMock,
}));

import { createCliHostModels } from './cli-host-models.js';

describe('createCliHostModels', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.clearAllMocks();
    selectModelMock.mockImplementation((modelId: string) => ({ modelId }));
    createAnthropicMock.mockReturnValue(selectModelMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    undefined,
    '',
    '   ',
  ])('fails before provider construction when the API key is %s', (apiKey) => {
    expect(() => createCliHostModels('model:default', { apiKey })).toThrow(
      'ANTHROPIC_API_KEY is required',
    );
    expect(createAnthropicMock).not.toHaveBeenCalled();
  });

  it('rejects an empty default model before provider construction', () => {
    expect(() => createCliHostModels('   ', { apiKey: 'test-key' })).toThrow(
      /non-empty default/,
    );
    expect(createAnthropicMock).not.toHaveBeenCalled();
  });

  it('selects the default or explicit model without making a network call', async () => {
    const models = createCliHostModels(' model:default ', {
      apiKey: ' test-key ',
    });

    expect(createAnthropicMock).toHaveBeenCalledWith({ apiKey: 'test-key' });
    await expect(models.getWithOptions('', 'trace')).resolves.toMatchObject({
      model: { modelId: 'model:default' },
      providerMode: 'official',
      contextWindowSize: 200_000,
    });
    await expect(
      models.getWithOptions(' model:explicit ', 'trace'),
    ).resolves.toMatchObject({ model: { modelId: 'model:explicit' } });
    expect(selectModelMock).toHaveBeenNthCalledWith(1, 'model:default');
    expect(selectModelMock).toHaveBeenNthCalledWith(2, 'model:explicit');
    expect(models.has('anything')).toBe(true);
    expect(models.getCapabilities('anything')).toMatchObject({
      toolCalling: true,
    });
  });

  it('propagates provider model-selection failure without returning a partial model', async () => {
    selectModelMock.mockImplementationOnce(() => {
      throw new Error('model unavailable');
    });
    const models = createCliHostModels('model:default', {
      apiKey: 'test-key',
    });

    await expect(
      models.getWithOptions('model:missing', 'trace'),
    ).rejects.toThrow('model unavailable');
  });
});
