import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronApp = vi.hoisted(() => ({
  isDefaultProtocolClient: vi.fn(() => true),
  setAsDefaultProtocolClient: vi.fn(() => true),
}));

vi.mock('electron', () => ({ app: electronApp }));
vi.mock('./auth/callback-scheme', () => ({
  AUTH_CALLBACK_SCHEME: 'clodex-ide',
}));

import {
  resolveDefaultProtocolSchemes,
  URIHandlerService,
} from './uri-handler';

function logger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe('URIHandlerService distribution policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('__APP_DISTRIBUTION_MODE__', 'community-unsigned');
    vi.stubGlobal('__APP_REGISTER_DEFAULT_PROTOCOLS__', false);
  });

  it('returns no protocol schemes when distribution policy disables them', () => {
    expect(
      resolveDefaultProtocolSchemes({
        authCallbackScheme: 'clodex-ide',
        registerDefaultProtocols: false,
      }),
    ).toEqual([]);
  });

  it('does not claim OS protocols for the community-observed distribution', async () => {
    vi.stubGlobal('__APP_DISTRIBUTION_MODE__', 'community-observed');
    vi.stubGlobal('__APP_REGISTER_DEFAULT_PROTOCOLS__', false);

    const service = await URIHandlerService.create(logger() as never);

    expect(electronApp.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    expect(electronApp.isDefaultProtocolClient).not.toHaveBeenCalled();

    await service.teardown();
  });

  it('does not attempt to claim an OS protocol association', async () => {
    const service = await URIHandlerService.create(logger() as never);

    expect(electronApp.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    expect(electronApp.isDefaultProtocolClient).not.toHaveBeenCalled();

    await service.teardown();
  });

  it('preserves canonical protocol registration for official builds', async () => {
    vi.stubGlobal('__APP_DISTRIBUTION_MODE__', 'official');
    vi.stubGlobal('__APP_REGISTER_DEFAULT_PROTOCOLS__', true);

    const service = await URIHandlerService.create(logger() as never);

    expect(electronApp.setAsDefaultProtocolClient.mock.calls).toEqual([
      ['clodex-ide'],
      ['clodex'],
    ]);

    await service.teardown();
  });
});
