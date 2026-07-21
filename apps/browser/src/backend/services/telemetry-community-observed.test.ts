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
    matched_process_counts: { private_process: 1 },
    total_matched: 1,
  })),
);

vi.hoisted(() => {
  vi.stubGlobal('__APP_VERSION__', '1.16.0-communityobserved42');
  vi.stubGlobal('__APP_RELEASE_CHANNEL__', 'release');
  vi.stubGlobal('__APP_PLATFORM__', 'darwin');
  vi.stubGlobal('__APP_ARCH__', 'arm64');
  vi.stubGlobal('__APP_DISTRIBUTION_MODE__', 'community-observed');
  vi.stubGlobal('__APP_TELEMETRY_ENABLED__', true);
  vi.stubGlobal('__APP_TELEMETRY_MODE__', 'anonymous-backend-only');
  vi.stubGlobal('__APP_TELEMETRY_PRIVACY_MODE__', true);
  vi.stubGlobal('__APP_EXCEPTION_TELEMETRY_ENABLED__', false);
  vi.stubGlobal('__APP_MODEL_TRACING_ENABLED__', false);
});

vi.mock('posthog-node', () => ({ PostHog: posthogConstructor }));
vi.mock('@posthog/ai', () => ({ withTracing: withTracingMock }));
vi.mock('./telemetry/process-snapshot', () => ({
  captureProcessSnapshot: captureProcessSnapshotMock,
}));

import {
  sanitizeCommunityObservedProperties,
  TelemetryService,
} from './telemetry';

type TelemetryLevel = 'off' | 'anonymous' | 'full';
type Privacy = {
  telemetryLevel: TelemetryLevel;
  anonymousTelemetryConsentVersion: number;
};
const TEST_PROJECT_KEY = [
  'phc',
  'community_observed_test_project_key_000000',
].join('_');

function makeHarness(
  initialLevel: TelemetryLevel,
  initialConsentVersion = initialLevel === 'anonymous' ? 1 : 0,
) {
  let privacy: Privacy = {
    telemetryLevel: initialLevel,
    anonymousTelemetryConsentVersion: initialConsentVersion,
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
      isDebugEnabled: true,
      warn: vi.fn(),
    } as never,
  );
  return {
    service,
    setPrivacy(next: Privacy) {
      const previous = privacy;
      privacy = next;
      listener?.({ privacy: next }, { privacy: previous });
    },
  };
}

describe('TelemetryService community-observed privacy contract', () => {
  beforeEach(() => {
    process.env.POSTHOG_API_KEY = TEST_PROJECT_KEY;
    process.env.POSTHOG_HOST = 'https://us.i.posthog.com';
    posthogConstructor.mockClear();
    for (const mock of Object.values(posthogClient)) mock.mockClear();
    withTracingMock.mockClear();
    captureProcessSnapshotMock.mockClear();
  });

  it('creates no PostHog client before explicit anonymous opt-in', async () => {
    const { service } = makeHarness('off');
    expect(service.telemetryLevel).toBe('off');
    expect(posthogConstructor).not.toHaveBeenCalled();

    service.capture('settings-opened');
    expect(posthogConstructor).not.toHaveBeenCalled();
    expect(posthogClient.capture).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('does not trust an anonymous level without the current consent version', async () => {
    const { service } = makeHarness('anonymous', 0);
    expect(service.telemetryLevel).toBe('off');
    service.capture('settings-opened');
    expect(posthogConstructor).not.toHaveBeenCalled();
    expect(posthogClient.capture).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('treats full as unavailable and never identifies a user', async () => {
    const { service } = makeHarness('full');
    expect(service.telemetryLevel).toBe('off');
    service.setUserProperties({
      user_id: 'account-id',
    });
    service.identifyUser();
    service.capture('settings-opened');

    expect(posthogConstructor).not.toHaveBeenCalled();
    expect(posthogClient.identify).not.toHaveBeenCalled();
    expect(posthogClient.alias).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('uses backend privacy mode and strips content-bearing properties', async () => {
    const { service } = makeHarness('anonymous');

    expect(posthogConstructor).toHaveBeenCalledWith(
      TEST_PROJECT_KEY,
      expect.objectContaining({
        defaultOptIn: true,
        disableGeoip: true,
        disableRemoteConfig: true,
        disableSurveys: true,
        enableExceptionAutocapture: false,
        preloadFeatureFlags: false,
        privacyMode: true,
        sendFeatureFlagEvent: false,
      }),
    );

    service.capture('tool-call-executed', {
      tool_name: 'shell',
      agent_type: 'coding-agent',
      agent_instance_id: 'private-agent-id',
      model_id: 'custom-model',
      success: false,
      error_message: 'secret error with /Users/person/repository',
      input_keys: ['command', 'cwd'],
      input_summary: 'rm -rf private-repository',
      duration_ms: 125,
    });

    expect(posthogClient.capture).toHaveBeenCalledTimes(1);
    const event = posthogClient.capture.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      disableGeoip: true,
      event: 'tool-call-executed',
      sendFeatureFlags: false,
    });
    expect(event.distinctId).toMatch(/^community-observed-[a-f0-9]{32}$/u);
    expect(event.distinctId).not.toContain('raw-machine-identifier');
    expect(event.properties).toMatchObject({
      success: false,
      duration_ms: 125,
      telemetry_level: 'anonymous',
      app_distribution_mode: 'community-observed',
      $process_person_profile: false,
    });
    for (const forbidden of [
      'tool_name',
      'agent_type',
      'agent_instance_id',
      'model_id',
      'error_message',
      'input_keys',
      'input_summary',
    ]) {
      expect(event.properties).not.toHaveProperty(forbidden);
    }
    await service.teardown();
  });

  it('emits lifecycle events without inspecting the host process list', async () => {
    const { service } = makeHarness('anonymous');

    service.captureAppLaunched();

    expect(captureProcessSnapshotMock).not.toHaveBeenCalled();
    expect(posthogClient.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'app-launched',
        properties: expect.not.objectContaining({
          matched_process_counts: expect.anything(),
          total_matched_processes: expect.anything(),
        }),
      }),
    );
    await service.teardown();
    expect(captureProcessSnapshotMock).not.toHaveBeenCalled();
  });

  it('disables exception capture and AI tracing even after opt-in', async () => {
    const { service } = makeHarness('anonymous');
    const model = { modelId: 'private-model' } as never;
    expect(
      service.withTracing(model, {
        posthogProperties: {
          prompt: 'private prompt',
          source_url: 'https://example.invalid/private',
        },
      }),
    ).toBe(model);
    service.captureException(new Error('private exception'), {
      path: '/Users/person/repository',
    });

    expect(withTracingMock).not.toHaveBeenCalled();
    expect(posthogClient.captureException).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('starts only on an off-to-anonymous preference transition', async () => {
    const { service, setPrivacy } = makeHarness('off');
    setPrivacy({
      telemetryLevel: 'anonymous',
      anonymousTelemetryConsentVersion: 1,
    });

    expect(posthogConstructor).toHaveBeenCalledTimes(1);
    expect(posthogClient.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'telemetry-level-changed',
        properties: expect.objectContaining({
          from: 'off',
          to: 'anonymous',
          telemetry_level: 'anonymous',
        }),
      }),
    );
    await service.teardown();
  });

  it('persists an explicit decline without creating a client', async () => {
    const { service, setPrivacy } = makeHarness('off');
    setPrivacy({
      telemetryLevel: 'off',
      anonymousTelemetryConsentVersion: 1,
    });

    expect(service.telemetryLevel).toBe('off');
    expect(posthogConstructor).not.toHaveBeenCalled();
    expect(posthogClient.capture).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('stops without a shutdown flush after an anonymous-to-off change', async () => {
    const { service, setPrivacy } = makeHarness('anonymous');
    posthogClient.capture.mockClear();

    setPrivacy({
      telemetryLevel: 'off',
      anonymousTelemetryConsentVersion: 1,
    });
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

describe('sanitizeCommunityObservedProperties', () => {
  it('drops prompts, source, tool args, URLs, commands, errors, titles and feedback centrally', () => {
    expect(
      sanitizeCommunityObservedProperties('plugin-marketplace-operation', {
        success: true,
        duration_ms: 10,
        operation: 'install',
        prompt: 'private prompt',
        source: 'sidebar-top',
        tool_args: { command: 'cat secret' },
        command: 'cat secret',
        base_url: 'https://example.invalid/private',
        error_message: 'private error',
        input_summary: 'private input',
        new_title: 'private title',
        feedback: 'private feedback',
        repository_path: '/Users/person/private',
        numeric_user_id: 424242,
        arbitrary_flag: true,
        latency_ms: -1,
        input_tokens: 1_000_000_000_001,
      }),
    ).toEqual({
      success: true,
      duration_ms: 10,
      operation: 'install',
    });
  });

  it('uses per-event fields, exact enum values and numeric clamping', () => {
    expect(
      sanitizeCommunityObservedProperties('agent-step-completed', {
        provider_mode: 'custom',
        finish_reason: 'stop',
        input_tokens: 1_000_000_000_001,
        output_tokens: 10,
        tool_call_count: 2,
        duration_ms: 50,
        numeric_user_id: 42,
        reason: 'private-reason',
        api_spec: 'private-api',
      }),
    ).toEqual({
      provider_mode: 'custom',
      finish_reason: 'stop',
      input_tokens: 1_000_000_000,
      output_tokens: 10,
      tool_call_count: 2,
      duration_ms: 50,
    });
    expect(
      sanitizeCommunityObservedProperties('agent-step-completed', {
        provider_mode: 'attacker-controlled',
      }),
    ).toEqual({});
    expect(
      sanitizeCommunityObservedProperties('unknown-event', {
        success: true,
      }),
    ).toBeNull();
  });
});
