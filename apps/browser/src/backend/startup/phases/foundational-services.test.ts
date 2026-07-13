import type { Logger } from '../../services/logger';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const telemetryService = { service: 'telemetry' };
  const telemetryConstructor = vi.fn();

  return {
    faviconCreate: vi.fn(),
    identifierCreate: vi.fn(),
    localPortsScannerCreate: vi.fn(),
    preferencesCreate: vi.fn(),
    preferencesGet: vi.fn(),
    resolveFeatureGate: vi.fn(),
    telemetryConstructor,
    telemetryService,
    TelemetryService: vi.fn((...args: unknown[]) => {
      telemetryConstructor(...args);
      return telemetryService;
    }),
    webDataCreate: vi.fn(),
  };
});

vi.mock('@shared/feature-gates', () => ({
  resolveFeatureGate: mocks.resolveFeatureGate,
}));

vi.mock('../../services/favicon', () => ({
  FaviconService: { create: mocks.faviconCreate },
}));

vi.mock('../../services/identifier', () => ({
  IdentifierService: { create: mocks.identifierCreate },
}));

vi.mock('../../services/local-ports-scanner', () => ({
  LocalPortsScannerService: { create: mocks.localPortsScannerCreate },
}));

vi.mock('../../services/preferences', () => ({
  PreferencesService: { create: mocks.preferencesCreate },
}));

vi.mock('../../services/telemetry', () => ({
  TelemetryService: mocks.TelemetryService,
}));

vi.mock('../../services/webdata', () => ({
  WebDataService: { create: mocks.webDataCreate },
}));

import { runFoundationalServicesPhase } from './foundational-services';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const logger = {} as Logger;
const services = {
  preferencesService: { get: mocks.preferencesGet },
  identifierService: { service: 'identifier' },
  webDataService: { service: 'webdata' },
  faviconService: { service: 'favicon' },
  localPortsScannerService: { service: 'local-ports-scanner' },
};

function mockResolvedServices() {
  mocks.preferencesCreate.mockResolvedValue(services.preferencesService);
  mocks.identifierCreate.mockResolvedValue(services.identifierService);
  mocks.webDataCreate.mockResolvedValue(services.webDataService);
  mocks.faviconCreate.mockResolvedValue(services.faviconService);
  mocks.localPortsScannerCreate.mockResolvedValue(
    services.localPortsScannerService,
  );
}

describe('runFoundationalServicesPhase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts independent services in parallel before creating telemetry', async () => {
    const invocationOrder: string[] = [];
    const pending = {
      preferences: deferred<typeof services.preferencesService>(),
      identifier: deferred<typeof services.identifierService>(),
      webData: deferred<typeof services.webDataService>(),
      favicon: deferred<typeof services.faviconService>(),
      localPortsScanner: deferred<typeof services.localPortsScannerService>(),
    };

    mocks.preferencesCreate.mockImplementation(() => {
      invocationOrder.push('preferences');
      return pending.preferences.promise;
    });
    mocks.identifierCreate.mockImplementation(() => {
      invocationOrder.push('identifier');
      return pending.identifier.promise;
    });
    mocks.webDataCreate.mockImplementation(() => {
      invocationOrder.push('webdata');
      return pending.webData.promise;
    });
    mocks.faviconCreate.mockImplementation(() => {
      invocationOrder.push('favicon');
      return pending.favicon.promise;
    });
    mocks.localPortsScannerCreate.mockImplementation(() => {
      invocationOrder.push('local-ports-scanner');
      return pending.localPortsScanner.promise;
    });

    const phasePromise = runFoundationalServicesPhase({
      logger,
      releaseChannel: 'prerelease',
    });

    expect(invocationOrder).toEqual([
      'preferences',
      'identifier',
      'webdata',
      'favicon',
      'local-ports-scanner',
    ]);
    expect(mocks.preferencesCreate).toHaveBeenCalledWith(logger);
    expect(mocks.identifierCreate).toHaveBeenCalledWith(logger);
    expect(mocks.webDataCreate).toHaveBeenCalledWith(logger);
    expect(mocks.faviconCreate).toHaveBeenCalledWith(logger);
    expect(mocks.localPortsScannerCreate).toHaveBeenCalledWith(logger);
    expect(mocks.telemetryConstructor).not.toHaveBeenCalled();

    pending.preferences.resolve(services.preferencesService);
    pending.identifier.resolve(services.identifierService);
    pending.favicon.resolve(services.faviconService);
    pending.localPortsScanner.resolve(services.localPortsScannerService);
    await Promise.resolve();

    expect(mocks.telemetryConstructor).not.toHaveBeenCalled();

    pending.webData.resolve(services.webDataService);
    const result = await phasePromise;

    expect(mocks.telemetryConstructor).toHaveBeenCalledWith(
      services.identifierService,
      services.preferencesService,
      logger,
    );
    expect(result).toMatchObject({
      ...services,
      telemetryService: mocks.telemetryService,
    });
  });

  it('resolves feature gates from current preferences and the startup channel', async () => {
    mockResolvedServices();
    let overrides = { 'egress-policy-engine': true };
    mocks.preferencesGet.mockImplementation(() => ({
      featureGates: { overrides },
    }));
    mocks.resolveFeatureGate.mockImplementation(
      (feature: string, currentOverrides: Record<string, boolean>) => ({
        enabled: currentOverrides[feature] ?? false,
      }),
    );

    const result = await runFoundationalServicesPhase({
      logger,
      releaseChannel: 'prerelease',
    });

    expect(mocks.preferencesGet).not.toHaveBeenCalled();
    expect(result.startupFeatureEnabled('egress-policy-engine')).toBe(true);
    expect(mocks.resolveFeatureGate).toHaveBeenLastCalledWith(
      'egress-policy-engine',
      overrides,
      'prerelease',
    );

    overrides = { 'egress-policy-engine': false };

    expect(result.startupFeatureEnabled('egress-policy-engine')).toBe(false);
    expect(mocks.preferencesGet).toHaveBeenCalledTimes(2);
    expect(mocks.resolveFeatureGate).toHaveBeenLastCalledWith(
      'egress-policy-engine',
      overrides,
      'prerelease',
    );
  });
});
