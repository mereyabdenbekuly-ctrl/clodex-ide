import type { AppTelemetryMode } from '@shared/local-build-identity';

/**
 * Identifiable account telemetry is only available in the standard official
 * telemetry mode. Community Observed is deliberately anonymous-backend-only;
 * offering the full opt-in there would write an invalid preference and reopen
 * the mandatory anonymous-consent gate.
 */
export function supportsIdentifiableTelemetryOptIn(
  telemetryMode: AppTelemetryMode,
): boolean {
  return telemetryMode === 'standard';
}
