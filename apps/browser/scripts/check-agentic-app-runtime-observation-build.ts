import { __APP_RELEASE_CHANNEL__, __APP_VERSION__ } from '../build-constants';
import { assertAgenticAppRuntimeObservationBuildReady } from '../src/shared/agentic-app-runtime-observation-build';

try {
  const readiness = assertAgenticAppRuntimeObservationBuildReady({
    releaseChannel: __APP_RELEASE_CHANNEL__,
    appVersion: __APP_VERSION__,
    posthogApiKey: process.env.POSTHOG_API_KEY,
  });
  console.log(
    [
      'AGENTIC_APP_RUNTIME_OBSERVATION_BUILD',
      'ready=true',
      `channel=${readiness.releaseChannel}`,
      `version=${readiness.appVersion}`,
      `gateCount=${readiness.enabledGateIds.length}`,
      `event=${readiness.eventName}`,
      'exit=0',
    ].join(' '),
  );
} catch (error) {
  console.error(
    'AGENTIC_APP_RUNTIME_OBSERVATION_BUILD ready=false exit=1',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}
