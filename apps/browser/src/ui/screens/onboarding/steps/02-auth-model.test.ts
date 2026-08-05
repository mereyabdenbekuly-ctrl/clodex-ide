import { describe, expect, it } from 'vitest';
import { supportsIdentifiableTelemetryOptIn } from './02-auth-model';

describe('supportsIdentifiableTelemetryOptIn', () => {
  it('allows the explicit identifiable opt-in in standard telemetry mode', () => {
    expect(supportsIdentifiableTelemetryOptIn('standard')).toBe(true);
  });

  it.each([
    'anonymous-backend-only',
    'disabled',
  ] as const)('hides the identifiable opt-in in %s mode', (telemetryMode) => {
    expect(supportsIdentifiableTelemetryOptIn(telemetryMode)).toBe(false);
  });
});
