import { describe, expect, it, vi } from 'vitest';
import {
  CLODEX_RUNNER_SDK_VERSION,
  assertRunnerProviderConformance,
  createClodexRunner,
  defineClodexRunner,
  type WorkspaceExecutionProvider,
} from '.';

describe('runner SDK', () => {
  it('defines and creates a conforming provider', async () => {
    const provider = providerDouble();
    const registration = defineClodexRunner({
      manifest: manifest(),
      create: () => provider,
    });

    await expect(createClodexRunner(registration)).resolves.toBe(provider);
    expect(registration.manifest).toEqual(manifest());
    expect(Object.isFrozen(registration.manifest)).toBe(true);
  });

  it('rejects identity and capability widening mismatches', async () => {
    const registration = defineClodexRunner({
      manifest: manifest(),
      create: providerDouble,
    });
    const wrongIdentity = providerDouble();
    Object.defineProperty(wrongIdentity, 'id', { value: 'other-runner' });
    await expect(
      assertRunnerProviderConformance(registration, wrongIdentity),
    ).rejects.toThrow('id mismatch');

    const widened = providerDouble();
    widened.getCapabilities = vi.fn(async () => ({
      ...(await providerDouble().getCapabilities()),
      stdin: true,
    }));
    await expect(
      assertRunnerProviderConformance(registration, widened),
    ).rejects.toThrow('capability mismatch');
  });

  it('requires snapshot-bound workspace leases', () => {
    expect(() =>
      defineClodexRunner({
        manifest: {
          ...manifest(),
          capabilities: {
            ...manifest().capabilities,
            workspaceLeases: false,
          },
        },
        create: providerDouble,
      }),
    ).toThrow('workspace lease support');
  });
});

function manifest() {
  return {
    sdkVersion: CLODEX_RUNNER_SDK_VERSION,
    id: 'vendor.runner',
    name: 'Vendor Runner',
    providerKind: 'cloud' as const,
    networkAccess: 'restricted' as const,
    capabilities: {
      persistentSessions: false,
      streamingOutput: true,
      stdin: false,
      cancellation: true,
      workspaceLeases: true,
    },
  };
}

function providerDouble(): WorkspaceExecutionProvider {
  return {
    id: 'vendor.runner',
    kind: 'cloud',
    receiptPublicKey: 'public-key',
    getCapabilities: vi.fn(async () => ({ ...manifest().capabilities })),
    prepareWorkspace: vi.fn(),
    createSession: vi.fn(),
    execute: vi.fn(),
    killSession: vi.fn(),
    getRecentOutputForClassifier: vi.fn(),
    getSessionCurrentCwd: vi.fn(),
    clearPendingOutputs: vi.fn(),
    disposeWorkspace: vi.fn(),
  };
}
