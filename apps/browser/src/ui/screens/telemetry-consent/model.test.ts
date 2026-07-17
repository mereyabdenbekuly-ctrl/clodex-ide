import { applyPatches, enablePatches } from 'immer';
import { describe, expect, it } from 'vitest';
import { defaultUserPreferences } from '@shared/karton-contracts/ui/shared-types';
import { COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION } from '@shared/community-observed-telemetry-consent';
import { createCommunityObservedTelemetryConsentPatches } from './model';

enablePatches();

describe('community observed telemetry consent patches', () => {
  it('atomically records an allow choice and anonymous level', () => {
    const next = applyPatches(
      defaultUserPreferences,
      createCommunityObservedTelemetryConsentPatches('allow'),
    );

    expect(next.privacy).toEqual({
      telemetryLevel: 'anonymous',
      anonymousTelemetryConsentVersion:
        COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION,
    });
  });

  it('atomically records a decline and hard-off level', () => {
    const current = structuredClone(defaultUserPreferences);
    current.privacy.telemetryLevel = 'anonymous';
    const next = applyPatches(
      current,
      createCommunityObservedTelemetryConsentPatches('decline'),
    );

    expect(next.privacy).toEqual({
      telemetryLevel: 'off',
      anonymousTelemetryConsentVersion:
        COMMUNITY_OBSERVED_TELEMETRY_CONSENT_VERSION,
    });
  });
});
