import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { KartonService } from '@/services/karton';
import type { Logger } from '@/services/logger';
import { DisposableService } from '@/services/disposable';
import { readPersistedData, writePersistedData } from '@/utils/persisted-data';
import {
  dockerRunnerProfileInputSchema,
  type DeleteDockerRunnerProfileResult,
  type DockerRunnerProfile,
  type DockerRunnerProfileFailure,
  type DockerRunnerProfileInput,
  type DockerRunnerProfileOperationResult,
  type DockerRunnerProfileSelectionResult,
  type DockerRunnerProfilesSnapshot,
  type SaveDockerRunnerProfileResult,
} from '@shared/docker-runner-profiles';

const STORAGE_NAME = 'docker-runner-profiles' as const;
const STORAGE_OPTIONS = {
  encrypt: true,
  requireEncryption: true,
  allowPlaintextMigration: true,
} as const;
const STORE_VERSION = 1;
const DOCKER_TEST_TIMEOUT_MS = 5_000;
const MAX_DIAGNOSTIC_LENGTH = 512;

const storedProfileSchema = dockerRunnerProfileInputSchema
  .required({ id: true })
  .extend({
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    lastCheckedAt: z.number().int().nonnegative().nullable(),
    lastCheckSucceeded: z.boolean().nullable(),
    lastError: z.string().max(2048).nullable(),
  });

const storeSchema = z.object({
  version: z.literal(STORE_VERSION),
  profiles: z.array(storedProfileSchema),
  selectedProfileId: z.string().uuid().nullable(),
});

type StoredProfile = z.infer<typeof storedProfileSchema>;
type DockerRunnerProfilesStore = z.infer<typeof storeSchema>;

type DockerAvailabilityResult =
  | { ok: true; version: string }
  | { ok: false; unavailable: boolean; message: string };

export interface DockerAvailabilityTester {
  test(timeoutMs: number): Promise<DockerAvailabilityResult>;
}

class SystemDockerAvailabilityTester implements DockerAvailabilityTester {
  public async test(timeoutMs: number): Promise<DockerAvailabilityResult> {
    return await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const child = spawn(
        'docker',
        ['version', '--format', '{{json .Server.Version}}'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      const finish = (result: DockerAvailabilityResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const append = (current: string, chunk: unknown): string =>
        `${current}${String(chunk)}`.slice(0, MAX_DIAGNOSTIC_LENGTH);
      child.stdout?.on('data', (chunk) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr = append(stderr, chunk);
      });
      child.once('error', (error: NodeJS.ErrnoException) => {
        finish({
          ok: false,
          unavailable: error.code === 'ENOENT',
          message:
            error.code === 'ENOENT'
              ? 'Docker is not installed or is not available on PATH.'
              : sanitizeMessage(error.message),
        });
      });
      child.once('close', (code) => {
        if (timedOut) {
          finish({
            ok: false,
            unavailable: false,
            message: 'Docker did not respond before the test timed out.',
          });
          return;
        }
        if (code !== 0) {
          finish({
            ok: false,
            unavailable: false,
            message:
              sanitizeMessage(stderr || stdout) ||
              `Docker version exited with code ${code ?? 'unknown'}.`,
          });
          return;
        }
        const version = stdout.trim().replace(/^"|"$/g, '');
        finish({
          ok: true,
          version: version || 'available',
        });
      });
      const timer = setTimeout(
        () => {
          timedOut = true;
          child.kill('SIGKILL');
        },
        Math.max(250, timeoutMs),
      );
    });
  }
}

export type DockerRunnerProfilesServiceOptions = {
  logger: Logger;
  karton: KartonService;
  environmentOverride: boolean;
  now?: () => number;
  idGenerator?: () => string;
  loadStore?: () => Promise<unknown>;
  saveStore?: (store: unknown) => Promise<void>;
  dockerTester?: DockerAvailabilityTester;
  onSelectionChanged?: (profile: DockerRunnerProfile | null) => Promise<void>;
};

const DEFAULT_STORE: DockerRunnerProfilesStore = {
  version: STORE_VERSION,
  profiles: [],
  selectedProfileId: null,
};

const PROCEDURE_NAMES = [
  'dockerRunnerProfiles.list',
  'dockerRunnerProfiles.save',
  'dockerRunnerProfiles.delete',
  'dockerRunnerProfiles.test',
  'dockerRunnerProfiles.setSelected',
] as const;

function failure(
  code: DockerRunnerProfileFailure['code'],
  message: string,
  profile?: DockerRunnerProfile,
): DockerRunnerProfileFailure {
  return { ok: false, code, message, profile };
}

function sanitizeMessage(value: string): string {
  return value
    .replaceAll(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 2048);
}

export class DockerRunnerProfilesService extends DisposableService {
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly dockerTester: DockerAvailabilityTester;
  private store: DockerRunnerProfilesStore = DEFAULT_STORE;
  private saveQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: DockerRunnerProfilesServiceOptions,
  ) {
    super();
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.dockerTester =
      options.dockerTester ?? new SystemDockerAvailabilityTester();
  }

  public static async create(
    options: DockerRunnerProfilesServiceOptions,
  ): Promise<DockerRunnerProfilesService> {
    const service = new DockerRunnerProfilesService(options);
    await service.initialize();
    return service;
  }

  private async initialize(): Promise<void> {
    const loaded = this.options.loadStore
      ? await this.options.loadStore()
      : await readPersistedData(
          STORAGE_NAME,
          storeSchema,
          DEFAULT_STORE,
          STORAGE_OPTIONS,
        );
    this.store = storeSchema.parse(loaded);
    this.store.profiles = this.dedupeProfiles(this.store.profiles);
    if (
      this.store.selectedProfileId &&
      !this.store.profiles.some(
        (profile) => profile.id === this.store.selectedProfileId,
      )
    ) {
      this.store.selectedProfileId = null;
    }
    this.registerProcedures();
    this.options.logger.debug(
      `[DockerRunnerProfiles] Loaded ${this.store.profiles.length} saved profile(s)`,
    );
  }

  private registerProcedures(): void {
    const { karton } = this.options;
    karton.registerServerProcedureHandler(
      'dockerRunnerProfiles.list',
      async () => this.snapshot(),
    );
    karton.registerServerProcedureHandler(
      'dockerRunnerProfiles.save',
      async (_clientId, input: DockerRunnerProfileInput) => this.save(input),
    );
    karton.registerServerProcedureHandler(
      'dockerRunnerProfiles.delete',
      async (_clientId, id: string) => this.delete(id),
    );
    karton.registerServerProcedureHandler(
      'dockerRunnerProfiles.test',
      async (_clientId, id: string) => this.test(id),
    );
    karton.registerServerProcedureHandler(
      'dockerRunnerProfiles.setSelected',
      async (_clientId, id: string | null) => this.setSelected(id),
    );
  }

  public snapshot(): DockerRunnerProfilesSnapshot {
    this.assertNotDisposed();
    const selectedProfileId = this.store.selectedProfileId;
    const environmentOverride = this.options.environmentOverride;
    return {
      profiles: [...this.store.profiles]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((profile) => structuredClone(profile)),
      selectedProfileId,
      runtime: {
        source: environmentOverride
          ? 'environment'
          : selectedProfileId
            ? 'profile'
            : 'none',
        activeProfileId: environmentOverride ? null : selectedProfileId,
        environmentOverride,
        message: environmentOverride
          ? 'A startup environment override controls the Docker runner.'
          : selectedProfileId
            ? 'The selected profile controls the Docker runner.'
            : 'No Docker runner profile is selected.',
      },
    };
  }

  public getSelectedProfile(): DockerRunnerProfile | null {
    this.assertNotDisposed();
    const id = this.store.selectedProfileId;
    const profile = id ? this.findStored(id) : null;
    return profile ? structuredClone(profile) : null;
  }

  public async save(
    rawInput: DockerRunnerProfileInput,
  ): Promise<SaveDockerRunnerProfileResult> {
    this.assertNotDisposed();
    const parsed = dockerRunnerProfileInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return failure(
        'invalid-input',
        parsed.error.issues[0]?.message ?? 'Docker profile is invalid.',
      );
    }
    const input = parsed.data;
    const existing = input.id ? this.findStored(input.id) : null;
    if (input.id && !existing) {
      return failure('not-found', 'The Docker profile no longer exists.');
    }
    const duplicate = this.store.profiles.find(
      (profile) =>
        profile.id !== input.id &&
        profile.name.localeCompare(input.name, undefined, {
          sensitivity: 'accent',
        }) === 0,
    );
    if (duplicate) {
      return failure(
        'invalid-input',
        'A Docker profile with this name already exists.',
      );
    }
    const now = this.now();
    const stored: StoredProfile = {
      ...input,
      id: existing?.id ?? this.idGenerator(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastCheckedAt: existing?.lastCheckedAt ?? null,
      lastCheckSucceeded: existing?.lastCheckSucceeded ?? null,
      lastError: existing?.lastError ?? null,
    };
    if (
      existing &&
      this.store.selectedProfileId === existing.id &&
      !this.options.environmentOverride
    ) {
      try {
        await this.options.onSelectionChanged?.(stored);
      } catch (error) {
        return failure(
          'operation-failed',
          sanitizeMessage(
            error instanceof Error ? error.message : String(error),
          ) || 'The Docker runner could not be reconfigured.',
          structuredClone(existing),
        );
      }
    }
    const index = this.store.profiles.findIndex(
      (profile) => profile.id === stored.id,
    );
    if (index < 0) this.store.profiles.push(stored);
    else this.store.profiles[index] = stored;
    await this.persist();
    return {
      ok: true,
      profile: structuredClone(stored),
      message: 'Docker runner profile saved.',
    };
  }

  public async delete(id: string): Promise<DeleteDockerRunnerProfileResult> {
    this.assertNotDisposed();
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success) {
      return failure('invalid-input', 'Docker profile id is invalid.');
    }
    const existing = this.findStored(parsed.data);
    if (!existing) {
      return failure('not-found', 'The Docker profile no longer exists.');
    }
    if (this.store.selectedProfileId === existing.id) {
      if (!this.options.environmentOverride) {
        try {
          await this.options.onSelectionChanged?.(null);
        } catch (error) {
          return failure(
            'operation-failed',
            sanitizeMessage(
              error instanceof Error ? error.message : String(error),
            ) || 'The Docker runner could not be detached.',
            structuredClone(existing),
          );
        }
      }
      this.store.selectedProfileId = null;
    }
    this.store.profiles = this.store.profiles.filter(
      (profile) => profile.id !== existing.id,
    );
    await this.persist();
    return {
      ok: true,
      id: existing.id,
      message: 'Docker runner profile deleted.',
    };
  }

  public async test(id: string): Promise<DockerRunnerProfileOperationResult> {
    this.assertNotDisposed();
    const profile = this.findStored(id);
    if (!profile) {
      return failure('not-found', 'The Docker profile no longer exists.');
    }
    const result = await this.dockerTester.test(DOCKER_TEST_TIMEOUT_MS);
    profile.lastCheckedAt = this.now();
    profile.updatedAt = profile.lastCheckedAt;
    profile.lastCheckSucceeded = result.ok;
    profile.lastError = result.ok ? null : result.message;
    await this.persist();
    if (!result.ok) {
      return failure(
        result.unavailable ? 'docker-unavailable' : 'operation-failed',
        result.message,
        structuredClone(profile),
      );
    }
    return {
      ok: true,
      profile: structuredClone(profile),
      message: `Docker daemon ${result.version} is available.`,
    };
  }

  public async setSelected(
    id: string | null,
  ): Promise<DockerRunnerProfileSelectionResult> {
    this.assertNotDisposed();
    const parsed =
      id === null
        ? { success: true as const, data: null }
        : z.string().uuid().safeParse(id);
    if (!parsed.success) {
      return failure('invalid-input', 'Docker profile id is invalid.');
    }
    const profile = parsed.data ? this.findStored(parsed.data) : null;
    if (parsed.data && !profile) {
      return failure('not-found', 'The Docker profile no longer exists.');
    }
    if (!this.options.environmentOverride) {
      try {
        await this.options.onSelectionChanged?.(
          profile ? structuredClone(profile) : null,
        );
      } catch (error) {
        return failure(
          'operation-failed',
          sanitizeMessage(
            error instanceof Error ? error.message : String(error),
          ) || 'The Docker runner could not be configured.',
          profile ? structuredClone(profile) : undefined,
        );
      }
    }
    this.store.selectedProfileId = parsed.data;
    await this.persist();
    return {
      ok: true,
      selectedProfileId: parsed.data,
      profile: profile ? structuredClone(profile) : undefined,
      message: this.options.environmentOverride
        ? parsed.data === null
          ? 'Profile selection cleared. The startup environment override remains active.'
          : 'Profile selected. The startup environment override remains active.'
        : parsed.data === null
          ? 'Docker runner selection cleared.'
          : `Docker runner will use ${profile!.name}.`,
    };
  }

  private findStored(id: string): StoredProfile | null {
    return this.store.profiles.find((profile) => profile.id === id) ?? null;
  }

  private dedupeProfiles(profiles: StoredProfile[]): StoredProfile[] {
    const seen = new Set<string>();
    return profiles.filter((profile) => {
      if (seen.has(profile.id)) return false;
      seen.add(profile.id);
      return true;
    });
  }

  private async persist(): Promise<void> {
    const snapshot = storeSchema.parse(this.store);
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.options.saveStore) {
          await this.options.saveStore(snapshot);
          return;
        }
        await writePersistedData(
          STORAGE_NAME,
          storeSchema,
          snapshot,
          STORAGE_OPTIONS,
        );
      });
    await this.saveQueue;
  }

  protected onTeardown(): void {
    for (const procedureName of PROCEDURE_NAMES) {
      this.options.karton.removeServerProcedureHandler(procedureName);
    }
  }
}
