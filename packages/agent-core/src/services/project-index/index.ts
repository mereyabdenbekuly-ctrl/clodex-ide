import path from 'node:path';
import { readdir, readFile, stat } from '../../fs';
import {
  getFileSymbols,
  getLanguageForExt,
  type SymbolInfo,
} from '../../file-read-transformer/ast';
import type {
  FileIndex,
  ProjectIndexMount,
  ProjectIndexSymbol,
  ProjectSymbolMatch,
  SearchProjectSymbolsOptions,
  SearchProjectSymbolsResult,
} from './types';

export type {
  FileIndex,
  ProjectIndexMount,
  ProjectIndexSymbol,
  ProjectSymbolMatch,
  SearchProjectSymbolsOptions,
  SearchProjectSymbolsResult,
} from './types';

const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS = 50;
const MAX_INDEXED_FILES_PER_MOUNT = 2_500;
const MAX_SOURCE_FILE_BYTES = 1_000_000;
const INDEX_TTL_MS = 5_000;
const INDEX_BATCH_SIZE = 8;

const IGNORED_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.next',
  '.nuxt',
  '.svn',
  '.turbo',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

const IGNORED_FILE_SUFFIXES = ['.map', '.min.js', '.min.css'];

interface MountIndexState {
  lastScanAt: number;
  indexedFiles: Set<string>;
  scannedFiles: number;
  skippedFiles: number;
  hitFileLimit: boolean;
  scanInFlight?: Promise<void>;
}

interface ScoredProjectSymbolMatch extends ProjectSymbolMatch {
  score: number;
}

export class ProjectIndexService {
  private readonly files = new Map<string, FileIndex>();
  private readonly mountStates = new Map<string, MountIndexState>();

  public invalidateFile(absolutePath: string, mountRoot?: string): void {
    const resolvedPath = path.resolve(absolutePath);
    for (const [key, file] of this.files.entries()) {
      if (file.absolutePath === resolvedPath) this.files.delete(key);
    }

    if (mountRoot) {
      this.invalidateMount(mountRoot);
      return;
    }

    for (const [stateKey, state] of this.mountStates.entries()) {
      const root = stateKey.split('\0').at(-1) ?? '';
      if (isInsideRoot(resolvedPath, root)) {
        state.lastScanAt = 0;
      }
    }
  }

  public invalidateMount(mountRoot: string): void {
    const root = path.resolve(mountRoot);
    for (const [stateKey, state] of this.mountStates.entries()) {
      if (stateKey.endsWith(`\0${root}`)) state.lastScanAt = 0;
    }
  }

  public clear(): void {
    this.files.clear();
    this.mountStates.clear();
  }

  public async searchSymbols(
    options: SearchProjectSymbolsOptions,
  ): Promise<SearchProjectSymbolsResult> {
    const query = options.query.trim();
    if (!query) {
      throw new Error('query must not be empty');
    }

    const mounts = dedupeMounts(options.mounts);
    if (mounts.length === 0) {
      throw new Error('No workspace mounts are available to search');
    }

    await Promise.all(mounts.map((mount) => this.ensureMountIndexed(mount)));

    const maxResults = Math.min(
      Math.max(options.maxResults ?? DEFAULT_MAX_RESULTS, 1),
      MAX_RESULTS,
    );
    const scored: ScoredProjectSymbolMatch[] = [];
    const normalizedQuery = query.toLowerCase();
    const tokens = tokenizeQuery(normalizedQuery);

    for (const mount of mounts) {
      const mountRoot = path.resolve(mount.absolutePath);
      for (const file of this.files.values()) {
        if (file.mountRoot !== mountRoot || file.mountPrefix !== mount.prefix) {
          continue;
        }
        for (const symbol of file.symbols) {
          const score = scoreSymbolMatch(symbol, file, normalizedQuery, tokens);
          if (score <= 0) continue;
          scored.push({
            path: file.path,
            relativePath: file.relativePath,
            mountPrefix: file.mountPrefix,
            language: file.language,
            symbol,
            score,
          });
        }
      }
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.path !== b.path) return a.path.localeCompare(b.path);
      return a.symbol.fullName.localeCompare(b.symbol.fullName);
    });

    const matches = scored
      .slice(0, maxResults)
      .map(({ score: _score, ...m }) => m);
    const totalMatches = scored.length;
    const stats = summarizeMountStats(mounts, this.mountStates);

    return {
      query,
      totalMatches,
      matches,
      truncated: totalMatches > matches.length,
      itemsRemoved: Math.max(0, totalMatches - matches.length),
      scannedFiles: stats.scannedFiles,
      indexedFiles: stats.indexedFiles,
      skippedFiles: stats.skippedFiles,
    };
  }

  private async ensureMountIndexed(mount: ProjectIndexMount): Promise<void> {
    const mountRoot = path.resolve(mount.absolutePath);
    const stateKey = mountStateKey(mount.prefix, mountRoot);
    let state = this.mountStates.get(stateKey);
    if (!state) {
      state = {
        lastScanAt: 0,
        indexedFiles: new Set(),
        scannedFiles: 0,
        skippedFiles: 0,
        hitFileLimit: false,
      };
      this.mountStates.set(stateKey, state);
    }

    if (state.scanInFlight) {
      await state.scanInFlight;
      return;
    }

    if (Date.now() - state.lastScanAt < INDEX_TTL_MS) return;

    state.scanInFlight = this.scanMount(mount, state);
    try {
      await state.scanInFlight;
    } finally {
      state.scanInFlight = undefined;
    }
  }

  private async scanMount(
    mount: ProjectIndexMount,
    state: MountIndexState,
  ): Promise<void> {
    const mountRoot = path.resolve(mount.absolutePath);
    const files = await collectSourceFiles(mountRoot);
    const limitedFiles = files.slice(0, MAX_INDEXED_FILES_PER_MOUNT);
    const seenFiles = new Set<string>();
    let skippedFiles = Math.max(0, files.length - limitedFiles.length);

    for (let i = 0; i < limitedFiles.length; i += INDEX_BATCH_SIZE) {
      const batch = limitedFiles.slice(i, i + INDEX_BATCH_SIZE);
      const indexed = await Promise.all(
        batch.map(async (absolutePath) => {
          seenFiles.add(absolutePath);
          try {
            return await this.indexFile(mount, absolutePath);
          } catch {
            return null;
          }
        }),
      );
      skippedFiles += indexed.filter((file) => !file).length;
    }

    if (files.length <= MAX_INDEXED_FILES_PER_MOUNT) {
      for (const indexedFile of state.indexedFiles) {
        if (!seenFiles.has(indexedFile)) {
          this.files.delete(fileIndexKey(mount.prefix, indexedFile));
        }
      }
    }

    state.indexedFiles = seenFiles;
    state.scannedFiles = limitedFiles.length;
    state.skippedFiles = skippedFiles;
    state.hitFileLimit = files.length > MAX_INDEXED_FILES_PER_MOUNT;
    state.lastScanAt = Date.now();
  }

  private async indexFile(
    mount: ProjectIndexMount,
    absolutePath: string,
  ): Promise<FileIndex | null> {
    const cacheKey = fileIndexKey(mount.prefix, absolutePath);
    const fileStat = await stat(absolutePath);
    if (fileStat.size > MAX_SOURCE_FILE_BYTES) {
      this.files.delete(cacheKey);
      return null;
    }

    const cached = this.files.get(cacheKey);
    if (
      cached &&
      cached.lastModified === fileStat.mtimeMs &&
      cached.size === fileStat.size
    ) {
      return cached;
    }

    const ext = extForPath(absolutePath);
    if (!ext || !getLanguageForExt(ext)) {
      this.files.delete(cacheKey);
      return null;
    }

    const source = await readFile(absolutePath, 'utf-8');
    const parsed = await getFileSymbols(source, ext);
    if (!parsed) {
      this.files.delete(cacheKey);
      return null;
    }

    const mountRoot = path.resolve(mount.absolutePath);
    const relativePath = toPosix(path.relative(mountRoot, absolutePath));
    const fileIndex: FileIndex = {
      mountPrefix: mount.prefix,
      mountRoot,
      absolutePath,
      relativePath,
      path: `${mount.prefix}/${relativePath}`,
      language: parsed.language,
      lastModified: fileStat.mtimeMs,
      size: fileStat.size,
      symbols: flattenSymbols(parsed.symbols),
    };
    this.files.set(cacheKey, fileIndex);
    return fileIndex;
  }
}

export const defaultProjectIndexService = new ProjectIndexService();

async function collectSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_INDEXED_FILES_PER_MOUNT) return;

    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (out.length >= MAX_INDEXED_FILES_PER_MOUNT) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        await walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      const absolutePath = path.join(dir, entry.name);
      if (!isSupportedSourcePath(absolutePath)) continue;
      out.push(absolutePath);
    }
  }

  await walk(root);
  return out;
}

function flattenSymbols(
  symbols: readonly SymbolInfo[],
  parent: readonly string[] = [],
): ProjectIndexSymbol[] {
  const out: ProjectIndexSymbol[] = [];

  for (const symbol of symbols) {
    const pathParts = [...parent, symbol.name];
    const flattened: ProjectIndexSymbol = {
      name: symbol.name,
      fullName: pathParts.join('.'),
      kind: symbol.kind,
      exported: symbol.exported,
      line: symbol.line + 1,
      ...(symbol.signature ? { signature: symbol.signature } : {}),
    };
    out.push(flattened);
    if (symbol.children) {
      out.push(...flattenSymbols(symbol.children, pathParts));
    }
  }

  return out;
}

function scoreSymbolMatch(
  symbol: ProjectIndexSymbol,
  file: FileIndex,
  normalizedQuery: string,
  tokens: readonly string[],
): number {
  const name = symbol.name.toLowerCase();
  const fullName = symbol.fullName.toLowerCase();
  const signature = symbol.signature?.toLowerCase() ?? '';
  const relativePath = file.relativePath.toLowerCase();

  const haystack = `${name}\n${fullName}\n${signature}\n${relativePath}`;
  if (!tokens.every((token) => haystack.includes(token))) return 0;

  let score = 10;
  if (name === normalizedQuery) score += 100;
  else if (fullName === normalizedQuery) score += 95;
  else if (name.startsWith(normalizedQuery)) score += 80;
  else if (fullName.startsWith(normalizedQuery)) score += 70;
  else if (name.includes(normalizedQuery)) score += 55;
  else if (fullName.includes(normalizedQuery)) score += 45;
  else if (signature.includes(normalizedQuery)) score += 25;
  else if (relativePath.includes(normalizedQuery)) score += 15;

  if (symbol.exported) score += 5;
  if (symbol.kind === 'class' || symbol.kind === 'function') score += 3;

  return score;
}

function tokenizeQuery(query: string): string[] {
  const tokens = query
    .split(/[^a-zA-Z0-9_$]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  return tokens.length > 0 ? tokens : [query];
}

function summarizeMountStats(
  mounts: readonly ProjectIndexMount[],
  states: ReadonlyMap<string, MountIndexState>,
): { scannedFiles: number; indexedFiles: number; skippedFiles: number } {
  let scannedFiles = 0;
  let indexedFiles = 0;
  let skippedFiles = 0;

  for (const mount of dedupeMounts(mounts)) {
    const state = states.get(
      mountStateKey(mount.prefix, path.resolve(mount.absolutePath)),
    );
    if (!state) continue;
    scannedFiles += state.scannedFiles;
    indexedFiles += state.indexedFiles.size;
    skippedFiles += state.skippedFiles;
  }

  return { scannedFiles, indexedFiles, skippedFiles };
}

function mountStateKey(prefix: string, mountRoot: string): string {
  return `${prefix}\0${path.resolve(mountRoot)}`;
}

function fileIndexKey(prefix: string, absolutePath: string): string {
  return `${prefix}\0${path.resolve(absolutePath)}`;
}

function dedupeMounts(
  mounts: readonly ProjectIndexMount[],
): ProjectIndexMount[] {
  const seen = new Set<string>();
  const out: ProjectIndexMount[] = [];

  for (const mount of mounts) {
    const prefix = mount.prefix.trim();
    if (!prefix) continue;
    const absolutePath = path.resolve(mount.absolutePath);
    const key = `${prefix}\0${absolutePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ prefix, absolutePath });
  }

  return out;
}

function shouldSkipDir(name: string): boolean {
  return IGNORED_DIR_NAMES.has(name) || name.endsWith('.egg-info');
}

function isSupportedSourcePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (IGNORED_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return false;
  }
  const ext = extForPath(filePath);
  return Boolean(ext && getLanguageForExt(ext));
}

function extForPath(filePath: string): string {
  return path.extname(filePath).toLowerCase().replace(/^\./, '');
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function isInsideRoot(absolutePath: string, root: string): boolean {
  const resolvedPath = path.resolve(absolutePath);
  const resolvedRoot = path.resolve(root);
  return (
    resolvedPath === resolvedRoot ||
    resolvedPath.startsWith(resolvedRoot + path.sep)
  );
}
