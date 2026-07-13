import { describe, expect, it } from 'vitest';
import {
  browserEgressPackagedAcceptanceManifestSchema,
  serializeBrowserEgressPackagedAcceptanceManifest,
  type BrowserEgressPackagedAcceptanceManifest,
} from './browser-egress-packaged-acceptance';

const validManifest = (): BrowserEgressPackagedAcceptanceManifest => ({
  schemaVersion: 1,
  kind: 'browser-egress-packaged-acceptance',
  createdAt: '2026-07-13T07:20:00.000Z',
  result: 'passed',
  app: {
    platform: 'darwin',
    architecture: 'arm64',
    releaseChannel: 'prerelease',
    version: '1.16.0-preview.2',
  },
  enforcement: {
    outcome: 'fail-closed',
    browserSignal: 'proxy-denial-response',
    promptObserved: false,
    allowReasonCode: 'exact-destination-grant',
    denyReasonCode: 'loopback-denied',
  },
  checks: {
    packagedAppLaunched: true,
    realUiBrowserTabOpened: true,
    localNavigationSucceeded: true,
    auditChainVerified: true,
    blockedAttemptFailClosed: true,
    zeroSinkConnections: true,
    zeroSinkRequests: true,
    zeroSinkBodyBytes: true,
  },
  counts: {
    localFixtureRequests: 1,
    allowedAuditDecisions: 1,
    deniedAuditDecisions: 1,
    sinkConnections: 0,
    sinkRequests: 0,
    sinkBodyBytes: 0,
    unexpectedAllows: 0,
  },
  audit: {
    verified: true,
    policyHash: 'a'.repeat(64),
    terminalEventHash: 'b'.repeat(64),
  },
  retention: {
    rawLogs: false,
    rawAudit: false,
    networkAddresses: false,
    responseBodies: false,
    screenshots: false,
    profileData: false,
    inheritedSecrets: false,
  },
});

describe('browser egress packaged acceptance manifest', () => {
  it('serializes only content-free results, counts, reason codes, and hashes', () => {
    const serialized = serializeBrowserEgressPackagedAcceptanceManifest(
      validManifest(),
    );

    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain('localhost');
    expect(serialized).not.toContain('http://');
    expect(serialized).not.toContain('<html');
    expect(serialized).not.toContain('Search or type a URL');
    expect(JSON.parse(serialized)).toEqual(validManifest());
  });

  it('rejects stable builds where controlled egress gates are unavailable', () => {
    const manifest = validManifest() as unknown as Record<string, unknown>;
    manifest.app = {
      ...(manifest.app as object),
      releaseChannel: 'release',
    };

    expect(
      browserEgressPackagedAcceptanceManifestSchema.safeParse(manifest).success,
    ).toBe(false);
  });

  it('rejects content-bearing extensions at every manifest boundary', () => {
    const topLevel = {
      ...validManifest(),
      destinationUrl: 'http://127.0.0.1/private',
    };
    const nested = validManifest() as unknown as Record<string, unknown>;
    nested.audit = {
      ...(nested.audit as object),
      responseBody: 'fixture content',
    };

    expect(
      browserEgressPackagedAcceptanceManifestSchema.safeParse(topLevel).success,
    ).toBe(false);
    expect(
      browserEgressPackagedAcceptanceManifestSchema.safeParse(nested).success,
    ).toBe(false);
  });
});
