import {
  createSessionShareInputSchema,
  sessionTeleportInputSchema,
  type ReadOnlySessionSharePayload,
  type SessionContinuityReadiness,
  type SessionShareRecord,
  type SessionShareSnapshot,
} from '@shared/session-continuity';
import {
  agentSessionCheckpointSchema,
  type AgentSessionCheckpoint,
} from '@clodex/agent-core/agents';
import { z } from 'zod';
import { readPersistedData, writePersistedData } from '@/utils/persisted-data';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import { DisposableService } from '../disposable';

const PROCEDURES = [
  'sessionContinuity.getReadiness',
  'sessionContinuity.teleport',
  'sessionContinuity.getShares',
  'sessionContinuity.createShare',
  'sessionContinuity.revokeShare',
] as const;

const sessionShareRecordSchema = z.object({
  id: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  url: z.string().url(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});

const shareStoreSchema = z.object({
  version: z.literal(1),
  shares: z.array(sessionShareRecordSchema).max(1_000),
});
type ShareStore = z.infer<typeof shareStoreSchema>;

const checkpointStoreSchema = z.object({
  version: z.literal(1),
  checkpoints: z.array(agentSessionCheckpointSchema).max(1_000),
});
type CheckpointStore = z.infer<typeof checkpointStoreSchema>;

export interface SessionContinuityPersistence {
  load(): Promise<ShareStore>;
  save(store: ShareStore): Promise<void>;
}

export interface SessionCheckpointPersistence {
  load(): Promise<CheckpointStore>;
  save(store: CheckpointStore): Promise<void>;
}

export interface SessionContinuityInfo {
  exists: boolean;
  messageCount: number;
  workspacePaths: string[];
}

export interface SessionSharingAdapter {
  available(): boolean;
  createShare(
    payload: ReadOnlySessionSharePayload,
    expiresInHours: number,
  ): Promise<{ id: string; url: string; expiresAt: string }>;
  revokeShare(shareId: string): Promise<void>;
}

export interface SessionContinuityServiceOptions {
  logger: Logger;
  karton: KartonService;
  isFeatureEnabled: () => boolean;
  isCloudAvailable: () => boolean;
  getSessionInfo: (sessionId: string) => Promise<SessionContinuityInfo>;
  prepareCheckpoint: (sessionId: string) => Promise<AgentSessionCheckpoint>;
  teleport: (
    sessionId: string,
    prompt: string,
    checkpoint: AgentSessionCheckpoint,
  ) => Promise<{ agentId: string }>;
  buildSharePayload: (
    sessionId: string,
  ) => Promise<ReadOnlySessionSharePayload>;
  sharingAdapter?: SessionSharingAdapter;
  persistence?: SessionContinuityPersistence;
  checkpointPersistence?: SessionCheckpointPersistence;
  now?: () => number;
}

class PersistedShareStore implements SessionContinuityPersistence {
  async load(): Promise<ShareStore> {
    return await readPersistedData(
      'session-shares',
      shareStoreSchema,
      { version: 1, shares: [] },
      {
        encrypt: true,
        requireEncryption: true,
        allowPlaintextMigration: true,
      },
    );
  }

  async save(store: ShareStore): Promise<void> {
    await writePersistedData('session-shares', shareStoreSchema, store, {
      encrypt: true,
      requireEncryption: true,
    });
  }
}

class PersistedCheckpointStore implements SessionCheckpointPersistence {
  async load(): Promise<CheckpointStore> {
    return await readPersistedData(
      'session-checkpoints',
      checkpointStoreSchema,
      { version: 1, checkpoints: [] },
      {
        encrypt: true,
        requireEncryption: true,
        allowPlaintextMigration: true,
      },
    );
  }

  async save(store: CheckpointStore): Promise<void> {
    await writePersistedData(
      'session-checkpoints',
      checkpointStoreSchema,
      store,
      {
        encrypt: true,
        requireEncryption: true,
      },
    );
  }
}

export class SessionContinuityService extends DisposableService {
  private store: ShareStore = { version: 1, shares: [] };
  private checkpointStore: CheckpointStore = {
    version: 1,
    checkpoints: [],
  };
  private readonly persistence: SessionContinuityPersistence;
  private readonly checkpointPersistence: SessionCheckpointPersistence;
  private readonly now: () => number;
  private mutation = Promise.resolve();

  private constructor(
    private readonly options: SessionContinuityServiceOptions,
  ) {
    super();
    this.persistence = options.persistence ?? new PersistedShareStore();
    this.checkpointPersistence =
      options.checkpointPersistence ?? new PersistedCheckpointStore();
    this.now = options.now ?? Date.now;
  }

  public static async create(
    options: SessionContinuityServiceOptions,
  ): Promise<SessionContinuityService> {
    const service = new SessionContinuityService(options);
    service.store = shareStoreSchema.parse(await service.persistence.load());
    service.checkpointStore = checkpointStoreSchema.parse(
      await service.checkpointPersistence.load(),
    );
    service.registerProcedures();
    return service;
  }

  private registerProcedures(): void {
    this.options.karton.registerServerProcedureHandler(
      'sessionContinuity.getReadiness',
      async (_clientId, sessionId) => await this.getReadiness(sessionId),
    );
    this.options.karton.registerServerProcedureHandler(
      'sessionContinuity.teleport',
      async (_clientId, input) => await this.teleport(input),
    );
    this.options.karton.registerServerProcedureHandler(
      'sessionContinuity.getShares',
      async () => this.getShares(),
    );
    this.options.karton.registerServerProcedureHandler(
      'sessionContinuity.createShare',
      async (_clientId, input) => await this.createShare(input),
    );
    this.options.karton.registerServerProcedureHandler(
      'sessionContinuity.revokeShare',
      async (_clientId, shareId) => await this.revokeShare(shareId),
    );
  }

  public async getReadiness(
    sessionId: string,
  ): Promise<SessionContinuityReadiness> {
    this.assertEnabled();
    const info = await this.options.getSessionInfo(sessionId);
    const cloudAvailable = this.options.isCloudAvailable();
    const sharingAvailable = this.options.sharingAdapter?.available() ?? false;
    const reasons: string[] = [];
    if (!info.exists) reasons.push('session-not-found');
    if (!cloudAvailable) reasons.push('cloud-unavailable');
    if (!sharingAvailable) reasons.push('sharing-unavailable');
    if (info.messageCount === 0) reasons.push('empty-session');

    return {
      sessionId,
      exists: info.exists,
      cloudAvailable,
      sharingAvailable,
      messageCount: info.messageCount,
      workspacePaths: info.workspacePaths,
      readyForTeleport: info.exists && cloudAvailable,
      readyForSharing: info.exists && info.messageCount > 0 && sharingAvailable,
      reasons,
    };
  }

  public async teleport(input: unknown): Promise<{ agentId: string }> {
    this.assertEnabled();
    const parsed = sessionTeleportInputSchema.parse(input);
    const readiness = await this.getReadiness(parsed.sessionId);
    if (!readiness.readyForTeleport) {
      throw new Error(
        `Session is not ready for cloud teleport: ${readiness.reasons.join(', ')}`,
      );
    }
    const checkpoint = agentSessionCheckpointSchema.parse(
      await this.options.prepareCheckpoint(parsed.sessionId),
    );
    if (!checkpoint.workspace.snapshot) {
      throw new Error(
        'Session teleport requires a canonical WorkspaceSnapshot checkpoint',
      );
    }
    await this.serialize(async () => {
      this.checkpointStore.checkpoints.unshift(checkpoint);
      this.checkpointStore.checkpoints = this.checkpointStore.checkpoints.slice(
        0,
        1_000,
      );
      await this.checkpointPersistence.save(this.checkpointStore);
    });
    return await this.options.teleport(
      parsed.sessionId,
      parsed.prompt,
      checkpoint,
    );
  }

  public getLatestCheckpoint(sessionId: string): AgentSessionCheckpoint | null {
    const checkpoint = this.checkpointStore.checkpoints.find(
      (candidate) => candidate.task.agentInstanceId === sessionId,
    );
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  public getShares(): SessionShareSnapshot {
    this.assertEnabled();
    return {
      shares: structuredClone(this.store.shares),
    };
  }

  public async createShare(input: unknown): Promise<SessionShareRecord> {
    this.assertEnabled();
    const parsed = createSessionShareInputSchema.parse(input);
    const readiness = await this.getReadiness(parsed.sessionId);
    if (!readiness.readyForSharing) {
      throw new Error(
        `Session is not ready for sharing: ${readiness.reasons.join(', ')}`,
      );
    }
    const adapter = this.options.sharingAdapter;
    if (!adapter) throw new Error('Session sharing adapter is unavailable');
    const payload = await this.options.buildSharePayload(parsed.sessionId);
    const remote = await adapter.createShare(payload, parsed.expiresInHours);
    const url = new URL(remote.url);
    if (url.protocol !== 'https:') {
      throw new Error('Session share URL must use HTTPS');
    }
    const record = sessionShareRecordSchema.parse({
      ...remote,
      sessionId: parsed.sessionId,
      createdAt: new Date(this.now()).toISOString(),
      revokedAt: null,
    });
    await this.serialize(async () => {
      this.store.shares.unshift(record);
      this.store.shares = this.store.shares.slice(0, 1_000);
      await this.persistence.save(this.store);
    });
    return structuredClone(record);
  }

  public async revokeShare(shareId: string): Promise<SessionShareRecord> {
    this.assertEnabled();
    const adapter = this.options.sharingAdapter;
    if (!adapter?.available()) {
      throw new Error('Session sharing adapter is unavailable');
    }
    const record = this.store.shares.find((share) => share.id === shareId);
    if (!record) throw new Error('Session share not found');
    if (!record.revokedAt) await adapter.revokeShare(shareId);
    return await this.serialize(async () => {
      record.revokedAt ??= new Date(this.now()).toISOString();
      await this.persistence.save(this.store);
      return structuredClone(record);
    });
  }

  private assertEnabled(): void {
    if (!this.options.isFeatureEnabled()) {
      throw new Error('Session continuity feature is disabled');
    }
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
