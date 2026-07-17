import type { TelemetryLevel } from './karton-contracts/ui/shared-types';
import communityObservedTelemetryContract from './community-observed-telemetry-contract.json';

/**
 * Bump this only when the anonymous telemetry disclosure or data contract
 * changes in a way that requires users to make a fresh choice.
 */
export const COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION =
  communityObservedTelemetryContract.consentVersion;
export const COMMUNITY_OBSERVED_TELEMETRY_CONSENT_UI_ASSERTION =
  communityObservedTelemetryContract.consentUiAssertion;

export type CommunityObservedTelemetryPrivacy = {
  telemetryLevel: TelemetryLevel;
  anonymousTelemetryConsentVersion: number;
};

export function hasCurrentCommunityObservedTelemetryDecision(
  privacy: CommunityObservedTelemetryPrivacy,
): boolean {
  return (
    privacy.anonymousTelemetryConsentVersion ===
      COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION &&
    (privacy.telemetryLevel === 'anonymous' || privacy.telemetryLevel === 'off')
  );
}

export function getCommunityObservedTelemetryLevel(
  privacy: CommunityObservedTelemetryPrivacy,
): Extract<TelemetryLevel, 'off' | 'anonymous'> {
  return hasCurrentCommunityObservedTelemetryDecision(privacy) &&
    privacy.telemetryLevel === 'anonymous'
    ? 'anonymous'
    : 'off';
}

export function shouldShowCommunityObservedTelemetryConsent(
  telemetryMode: string,
  privacy: CommunityObservedTelemetryPrivacy,
): boolean {
  return (
    telemetryMode === 'anonymous-backend-only' &&
    !hasCurrentCommunityObservedTelemetryDecision(privacy)
  );
}
