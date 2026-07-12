import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AeadDataProtection,
  ProtectedFileStorage,
} from '@clodex/agent-core/host';

const pathMock = vi.hoisted(() => ({
  chronicleDir: '',
  segmentsDir: '',
  ocrDir: '',
  summariesDir: '',
}));

vi.mock('@/utils/paths', () => ({
  getAgentOsStatePath: () =>
    path.join(pathMock.chronicleDir, '..', 'state.json'),
  getChronicleDir: () => pathMock.chronicleDir,
  getChronicleSegmentsDir: () => pathMock.segmentsDir,
  getChronicleOcrDir: () => pathMock.ocrDir,
  getChronicleSummariesDir: () => pathMock.summariesDir,
}));

import { AgentOsStateStore } from './state-store';
import { ChronicleService } from './chronicle';

describe('ChronicleService', () => {
  let root: string;
  let store: AgentOsStateStore;
  let captureImage: Buffer;
  let service: ChronicleService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-os-chronicle-'));
    pathMock.chronicleDir = path.join(root, 'chronicle');
    pathMock.segmentsDir = path.join(pathMock.chronicleDir, 'segments');
    pathMock.ocrDir = path.join(pathMock.chronicleDir, 'ocr');
    pathMock.summariesDir = path.join(pathMock.chronicleDir, 'summaries');
    store = await AgentOsStateStore.create(path.join(root, 'state.json'));
    captureImage = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 4,
        background: { r: 20, g: 80, b: 160, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    service = new ChronicleService(store, async () => ({
      image: captureImage,
      windowTitle: 'alice@example.com dashboard',
      appBundleId: 'com.example.browser',
    }));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not capture before explicit enablement', async () => {
    await expect(service.captureNow()).rejects.toThrow('must be enabled');
    await expect(
      fs.stat(path.join(root, 'chronicle', 'segments')),
    ).rejects.toThrow();
  });

  it('persists a privacy-filtered, blurred capture after enablement', async () => {
    await service.setEnabled(true);

    const event = await service.captureNow();

    expect(event.privacyFiltered).toBe(true);
    expect(event.windowTitle).toBe('[REDACTED_EMAIL] dashboard');
    expect(event.artifactPath).toBeDefined();
    const artifactStat = await fs.stat(event.artifactPath!);
    expect(artifactStat).toMatchObject({
      size: expect.any(Number),
    });
    if (process.platform !== 'win32') {
      expect(artifactStat.mode & 0o777).toBe(0o600);
    }
    expect(store.snapshot().chronicle.recording).toBe(false);
    expect(store.snapshot().chronicle.segments).toHaveLength(1);
  });

  it('redacts manual memory, supports search, summaries, and clear', async () => {
    await service.setEnabled(true);
    const manual = await service.captureManual(
      'Investigated sk-abcdefghijklmnopqrstuvwxyz0123456789 for alice@example.com',
    );

    expect(manual.text).toBe('Investigated [REDACTED] for [REDACTED_EMAIL]');
    expect(service.search('investigated')).toEqual([manual]);
    expect(service.getRecent(1)).toEqual([manual]);

    const summary = await service.summarizeLastWindow(60_000);
    expect(summary.source).toBe('summary');
    expect(summary.text).toContain('Investigated [REDACTED]');
    await expect(fs.stat(summary.artifactPath!)).resolves.toBeDefined();

    await service.clear();

    expect(store.snapshot().chronicle.events).toEqual([]);
    expect(store.snapshot().chronicle.segments).toEqual([]);
    await expect(fs.stat(summary.artifactPath!)).rejects.toThrow();
  });

  it('never deletes retention artifact paths outside the Chronicle root', async () => {
    const outsidePath = path.join(root, 'must-survive.txt');
    await fs.writeFile(outsidePath, 'keep');
    await store.update((draft) => {
      draft.chronicle.enabled = true;
      draft.chronicle.events.push({
        id: 'tampered-event',
        capturedAt: 0,
        source: 'summary',
        text: 'tampered persisted path',
        artifactPath: outsidePath,
        privacyFiltered: true,
      });
    });

    await service.setSettings({ retention: '1-hour' });

    await expect(fs.readFile(outsidePath, 'utf-8')).resolves.toBe('keep');
    expect(store.snapshot().chronicle.events).toEqual([]);
  });

  it('protects new artifacts and migrates legacy Chronicle files', async () => {
    const protectedFiles = new ProtectedFileStorage(
      new AeadDataProtection(randomBytes(32)),
      { chunkSize: 4096 },
    );
    const protectedService = new ChronicleService(
      store,
      async () => ({
        image: captureImage,
        windowTitle: 'sensitive-window-title',
      }),
      protectedFiles,
    );
    await protectedService.setEnabled(true);
    const capture = await protectedService.captureNow();
    const diskCapture = await fs.readFile(capture.artifactPath!);
    expect(diskCapture.subarray(0, 8).toString('ascii')).toBe('CLODEXPF');
    expect(
      await protectedService.readArtifact(capture.artifactPath!),
    ).not.toEqual(diskCapture);

    const legacyPath = path.join(pathMock.summariesDir, 'legacy.md');
    const orphanPath = path.join(pathMock.ocrDir, 'orphan.txt');
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.mkdir(path.dirname(orphanPath), { recursive: true });
    await fs.writeFile(legacyPath, 'legacy chronicle secret');
    await fs.writeFile(orphanPath, 'orphan chronicle secret');
    await store.update((draft) => {
      draft.chronicle.events.push({
        id: 'legacy',
        capturedAt: Date.now(),
        source: 'summary',
        text: 'legacy',
        artifactPath: legacyPath,
        privacyFiltered: true,
      });
    });
    await expect(protectedService.migrateExistingArtifacts()).resolves.toBe(2);
    expect(await protectedService.readArtifact(legacyPath)).toEqual(
      Buffer.from('legacy chronicle secret'),
    );
    expect(await fs.readFile(legacyPath, 'utf-8')).not.toContain(
      'legacy chronicle secret',
    );
    expect(await protectedService.readArtifact(orphanPath)).toEqual(
      Buffer.from('orphan chronicle secret'),
    );
  });
});
