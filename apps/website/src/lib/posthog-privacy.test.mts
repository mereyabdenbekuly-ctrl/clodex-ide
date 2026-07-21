import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { CaptureResult, PostHogConfig, Properties } from 'posthog-js';
import {
  parseCookieConsentValue,
  type ConsentStatus,
} from './cookie-consent-utils.ts';
import {
  createWebsiteAnalyticsController,
  createWebsitePostHogConfig,
  sanitizeWebsiteAnalyticsUrl,
  sanitizeWebsitePostHogEvent,
  type WebsitePostHogClient,
} from './posthog-privacy.ts';

const TEST_PROJECT_KEY = ['phc', 'privacy_test_project_key'].join('_');

class FakePostHogClient implements WebsitePostHogClient {
  readonly initCalls: Array<{
    apiKey: string;
    config: Partial<PostHogConfig>;
  }> = [];
  readonly captureCalls: Array<{ event: string; properties?: Properties }> = [];
  optInCalls = 0;
  optOutCalls = 0;
  resetCalls = 0;
  stopSessionRecordingCalls = 0;

  init(apiKey: string, config: Partial<PostHogConfig>): void {
    this.initCalls.push({ apiKey, config });
  }

  capture(event: string, properties?: Properties): void {
    this.captureCalls.push({ event, properties });
  }

  opt_in_capturing(options?: {
    captureEventName?: string | null | false;
  }): void {
    assert.equal(options?.captureEventName, false);
    this.optInCalls += 1;
  }

  opt_out_capturing(): void {
    this.optOutCalls += 1;
  }

  reset(): void {
    this.resetCalls += 1;
  }

  stopSessionRecording(): void {
    this.stopSessionRecordingCalls += 1;
  }
}

test('invalid consent values fail closed', () => {
  assert.equal(parseCookieConsentValue('accepted'), 'accepted');
  assert.equal(parseCookieConsentValue('denied'), 'denied');
  assert.equal(parseCookieConsentValue('yes'), null);
  assert.equal(parseCookieConsentValue(undefined), null);
});

test('React integration cannot bypass the audited controller', () => {
  const providerSource = readFileSync(
    new URL('../components/posthog-provider.tsx', import.meta.url),
    'utf8',
  );
  const bannerSource = readFileSync(
    new URL('../components/cookie-banner.tsx', import.meta.url),
    'utf8',
  );

  assert.match(providerSource, /createWebsiteAnalyticsController/u);
  assert.doesNotMatch(providerSource, /posthog\.(?:init|capture|opt_)/u);
  assert.match(bannerSource, /setCookieConsent\('accepted'\)/u);
  assert.match(bannerSource, /setCookieConsent\('denied'\)/u);
});

test('analytics URLs never contain credentials, queries, or fragments', () => {
  assert.equal(
    sanitizeWebsiteAnalyticsUrl(
      'https://user:password@ide.clodex.xyz/login?token=secret#callback',
    ),
    'https://ide.clodex.xyz/login',
  );
  assert.equal(sanitizeWebsiteAnalyticsUrl('file:///private/source.ts'), null);
  assert.equal(sanitizeWebsiteAnalyticsUrl('not a URL'), null);
});

test('before_send accepts only sanitized page views after consent', () => {
  const rawEvent: CaptureResult = {
    uuid: 'event-1',
    event: '$pageview',
    properties: {
      token: TEST_PROJECT_KEY,
      distinct_id: 'anonymous-id',
      $current_url:
        'https://ide.clodex.xyz/login?token=secret&email=user@example.com#x',
      $device_model: 'private-device-model',
      email: 'user@example.com',
      machineId: 'machine-secret',
      prompt: 'private prompt',
    },
  };

  assert.equal(
    sanitizeWebsitePostHogEvent(rawEvent, () => false),
    null,
  );
  assert.equal(
    sanitizeWebsitePostHogEvent(
      { ...rawEvent, event: '$autocapture' },
      () => true,
    ),
    null,
  );

  const sanitized = sanitizeWebsitePostHogEvent(rawEvent, () => true);
  assert.deepEqual(sanitized, {
    uuid: 'event-1',
    event: '$pageview',
    properties: {
      token: TEST_PROJECT_KEY,
      distinct_id: 'anonymous-id',
      $current_url: 'https://ide.clodex.xyz/login',
      $host: 'ide.clodex.xyz',
      $pathname: '/login',
    },
  });
});

test('PostHog config disables automatic and remotely loaded collection', () => {
  const config = createWebsitePostHogConfig(() => true, false);

  assert.equal(config.autocapture, false);
  assert.equal(config.rageclick, false);
  assert.equal(config.capture_pageview, false);
  assert.equal(config.capture_pageleave, false);
  assert.equal(config.capture_exceptions, false);
  assert.equal(config.capture_performance, false);
  assert.equal(config.capture_heatmaps, false);
  assert.equal(config.capture_dead_clicks, false);
  assert.equal(config.disable_session_recording, true);
  assert.equal(config.disable_surveys, true);
  assert.equal(config.disable_surveys_automatic_display, true);
  assert.equal(config.disable_product_tours, true);
  assert.equal(config.disable_conversations, true);
  assert.equal(config.disable_external_dependency_loading, true);
  assert.equal(config.disableDeviceModel, true);
  assert.equal(config.advanced_disable_flags, true);
  assert.equal(config.person_profiles, 'never');
  assert.equal(config.request_batching, false);
});

test('controller never initializes before Accept and stops after Deny', () => {
  const client = new FakePostHogClient();
  let consent: ConsentStatus = null;
  let currentUrl =
    'https://ide.clodex.xyz/download?token=secret&email=user@example.com';
  const controller = createWebsiteAnalyticsController({
    client,
    apiKey: TEST_PROJECT_KEY,
    getConsent: () => consent,
    getCurrentUrl: () => currentUrl,
  });

  controller.syncConsent();
  assert.equal(client.initCalls.length, 0);
  assert.equal(client.captureCalls.length, 0);

  consent = 'denied';
  controller.syncConsent();
  assert.equal(client.initCalls.length, 0);
  assert.equal(client.captureCalls.length, 0);
  assert.equal(controller.capturePageView(), false);

  consent = 'accepted';
  controller.syncConsent();
  controller.syncConsent(); // React Strict Mode effect replay.
  assert.equal(client.initCalls.length, 1);
  assert.equal(client.captureCalls.length, 1);
  assert.deepEqual(client.captureCalls[0], {
    event: '$pageview',
    properties: { $current_url: 'https://ide.clodex.xyz/download' },
  });

  currentUrl = 'https://ide.clodex.xyz/privacy?access_token=private#choice';
  assert.equal(controller.capturePageView(), true);
  assert.deepEqual(client.captureCalls[1], {
    event: '$pageview',
    properties: { $current_url: 'https://ide.clodex.xyz/privacy' },
  });

  consent = 'denied';
  controller.syncConsent();
  assert.equal(controller.isEnabled(), false);
  assert.equal(client.optOutCalls, 1);
  assert.equal(client.resetCalls, 1);
  assert.equal(client.stopSessionRecordingCalls, 1);
  assert.equal(controller.capturePageView(), false);
  assert.equal(client.captureCalls.length, 2);
});
