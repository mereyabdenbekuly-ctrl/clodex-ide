import {
  resolveFeatureGate,
  type AppReleaseChannel,
  type FeatureGateId,
} from '@shared/feature-gates';
import { FaviconService } from '../../services/favicon';
import { IdentifierService } from '../../services/identifier';
import { LocalPortsScannerService } from '../../services/local-ports-scanner';
import type { Logger } from '../../services/logger';
import { PreferencesService } from '../../services/preferences';
import { TelemetryService } from '../../services/telemetry';
import { WebDataService } from '../../services/webdata';

export type StartupFeatureGateResolver = (feature: FeatureGateId) => boolean;

export interface FoundationalServicesPhaseOptions {
  logger: Logger;
  releaseChannel: AppReleaseChannel;
}

export interface FoundationalServicesPhaseResult {
  preferencesService: PreferencesService;
  identifierService: IdentifierService;
  webDataService: WebDataService;
  faviconService: FaviconService;
  localPortsScannerService: LocalPortsScannerService;
  telemetryService: TelemetryService;
  startupFeatureEnabled: StartupFeatureGateResolver;
}

export async function runFoundationalServicesPhase(
  options: FoundationalServicesPhaseOptions,
): Promise<FoundationalServicesPhaseResult> {
  const { logger, releaseChannel } = options;

  // Bootstrap every service that has no inter-dependencies in parallel.
  // These were previously awaited one-by-one, serializing independent
  // disk/DB I/O and needlessly delaying the first window paint. They all
  // only need `logger`, so they can be created concurrently. Services with
  // dependencies are created in level order just below.
  const [
    preferencesService,
    identifierService,
    webDataService,
    faviconService,
    localPortsScannerService,
  ] = await Promise.all([
    PreferencesService.create(logger),
    IdentifierService.create(logger),
    // WebDataService must exist before HistoryService (history keyword IDs
    // reference the keywords table owned by WebDataService).
    WebDataService.create(logger),
    FaviconService.create(logger),
    // LocalPortsScannerService discovers local dev servers.
    LocalPortsScannerService.create(logger),
  ]);

  // TelemetryService depends on identifier + preferences.
  const telemetryService = new TelemetryService(
    identifierService,
    preferencesService,
    logger,
  );

  const startupFeatureEnabled: StartupFeatureGateResolver = (feature) =>
    resolveFeatureGate(
      feature,
      preferencesService.get().featureGates.overrides,
      releaseChannel,
    ).enabled;

  return {
    preferencesService,
    identifierService,
    webDataService,
    faviconService,
    localPortsScannerService,
    telemetryService,
    startupFeatureEnabled,
  };
}
