import { isolatedAgentRuntimeObservationEventNames } from './agent-runtime-telemetry';
import {
  getIsolatedAgentRuntimeRolloutPolicy,
  type IsolatedAgentRuntimeReleaseChannel,
} from './isolated-agent-runtime-policy';

export interface IsolatedAgentRuntimeObservationBuildInput {
  releaseChannel: IsolatedAgentRuntimeReleaseChannel;
  appVersion: string;
  posthogApiKey: string | undefined;
}

export interface IsolatedAgentRuntimeObservationBuildReadiness {
  releaseChannel: 'prerelease';
  appVersion: string;
  eventNames: typeof isolatedAgentRuntimeObservationEventNames;
}

const supportedObservationPrereleaseVersion =
  /^(?:\d+\.\d+\.\d+-(?:alpha|beta)\d{3}|\d+\.\d+\.\d+-preview\.[1-9]\d*)$/;

export function assertIsolatedAgentRuntimeObservationBuildReady(
  input: IsolatedAgentRuntimeObservationBuildInput,
): IsolatedAgentRuntimeObservationBuildReadiness {
  if (input.releaseChannel !== 'prerelease') {
    throw new Error(
      `observation build must use releaseChannel="prerelease"; received ${JSON.stringify(input.releaseChannel)}`,
    );
  }

  if (!supportedObservationPrereleaseVersion.test(input.appVersion)) {
    throw new Error(
      'observation build version must use alphaNNN, betaNNN, or the explicit preview.N technical-preview format',
    );
  }

  const policy = getIsolatedAgentRuntimeRolloutPolicy('prerelease');
  if (!policy.defaultEnabled || policy.rolloutStage !== 'canary') {
    throw new Error(
      'prerelease isolated agent runtime policy must be default-on canary',
    );
  }

  if (!input.posthogApiKey?.trim()) {
    throw new Error(
      'POSTHOG_API_KEY is required so the prerelease observation events are delivered',
    );
  }

  return {
    releaseChannel: 'prerelease',
    appVersion: input.appVersion,
    eventNames: isolatedAgentRuntimeObservationEventNames,
  };
}
