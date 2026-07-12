import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  protectedFileContext,
  type ProtectedFileStorage,
} from '@clodex/agent-core/host';
import {
  AGENT_OS_LIMITS,
  chroniclePrivacyModeSchema,
  chronicleRetentionSchema,
  type ChronicleEvent,
  type ChroniclePrivacyMode,
  type ChronicleRetention,
  type ChronicleSegment,
} from '@shared/agent-os';
import {
  getChronicleDir,
  getChronicleOcrDir,
  getChronicleSegmentsDir,
  getChronicleSummariesDir,
  getAgentOsStatePath,
} from '@/utils/paths';
import { AgentOsStateStore } from './state-store';
import { redactSensitiveText } from './privacy';

export interface ChronicleCapture {
  image: Buffer;
  windowTitle?: string;
  appBundleId?: string;
}

export type ChronicleCaptureProvider = () => Promise<ChronicleCapture | null>;

const RETENTION_MS: Record<Exclude<ChronicleRetention, 'off'>, number> = {
  '1-hour': 60 * 60 * 1000,
  '24-hours': 24 * 60 * 60 * 1000,
  '7-days': 7 * 24 * 60 * 60 * 1000,
};

export async function migrateChronicleArtifacts(
  protectedFiles: ProtectedFileStorage,
): Promise<number> {
  const store = await AgentOsStateStore.create(getAgentOsStatePath());
  const chronicle = new ChronicleService(
    store,
    async () => null,
    protectedFiles,
  );
  return chronicle.migrateExistingArtifacts();
}

export class ChronicleService {
  public constructor(
    private readonly store: AgentOsStateStore,
    private readonly captureProvider: ChronicleCaptureProvider,
    private readonly protectedFiles?: ProtectedFileStorage,
  ) {}

  public async setEnabled(enabled: boolean): Promise<void> {
    await this.store.update((draft) => {
      draft.chronicle.enabled = enabled;
      if (!enabled) draft.chronicle.recording = false;
    });
  }

  public async setSettings(settings: {
    retention?: ChronicleRetention;
    privacyMode?: ChroniclePrivacyMode;
  }): Promise<void> {
    const retention =
      settings.retention === undefined
        ? undefined
        : chronicleRetentionSchema.parse(settings.retention);
    const privacyMode =
      settings.privacyMode === undefined
        ? undefined
        : chroniclePrivacyModeSchema.parse(settings.privacyMode);

    await this.store.update((draft) => {
      if (retention !== undefined) draft.chronicle.retention = retention;
      if (privacyMode !== undefined) {
        draft.chronicle.privacyMode = privacyMode;
      }
    });
    await this.applyRetention();
  }

  public async captureNow(): Promise<ChronicleEvent> {
    const state = this.store.snapshot().chronicle;
    if (!state.enabled) {
      throw new Error('Chronicle must be enabled before capturing');
    }

    await this.store.update((draft) => {
      draft.chronicle.recording = true;
    });

    try {
      const capture = await this.captureProvider();
      if (!capture) throw new Error('No capturable window is available');

      const id = randomUUID();
      const capturedAt = Date.now();
      const segmentDir = path.join(getChronicleSegmentsDir(), id);
      const artifactPath = path.join(segmentDir, 'frame.png');
      await fs.mkdir(segmentDir, { recursive: true, mode: 0o700 });

      const blurSigma = state.privacyMode === 'strict' ? 32 : 16;
      const filteredImage = await sharp(capture.image)
        .blur(blurSigma)
        .png({ compressionLevel: 9 })
        .toBuffer();
      if (this.protectedFiles) {
        await this.protectedFiles.writeFile(
          artifactPath,
          filteredImage,
          this.artifactContext(artifactPath),
        );
      } else {
        await fs.writeFile(artifactPath, filteredImage, { mode: 0o600 });
      }

      const text = redactSensitiveText(
        capture.windowTitle
          ? `Captured window: ${capture.windowTitle}`
          : 'Captured current application window',
        { redactEmails: state.privacyMode === 'strict' },
      );
      const event: ChronicleEvent = {
        id,
        capturedAt,
        source: 'screen',
        windowTitle: capture.windowTitle
          ? redactSensitiveText(capture.windowTitle, {
              redactEmails: state.privacyMode === 'strict',
            })
          : undefined,
        appBundleId: capture.appBundleId,
        text,
        artifactPath,
        privacyFiltered: true,
      };

      let trimmed: {
        events: ChronicleEvent[];
        segments: ChronicleSegment[];
      } = { events: [], segments: [] };
      await this.store.update((draft) => {
        draft.chronicle.recording = false;
        draft.chronicle.lastCaptureAt = capturedAt;
        draft.chronicle.events.push(event);
        draft.chronicle.segments.push({
          id,
          startedAt: capturedAt,
          endedAt: capturedAt,
          frameDir: segmentDir,
          ocrPath: path.join(getChronicleOcrDir(), `${id}.txt`),
          summaryPath: path.join(getChronicleSummariesDir(), `${id}.md`),
        });
        trimmed = this.trimState(draft.chronicle);
      });
      await this.cleanupArtifacts(trimmed.events, trimmed.segments);
      await this.applyRetention();
      return event;
    } catch (error) {
      await this.store.update((draft) => {
        draft.chronicle.recording = false;
      });
      throw error;
    }
  }

  public async captureManual(text: string): Promise<ChronicleEvent> {
    const state = this.store.snapshot().chronicle;
    if (!state.enabled) {
      throw new Error('Chronicle must be enabled before adding memory');
    }
    const event: ChronicleEvent = {
      id: randomUUID(),
      capturedAt: Date.now(),
      source: 'manual',
      text: redactSensitiveText(text, {
        redactEmails: state.privacyMode === 'strict',
      }),
      privacyFiltered: true,
    };
    let trimmed: {
      events: ChronicleEvent[];
      segments: ChronicleSegment[];
    } = { events: [], segments: [] };
    await this.store.update((draft) => {
      draft.chronicle.lastCaptureAt = event.capturedAt;
      draft.chronicle.events.push(event);
      trimmed = this.trimState(draft.chronicle);
    });
    await this.cleanupArtifacts(trimmed.events, trimmed.segments);
    await this.applyRetention();
    return event;
  }

  public search(query: string): ChronicleEvent[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return this.store
      .snapshot()
      .chronicle.events.filter((event) => {
        const haystack = [
          event.text,
          event.windowTitle ?? '',
          event.appBundleId ?? '',
        ]
          .join('\n')
          .toLocaleLowerCase();
        return haystack.includes(normalized);
      })
      .sort((a, b) => b.capturedAt - a.capturedAt);
  }

  public getRecent(limit: number): ChronicleEvent[] {
    const safeLimit = Math.max(
      0,
      Math.min(AGENT_OS_LIMITS.maxChronicleEvents, Math.floor(limit)),
    );
    return this.store
      .snapshot()
      .chronicle.events.sort((a, b) => b.capturedAt - a.capturedAt)
      .slice(0, safeLimit);
  }

  public async summarizeLastWindow(
    durationMs: number,
  ): Promise<ChronicleEvent> {
    const state = this.store.snapshot().chronicle;
    if (!state.enabled) {
      throw new Error('Chronicle must be enabled before summarizing');
    }
    const since = Date.now() - Math.max(1, durationMs);
    const sourceEvents = state.events.filter(
      (event) => event.capturedAt >= since && event.source !== 'summary',
    );
    const text =
      sourceEvents.length === 0
        ? 'No Chronicle events were captured in this window.'
        : sourceEvents
            .slice(-20)
            .map(
              (event) =>
                `- ${new Date(event.capturedAt).toISOString()}: ${event.text}`,
            )
            .join('\n');
    const id = randomUUID();
    const summaryPath = path.join(getChronicleSummariesDir(), `${id}.md`);
    await fs.mkdir(getChronicleSummariesDir(), {
      recursive: true,
      mode: 0o700,
    });
    if (this.protectedFiles) {
      await this.protectedFiles.writeFile(
        summaryPath,
        `${text}\n`,
        this.artifactContext(summaryPath),
      );
    } else {
      await fs.writeFile(summaryPath, `${text}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
      });
    }

    const event: ChronicleEvent = {
      id,
      capturedAt: Date.now(),
      source: 'summary',
      text,
      artifactPath: summaryPath,
      privacyFiltered: true,
    };
    let trimmed: {
      events: ChronicleEvent[];
      segments: ChronicleSegment[];
    } = { events: [], segments: [] };
    await this.store.update((draft) => {
      draft.chronicle.events.push(event);
      trimmed = this.trimState(draft.chronicle);
    });
    await this.cleanupArtifacts(trimmed.events, trimmed.segments);
    await this.applyRetention();
    return event;
  }

  public async clear(): Promise<void> {
    await fs.rm(getChronicleDir(), { recursive: true, force: true });
    await Promise.all([
      fs.mkdir(getChronicleSegmentsDir(), { recursive: true, mode: 0o700 }),
      fs.mkdir(getChronicleOcrDir(), { recursive: true, mode: 0o700 }),
      fs.mkdir(getChronicleSummariesDir(), { recursive: true, mode: 0o700 }),
    ]);
    await this.store.update((draft) => {
      draft.chronicle.recording = false;
      draft.chronicle.lastCaptureAt = null;
      draft.chronicle.events = [];
      draft.chronicle.segments = [];
    });
  }

  public async readArtifact(artifactPath: string): Promise<Buffer> {
    const resolved = this.assertArtifactPath(artifactPath);
    if (this.protectedFiles) {
      if (!(await this.protectedFiles.isProtectedFile(resolved))) {
        throw new Error(
          'Plaintext Chronicle artifact found after protected migration',
        );
      }
      return this.protectedFiles.readFile(
        resolved,
        this.artifactContext(resolved),
      );
    }
    return fs.readFile(resolved);
  }

  public async migrateExistingArtifacts(): Promise<number> {
    if (!this.protectedFiles) return 0;
    const state = this.store.snapshot().chronicle;
    const candidates = new Set<string>();
    for (const event of state.events) {
      if (event.artifactPath) candidates.add(event.artifactPath);
    }
    for (const segment of state.segments) {
      candidates.add(path.join(segment.frameDir, 'frame.png'));
      candidates.add(segment.ocrPath);
      candidates.add(segment.summaryPath);
    }
    const walk = async (directory: string): Promise<void> => {
      let entries: Awaited<ReturnType<typeof fs.readdir>>;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.includes('.staging')) continue;
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(absolutePath);
        } else if (entry.isFile()) {
          candidates.add(absolutePath);
        }
      }
    };
    await walk(getChronicleDir());

    let migrated = 0;
    for (const candidate of candidates) {
      let resolved: string;
      try {
        resolved = this.assertArtifactPath(candidate);
      } catch {
        continue;
      }
      const result = await this.protectedFiles.migrateFile(
        resolved,
        this.artifactContext(resolved),
      );
      if (result === 'migrated') migrated++;
    }
    return migrated;
  }

  private assertArtifactPath(artifactPath: string): string {
    const root = path.resolve(getChronicleDir());
    const resolved = path.resolve(artifactPath);
    const relative = path.relative(root, resolved);
    if (
      relative === '' ||
      relative.startsWith('..') ||
      path.isAbsolute(relative)
    ) {
      throw new Error('Chronicle artifact path is outside Chronicle storage');
    }
    return resolved;
  }

  private artifactContext(artifactPath: string): string {
    const root = path.resolve(getChronicleDir());
    const resolved = this.assertArtifactPath(artifactPath);
    return protectedFileContext.chronicle(path.relative(root, resolved));
  }

  private trimState(
    chronicle: ReturnType<AgentOsStateStore['snapshot']>['chronicle'],
  ): { events: ChronicleEvent[]; segments: ChronicleSegment[] } {
    const removedEvents: ChronicleEvent[] = [];
    const removedSegments: ChronicleSegment[] = [];
    if (chronicle.events.length > AGENT_OS_LIMITS.maxChronicleEvents) {
      removedEvents.push(
        ...chronicle.events.splice(
          0,
          chronicle.events.length - AGENT_OS_LIMITS.maxChronicleEvents,
        ),
      );
    }
    const removedEventIds = new Set(removedEvents.map((event) => event.id));
    if (removedEventIds.size > 0) {
      for (let index = chronicle.segments.length - 1; index >= 0; index--) {
        const segment = chronicle.segments[index];
        if (segment && removedEventIds.has(segment.id)) {
          removedSegments.push(segment);
          chronicle.segments.splice(index, 1);
        }
      }
    }
    if (chronicle.segments.length > AGENT_OS_LIMITS.maxChronicleSegments) {
      removedSegments.push(
        ...chronicle.segments.splice(
          0,
          chronicle.segments.length - AGENT_OS_LIMITS.maxChronicleSegments,
        ),
      );
    }
    const removedSegmentIds = new Set(
      removedSegments.map((segment) => segment.id),
    );
    if (removedSegmentIds.size > 0) {
      for (let index = chronicle.events.length - 1; index >= 0; index--) {
        const event = chronicle.events[index];
        if (event && removedSegmentIds.has(event.id)) {
          removedEvents.push(event);
          chronicle.events.splice(index, 1);
        }
      }
    }
    return { events: removedEvents, segments: removedSegments };
  }

  private async applyRetention(): Promise<void> {
    const state = this.store.snapshot().chronicle;
    if (state.retention === 'off') return;
    const cutoff = Date.now() - RETENTION_MS[state.retention];
    const expired = state.events.filter((event) => event.capturedAt < cutoff);
    const expiredSegments = state.segments.filter(
      (segment) => segment.startedAt < cutoff,
    );
    await this.cleanupArtifacts(expired, expiredSegments);
    await this.store.update((draft) => {
      draft.chronicle.events = draft.chronicle.events.filter(
        (event) => event.capturedAt >= cutoff,
      );
      draft.chronicle.segments = draft.chronicle.segments.filter(
        (segment) => segment.startedAt >= cutoff,
      );
    });
  }

  private async cleanupArtifacts(
    events: ChronicleEvent[],
    segments: ChronicleSegment[],
  ): Promise<void> {
    const chronicleRoot = path.resolve(getChronicleDir());
    const segmentRoot = path.resolve(getChronicleSegmentsDir());
    const safeRemove = async (
      candidate: string,
      recursive = false,
    ): Promise<void> => {
      const resolved = path.resolve(candidate);
      const relative = path.relative(chronicleRoot, resolved);
      if (
        relative === '' ||
        relative.startsWith('..') ||
        path.isAbsolute(relative)
      ) {
        return;
      }
      await fs.rm(resolved, { recursive, force: true }).catch(() => undefined);
    };

    for (const event of events) {
      if (!event.artifactPath) continue;
      const artifactPath = path.resolve(event.artifactPath);
      await safeRemove(artifactPath);
      const parent = path.dirname(artifactPath);
      const relativeToSegments = path.relative(segmentRoot, parent);
      if (
        relativeToSegments !== '' &&
        !relativeToSegments.startsWith('..') &&
        !path.isAbsolute(relativeToSegments)
      ) {
        await safeRemove(parent, true);
      }
    }
    for (const segment of segments) {
      await safeRemove(segment.frameDir, true);
      await safeRemove(segment.ocrPath);
      await safeRemove(segment.summaryPath);
    }
  }
}
