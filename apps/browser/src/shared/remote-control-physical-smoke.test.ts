import { describe, expect, it } from 'vitest';
import {
  createRemoteControlPhysicalSmokeReport,
  remoteControlPhysicalSmokeCheckIdSchema,
  remoteControlPhysicalSmokeReportSchema,
} from './remote-control-physical-smoke';

function passedChecks() {
  return Object.fromEntries(
    remoteControlPhysicalSmokeCheckIdSchema.options.map((check) => [
      check,
      true,
    ]),
  ) as Record<
    (typeof remoteControlPhysicalSmokeCheckIdSchema.options)[number],
    boolean
  >;
}

describe('remote control physical smoke evidence', () => {
  it('creates a fixed-shape privacy-safe passed report', () => {
    const report = createRemoteControlPhysicalSmokeReport({
      platform: 'ios',
      deviceModel: 'Physical iPhone',
      osVersion: 'test-os',
      appBuild: 'test-build',
      attestationProvider: 'apple-app-attest',
      startedAt: 1_000,
      completedAt: 2_000,
      checks: passedChecks(),
    });

    expect(remoteControlPhysicalSmokeReportSchema.parse(report)).toMatchObject({
      outcome: 'passed',
      platform: 'ios',
      trustLevel: 'hardware-backed',
      privacy: {
        rawEvidencePersisted: false,
        rawEvidenceAudited: false,
      },
    });
    expect(JSON.stringify(report)).not.toContain('token');
    expect(JSON.stringify(report)).not.toContain('attestationObject');
  });

  it('refuses to report success when a device-only check is missing', () => {
    const checks = passedChecks();
    checks.networkHandoff = false;

    expect(() =>
      createRemoteControlPhysicalSmokeReport({
        platform: 'android',
        deviceModel: 'Physical Android',
        osVersion: 'test-os',
        appBuild: 'test-build',
        attestationProvider: 'android-play-integrity',
        startedAt: 1_000,
        checks,
      }),
    ).toThrow('networkHandoff');
  });

  it('rejects a provider that does not match the physical platform', () => {
    expect(() =>
      createRemoteControlPhysicalSmokeReport({
        platform: 'ios',
        deviceModel: 'Physical iPhone',
        osVersion: 'test-os',
        appBuild: 'test-build',
        attestationProvider: 'android-play-integrity',
        startedAt: 1_000,
        checks: passedChecks(),
      }),
    ).toThrow('apple-app-attest');
  });
});
