import { describe, expect, it } from 'vitest';
import {
  ArtifactBridgeEffectWal,
  type ArtifactBridgeEffectWalPersistence,
} from './effect-wal';

const effectId = '00000000-0000-4000-8000-000000000001';
const commitmentHash = 'a'.repeat(64);
const ticketHash = 'b'.repeat(64);
const actionHash = 'c'.repeat(64);
const definitionHash = 'd'.repeat(64);
const adapterHash = 'e'.repeat(64);

function persistence(initial: unknown = { version: 1, records: {} }) {
  let store = structuredClone(initial);
  const adapter: ArtifactBridgeEffectWalPersistence = {
    load: async () => structuredClone(store),
    save: async (next) => {
      store = structuredClone(next);
    },
  };
  return { adapter, getStore: () => structuredClone(store) };
}

async function preparedWal() {
  const persisted = persistence();
  const wal = await ArtifactBridgeEffectWal.create(persisted.adapter, () =>
    Date.parse('2026-07-14T00:00:00.000Z'),
  );
  await wal.prepare({
    effectId,
    kind: 'mcp-write',
    commitmentHash,
    ticketHash,
  });
  return { wal, persisted };
}

describe('ArtifactBridgeEffectWal', () => {
  it('persists PREPARED before allowing DISPATCHING', async () => {
    const { wal, persisted } = await preparedWal();
    expect(wal.get(effectId)?.state).toBe('PREPARED');
    await wal.beginDispatch({ effectId, commitmentHash, ticketHash });
    expect(wal.get(effectId)?.state).toBe('DISPATCHING');
    expect((persisted.getStore() as any).records[effectId].state).toBe(
      'DISPATCHING',
    );
  });

  it('rejects a mismatched ticket or commitment', async () => {
    const { wal } = await preparedWal();
    await expect(
      wal.beginDispatch({
        effectId,
        commitmentHash: 'c'.repeat(64),
        ticketHash,
      }),
    ).rejects.toThrow('mismatch');
    expect(wal.get(effectId)?.state).toBe('PREPARED');
  });

  it('never allows a second dispatch for the same ticket', async () => {
    const { wal } = await preparedWal();
    await wal.beginDispatch({ effectId, commitmentHash, ticketHash });
    await expect(
      wal.beginDispatch({ effectId, commitmentHash, ticketHash }),
    ).rejects.toThrow('DISPATCHING -> DISPATCHING');
  });

  it('supports committed and committed-result-unavailable terminals', async () => {
    const { wal } = await preparedWal();
    await wal.beginDispatch({ effectId, commitmentHash, ticketHash });
    await wal.markCommitted(effectId, 'd'.repeat(64));
    expect(wal.get(effectId)).toMatchObject({
      state: 'COMMITTED',
      resultHash: 'd'.repeat(64),
    });
    await wal.markResultUnavailable(effectId, 'result serialization failed');
    expect(wal.get(effectId)).toMatchObject({
      state: 'RESULT_UNAVAILABLE',
      error: 'result serialization failed',
    });
  });

  it('marks ambiguous adapter failure UNCERTAIN and forbids retry', async () => {
    const { wal } = await preparedWal();
    await wal.beginDispatch({ effectId, commitmentHash, ticketHash });
    await wal.markUncertain(effectId, 'adapter response unavailable');
    await expect(
      wal.beginDispatch({ effectId, commitmentHash, ticketHash }),
    ).rejects.toThrow('UNCERTAIN -> DISPATCHING');
  });

  it('records final-fence rejection as FAILED_PRE_EFFECT', async () => {
    const { wal } = await preparedWal();
    await wal.beginDispatch({ effectId, commitmentHash, ticketHash });
    await wal.markFailedPreEffect(effectId, 'grant revoked');
    expect(wal.get(effectId)?.state).toBe('FAILED_PRE_EFFECT');
  });

  it('recovers persisted DISPATCHING records as UNCERTAIN', async () => {
    const persisted = persistence({
      version: 1,
      records: {
        [effectId]: {
          version: 1,
          effectId,
          kind: 'mcp-write',
          commitmentHash,
          ticketHash,
          state: 'DISPATCHING',
          createdAt: '2026-07-14T00:00:00.000Z',
          updatedAt: '2026-07-14T00:00:00.000Z',
          dispatchStartedAt: '2026-07-14T00:00:00.000Z',
          terminalAt: null,
          resultHash: null,
          error: null,
        },
      },
    });
    const wal = await ArtifactBridgeEffectWal.create(persisted.adapter, () =>
      Date.parse('2026-07-14T00:01:00.000Z'),
    );
    expect(wal.get(effectId)).toMatchObject({
      state: 'UNCERTAIN',
      terminalAt: '2026-07-14T00:01:00.000Z',
    });
  });

  it('binds the exact universal action, definition, and adapter hashes', async () => {
    const persisted = persistence();
    const wal = await ArtifactBridgeEffectWal.create(persisted.adapter);
    await wal.prepare({
      effectId,
      kind: 'agent-ask',
      commitmentHash,
      ticketHash,
      actionHash,
      definitionHash,
      adapterHash,
    });
    await expect(
      wal.prepare({
        effectId,
        kind: 'agent-ask',
        commitmentHash,
        ticketHash,
        actionHash,
        definitionHash: 'f'.repeat(64),
        adapterHash,
      }),
    ).rejects.toThrow('mismatch');
  });

  it('burns orphaned universal PREPARED records on startup without replay', async () => {
    const persisted = persistence({
      version: 1,
      records: {
        [effectId]: {
          version: 1,
          effectId,
          kind: 'automation',
          commitmentHash,
          ticketHash,
          actionHash,
          definitionHash,
          adapterHash,
          state: 'PREPARED',
          createdAt: '2026-07-14T00:00:00.000Z',
          updatedAt: '2026-07-14T00:00:00.000Z',
          dispatchStartedAt: null,
          terminalAt: null,
          resultHash: null,
          error: null,
        },
      },
    });
    const wal = await ArtifactBridgeEffectWal.create(persisted.adapter, () =>
      Date.parse('2026-07-14T00:01:00.000Z'),
    );
    expect(wal.get(effectId)).toMatchObject({
      state: 'FAILED_PRE_EFFECT',
      terminalAt: '2026-07-14T00:01:00.000Z',
    });
    await expect(
      wal.beginDispatch({ effectId, commitmentHash, ticketHash }),
    ).rejects.toThrow('FAILED_PRE_EFFECT -> DISPATCHING');
  });

  it('does not publish an in-memory transition when persistence fails', async () => {
    let saves = 0;
    const wal = await ArtifactBridgeEffectWal.create({
      load: async () => ({ version: 1, records: {} }),
      save: async () => {
        saves += 1;
        if (saves === 2) throw new Error('disk unavailable');
      },
    });
    await wal.prepare({
      effectId,
      kind: 'mcp-write',
      commitmentHash,
      ticketHash,
    });
    await expect(
      wal.beginDispatch({ effectId, commitmentHash, ticketHash }),
    ).rejects.toThrow('disk unavailable');
    expect(wal.get(effectId)?.state).toBe('PREPARED');
  });
});
