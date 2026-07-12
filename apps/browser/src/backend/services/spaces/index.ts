import { randomUUID } from 'node:crypto';
import {
  createSpaceInputSchema,
  spaceDefinitionSchema,
  type SpaceDefinition,
  type SpaceProjectImport,
  type SpacesSnapshot,
  updateSpaceInputSchema,
} from '@shared/spaces';
import { z } from 'zod';
import { readPersistedData, writePersistedData } from '@/utils/persisted-data';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import { DisposableService } from '../disposable';

const PROCEDURES = [
  'spaces.getSnapshot',
  'spaces.create',
  'spaces.update',
  'spaces.delete',
  'spaces.importProjects',
] as const;

const spacesStoreSchema = z.object({
  version: z.literal(1),
  spaces: z.array(spaceDefinitionSchema).max(1_000),
  projectsImportedAt: z.string().datetime().nullable(),
});
type SpacesStore = z.infer<typeof spacesStoreSchema>;

export interface SpacesPersistence {
  load(): Promise<SpacesStore>;
  save(store: SpacesStore): Promise<void>;
}

export interface SpacesServiceOptions {
  logger: Logger;
  karton: KartonService;
  isFeatureEnabled: () => boolean;
  listProjects: () => Promise<SpaceProjectImport[]>;
  persistence?: SpacesPersistence;
  now?: () => number;
}

class PersistedSpacesStore implements SpacesPersistence {
  async load(): Promise<SpacesStore> {
    return await readPersistedData(
      'spaces',
      spacesStoreSchema,
      { version: 1, spaces: [], projectsImportedAt: null },
      {
        encrypt: true,
        requireEncryption: true,
        allowPlaintextMigration: true,
      },
    );
  }

  async save(store: SpacesStore): Promise<void> {
    await writePersistedData('spaces', spacesStoreSchema, store, {
      encrypt: true,
      requireEncryption: true,
    });
  }
}

export class SpacesService extends DisposableService {
  private store: SpacesStore = {
    version: 1,
    spaces: [],
    projectsImportedAt: null,
  };
  private readonly persistence: SpacesPersistence;
  private readonly now: () => number;
  private mutation = Promise.resolve();

  private constructor(private readonly options: SpacesServiceOptions) {
    super();
    this.persistence = options.persistence ?? new PersistedSpacesStore();
    this.now = options.now ?? Date.now;
  }

  public static async create(
    options: SpacesServiceOptions,
  ): Promise<SpacesService> {
    const service = new SpacesService(options);
    service.store = spacesStoreSchema.parse(await service.persistence.load());
    service.registerProcedures();
    if (options.isFeatureEnabled() && !service.store.projectsImportedAt) {
      await service.importProjects().catch((error) => {
        options.logger.warn('[Spaces] Initial project import failed', error);
      });
    }
    return service;
  }

  public getSnapshot(): SpacesSnapshot {
    this.assertEnabled();
    return structuredClone(this.store);
  }

  private registerProcedures(): void {
    this.options.karton.registerServerProcedureHandler(
      'spaces.getSnapshot',
      async () => this.getSnapshot(),
    );
    this.options.karton.registerServerProcedureHandler(
      'spaces.create',
      async (_clientId, input) => await this.createSpace(input),
    );
    this.options.karton.registerServerProcedureHandler(
      'spaces.update',
      async (_clientId, input) => await this.updateSpace(input),
    );
    this.options.karton.registerServerProcedureHandler(
      'spaces.delete',
      async (_clientId, id) => await this.deleteSpace(id),
    );
    this.options.karton.registerServerProcedureHandler(
      'spaces.importProjects',
      async () => await this.importProjects(),
    );
  }

  private async createSpace(input: unknown): Promise<SpaceDefinition> {
    this.assertEnabled();
    return await this.serialize(async () => {
      const parsed = createSpaceInputSchema.parse(input);
      const timestamp = new Date(this.now()).toISOString();
      const space = spaceDefinitionSchema.parse({
        ...parsed,
        workspacePaths: this.normalizePaths(parsed.workspacePaths),
        id: randomUUID(),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      this.store.spaces.push(space);
      await this.persistence.save(this.store);
      return structuredClone(space);
    });
  }

  private async updateSpace(input: unknown): Promise<SpaceDefinition> {
    this.assertEnabled();
    return await this.serialize(async () => {
      const parsed = updateSpaceInputSchema.parse(input);
      const index = this.store.spaces.findIndex(
        (space) => space.id === parsed.id,
      );
      if (index < 0) throw new Error('Space not found');
      const existing = this.store.spaces[index]!;
      const space = spaceDefinitionSchema.parse({
        ...existing,
        ...parsed,
        workspacePaths: parsed.workspacePaths
          ? this.normalizePaths(parsed.workspacePaths)
          : existing.workspacePaths,
        updatedAt: new Date(this.now()).toISOString(),
      });
      this.store.spaces[index] = space;
      await this.persistence.save(this.store);
      return structuredClone(space);
    });
  }

  private async deleteSpace(id: string): Promise<void> {
    this.assertEnabled();
    await this.serialize(async () => {
      const index = this.store.spaces.findIndex((space) => space.id === id);
      if (index < 0) throw new Error('Space not found');
      this.store.spaces.splice(index, 1);
      await this.persistence.save(this.store);
    });
  }

  public async importProjects(): Promise<SpacesSnapshot> {
    this.assertEnabled();
    return await this.serialize(async () => {
      const projects = await this.options.listProjects();
      const existingPaths = new Set(
        this.store.spaces.flatMap((space) =>
          space.workspacePaths.map((workspacePath) =>
            this.normalizePath(workspacePath),
          ),
        ),
      );
      const timestamp = new Date(this.now()).toISOString();
      for (const project of projects) {
        if (!project.rootPath) continue;
        const normalized = this.normalizePath(project.rootPath);
        if (existingPaths.has(normalized)) continue;
        this.store.spaces.push(
          spaceDefinitionSchema.parse({
            id: randomUUID(),
            name: project.name,
            description: '',
            workspacePaths: [project.rootPath],
            links: [],
            instructions: '',
            archived: false,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        );
        existingPaths.add(normalized);
      }
      this.store.projectsImportedAt = timestamp;
      await this.persistence.save(this.store);
      return structuredClone(this.store);
    });
  }

  private normalizePaths(paths: string[]): string[] {
    const unique = new Map<string, string>();
    for (const workspacePath of paths) {
      unique.set(this.normalizePath(workspacePath), workspacePath);
    }
    return [...unique.values()];
  }

  private normalizePath(value: string): string {
    return value.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  }

  private assertEnabled(): void {
    if (!this.options.isFeatureEnabled())
      throw new Error('Spaces feature is disabled');
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  protected async onTeardown(): Promise<void> {
    for (const procedure of PROCEDURES) {
      this.options.karton.removeServerProcedureHandler(procedure);
    }
    await this.mutation;
  }
}
