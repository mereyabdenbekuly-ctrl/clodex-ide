import { describe, expect, it, vi } from 'vitest';

const posthogConstructor = vi.hoisted(() => vi.fn());

vi.hoisted(() => {
  vi.stubGlobal('__APP_VERSION__', '1.16.0');
  vi.stubGlobal('__APP_RELEASE_CHANNEL__', 'release');
  vi.stubGlobal('__APP_PLATFORM__', 'darwin');
  vi.stubGlobal('__APP_ARCH__', 'arm64');
  vi.stubGlobal('__APP_DISTRIBUTION_MODE__', 'community-unsigned');
  vi.stubGlobal('__APP_TELEMETRY_ENABLED__', false);
});

vi.mock('posthog-node', () => ({ PostHog: posthogConstructor }));

import { TelemetryService } from './telemetry';

describe('TelemetryService community distribution guard', () => {
  it('does not create a PostHog client even when an ambient key exists', async () => {
    const previousApiKey = process.env.POSTHOG_API_KEY;
    process.env.POSTHOG_API_KEY = 'must-not-be-used';
    try {
      const service = new TelemetryService(
        { getMachineId: vi.fn(() => 'community-machine') } as never,
        {
          addListener: vi.fn(),
          get: vi.fn(() => ({ privacy: { telemetryLevel: 'full' } })),
        } as never,
        {
          debug: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
          isDebugEnabled: false,
          warn: vi.fn(),
        } as never,
      );

      expect(posthogConstructor).not.toHaveBeenCalled();
      expect(service.posthogClient).toBeNull();
      expect(() =>
        service.capture('telemetry-level-changed', {
          from: 'off',
          to: 'full',
        }),
      ).not.toThrow();

      await service.teardown();
    } finally {
      if (previousApiKey === undefined) delete process.env.POSTHOG_API_KEY;
      else process.env.POSTHOG_API_KEY = previousApiKey;
    }
  });
});
