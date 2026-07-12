import fs from 'node:fs/promises';
import { dialog } from 'electron';
import type {
  MemoryNotesExport,
  MemoryNotesService,
} from '@clodex/agent-core/memory-notes';
import type { FeatureGateId } from '@shared/feature-gates';
import {
  getMemoryNotesRetentionDurationMs,
  memoryNotesManagementScopeSchema,
  memoryNotesRetentionSchema,
  type MemoryNotesExportResult,
  type MemoryNotesManagementScope,
  type MemoryNotesRetention,
  type MemoryNotesRetentionResult,
  type MemoryNotesResetResult,
  type MemoryNotesStats,
} from '@shared/memory-notes';
import { DisposableService } from './disposable';
import type { KartonService } from './karton';
import type { Logger } from './logger';
import type { PreferencesService } from './preferences';

const PROCEDURE_NAMES = [
  'memoryNotes.getStats',
  'memoryNotes.setRetention',
  'memoryNotes.exportToFile',
  'memoryNotes.reset',
] as const;

type MemoryNotesStore = Pick<
  MemoryNotesService,
  'getStats' | 'exportNotes' | 'clear' | 'pruneOlderThan'
>;

interface SaveExportResult {
  canceled: boolean;
  filePath?: string;
}

export interface MemoryNotesSettingsServiceOptions {
  logger: Logger;
  karton: KartonService;
  preferences: Pick<PreferencesService, 'get' | 'update'>;
  memoryNotes: MemoryNotesStore | undefined;
  isFeatureEnabled: (feature: FeatureGateId) => boolean;
  saveExport?: (
    exported: MemoryNotesExport,
    scope: MemoryNotesManagementScope,
  ) => Promise<SaveExportResult>;
  now?: () => number;
}

/**
 * User-owned settings surface for portable export, scoped reset, and
 * retention. These operations never expose the raw SQLite database.
 */
export class MemoryNotesSettingsService extends DisposableService {
  private constructor(
    private readonly options: MemoryNotesSettingsServiceOptions,
  ) {
    super();
  }

  public static async create(
    options: MemoryNotesSettingsServiceOptions,
  ): Promise<MemoryNotesSettingsService> {
    const service = new MemoryNotesSettingsService(options);
    service.registerProcedures();
    try {
      await service.applyRetention(
        options.preferences.get().memoryNotes.retention,
      );
    } catch (error) {
      options.logger.warn(
        `[MemoryNotesSettings] Startup retention cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return service;
  }

  private registerProcedures(): void {
    const { karton } = this.options;
    karton.registerServerProcedureHandler('memoryNotes.getStats', async () => {
      return await this.getStats();
    });
    karton.registerServerProcedureHandler(
      'memoryNotes.setRetention',
      async (_clientId, retention: MemoryNotesRetention) => {
        return await this.setRetention(retention);
      },
    );
    karton.registerServerProcedureHandler(
      'memoryNotes.exportToFile',
      async (_clientId, scope: MemoryNotesManagementScope) => {
        return await this.exportToFile(scope);
      },
    );
    karton.registerServerProcedureHandler(
      'memoryNotes.reset',
      async (_clientId, scope: MemoryNotesManagementScope) => {
        return await this.reset(scope);
      },
    );
  }

  private async getStats(): Promise<MemoryNotesStats> {
    const store = this.assertReady();
    return await store.getStats();
  }

  private async setRetention(
    value: MemoryNotesRetention,
  ): Promise<MemoryNotesRetentionResult> {
    const retention = memoryNotesRetentionSchema.parse(value);
    this.assertReady();
    await this.options.preferences.update([
      {
        op: 'replace',
        path: ['memoryNotes', 'retention'],
        value: retention,
      },
    ]);
    const deleted = await this.applyRetention(retention);
    return { retention, deleted };
  }

  private async exportToFile(
    value: MemoryNotesManagementScope,
  ): Promise<MemoryNotesExportResult> {
    const scope = memoryNotesManagementScopeSchema.parse(value);
    const store = this.assertReady();
    const exported = await store.exportNotes(scope === 'all' ? {} : { scope });
    const result = await (this.options.saveExport ?? saveMemoryNotesExport)(
      exported,
      scope,
    );
    return {
      ...result,
      count: exported.notes.length,
    };
  }

  private async reset(
    value: MemoryNotesManagementScope,
  ): Promise<MemoryNotesResetResult> {
    const scope = memoryNotesManagementScopeSchema.parse(value);
    const store = this.assertReady();
    const deleted = await store.clear(scope === 'all' ? {} : { scope });
    return { scope, deleted };
  }

  private async applyRetention(
    retention: MemoryNotesRetention,
  ): Promise<number> {
    const store = this.options.memoryNotes;
    if (!store) return 0;
    const durationMs = getMemoryNotesRetentionDurationMs(retention);
    if (durationMs === null) return 0;
    const cutoff = Math.max(0, (this.options.now ?? Date.now)() - durationMs);
    return await store.pruneOlderThan(cutoff);
  }

  private assertReady(): MemoryNotesStore {
    if (!this.options.isFeatureEnabled('memory-notes')) {
      throw new Error('Memory notes preview feature is disabled');
    }
    if (!this.options.memoryNotes) {
      throw new Error('Memory notes storage is unavailable');
    }
    return this.options.memoryNotes;
  }

  protected onTeardown(): void {
    for (const procedureName of PROCEDURE_NAMES) {
      this.options.karton.removeServerProcedureHandler(procedureName);
    }
  }
}

async function saveMemoryNotesExport(
  exported: MemoryNotesExport,
  scope: MemoryNotesManagementScope,
): Promise<SaveExportResult> {
  const date = new Date(exported.exportedAt).toISOString().slice(0, 10);
  const result = await dialog.showSaveDialog({
    title: 'Export memory notes',
    defaultPath: `clodex-memory-notes-${scope}-${date}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  await fs.writeFile(
    result.filePath,
    `${JSON.stringify(exported, null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
  return {
    canceled: false,
    filePath: result.filePath,
  };
}
