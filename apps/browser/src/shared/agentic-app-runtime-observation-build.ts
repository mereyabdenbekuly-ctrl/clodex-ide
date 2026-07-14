import { agenticAppRuntimeDogfoodEventName } from './agentic-app-runtime-telemetry';
import {
  agenticAppRuntimeDogfoodChannels,
  resolveFeatureGate,
  type AppReleaseChannel,
  type FeatureGateId,
} from './feature-gates';

export const agenticAppRuntimeObservationGateIds = [
  'artifact-bridge',
  'artifact-bridge-writes',
  'artifact-bridge-runtime-quotas',
  'artifact-bridge-lifecycle-events',
  'artifact-bridge-ephemeral-grants',
  'artifact-bridge-sensitive-egress',
  'artifact-bridge-async-operations',
  'artifact-bridge-runtime-inspector',
  'generated-app-packages',
  'generated-app-package-capabilities',
] as const satisfies readonly FeatureGateId[];

const supportedObservationPrereleaseVersion =
  /^(?:\d+\.\d+\.\d+-(?:alpha|beta)\d{3}|\d+\.\d+\.\d+-preview\.[1-9]\d*)$/;

export function assertAgenticAppRuntimeObservationBuildReady(input: {
  releaseChannel: AppReleaseChannel;
  appVersion: string;
  posthogApiKey: string | undefined;
}): {
  releaseChannel: 'prerelease';
  appVersion: string;
  eventName: typeof agenticAppRuntimeDogfoodEventName;
  enabledGateIds: typeof agenticAppRuntimeObservationGateIds;
} {
  if (input.releaseChannel !== 'prerelease') {
    throw new Error(
      `Agentic App Runtime observation build must use releaseChannel="prerelease"; received ${JSON.stringify(input.releaseChannel)}`,
    );
  }
  if (!supportedObservationPrereleaseVersion.test(input.appVersion)) {
    throw new Error(
      'Agentic App Runtime observation build version must use alphaNNN, betaNNN, or the explicit preview.N technical-preview format',
    );
  }
  if (!agenticAppRuntimeDogfoodChannels.includes(input.releaseChannel)) {
    throw new Error(
      'prerelease must remain an Agentic App Runtime dogfood channel',
    );
  }
  const disabled = agenticAppRuntimeObservationGateIds.filter(
    (gateId) => !resolveFeatureGate(gateId, {}, input.releaseChannel).enabled,
  );
  if (disabled.length > 0) {
    throw new Error(
      `Agentic App Runtime observation gates must be default-on: ${disabled.join(', ')}`,
    );
  }
  if (!input.posthogApiKey?.trim()) {
    throw new Error(
      'POSTHOG_API_KEY is required for Agentic App Runtime dogfood telemetry',
    );
  }
  return {
    releaseChannel: 'prerelease',
    appVersion: input.appVersion,
    eventName: agenticAppRuntimeDogfoodEventName,
    enabledGateIds: agenticAppRuntimeObservationGateIds,
  };
}
