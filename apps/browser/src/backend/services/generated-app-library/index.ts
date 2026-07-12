import type { Dirent, Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from '@/services/logger';
import { getAgentsDir } from '@/utils/paths';
import { readPersistedData, writePersistedData } from '@/utils/persisted-data';
import {
  createGeneratedAppKey,
  createGeneratedAppPreviewUrl,
  decodeGeneratedAppKey,
  type GeneratedApp,
  type GeneratedAppActionResult,
  type GeneratedAppOwner,
  type GeneratedAppsListResult,
  type GeneratedAppsQuery,
  type GeneratedAppsSort,
  type GeneratedAppsStatusFilter,
  type LaunchGeneratedAppResult,
} from '@shared/generated-apps';

const STORE_VERSION = 1;
const MAX_AGENT_DIRECTORIES = 2_000;
const MAX_APPS = 5_000;
const MAX_APP_ENTRIES = 5_000;
const MAX_INDEX_HTML_BYTES = 256 * 1024;
const ENTRY_FILE_NAME = 'index.html';
const STORAGE_NAME = 'generated-app-library' as const;

const storedOwnerSchema = z.object({
  kind: z.literal('agent'),
  agentId: z.string().min(1).max(512),
  taskTitle: z.string().max(512).nullable(),
  workspacePath: z.string().max(4096).nullable(),
});

const storedAppSchema = z.object({
  key: z.string().min(1).max(4096),
  appId: z.string().min(1).max(512),
  owner: storedOwnerSchema,
  title: z.string().min(1).max(512),
  description: z.string().max(2048).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastOpenedAt: z.string().datetime().nullable(),
  regenerationRequestedAt: z.string().datetime().nullable(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  error: z.string().max(2048).nullable(),
});

const generatedAppLibraryStoreSchema = z.object({
  version: z.literal(STORE_VERSION),
  apps: z.record(z.string(), storedAppSchema),
});

type StoredGeneratedApp = z.infer<typeof storedAppSchema>;
type GeneratedAppLibraryStore = z.infer<typeof generatedAppLibraryStoreSchema>;

export type GeneratedAppOwnerSnapshot = {
  taskTitle: string | null;
  workspacePath: string | null;
};

type ScannedGeneratedApp = {
  agentId: string;
  appId: string;
  title: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
  totalBytes: number;
  error: string | null;
};

type RegenerateGeneratedAppInput = {
  agentId: string;
  appId: string;
  title: string;
};

export type GeneratedAppLibraryServiceOptions = {
  logger: Logger;
  agentsDir?: string;
  now?: () => number;
  loadStore?: () => Promise<unknown>;
  saveStore?: (store: GeneratedAppLibraryStore) => Promise<void>;
  getOwnerSnapshots?: (
    agentIds: string[],
  ) => Promise<Map<string, GeneratedAppOwnerSnapshot>>;
  openPreview?: (app: GeneratedApp) => Promise<void>;
  regenerateOwnerApp?: (input: RegenerateGeneratedAppInput) => Promise<void>;
};

const DEFAULT_STORE: GeneratedAppLibraryStore = {
  version: STORE_VERSION,
  apps: {},
};

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function isSafePathPart(part: string): boolean {
  return (
    part.length > 0 &&
    part !== '.' &&
    part !== '..' &&
    !part.includes('/') &&
    !part.includes('\\') &&
    !part.includes('\0') &&
    part.length <= 512
  );
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function safeIso(value: number): string {
  return new Date(Number.isFinite(value) ? value : 0).toISOString();
}

function humanizeAppId(appId: string): string {
  const value = appId
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return 'Generated app';
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`.slice(0, 512);
}

function decodeHtmlEntities(value: string): string {
  const fromCodePoint = (code: string, radix: number, fallback: string) => {
    const parsed = Number.parseInt(code, radix);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0x10ffff) {
      return fallback;
    }
    try {
      return String.fromCodePoint(parsed);
    } catch {
      return fallback;
    }
  };

  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (match, code: string) =>
      fromCodePoint(code, 10, match),
    )
    .replace(/&#x([0-9a-f]+);/gi, (match, code: string) =>
      fromCodePoint(code, 16, match),
    );
}

function normalizeMetadataText(value: string, maxLength: number): string {
  return decodeHtmlEntities(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function readHtmlAttribute(tag: string, name: string): string | null {
  const match = tag.match(
    new RegExp(
      `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\x60]+))`,
      'i',
    ),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function extractHtmlMetadata(
  html: string,
  appId: string,
): { title: string; description: string | null } {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? normalizeMetadataText(titleMatch[1] ?? '', 512)
    : '';

  let description: string | null = null;
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const name = readHtmlAttribute(tag, 'name')?.toLowerCase();
    const property = readHtmlAttribute(tag, 'property')?.toLowerCase();
    if (name !== 'description' && property !== 'og:description') continue;
    const content = readHtmlAttribute(tag, 'content');
    if (!content) continue;
    const normalized = normalizeMetadataText(content, 2048);
    if (normalized) {
      description = normalized;
      break;
    }
  }

  return {
    title: title || humanizeAppId(appId),
    description,
  };
}

function summarize(apps: GeneratedApp[]): GeneratedAppsListResult['summary'] {
  return {
    total: apps.length,
    ready: apps.filter((app) => app.status === 'ready').length,
    needsAttention: apps.filter(
      (app) => app.status === 'broken' || app.status === 'missing',
    ).length,
    regenerating: apps.filter((app) => app.status === 'regenerating').length,
  };
}

function matchesStatus(
  app: GeneratedApp,
  status: GeneratedAppsStatusFilter,
): boolean {
  if (status === 'all') return true;
  if (status === 'attention')
    return app.status === 'broken' || app.status === 'missing';
  return app.status === status;
}

function sortGeneratedApps(
  apps: GeneratedApp[],
  sort: GeneratedAppsSort,
): GeneratedApp[] {
  return apps.sort((left, right) => {
    if (sort === 'title-asc') {
      return left.title.localeCompare(right.title, undefined, {
        sensitivity: 'base',
      });
    }
    if (sort === 'opened-desc') {
      const openedDiff =
        Date.parse(right.lastOpenedAt ?? '') -
        Date.parse(left.lastOpenedAt ?? '');
      if (Number.isFinite(openedDiff) && openedDiff !== 0) return openedDiff;
    }
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

function applyQuery(
  apps: GeneratedApp[],
  query: GeneratedAppsQuery,
): GeneratedApp[] {
  const normalizedQuery = query.query?.trim().toLocaleLowerCase() ?? '';
  const status = query.status ?? 'all';

  const filtered = apps.filter((app) => {
    if (!matchesStatus(app, status)) return false;
    if (
      query.workspacePath &&
      app.owner.workspacePath !== query.workspacePath
    ) {
      return false;
    }
    if (query.ownerAgentId && app.owner.agentId !== query.ownerAgentId) {
      return false;
    }
    if (!normalizedQuery) return true;

    return [
      app.title,
      app.description ?? '',
      app.appId,
      app.owner.taskTitle ?? '',
      app.owner.workspacePath ?? '',
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });

  return sortGeneratedApps(filtered, query.sort ?? 'updated-desc');
}

function actionFailure(
  code: Exclude<GeneratedAppActionResult, { ok: true }>['code'],
  message: string,
  retryable: boolean,
): Exclude<GeneratedAppActionResult, { ok: true }> {
  return { ok: false, code, message, retryable };
}

export class GeneratedAppLibraryService {
  private readonly logger: Logger;
  private readonly agentsDir: string;
  private readonly now: () => number;
  private readonly loadStoreImpl: () => Promise<unknown>;
  private readonly saveStoreImpl: (
    store: GeneratedAppLibraryStore,
  ) => Promise<void>;
  private readonly getOwnerSnapshots?: GeneratedAppLibraryServiceOptions['getOwnerSnapshots'];
  private readonly openPreview?: GeneratedAppLibraryServiceOptions['openPreview'];
  private readonly regenerateOwnerApp?: GeneratedAppLibraryServiceOptions['regenerateOwnerApp'];
  private storePromise: Promise<GeneratedAppLibraryStore> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly regenerationRequests = new Map<
    string,
    Promise<GeneratedAppActionResult>
  >();

  private constructor(options: GeneratedAppLibraryServiceOptions) {
    this.logger = options.logger;
    this.agentsDir = path.resolve(options.agentsDir ?? getAgentsDir());
    this.now = options.now ?? Date.now;
    this.loadStoreImpl =
      options.loadStore ??
      (() =>
        readPersistedData(
          STORAGE_NAME,
          generatedAppLibraryStoreSchema,
          DEFAULT_STORE,
        ));
    this.saveStoreImpl =
      options.saveStore ??
      ((store) =>
        writePersistedData(
          STORAGE_NAME,
          generatedAppLibraryStoreSchema,
          store,
        ));
    this.getOwnerSnapshots = options.getOwnerSnapshots;
    this.openPreview = options.openPreview;
    this.regenerateOwnerApp = options.regenerateOwnerApp;
  }

  public static create(
    options: GeneratedAppLibraryServiceOptions,
  ): GeneratedAppLibraryService {
    return new GeneratedAppLibraryService(options);
  }

  private async loadStore(): Promise<GeneratedAppLibraryStore> {
    this.storePromise ??= this.loadStoreImpl().then((value) => {
      const parsed = generatedAppLibraryStoreSchema.safeParse(value);
      if (parsed.success) return parsed.data;
      this.logger.warn(
        '[GeneratedAppLibrary] Ignoring invalid local metadata store',
      );
      return structuredClone(DEFAULT_STORE);
    });
    return await this.storePromise;
  }

  private async saveStore(store: GeneratedAppLibraryStore): Promise<void> {
    const parsed = generatedAppLibraryStoreSchema.parse(store);
    await this.saveStoreImpl(parsed);
    this.storePromise = Promise.resolve(parsed);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release: () => void = () => {};
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readDirectory(directory: string): Promise<Dirent[] | null> {
    try {
      return await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  private async inspectAppDirectory(
    appDirectory: string,
    appId: string,
  ): Promise<Omit<ScannedGeneratedApp, 'agentId' | 'appId'>> {
    let rootStat: Stats;
    try {
      rootStat = await fs.stat(appDirectory);
    } catch {
      const fallback = safeIso(this.now());
      return {
        title: humanizeAppId(appId),
        description: null,
        createdAt: fallback,
        updatedAt: fallback,
        fileCount: 0,
        totalBytes: 0,
        error: 'The app directory could not be read.',
      };
    }

    let fileCount = 0;
    let totalBytes = 0;
    let scannedEntries = 0;
    let newestMtime = rootStat.mtimeMs;
    let scanError: string | null = null;
    const queue = [appDirectory];

    while (queue.length > 0 && !scanError) {
      const current = queue.shift();
      if (!current) break;

      let entries: Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        scanError = 'One or more app files could not be inspected.';
        break;
      }

      for (const entry of entries) {
        scannedEntries += 1;
        if (scannedEntries > MAX_APP_ENTRIES) {
          scanError = `The app contains more than ${MAX_APP_ENTRIES.toLocaleString()} entries.`;
          break;
        }

        const entryPath = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          queue.push(entryPath);
          continue;
        }
        if (!entry.isFile()) continue;

        try {
          const stat = await fs.stat(entryPath);
          fileCount += 1;
          totalBytes += stat.size;
          newestMtime = Math.max(newestMtime, stat.mtimeMs);
        } catch {
          scanError = 'One or more app files could not be inspected.';
          break;
        }
      }
    }

    const entryPath = path.join(appDirectory, ENTRY_FILE_NAME);
    let htmlMetadata = {
      title: humanizeAppId(appId),
      description: null as string | null,
    };
    let entryError: string | null = null;
    try {
      const entryStat = await fs.lstat(entryPath);
      if (!entryStat.isFile() || entryStat.isSymbolicLink()) {
        entryError = 'index.html must be a regular file.';
      } else if (entryStat.size > MAX_INDEX_HTML_BYTES) {
        entryError = 'index.html is too large to inspect safely.';
      } else {
        const realAppDirectory = await fs.realpath(appDirectory);
        const realEntryPath = await fs.realpath(entryPath);
        if (!isPathInside(realAppDirectory, realEntryPath)) {
          entryError = 'index.html resolves outside the app directory.';
        } else {
          const html = await fs.readFile(realEntryPath, 'utf8');
          htmlMetadata = extractHtmlMetadata(html, appId);
        }
      }
    } catch (error) {
      entryError =
        isNodeError(error) && error.code === 'ENOENT'
          ? 'index.html is missing.'
          : 'index.html could not be read.';
    }

    return {
      ...htmlMetadata,
      createdAt: safeIso(rootStat.birthtimeMs || rootStat.ctimeMs),
      updatedAt: safeIso(newestMtime),
      fileCount,
      totalBytes,
      error: entryError ?? scanError,
    };
  }

  private async scanDisk(): Promise<ScannedGeneratedApp[]> {
    const agentEntries = await this.readDirectory(this.agentsDir);
    if (!agentEntries) return [];

    let realAgentsDir: string;
    try {
      realAgentsDir = await fs.realpath(this.agentsDir);
    } catch {
      return [];
    }

    const scanned: ScannedGeneratedApp[] = [];
    const safeAgentEntries = agentEntries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          isSafePathPart(entry.name),
      )
      .slice(0, MAX_AGENT_DIRECTORIES);

    for (const agentEntry of safeAgentEntries) {
      const agentId = agentEntry.name;
      const agentDirectory = path.resolve(this.agentsDir, agentId);
      const appsDirectory = path.resolve(agentDirectory, 'apps');

      try {
        const [realAgentDirectory, realAppsDirectory] = await Promise.all([
          fs.realpath(agentDirectory),
          fs.realpath(appsDirectory),
        ]);
        if (
          !isPathInside(realAgentsDir, realAgentDirectory) ||
          !isPathInside(realAgentDirectory, realAppsDirectory)
        ) {
          this.logger.warn(
            '[GeneratedAppLibrary] Skipping an apps directory outside its agent root',
          );
          continue;
        }

        const appEntries = await this.readDirectory(realAppsDirectory);
        if (!appEntries) continue;
        for (const appEntry of appEntries) {
          if (scanned.length >= MAX_APPS) return scanned;
          if (
            !appEntry.isDirectory() ||
            appEntry.isSymbolicLink() ||
            !isSafePathPart(appEntry.name)
          ) {
            continue;
          }

          const appId = appEntry.name;
          const appDirectory = path.resolve(realAppsDirectory, appId);
          let realAppDirectory: string;
          try {
            realAppDirectory = await fs.realpath(appDirectory);
          } catch {
            continue;
          }
          if (!isPathInside(realAppsDirectory, realAppDirectory)) {
            this.logger.warn(
              '[GeneratedAppLibrary] Skipping an app directory outside its owner root',
            );
            continue;
          }

          const inspection = await this.inspectAppDirectory(
            realAppDirectory,
            appId,
          );
          scanned.push({ agentId, appId, ...inspection });
        }
      } catch (error) {
        if (!(isNodeError(error) && error.code === 'ENOENT')) {
          this.logger.warn(
            '[GeneratedAppLibrary] Failed to inspect an agent apps directory',
            {
              agentId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
    }

    return scanned;
  }

  private async resolveOwners(
    agentIds: string[],
  ): Promise<Map<string, GeneratedAppOwnerSnapshot>> {
    if (!this.getOwnerSnapshots || agentIds.length === 0) return new Map();
    try {
      return await this.getOwnerSnapshots(Array.from(new Set(agentIds)));
    } catch (error) {
      this.logger.warn(
        '[GeneratedAppLibrary] Failed to resolve task ownership metadata',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return new Map();
    }
  }

  private createOwner(
    agentId: string,
    snapshot: GeneratedAppOwnerSnapshot | undefined,
    fallback: GeneratedAppOwner | undefined,
  ): GeneratedAppOwner {
    return {
      kind: 'agent',
      agentId,
      taskTitle: snapshot?.taskTitle ?? fallback?.taskTitle ?? null,
      workspacePath: snapshot?.workspacePath ?? fallback?.workspacePath ?? null,
    };
  }

  private materializeApp(
    stored: StoredGeneratedApp,
    status: GeneratedApp['status'],
  ): GeneratedApp {
    return {
      ...stored,
      status,
      entryPath: ENTRY_FILE_NAME,
      previewUrl: createGeneratedAppPreviewUrl(
        stored.owner.agentId,
        stored.appId,
        stored.updatedAt,
      ),
    };
  }

  private async scanAndReconcile(): Promise<{
    apps: GeneratedApp[];
    store: GeneratedAppLibraryStore;
  }> {
    const store = structuredClone(await this.loadStore());
    const before = JSON.stringify(store);
    const scanned = await this.scanDisk();
    const owners = await this.resolveOwners([
      ...scanned.map((app) => app.agentId),
      ...Object.values(store.apps).map((app) => app.owner.agentId),
    ]);
    const diskKeys = new Set<string>();
    const apps: GeneratedApp[] = [];

    for (const app of scanned) {
      const key = createGeneratedAppKey(app.agentId, app.appId);
      diskKeys.add(key);
      const previous = store.apps[key];
      const owner = this.createOwner(
        app.agentId,
        owners.get(app.agentId),
        previous?.owner,
      );
      const requestedAt = previous?.regenerationRequestedAt ?? null;
      const regenerationPending =
        requestedAt !== null &&
        Date.parse(app.updatedAt) <= Date.parse(requestedAt);
      const stored: StoredGeneratedApp = {
        key,
        appId: app.appId,
        owner,
        title: app.title,
        description: app.description,
        createdAt: app.createdAt,
        updatedAt: app.updatedAt,
        lastOpenedAt: previous?.lastOpenedAt ?? null,
        regenerationRequestedAt: regenerationPending ? requestedAt : null,
        fileCount: app.fileCount,
        totalBytes: app.totalBytes,
        error: app.error,
      };
      store.apps[key] = stored;
      apps.push(
        this.materializeApp(
          stored,
          regenerationPending ? 'regenerating' : app.error ? 'broken' : 'ready',
        ),
      );
    }

    for (const [key, previous] of Object.entries(store.apps)) {
      if (diskKeys.has(key)) continue;
      const owner = this.createOwner(
        previous.owner.agentId,
        owners.get(previous.owner.agentId),
        previous.owner,
      );
      const stored: StoredGeneratedApp = {
        ...previous,
        owner,
        error: 'The generated app directory is missing.',
      };
      store.apps[key] = stored;
      apps.push(
        this.materializeApp(
          stored,
          stored.regenerationRequestedAt ? 'regenerating' : 'missing',
        ),
      );
    }

    if (JSON.stringify(store) !== before) await this.saveStore(store);
    return { apps, store };
  }

  public async listGeneratedApps(
    query: GeneratedAppsQuery = {},
  ): Promise<GeneratedAppsListResult> {
    return await this.withLock(async () => {
      const { apps } = await this.scanAndReconcile();
      return {
        apps: applyQuery(apps, query),
        summary: summarize(apps),
      };
    });
  }

  public async getGeneratedApp(key: string): Promise<GeneratedApp | null> {
    return await this.withLock(async () => {
      const { apps } = await this.scanAndReconcile();
      return apps.find((app) => app.key === key) ?? null;
    });
  }

  public async launchGeneratedApp(
    key: string,
  ): Promise<LaunchGeneratedAppResult> {
    return await this.withLock(async () => {
      const { apps, store } = await this.scanAndReconcile();
      const app = apps.find((candidate) => candidate.key === key);
      if (!app) {
        return actionFailure(
          'not-found',
          'The generated app no longer exists in this library.',
          false,
        );
      }
      if (app.status === 'broken' || app.status === 'missing') {
        return actionFailure(
          'not-runnable',
          'Repair or regenerate this app before launching it.',
          false,
        );
      }
      if (!this.openPreview) {
        return actionFailure(
          'operation-failed',
          'App launching is not available in this window.',
          true,
        );
      }

      try {
        await this.openPreview(app);
        const openedAt = safeIso(this.now());
        const stored = store.apps[key];
        if (stored) {
          stored.lastOpenedAt = openedAt;
          await this.saveStore(store);
        }
        return {
          ok: true,
          app: { ...app, lastOpenedAt: openedAt },
          previewUrl: app.previewUrl,
        };
      } catch (error) {
        this.logger.warn('[GeneratedAppLibrary] Failed to launch app', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
        return actionFailure(
          'operation-failed',
          'The app preview could not be opened.',
          true,
        );
      }
    });
  }

  private async resolveOwnedAppDirectory(
    key: string,
  ): Promise<
    | { ok: true; agentId: string; appId: string; appDirectory: string }
    | { ok: false; message: string }
  > {
    const identity = decodeGeneratedAppKey(key);
    if (
      !identity ||
      !isSafePathPart(identity.agentId) ||
      !isSafePathPart(identity.appId)
    ) {
      return { ok: false, message: 'The generated app identity is invalid.' };
    }

    const agentDirectory = path.resolve(this.agentsDir, identity.agentId);
    const appsDirectory = path.resolve(agentDirectory, 'apps');
    const appDirectory = path.resolve(appsDirectory, identity.appId);
    if (
      !isPathInside(this.agentsDir, agentDirectory) ||
      !isPathInside(agentDirectory, appsDirectory) ||
      !isPathInside(appsDirectory, appDirectory)
    ) {
      return { ok: false, message: 'The generated app path is unsafe.' };
    }

    try {
      const [realAgentsDir, realAgentDirectory, realAppsDirectory] =
        await Promise.all([
          fs.realpath(this.agentsDir),
          fs.realpath(agentDirectory),
          fs.realpath(appsDirectory),
        ]);
      if (
        !isPathInside(realAgentsDir, realAgentDirectory) ||
        !isPathInside(realAgentDirectory, realAppsDirectory)
      ) {
        return { ok: false, message: 'The generated app path is unsafe.' };
      }

      let targetStat: Stats;
      try {
        targetStat = await fs.lstat(appDirectory);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          return {
            ok: true,
            agentId: identity.agentId,
            appId: identity.appId,
            appDirectory,
          };
        }
        throw error;
      }
      if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
        return {
          ok: false,
          message: 'The generated app path is not a regular directory.',
        };
      }
      const realAppDirectory = await fs.realpath(appDirectory);
      if (!isPathInside(realAppsDirectory, realAppDirectory)) {
        return { ok: false, message: 'The generated app path is unsafe.' };
      }
      return {
        ok: true,
        agentId: identity.agentId,
        appId: identity.appId,
        appDirectory,
      };
    } catch {
      return {
        ok: false,
        message: 'The generated app path could not be validated.',
      };
    }
  }

  public async deleteGeneratedApp(
    key: string,
  ): Promise<GeneratedAppActionResult> {
    return await this.withLock(async () => {
      const target = await this.resolveOwnedAppDirectory(key);
      if (!target.ok) {
        return actionFailure('unsafe-path', target.message, false);
      }

      const store = structuredClone(await this.loadStore());
      const previous = store.apps[key];
      if (!previous) {
        const { apps } = await this.scanAndReconcile();
        if (!apps.some((app) => app.key === key)) {
          return actionFailure(
            'not-found',
            'The generated app no longer exists in this library.',
            false,
          );
        }
      }

      try {
        await fs.rm(target.appDirectory, { recursive: true, force: true });
        const deleted = previous ??
          store.apps[key] ?? {
            key,
            appId: target.appId,
            owner: {
              kind: 'agent' as const,
              agentId: target.agentId,
              taskTitle: null,
              workspacePath: null,
            },
            title: humanizeAppId(target.appId),
            description: null,
            createdAt: safeIso(this.now()),
            updatedAt: safeIso(this.now()),
            lastOpenedAt: null,
            regenerationRequestedAt: null,
            fileCount: 0,
            totalBytes: 0,
            error: null,
          };
        delete store.apps[key];
        await this.saveStore(store);
        return {
          ok: true,
          app: this.materializeApp(deleted, 'missing'),
          message: 'Generated app deleted.',
        };
      } catch (error) {
        this.logger.warn('[GeneratedAppLibrary] Failed to delete app', {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
        return actionFailure(
          'operation-failed',
          'The generated app could not be deleted.',
          true,
        );
      }
    });
  }

  public regenerateGeneratedApp(
    key: string,
  ): Promise<GeneratedAppActionResult> {
    const inFlight = this.regenerationRequests.get(key);
    if (inFlight) return inFlight;

    const request = this.regenerateGeneratedAppInternal(key).finally(() => {
      this.regenerationRequests.delete(key);
    });
    this.regenerationRequests.set(key, request);
    return request;
  }

  private async regenerateGeneratedAppInternal(
    key: string,
  ): Promise<GeneratedAppActionResult> {
    let app: GeneratedApp | null = null;
    let requestedAt: string | null = null;
    const marked = await this.withLock(async () => {
      const reconciled = await this.scanAndReconcile();
      app = reconciled.apps.find((candidate) => candidate.key === key) ?? null;
      if (!app) return false;
      const stored = reconciled.store.apps[key];
      if (!stored) return false;
      requestedAt = safeIso(this.now());
      stored.regenerationRequestedAt = requestedAt;
      await this.saveStore(reconciled.store);
      return true;
    });

    if (!marked || !app) {
      return actionFailure(
        'not-found',
        'The generated app no longer exists in this library.',
        false,
      );
    }
    if (!this.regenerateOwnerApp) {
      await this.clearRegenerationRequest(key);
      return actionFailure(
        'owner-unavailable',
        'The owner task is not available for regeneration.',
        true,
      );
    }

    const selectedApp = app as GeneratedApp;
    try {
      await this.regenerateOwnerApp({
        agentId: selectedApp.owner.agentId,
        appId: selectedApp.appId,
        title: selectedApp.title,
      });
      const regeneratingApp: GeneratedApp = {
        ...selectedApp,
        status: 'regenerating',
        regenerationRequestedAt: requestedAt,
      };
      return {
        ok: true,
        app: regeneratingApp,
        message:
          'Regeneration was sent to the owner task. Existing files stay available until replacements are ready.',
      };
    } catch (error) {
      await this.clearRegenerationRequest(key);
      this.logger.warn('[GeneratedAppLibrary] Failed to request regeneration', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return actionFailure(
        'operation-failed',
        'The regeneration request could not be sent to the owner task.',
        true,
      );
    }
  }

  private async clearRegenerationRequest(key: string): Promise<void> {
    await this.withLock(async () => {
      const store = structuredClone(await this.loadStore());
      const stored = store.apps[key];
      if (!stored || stored.regenerationRequestedAt === null) return;
      stored.regenerationRequestedAt = null;
      await this.saveStore(store);
    });
  }
}
