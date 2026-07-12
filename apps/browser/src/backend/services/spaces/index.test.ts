import { describe, expect, it } from 'vitest';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import { SpacesService, type SpacesPersistence } from './index';

describe('SpacesService', () => {
  it('imports current projects once and deduplicates workspace roots', async () => {
    let store = { version: 1 as const, spaces: [], projectsImportedAt: null };
    const persistence: SpacesPersistence = {
      load: async () => structuredClone(store),
      save: async (value) => {
        store = structuredClone(value) as typeof store;
      },
    };
    const handlers = new Map<string, (...args: any[]) => Promise<any>>();
    const karton = {
      registerServerProcedureHandler: (
        name: string,
        handler: (...args: any[]) => Promise<any>,
      ) => handlers.set(name, handler),
      removeServerProcedureHandler: (name: string) => handlers.delete(name),
    } as unknown as KartonService;
    const service = await SpacesService.create({
      logger: { warn: () => undefined } as unknown as Logger,
      karton,
      persistence,
      isFeatureEnabled: () => true,
      now: () => Date.parse('2026-07-11T10:00:00.000Z'),
      listProjects: async () => [
        { name: 'Clodex', rootPath: '/repo/clodex/' },
        { name: 'Clodex duplicate', rootPath: '/repo/clodex' },
        { name: 'No workspace', rootPath: null },
      ],
    });

    expect(service.getSnapshot().spaces).toHaveLength(1);
    expect(service.getSnapshot().spaces[0]).toMatchObject({
      name: 'Clodex',
      workspacePaths: ['/repo/clodex/'],
    });
    await handlers.get('spaces.importProjects')?.('ui');
    expect(service.getSnapshot().spaces).toHaveLength(1);
    await service.teardown();
  });
});
