import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION,
  getCommunityObservedTelemetryLevel,
  hasCurrentCommunityObservedTelemetryDecision,
  shouldShowCommunityObservedTelemetryConsent,
} from './community-observed-telemetry-consent';
import communityObservedTelemetryContract from './community-observed-telemetry-contract.json';

describe('community observed telemetry consent', () => {
  it('keeps the canonical backend and UI assertions on the same version', () => {
    const backendAssertion = JSON.parse(
      communityObservedTelemetryContract.backendArtifactAssertion.slice(
        'clodex-community-observed-contract:'.length,
      ),
    );
    const uiAssertion = JSON.parse(
      communityObservedTelemetryContract.consentUiAssertion.slice(
        'clodex-community-observed-consent-ui:'.length,
      ),
    );

    expect(backendAssertion.consentVersion).toBe(
      COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION,
    );
    expect(uiAssertion.version).toBe(
      COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION,
    );
  });

  it('requires a choice only for an observed build with no current decision', () => {
    expect(
      shouldShowCommunityObservedTelemetryConsent('anonymous-backend-only', {
        telemetryLevel: 'off',
        anonymousTelemetryConsentVersion: 0,
      }),
    ).toBe(true);
    expect(
      shouldShowCommunityObservedTelemetryConsent('anonymous-backend-only', {
        telemetryLevel: 'off',
        anonymousTelemetryConsentVersion:
          COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION,
      }),
    ).toBe(false);
    expect(
      shouldShowCommunityObservedTelemetryConsent('standard', {
        telemetryLevel: 'off',
        anonymousTelemetryConsentVersion: 0,
      }),
    ).toBe(false);
    expect(
      shouldShowCommunityObservedTelemetryConsent('anonymous-backend-only', {
        telemetryLevel: 'full',
        anonymousTelemetryConsentVersion:
          COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION,
      }),
    ).toBe(true);
  });

  it('requires both the current decision and anonymous level before sending', () => {
    expect(
      getCommunityObservedTelemetryLevel({
        telemetryLevel: 'anonymous',
        anonymousTelemetryConsentVersion: 0,
      }),
    ).toBe('off');
    expect(
      getCommunityObservedTelemetryLevel({
        telemetryLevel: 'off',
        anonymousTelemetryConsentVersion:
          COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION,
      }),
    ).toBe('off');
    expect(
      getCommunityObservedTelemetryLevel({
        telemetryLevel: 'full',
        anonymousTelemetryConsentVersion:
          COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION,
      }),
    ).toBe('off');
    expect(
      getCommunityObservedTelemetryLevel({
        telemetryLevel: 'anonymous',
        anonymousTelemetryConsentVersion:
          COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION,
      }),
    ).toBe('anonymous');
  });

  it('fails closed on an unknown future consent version', () => {
    expect(
      hasCurrentCommunityObservedTelemetryDecision({
        telemetryLevel: 'off',
        anonymousTelemetryConsentVersion:
          COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION + 1,
      }),
    ).toBe(false);
  });
});
