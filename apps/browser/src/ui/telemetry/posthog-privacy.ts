import type {
  BeforeSendFn,
  CaptureResult,
  PostHogConfig,
  Properties,
} from 'posthog-js';
import type { TelemetryLevel } from '@shared/karton-contracts/ui/shared-types';

type FutureSafePostHogConfig = Partial<PostHogConfig> & {
  /** Added by newer posthog-js releases; ignored safely by 1.379.1. */
  disableDeviceModel: true;
};

export interface RendererPostHogClient {
  _isIdentified(): boolean;
  get_distinct_id(): string;
  identify(distinctId: string, properties?: Properties): void;
  init(apiKey: string, config: Partial<PostHogConfig>): void;
  opt_in_capturing(options?: {
    captureEventName?: string | null | false;
  }): void;
  opt_out_capturing(): void;
  register(properties: Properties): void;
  reset(): void;
  stopSessionRecording(): void;
}

export interface RendererTelemetryMetadata {
  product: 'clodex-browser';
  app_name: string;
  app_version: string;
  app_release_channel: string;
  app_platform: string;
  app_arch: string;
}

export interface RendererTelemetryState {
  rendererEnabled: boolean;
  telemetryLevel: TelemetryLevel;
  disabledInDevelopment: boolean;
  apiKey: string | undefined;
  apiHost: string | undefined;
  userId: string | undefined;
}

export function createRendererPostHogConfig(
  apiHost: string | undefined,
  debug: boolean,
  beforeSend: BeforeSendFn,
): FutureSafePostHogConfig {
  return {
    api_host: apiHost,
    ui_host: 'https://us.posthog.com',
    before_send: beforeSend,
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
    opt_out_capturing_by_default: true,
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
    property_denylist: ['email', '$email', 'machineId', 'machine_id'],
    debug,
  };
}

export function createRendererIdentity(
  telemetryLevel: TelemetryLevel,
  userId: string | undefined,
): { distinctId: string; properties: Properties } | null {
  if (telemetryLevel !== 'full' || !userId) return null;
  return {
    distinctId: userId,
    properties: { telemetryLevel: 'full' },
  };
}

function isForbiddenIdentityProperty(name: string): boolean {
  const normalized = name.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  return normalized === 'email' || normalized === 'machineid';
}

function stripForbiddenIdentityProperties(
  properties: Properties | undefined,
): Properties | undefined {
  if (!properties) return undefined;
  return Object.fromEntries(
    Object.entries(properties).filter(
      ([name]) => !isForbiddenIdentityProperty(name),
    ),
  ) as Properties;
}

export function sanitizeRendererPostHogEvent(
  event: CaptureResult | null,
  telemetryLevel: TelemetryLevel,
  next: BeforeSendFn,
): CaptureResult | null {
  if (!event || telemetryLevel === 'off') return null;
  // Explicit captureException calls can contain messages, stacks, paths, and
  // component state. They require the separately selected full level.
  if (event.event === '$exception' && telemetryLevel !== 'full') return null;

  const sanitized: CaptureResult = {
    ...event,
    properties: stripForbiddenIdentityProperties(event.properties) ?? {},
  };
  const safeSet = stripForbiddenIdentityProperties(event.$set);
  const safeSetOnce = stripForbiddenIdentityProperties(event.$set_once);
  if (safeSet) sanitized.$set = safeSet;
  if (safeSetOnce) sanitized.$set_once = safeSetOnce;
  return next(sanitized);
}

interface RendererPostHogControllerOptions {
  client: RendererPostHogClient;
  metadata: RendererTelemetryMetadata;
  beforeSend: BeforeSendFn;
  debug: boolean;
}

export interface RendererPostHogController {
  sync(state: RendererTelemetryState): void;
}

/**
 * Keeps SDK initialization, consent, and identity transitions in one audited
 * state machine. `off` never initializes PostHog and always leaves the client
 * opted out; moving away from `full` scrubs any persisted legacy identity.
 */
export function createRendererPostHogController({
  client,
  metadata,
  beforeSend,
  debug,
}: RendererPostHogControllerOptions): RendererPostHogController {
  let initializedKey: string | null = null;
  let registeredKey: string | null = null;
  let privacyScrubbedKey: string | null = null;
  let identifiedUserId: string | null = null;
  let disabledStateApplied = false;
  let activeTelemetryLevel: TelemetryLevel = 'off';

  const privacyBeforeSend: BeforeSendFn = (event) =>
    sanitizeRendererPostHogEvent(event, activeTelemetryLevel, beforeSend);

  const registerMetadata = (key: string) => {
    if (registeredKey === key) return;
    client.register({ ...metadata });
    registeredKey = key;
  };

  const resetIdentity = () => {
    registeredKey = null;
    identifiedUserId = null;
    client.reset();
  };

  const disable = () => {
    activeTelemetryLevel = 'off';
    if (disabledStateApplied) return;
    privacyScrubbedKey = null;

    try {
      client.stopSessionRecording();
    } catch {}
    try {
      // Clear identifiers and legacy email/machine properties before
      // persisting the opt-out state. Safe to call before init.
      resetIdentity();
    } catch {}
    try {
      client.opt_out_capturing();
      disabledStateApplied = true;
    } catch {}
    // The next sync remains disabled and will never initialize the SDK.
  };

  return {
    sync(state) {
      const shouldEnable =
        state.rendererEnabled &&
        state.telemetryLevel !== 'off' &&
        !state.disabledInDevelopment &&
        Boolean(state.apiKey);

      if (!shouldEnable || !state.apiKey) {
        disable();
        return;
      }

      disabledStateApplied = false;
      activeTelemetryLevel = state.telemetryLevel;
      const initKey = `${state.apiKey}::${state.apiHost ?? ''}`;

      try {
        if (initializedKey !== initKey) {
          client.init(
            state.apiKey,
            createRendererPostHogConfig(
              state.apiHost,
              debug,
              privacyBeforeSend,
            ),
          );
          initializedKey = initKey;
          registeredKey = null;
          privacyScrubbedKey = null;
          identifiedUserId = null;
        }

        // Scrub identifiers persisted by older builds once for every init
        // target, before any opted-in event can leave the renderer.
        if (privacyScrubbedKey !== initKey) {
          resetIdentity();
          privacyScrubbedKey = initKey;
        }

        const identity = createRendererIdentity(
          state.telemetryLevel,
          state.userId,
        );
        if (
          !identity &&
          (identifiedUserId !== null || client._isIdentified())
        ) {
          resetIdentity();
        }

        registerMetadata(initKey);
        client.opt_in_capturing({ captureEventName: false });

        if (identity) {
          const needsIdentityChange =
            identifiedUserId !== identity.distinctId ||
            !client._isIdentified() ||
            client.get_distinct_id() !== identity.distinctId;
          if (needsIdentityChange) {
            if (client._isIdentified()) {
              resetIdentity();
              registerMetadata(initKey);
              client.opt_in_capturing({ captureEventName: false });
            }
            client.identify(identity.distinctId, identity.properties);
            identifiedUserId = identity.distinctId;
          }
        }
      } catch {
        disable();
      }
    },
  };
}
