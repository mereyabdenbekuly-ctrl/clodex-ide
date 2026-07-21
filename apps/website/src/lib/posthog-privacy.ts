import type { CaptureResult, PostHogConfig, Properties } from 'posthog-js';
import type { ConsentStatus } from './cookie-consent-utils';

type FutureSafePostHogConfig = Partial<PostHogConfig> & {
  /** Added by newer posthog-js releases; ignored safely by 1.379.1. */
  disableDeviceModel: true;
};

export const WEBSITE_POSTHOG_ALLOWED_EVENT = '$pageview' as const;

export const WEBSITE_POSTHOG_ALLOWED_PROPERTIES = Object.freeze([
  'token',
  'distinct_id',
  '$device_id',
  '$session_id',
  '$window_id',
  '$insert_id',
  '$lib',
  '$lib_version',
  '$browser',
  '$browser_version',
  '$os',
  '$os_version',
  '$device_type',
  '$process_person_profile',
] as const);

const allowedPropertyNames = new Set<string>(
  WEBSITE_POSTHOG_ALLOWED_PROPERTIES,
);

function isAllowedScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Analytics never receives query strings, fragments, credentials, or non-web
 * protocols. This remains true even after the visitor accepts analytics.
 */
export function sanitizeWebsiteAnalyticsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export function sanitizeWebsitePostHogEvent(
  event: CaptureResult | null,
  isConsentAccepted: () => boolean,
): CaptureResult | null {
  if (!isConsentAccepted()) return null;
  if (!event || event.event !== WEBSITE_POSTHOG_ALLOWED_EVENT) return null;

  const safeUrl = sanitizeWebsiteAnalyticsUrl(event.properties.$current_url);
  if (!safeUrl) return null;

  const safeProperties: Properties = {};
  for (const [name, value] of Object.entries(event.properties)) {
    if (allowedPropertyNames.has(name) && isAllowedScalar(value)) {
      safeProperties[name] = value;
    }
  }

  const parsedUrl = new URL(safeUrl);
  safeProperties.$current_url = safeUrl;
  safeProperties.$host = parsedUrl.host;
  safeProperties.$pathname = parsedUrl.pathname;

  const safeEvent: CaptureResult = {
    uuid: event.uuid,
    event: WEBSITE_POSTHOG_ALLOWED_EVENT,
    properties: safeProperties,
  };
  if (event.timestamp) safeEvent.timestamp = event.timestamp;
  return safeEvent;
}

export function createWebsitePostHogConfig(
  isConsentAccepted: () => boolean,
  debug: boolean,
): FutureSafePostHogConfig {
  return {
    api_host: '/ingest',
    ui_host: 'https://us.posthog.com',
    autocapture: false,
    rageclick: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_exceptions: false,
    capture_performance: false,
    capture_heatmaps: false,
    capture_dead_clicks: false,
    disable_session_recording: true,
    enable_recording_console_log: false,
    disable_surveys: true,
    disable_surveys_automatic_display: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    disable_external_dependency_loading: true,
    disableDeviceModel: true,
    advanced_disable_flags: true,
    advanced_disable_feature_flags: true,
    advanced_disable_feature_flags_on_first_load: true,
    person_profiles: 'never',
    save_referrer: false,
    save_campaign_params: false,
    persistence: 'memory',
    cross_subdomain_cookie: false,
    opt_out_capturing_by_default: true,
    opt_out_capturing_persistence_type: 'cookie',
    opt_out_persistence_by_default: true,
    respect_dnt: true,
    request_batching: false,
    mask_all_text: true,
    mask_all_element_attributes: true,
    mask_personal_data_properties: true,
    custom_personal_data_properties: [
      'email',
      'token',
      'access_token',
      'code',
      'state',
    ],
    property_denylist: [
      'email',
      '$email',
      'machineId',
      'machine_id',
      'prompt',
      'response',
      'source_code',
      'file_path',
    ],
    debug,
    before_send: (event) =>
      sanitizeWebsitePostHogEvent(event, isConsentAccepted),
  };
}

export interface WebsitePostHogClient {
  init(apiKey: string, config: Partial<PostHogConfig>): void;
  capture(event: string, properties?: Properties): void;
  opt_in_capturing(options?: {
    captureEventName?: string | null | false;
  }): void;
  opt_out_capturing(): void;
  reset(): void;
  stopSessionRecording(): void;
}

interface WebsiteAnalyticsControllerOptions {
  client: WebsitePostHogClient;
  apiKey: string | undefined;
  getConsent: () => ConsentStatus;
  getCurrentUrl: () => string;
  debug?: boolean;
}

export interface WebsiteAnalyticsController {
  syncConsent(): void;
  capturePageView(url?: string): boolean;
  isInitialized(): boolean;
  isEnabled(): boolean;
}

/**
 * Small state machine used by the React provider and by privacy tests. Network
 * capable SDK methods are unreachable until the exact `accepted` state.
 */
export function createWebsiteAnalyticsController({
  client,
  apiKey,
  getConsent,
  getCurrentUrl,
  debug = false,
}: WebsiteAnalyticsControllerOptions): WebsiteAnalyticsController {
  let initialized = false;
  let enabled = false;

  const consentAccepted = () => getConsent() === 'accepted';

  const disable = () => {
    // Close the local gate before touching the SDK so concurrent navigation
    // effects cannot enqueue another event during withdrawal.
    enabled = false;
    if (!initialized) return;

    try {
      client.stopSessionRecording();
    } catch {}
    try {
      client.reset();
    } catch {}
    try {
      client.opt_out_capturing();
    } catch {}
    // The local gate remains closed even if a third-party SDK method fails.
  };

  const enable = (): boolean => {
    if (!apiKey || !consentAccepted()) {
      disable();
      return false;
    }

    try {
      if (!initialized) {
        client.init(apiKey, createWebsitePostHogConfig(consentAccepted, debug));
        initialized = true;
      }
      client.opt_in_capturing({ captureEventName: false });
      enabled = true;
      return true;
    } catch {
      enabled = false;
      return false;
    }
  };

  const capturePageView = (url = getCurrentUrl()): boolean => {
    if (!enabled || !consentAccepted()) return false;
    const safeUrl = sanitizeWebsiteAnalyticsUrl(url);
    if (!safeUrl) return false;

    client.capture(WEBSITE_POSTHOG_ALLOWED_EVENT, {
      $current_url: safeUrl,
    });
    return true;
  };

  return {
    syncConsent() {
      const wasEnabled = enabled;
      if (!enable()) return;
      if (!wasEnabled) capturePageView();
    },
    capturePageView,
    isInitialized: () => initialized,
    isEnabled: () => enabled,
  };
}
