import { __APP_RELEASE_CHANNEL__, __APP_VERSION__ } from '../build-constants';
import { assertIsolatedAgentRuntimeObservationBuildReady } from '../src/shared/isolated-agent-runtime-observation-build';

try {
  const readiness = assertIsolatedAgentRuntimeObservationBuildReady({
    releaseChannel: __APP_RELEASE_CHANNEL__,
    appVersion: __APP_VERSION__,
    posthogApiKey: process.env.POSTHOG_API_KEY,
  });

  console.log(
    [
      'ISOLATED_AGENT_RUNTIME_OBSERVATION_BUILD',
      'ready=true',
      `channel=${readiness.releaseChannel}`,
      `version=${readiness.appVersion}`,
      `eventCount=${readiness.eventNames.length}`,
      'exit=0',
    ].join(' '),
  );
} catch (error) {
  console.error(
    'ISOLATED_AGENT_RUNTIME_OBSERVATION_BUILD ready=false exit=1',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}
