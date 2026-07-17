import communityObservedTelemetryContract from '@shared/community-observed-telemetry-contract.json';

export const COMMUNITY_OBSERVED_RENDERER_POSTHOG_NOOP =
  communityObservedTelemetryContract.rendererPosthogNoop;

const noop = () => undefined;

const posthog = Object.freeze({
  __clodexTelemetryContract: COMMUNITY_OBSERVED_RENDERER_POSTHOG_NOOP,
  _isIdentified: () => false,
  alias: noop,
  capture: noop,
  captureException: noop,
  consent: Object.freeze({ optInOut: noop }),
  get_distinct_id: () => '',
  identify: noop,
  init: noop,
  opt_in_capturing: noop,
  opt_out_capturing: noop,
  register: noop,
  reset: noop,
  startSessionRecording: noop,
  stopSessionRecording: noop,
});

export default posthog;
