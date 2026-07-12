/**
 * Mermaid SVG Cache
 *
 * Two-tier cache for rendered Mermaid SVG HTML:
 * 1. In-memory Map for fast O(1) lookups
 * 2. localStorage for persistence across page refreshes
 *
 * Ensures that re-mounting a Mermaid component (e.g. when Virtuoso
 * recycles items during scroll) is synchronous with zero layout shift.
 *
 * Follows the same pattern as use-shiki-highlighter-cache.ts.
 */

import type { MermaidConfig } from 'mermaid';

const MERMAID_CACHE_CONFIG = {
  /** Mermaid SVGs are larger than syntax-highlighted code (~10-50KB each) */
  MAX_CACHE_SIZE: 50,
  STORAGE_DEBOUNCE_MS: 1500,
  STORAGE_KEY: 'clodex_mermaid_cache',
  CACHE_VERSION: 1,
} as const;

export type MermaidCacheEntry = {
  svgHtml: string;
  accessTime: number;
};

type StorageData = {
  version: number;
  entries: Record<string, MermaidCacheEntry>;
};

export class MermaidCache {
  private cache = new Map<string, MermaidCacheEntry>();
  private maxSize: number;
  private storageDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isHydrated = false;
  private storageAvailable: boolean | null = null;

  constructor(maxSize: number = MERMAID_CACHE_CONFIG.MAX_CACHE_SIZE) {
    this.maxSize = maxSize;
  }

  private generateKey(chart: string, config?: MermaidConfig): string {
    const chartHash =
      chart.length > 200
        ? `${chart.slice(0, 100)}...${chart.slice(-50)}:${chart.length}`
        : chart;
    const configKey = config ? JSON.stringify(config) : '';
    return `${configKey}|${chartHash}`;
  }

  private checkStorageAvailable(): boolean {
    if (this.storageAvailable !== null) return this.storageAvailable;

    try {
      const testKey = '__clodex_mermaid_test__';
      localStorage.setItem(testKey, 'test');
      localStorage.removeItem(testKey);
      this.storageAvailable = true;
    } catch {
      this.storageAvailable = false;
    }
    return this.storageAvailable;
  }

  private hydrateFromStorage(): void {
    if (this.isHydrated) return;
    this.isHydrated = true;

    if (typeof window === 'undefined' || !this.checkStorageAvailable()) return;

    try {
      const raw = localStorage.getItem(MERMAID_CACHE_CONFIG.STORAGE_KEY);
      if (!raw) return;

      const data: StorageData = JSON.parse(raw);

      if (data.version !== MERMAID_CACHE_CONFIG.CACHE_VERSION) {
        localStorage.removeItem(MERMAID_CACHE_CONFIG.STORAGE_KEY);
        return;
      }

      for (const [key, entry] of Object.entries(data.entries))
        this.cache.set(key, entry);

      while (this.cache.size > this.maxSize) this.evictOldest();
    } catch (error) {
      console.warn('MermaidCache: Failed to hydrate from localStorage', error);
      try {
        localStorage.removeItem(MERMAID_CACHE_CONFIG.STORAGE_KEY);
      } catch {
        // Ignore
      }
    }
  }

  private schedulePersistence(): void {
    if (typeof window === 'undefined' || !this.checkStorageAvailable()) return;

    if (this.storageDebounceTimer !== null)
      clearTimeout(this.storageDebounceTimer);

    this.storageDebounceTimer = setTimeout(() => {
      this.storageDebounceTimer = null;
      this.persistToStorage();
    }, MERMAID_CACHE_CONFIG.STORAGE_DEBOUNCE_MS);
  }

  private persistToStorage(): void {
    if (typeof window === 'undefined' || !this.checkStorageAvailable()) return;

    try {
      const data: StorageData = {
        version: MERMAID_CACHE_CONFIG.CACHE_VERSION,
        entries: Object.fromEntries(this.cache.entries()),
      };
      localStorage.setItem(
        MERMAID_CACHE_CONFIG.STORAGE_KEY,
        JSON.stringify(data),
      );
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === 'QuotaExceededError' ||
          error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
      ) {
        console.warn(
          'MermaidCache: localStorage quota exceeded, evicting entries',
        );
        const entriesToEvict = Math.ceil(this.cache.size / 2);
        for (let i = 0; i < entriesToEvict; i++) this.evictOldest();

        try {
          const data: StorageData = {
            version: MERMAID_CACHE_CONFIG.CACHE_VERSION,
            entries: Object.fromEntries(this.cache.entries()),
          };
          localStorage.setItem(
            MERMAID_CACHE_CONFIG.STORAGE_KEY,
            JSON.stringify(data),
          );
        } catch {
          console.warn(
            'MermaidCache: Failed to persist after eviction, disabling storage',
          );
          this.storageAvailable = false;
        }
      } else {
        console.warn('MermaidCache: Failed to persist to localStorage', error);
      }
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;

    const entries = Array.from(this.cache.entries());
    for (const [key, entry] of entries) {
      if (entry.accessTime < oldestTime) {
        oldestTime = entry.accessTime;
        oldestKey = key;
      }
    }

    if (oldestKey) this.cache.delete(oldestKey);
  }

  get(chart: string, config?: MermaidConfig): MermaidCacheEntry | undefined {
    this.hydrateFromStorage();

    const key = this.generateKey(chart, config);
    const entry = this.cache.get(key);
    if (entry) entry.accessTime = Date.now();

    return entry;
  }

  set(chart: string, config: MermaidConfig | undefined, svgHtml: string): void {
    this.hydrateFromStorage();

    const key = this.generateKey(chart, config);

    if (this.cache.size >= this.maxSize && !this.cache.has(key))
      this.evictOldest();

    this.cache.set(key, {
      svgHtml,
      accessTime: Date.now(),
    });

    this.schedulePersistence();
  }

  clear(): void {
    this.cache.clear();
    if (this.storageDebounceTimer !== null) {
      clearTimeout(this.storageDebounceTimer);
      this.storageDebounceTimer = null;
    }

    if (typeof window === 'undefined' || !this.checkStorageAvailable()) return;
    try {
      localStorage.removeItem(MERMAID_CACHE_CONFIG.STORAGE_KEY);
    } catch {
      // Ignore
    }
  }

  get size(): number {
    this.hydrateFromStorage();
    return this.cache.size;
  }

  warmup(): void {
    this.hydrateFromStorage();
  }
}

declare global {
  interface Window {
    __clodex_mermaid_cache?: MermaidCache;
  }
}

export function getMermaidCache(): MermaidCache {
  if (!window.__clodex_mermaid_cache) {
    window.__clodex_mermaid_cache = new MermaidCache();

    const cache = window.__clodex_mermaid_cache;
    if (typeof requestIdleCallback === 'function')
      requestIdleCallback(() => cache.warmup());
    else setTimeout(() => cache.warmup(), 200);
  }

  return window.__clodex_mermaid_cache;
}
