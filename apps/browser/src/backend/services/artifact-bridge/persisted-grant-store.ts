import {
  grantStoreReaderSchema,
  grantStoreSchema,
  type ArtifactBridgePersistence,
  type GrantStore,
} from './bridge-schemas';

export class PersistedGrantStore implements ArtifactBridgePersistence {
  async load(): Promise<unknown> {
    const { readPersistedData } = await import('@/utils/persisted-data');
    return await readPersistedData(
      'artifact-capability-grants',
      grantStoreReaderSchema,
      { version: 5, grants: {} },
      {
        encrypt: true,
        requireEncryption: true,
        allowPlaintextMigration: true,
      },
    );
  }

  async save(store: GrantStore): Promise<void> {
    const { writePersistedData } = await import('@/utils/persisted-data');
    await writePersistedData(
      'artifact-capability-grants',
      grantStoreSchema,
      store,
      {
        encrypt: true,
        requireEncryption: true,
      },
    );
  }
}
