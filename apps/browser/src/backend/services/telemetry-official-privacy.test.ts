import { beforeEach, describe, expect, it, vi } from 'vitest';

const posthogClient = vi.hoisted(() => ({
  alias: vi.fn(),
  capture: vi.fn(),
  captureException: vi.fn(),
  identify: vi.fn(),
  optOut: vi.fn(async () => undefined),
  shutdown: vi.fn(async () => undefined),
}));
const posthogConstructor = vi.hoisted(() => vi.fn(() => posthogClient));
const withTracingMock = vi.hoisted(() => vi.fn());
const captureProcessSnapshotMock = vi.hoisted(() =>
  vi.fn(async () => ({
    matched_process_counts: {},
    total_matched: 0,
  })),
);

vi.hoisted(() => {
  vi.stubGlobal('__APP_VERSION__', '1.16.0');
  vi.stubGlobal('__APP_RELEASE_CHANNEL__', 'release');
  vi.stubGlobal('__APP_PLATFORM__', 'darwin');
  vi.stubGlobal('__APP_ARCH__', 'arm64');
  vi.stubGlobal('__APP_DISTRIBUTION_MODE__', 'official');
  vi.stubGlobal('__APP_TELEMETRY_ENABLED__', true);
  vi.stubGlobal('__APP_TELEMETRY_MODE__', 'standard');
  vi.stubGlobal('__APP_TELEMETRY_PRIVACY_MODE__', false);
  vi.stubGlobal('__APP_EXCEPTION_TELEMETRY_ENABLED__', true);
  vi.stubGlobal('__APP_MODEL_TRACING_ENABLED__', true);
});

vi.mock('posthog-node', () => ({ PostHog: posthogConstructor }));
vi.mock('@posthog/ai', () => ({ withTracing: withTracingMock }));
vi.mock('./telemetry/process-snapshot', () => ({
  captureProcessSnapshot: captureProcessSnapshotMock,
}));

import { TelemetryService } from './telemetry';

type TelemetryLevel = 'off' | 'anonymous' | 'full';
type Privacy = {
  telemetryLevel: TelemetryLevel;
  anonymousTelemetryConsentVersion: number;
};
const TEST_PROJECT_KEY = ['phc', 'official_privacy_test_key'].join('_');

function makeHarness(initialLevel: TelemetryLevel) {
  let privacy: Privacy = {
    telemetryLevel: initialLevel,
    anonymousTelemetryConsentVersion: 0,
  };
  let listener:
    | ((next: { privacy: Privacy }, previous: { privacy: Privacy }) => void)
    | undefined;
  const service = new TelemetryService(
    { getMachineId: vi.fn(() => 'raw-machine-identifier') } as never,
    {
      addListener: vi.fn((candidate) => {
        listener = candidate;
      }),
      get: vi.fn(() => ({ privacy })),
    } as never,
    {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      isDebugEnabled: false,
      warn: vi.fn(),
    } as never,
  );
  return {
    service,
    setLevel(telemetryLevel: TelemetryLevel) {
      const previous = privacy;
      privacy = { ...privacy, telemetryLevel };
      listener?.({ privacy }, { privacy: previous });
    },
  };
}

describe('TelemetryService official privacy contract', () => {
  beforeEach(() => {
    process.env.POSTHOG_API_KEY = TEST_PROJECT_KEY;
    process.env.POSTHOG_HOST = 'https://us.i.posthog.com';
    posthogConstructor.mockClear();
    for (const mock of Object.values(posthogClient)) mock.mockClear();
    withTracingMock.mockClear();
    captureProcessSnapshotMock.mockClear();
  });

  it('creates no client and sends no event while telemetry is off', async () => {
    const { service } = makeHarness('off');

    expect(posthogConstructor).not.toHaveBeenCalled();
    service.capture('settings-opened');
    service.captureException(new Error('private error'), {
      path: '/Users/person/private',
    });
    expect(posthogClient.capture).not.toHaveBeenCalled();
    expect(posthogClient.captureException).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('uses an ephemeral anonymous ID and privacy-safe client options', async () => {
    const { service } = makeHarness('anonymous');

    expect(posthogConstructor).toHaveBeenCalledWith(
      TEST_PROJECT_KEY,
      expect.objectContaining({
        defaultOptIn: true,
        disableGeoip: true,
        disableRemoteConfig: true,
        disableSurveys: true,
        enableExceptionAutocapture: false,
        flushAt: 1,
        flushInterval: 0,
        preloadFeatureFlags: false,
        privacyMode: true,
        sendFeatureFlagEvent: false,
      }),
    );

    service.capture('settings-opened');
    const event = posthogClient.capture.mock.calls[0]?.[0];
    expect(event.distinctId).toMatch(/^clodex-anonymous-[0-9a-f-]{36}$/u);
    expect(event.distinctId).not.toContain('raw-machine-identifier');
    expect(posthogClient.identify).not.toHaveBeenCalled();
    expect(posthogClient.alias).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('identifies full telemetry without email or machine aliases', async () => {
    const { service } = makeHarness('full');
    service.setUserProperties({ user_id: 'account-1' });
    service.identifyUser();

    expect(posthogClient.identify).toHaveBeenCalledWith({
      distinctId: 'account-1',
      properties: { telemetry_level: 'full' },
    });
    expect(posthogClient.alias).not.toHaveBeenCalled();

    service.capture('settings-opened');
    expect(posthogClient.capture).toHaveBeenCalledWith(
      expect.objectContaining({ distinctId: 'account-1' }),
    );
    await service.teardown();
  });

  it('forks tracing from the exact admitted model and merges trace metadata', async () => {
    const { service } = makeHarness('full');
    const sourceModel = { modelId: 'exact-route-model' } as never;
    const originatingWrapper = { modelId: 'originating-wrapper' } as never;
    const forkedWrapper = { modelId: 'forked-wrapper' } as never;
    withTracingMock
      .mockReturnValueOnce(originatingWrapper)
      .mockReturnValueOnce(forkedWrapper);

    const originating = service.withTracing(sourceModel, {
      posthogTraceId: 'agent-step-trace',
      posthogProperties: {
        modelId: 'exact-route-model',
        originating_marker: 'turn-a',
      },
    });
    const forked = service.forkTracing(originating, {
      posthogTraceId: 'agent-os-helper-trace',
      posthogProperties: {
        posthogTraceId: 'agent-os-helper-trace',
        model_request_purpose: 'internal',
        task_role: 'review',
      },
    });

    expect(forked).toBe(forkedWrapper);
    expect(withTracingMock).toHaveBeenCalledTimes(2);
    expect(withTracingMock.mock.calls[1]?.[0]).toBe(sourceModel);
    expect(withTracingMock.mock.calls[1]?.[2]).toMatchObject({
      posthogTraceId: 'agent-os-helper-trace',
      posthogProperties: expect.objectContaining({
        modelId: 'exact-route-model',
        originating_marker: 'turn-a',
        posthogTraceId: 'agent-os-helper-trace',
        model_request_purpose: 'internal',
        task_role: 'review',
      }),
    });
    await service.teardown();
  });

  it('requires full telemetry for exception payloads', async () => {
    const { service, setLevel } = makeHarness('anonymous');

    service.captureException(new Error('private anonymous error'), {
      path: '/Users/person/private',
    });
    expect(posthogClient.captureException).not.toHaveBeenCalled();

    setLevel('full');
    service.captureException(new Error('full-only error'), {
      service: 'test',
    });
    expect(posthogClient.captureException).toHaveBeenCalledTimes(1);
    await service.teardown();
  });

  it('detaches on Deny without a shutdown flush or later capture', async () => {
    const { service, setLevel } = makeHarness('anonymous');
    posthogClient.capture.mockClear();

    setLevel('off');
    await Promise.resolve();

    expect(service.posthogClient).toBeNull();
    expect(posthogClient.optOut).toHaveBeenCalledTimes(1);
    expect(posthogClient.shutdown).not.toHaveBeenCalled();
    expect(posthogClient.capture).not.toHaveBeenCalled();

    service.capture('settings-opened');
    expect(posthogClient.capture).not.toHaveBeenCalled();
    await service.teardown();
    expect(posthogClient.shutdown).not.toHaveBeenCalled();
  });
});
