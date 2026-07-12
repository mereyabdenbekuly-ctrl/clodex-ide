import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KartonService } from '@/services/karton';
import type { Logger } from '@/services/logger';
import {
  DockerRunnerProfilesService,
  type DockerAvailabilityTester,
} from '@/services/docker-runner-profiles';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const IMAGE = `registry.example.test/clodex/runner@sha256:${'a'.repeat(64)}`;

function createKarton() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  return {
    handlers,
    service: {
      registerServerProcedureHandler: vi.fn(
        (name: string, handler: (...args: any[]) => unknown) => {
          handlers.set(name, handler);
        },
      ),
      removeServerProcedureHandler: vi.fn((name: string) => {
        handlers.delete(name);
      }),
    } as unknown as KartonService,
  };
}

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
} as unknown as Logger;

describe('DockerRunnerProfilesService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates and persists digest-pinned profiles', async () => {
    const karton = createKarton();
    let savedStore: any;
    const service = await DockerRunnerProfilesService.create({
      logger,
      karton: karton.service,
      environmentOverride: false,
      idGenerator: () => PROFILE_ID,
      now: () => 1_000,
      loadStore: async () => ({
        version: 1,
        profiles: [],
        selectedProfileId: null,
      }),
      saveStore: async (store) => {
        savedStore = structuredClone(store);
      },
    });

    await expect(
      service.save({
        name: 'Default',
        image: 'registry.example.test/clodex/runner:latest',
        cpus: 2,
        memoryMb: 4_096,
        pidsLimit: 512,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'invalid-input',
    });

    await expect(
      service.save({
        name: 'Default',
        image: IMAGE,
        cpus: 2,
        memoryMb: 4_096,
        pidsLimit: 512,
      }),
    ).resolves.toMatchObject({
      ok: true,
      profile: { id: PROFILE_ID, image: IMAGE },
    });
    expect(savedStore.profiles).toHaveLength(1);
  });

  it('configures, reconfigures, and detaches the selected profile', async () => {
    const onSelectionChanged = vi.fn(async () => undefined);
    const service = await DockerRunnerProfilesService.create({
      logger,
      karton: createKarton().service,
      environmentOverride: false,
      idGenerator: () => PROFILE_ID,
      now: () => 2_000,
      loadStore: async () => ({
        version: 1,
        profiles: [],
        selectedProfileId: null,
      }),
      saveStore: async () => undefined,
      onSelectionChanged,
    });
    await service.save({
      name: 'Default',
      image: IMAGE,
      cpus: 2,
      memoryMb: 4_096,
      pidsLimit: 512,
    });

    await expect(service.setSelected(PROFILE_ID)).resolves.toMatchObject({
      ok: true,
      selectedProfileId: PROFILE_ID,
    });
    expect(onSelectionChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: PROFILE_ID }),
    );

    await service.save({
      id: PROFILE_ID,
      name: 'Default',
      image: IMAGE,
      cpus: 4,
      memoryMb: 8_192,
      pidsLimit: 1_024,
    });
    expect(onSelectionChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ cpus: 4 }),
    );

    await service.delete(PROFILE_ID);
    expect(onSelectionChanged).toHaveBeenLastCalledWith(null);
    expect(service.snapshot().selectedProfileId).toBeNull();
  });

  it('does not change persisted selection when runtime configuration fails', async () => {
    const service = await DockerRunnerProfilesService.create({
      logger,
      karton: createKarton().service,
      environmentOverride: false,
      loadStore: async () => ({
        version: 1,
        selectedProfileId: null,
        profiles: [
          {
            id: PROFILE_ID,
            name: 'Default',
            image: IMAGE,
            cpus: 2,
            memoryMb: 4_096,
            pidsLimit: 512,
            createdAt: 1,
            updatedAt: 1,
            lastCheckedAt: null,
            lastCheckSucceeded: null,
            lastError: null,
          },
        ],
      }),
      saveStore: async () => undefined,
      onSelectionChanged: async () => {
        throw new Error('SSH runner is active');
      },
    });

    await expect(service.setSelected(PROFILE_ID)).resolves.toMatchObject({
      ok: false,
      code: 'operation-failed',
      message: 'SSH runner is active',
    });
    expect(service.snapshot().selectedProfileId).toBeNull();
  });

  it('tests Docker availability without exposing command output as state', async () => {
    const tester: DockerAvailabilityTester = {
      test: vi.fn(async () => ({ ok: true as const, version: '27.1.1' })),
    };
    const onSelectionChanged = vi.fn(async () => undefined);
    const service = await DockerRunnerProfilesService.create({
      logger,
      karton: createKarton().service,
      environmentOverride: true,
      now: () => 3_000,
      dockerTester: tester,
      loadStore: async () => ({
        version: 1,
        selectedProfileId: PROFILE_ID,
        profiles: [
          {
            id: PROFILE_ID,
            name: 'Default',
            image: IMAGE,
            cpus: 2,
            memoryMb: 4_096,
            pidsLimit: 512,
            createdAt: 1,
            updatedAt: 1,
            lastCheckedAt: null,
            lastCheckSucceeded: null,
            lastError: null,
          },
        ],
      }),
      saveStore: async () => undefined,
      onSelectionChanged,
    });

    await expect(service.test(PROFILE_ID)).resolves.toMatchObject({
      ok: true,
      message: 'Docker daemon 27.1.1 is available.',
    });
    expect(tester.test).toHaveBeenCalledWith(5_000);
    await expect(service.setSelected(null)).resolves.toMatchObject({
      ok: true,
      selectedProfileId: null,
      message:
        'Profile selection cleared. The startup environment override remains active.',
    });
    expect(onSelectionChanged).not.toHaveBeenCalled();
    expect(service.snapshot()).toMatchObject({
      selectedProfileId: null,
      runtime: {
        source: 'environment',
        environmentOverride: true,
        activeProfileId: null,
      },
    });
  });
});
