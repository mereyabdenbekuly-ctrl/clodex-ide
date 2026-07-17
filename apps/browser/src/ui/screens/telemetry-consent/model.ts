import type { Patch } from 'immer';
import { COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION } from '@shared/community-observed-telemetry-consent';

export type CommunityObservedTelemetryChoice = 'allow' | 'decline';

/**
 * Both fields are written in one PreferencesService update so the backend can
 * never observe a granted marker without the matching anonymous level (or an
 * anonymous level without the current marker).
 */
export function createCommunityObservedTelemetryConsentPatches(
  choice: CommunityObservedTelemetryChoice,
): Patch[] {
  return [
    {
      op: 'replace',
      path: ['privacy', 'telemetryLevel'],
      value: choice === 'allow' ? 'anonymous' : 'off',
    },
    {
      op: 'replace',
      path: ['privacy', 'anonymousTelemetryConsentVersion'],
      value: COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION,
    },
  ];
}
