import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BeforeSendFn, PostHogConfig, Properties } from 'posthog-js';
import {
  createRendererIdentity,
  createRendererPostHogConfig,
  createRendererPostHogController,
  sanitizeRendererPostHogEvent,
  type RendererPostHogClient,
  type RendererTelemetryState,
} from './posthog-privacy';

class FakePostHogClient implements RendererPostHogClient {
  readonly initCalls: Array<{
    apiKey: string;
    config: Partial<PostHogConfig>;
  }> = [];
  readonly identifyCalls: Array<{
    distinctId: string;
    properties?: Properties;
  }> = [];
  readonly registerCalls: Properties[] = [];
  optInCalls = 0;
  optOutCalls = 0;
  resetCalls = 0;
  stopSessionRecordingCalls = 0;
  private identified = false;
  private distinctId = 'anonymous';

  _isIdentified(): boolean {
    return this.identified;
  }

  get_distinct_id(): string {
    return this.distinctId;
  }

  identify(distinctId: string, properties?: Properties): void {
    this.identified = true;
    this.distinctId = distinctId;
    this.identifyCalls.push({ distinctId, properties });
  }

  init(apiKey: string, config: Partial<PostHogConfig>): void {
    this.initCalls.push({ apiKey, config });
  }

  opt_in_capturing(options?: {
    captureEventName?: string | null | false;
  }): void {
    expect(options?.captureEventName).toBe(false);
    this.optInCalls += 1;
  }

  opt_out_capturing(): void {
    this.optOutCalls += 1;
  }

  register(properties: Properties): void {
    this.registerCalls.push(properties);
  }

  reset(): void {
    this.identified = false;
    this.distinctId = 'anonymous';
    this.resetCalls += 1;
  }

  stopSessionRecording(): void {
    this.stopSessionRecordingCalls += 1;
  }
}

const metadata = {
  product: 'clodex-browser' as const,
  app_name: 'CLODEx',
  app_version: '1.16.0',
  app_release_channel: 'release',
  app_platform: 'darwin',
  app_arch: 'arm64',
};
const TEST_PROJECT_KEY = ['phc', 'renderer_privacy_test_key'].join('_');

function enabledState(
  overrides: Partial<RendererTelemetryState> = {},
): RendererTelemetryState {
  return {
    rendererEnabled: true,
    telemetryLevel: 'anonymous',
    disabledInDevelopment: false,
    apiKey: TEST_PROJECT_KEY,
    apiHost: 'https://us.i.posthog.com',
    userId: undefined,
    ...overrides,
  };
}

describe('renderer PostHog privacy policy', () => {
  it('keeps the React hook on the audited controller boundary', () => {
    const source = readFileSync(
      new URL('../hooks/use-posthog.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('createRendererPostHogController');
    expect(source).not.toMatch(/autocapture:\s*true/);
    expect(source).not.toMatch(/posthog\.alias\(/);
    expect(source).not.toMatch(/machineId\s*:/);
    expect(source).not.toMatch(/email\s*:/);
  });

  it('rejects unsafe automatic SDK features in config', () => {
    const beforeSend: BeforeSendFn = (event) => event;
    const config = createRendererPostHogConfig(
      'https://us.i.posthog.com',
      false,
      beforeSend,
    );

    expect(config.autocapture).toBe(false);
    expect(config.rageclick).toBe(false);
    expect(config.capture_pageleave).toBe(false);
    expect(config.capture_exceptions).toBe(false);
    expect(config.capture_performance).toBe(false);
    expect(config.capture_heatmaps).toBe(false);
    expect(config.capture_dead_clicks).toBe(false);
    expect(config.disable_session_recording).toBe(true);
    expect(config.disable_surveys).toBe(true);
    expect(config.disable_surveys_automatic_display).toBe(true);
    expect(config.disable_product_tours).toBe(true);
    expect(config.disable_conversations).toBe(true);
    expect(config.disable_external_dependency_loading).toBe(true);
    expect(config.disableDeviceModel).toBe(true);
    expect(config.advanced_disable_flags).toBe(true);
    expect(config.person_profiles).toBe('never');
    expect(config.request_batching).toBe(false);
  });

  it('never includes email or machine identity properties', () => {
    expect(createRendererIdentity('anonymous', 'account-1')).toBeNull();
    expect(createRendererIdentity('full', undefined)).toBeNull();
    expect(createRendererIdentity('full', 'account-1')).toEqual({
      distinctId: 'account-1',
      properties: { telemetryLevel: 'full' },
    });
  });

  it('rejects anonymous exceptions and strips forbidden identity fields', () => {
    const event = {
      uuid: 'event-1',
      event: 'tutorial_clicked_next',
      properties: {
        distinct_id: 'anonymous',
        email: 'person@example.invalid',
        machineId: 'machine-secret',
        step: 2,
      },
      $set: {
        $email: 'person@example.invalid',
        machine_id: 'machine-secret',
        telemetryLevel: 'anonymous',
      },
    };

    expect(
      sanitizeRendererPostHogEvent(
        { ...event, event: '$exception' },
        'anonymous',
        (candidate) => candidate,
      ),
    ).toBeNull();
    expect(
      sanitizeRendererPostHogEvent(
        event,
        'anonymous',
        (candidate) => candidate,
      ),
    ).toEqual({
      uuid: 'event-1',
      event: 'tutorial_clicked_next',
      properties: { distinct_id: 'anonymous', step: 2 },
      $set: { telemetryLevel: 'anonymous' },
    });
    expect(
      sanitizeRendererPostHogEvent(event, 'off', (candidate) => candidate),
    ).toBeNull();
  });

  it('does not initialize before consent and opts out after denial', () => {
    const client = new FakePostHogClient();
    const controller = createRendererPostHogController({
      client,
      metadata,
      beforeSend: (event) => event,
      debug: false,
    });

    controller.sync(enabledState({ telemetryLevel: 'off' }));
    controller.sync(enabledState({ telemetryLevel: 'off' }));
    expect(client.initCalls).toHaveLength(0);
    expect(client.identifyCalls).toHaveLength(0);
    expect(client.optOutCalls).toBe(1);

    controller.sync(enabledState());
    expect(client.initCalls).toHaveLength(1);
    expect(client.initCalls[0]?.config.autocapture).toBe(false);
    expect(client.identifyCalls).toHaveLength(0);
    expect(client.registerCalls.at(-1)).toEqual(metadata);

    controller.sync(
      enabledState({ telemetryLevel: 'full', userId: 'account-1' }),
    );
    controller.sync(
      enabledState({ telemetryLevel: 'full', userId: 'account-1' }),
    );
    expect(client.identifyCalls).toEqual([
      {
        distinctId: 'account-1',
        properties: { telemetryLevel: 'full' },
      },
    ]);

    controller.sync(enabledState({ telemetryLevel: 'anonymous' }));
    expect(client._isIdentified()).toBe(false);

    controller.sync(enabledState({ telemetryLevel: 'off' }));
    expect(client.initCalls).toHaveLength(1);
    expect(client.optOutCalls).toBe(2);
    expect(client.stopSessionRecordingCalls).toBeGreaterThanOrEqual(2);
  });
});
