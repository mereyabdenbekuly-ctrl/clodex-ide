import type { Logger } from './logger';
import type { KartonService } from './karton';
import type { HistoryService } from './history';
import type { WebDataService } from './webdata';
import type { FaviconService } from './favicon';
import type { LocalPortsScannerService } from './local-ports-scanner';
import type { OmniboxSuggestions } from '@shared/karton-contracts/ui';
import { DisposableService } from './disposable';

const LOCAL_PORTS_CACHE_TTL_MS = 30_000;

/**
 * Service responsible for providing omnibox autocomplete suggestions.
 * Has access to both HistoryService (for browsing history) and WebDataService (for search terms).
 */
export class OmniboxSuggestionsService extends DisposableService {
  private readonly logger: Logger;
  private readonly uiKarton: KartonService;
  private readonly historyService: HistoryService;
  private readonly webDataService: WebDataService;
  private readonly faviconService: FaviconService;
  private readonly localPortsScanner: LocalPortsScannerService;

  private constructor(
    logger: Logger,
    uiKarton: KartonService,
    historyService: HistoryService,
    webDataService: WebDataService,
    faviconService: FaviconService,
    localPortsScanner: LocalPortsScannerService,
  ) {
    super();
    this.logger = logger;
    this.uiKarton = uiKarton;
    this.historyService = historyService;
    this.webDataService = webDataService;
    this.faviconService = faviconService;
    this.localPortsScanner = localPortsScanner;
  }

  private async initialize(): Promise<void> {
    this.logger.debug('[OmniboxSuggestionsService] Initializing...');

    // Register the getOmniboxSuggestions procedure handler
    this.uiKarton.registerServerProcedureHandler(
      'getOmniboxSuggestions',
      async (
        _callingClientId: string,
        input: string,
      ): Promise<OmniboxSuggestions> => {
        return this.getSuggestions(input);
      },
    );

    this.logger.debug('[OmniboxSuggestionsService] Initialized');
  }

  public static async create(
    logger: Logger,
    uiKarton: KartonService,
    historyService: HistoryService,
    webDataService: WebDataService,
    faviconService: FaviconService,
    localPortsScanner: LocalPortsScannerService,
  ): Promise<OmniboxSuggestionsService> {
    const instance = new OmniboxSuggestionsService(
      logger,
      uiKarton,
      historyService,
      webDataService,
      faviconService,
      localPortsScanner,
    );
    await instance.initialize();
    return instance;
  }

  protected onTeardown(): void {
    this.uiKarton.removeServerProcedureHandler('getOmniboxSuggestions');
    this.logger.debug('[OmniboxSuggestionsService] Teardown complete');
  }

  /**
   * Get omnibox suggestions based on the input string.
   * Queries both history entries and previous search terms.
   * When input is empty, returns most visited pages and frequent searches as defaults.
   *
   * @param input - The user's input in the omnibox
   * @returns Suggestions including matching history entries and search terms
   */
  public async getSuggestions(input: string): Promise<OmniboxSuggestions> {
    const trimmed = input.trim();

    // When input is empty, return default suggestions
    if (!trimmed) {
      const defaults = await this.getDefaultSuggestions();
      return defaults;
    }

    // Check if input matches or is a prefix of "localhost" (min 3 chars)
    const normalizedForLocalCheck = trimmed
      .replace(/^http:\/\//i, '')
      .toLowerCase();
    const shouldIncludeLocalPorts =
      (normalizedForLocalCheck.length >= 3 &&
        'localhost'.startsWith(normalizedForLocalCheck)) ||
      normalizedForLocalCheck.startsWith('localhost');

    // Run queries in parallel for performance
    const [historyResults, searchTermResults, localPorts] = await Promise.all([
      this.historyService.queryHistoryForOmnibox({
        text: trimmed,
        limit: 4,
        maxPerHost: 2,
      }),
      this.historyService.querySearchTermsForOmnibox(trimmed, 3),
      shouldIncludeLocalPorts ? this.getLocalPorts(trimmed, 5) : [],
    ]);

    // Deduplicate history entries: keep shortest URL when multiple URLs share a common prefix
    const sortedByLength = [...historyResults].sort(
      (a, b) => a.url.length - b.url.length,
    );
    const keptUrls: string[] = [];
    const deduplicatedHistory = sortedByLength.filter((h) => {
      // Check if any already-kept URL is a prefix of this URL
      const dominated = keptUrls.some((kept) => h.url.startsWith(kept));
      if (dominated) {
        return false;
      }
      keptUrls.push(h.url);
      return true;
    });

    // Get favicons for history URLs
    const faviconMap = await this.faviconService.getFaviconsForUrls(
      deduplicatedHistory.map((h) => h.url),
    );

    // Get keyword hostnames for search terms
    const keywords = await this.webDataService.getAllKeywords();
    const keywordMap = new Map(keywords.map((k) => [k.id, k.keyword]));

    // Deduplicate search terms by normalized term (case-insensitive)
    const seenTerms = new Set<string>();
    const deduplicatedSearchTerms = searchTermResults.filter((s) => {
      const normalized = s.term.toLowerCase();
      if (seenTerms.has(normalized)) {
        return false;
      }
      seenTerms.add(normalized);
      return true;
    });

    return {
      historyEntries: deduplicatedHistory.map((h) => ({
        url: h.url,
        title: h.title,
        visitCount: h.visitCount,
        lastVisitTime: h.lastVisitTime,
        faviconUrl: faviconMap.get(h.url) ?? null,
      })),
      mostVisitedOrigins: [],
      searchTerms: deduplicatedSearchTerms.map((s) => ({
        term: s.term,
        keyword: keywordMap.get(s.keywordId),
      })),
      localPorts,
    };
  }

  /**
   * Get default suggestions when omnibox input is empty.
   * Returns most visited origins (grouped by scheme://host, within a 7-day
   * window relative to the last history entry, min 2 visits) and frequent
   * search terms.
   */
  private async getDefaultSuggestions(): Promise<OmniboxSuggestions> {
    // Run queries in parallel for performance
    const [mostVisitedOrigins, frequentSearchResults, localPorts] =
      await Promise.all([
        this.historyService.getMostVisitedOrigins({
          timespanDays: 7,
          limit: 4,
          minVisitCount: 2,
          excludeLocalOrigins: true,
        }),
        this.historyService.getFrequentSearchTermsForOmnibox({
          dayWindow: 7,
          minOccurrences: 2,
          limit: 3,
        }),
        this.getLocalPorts(),
      ]);

    // Get favicons for origin URLs (try both bare origin and with trailing slash)
    const originUrls = mostVisitedOrigins.flatMap((o) => [
      o.origin,
      `${o.origin}/`,
    ]);
    const faviconMap = await this.faviconService.getFaviconsForUrls(originUrls);

    // Get keyword hostnames for search terms
    const keywords = await this.webDataService.getAllKeywords();
    const keywordMap = new Map(keywords.map((k) => [k.id, k.keyword]));

    return {
      historyEntries: [],
      mostVisitedOrigins: mostVisitedOrigins.map((o) => ({
        origin: o.origin,
        visitCount: o.visitCount,
        lastVisitTime: o.lastVisitTime,
        faviconUrl:
          faviconMap.get(o.origin) ?? faviconMap.get(`${o.origin}/`) ?? null,
      })),
      searchTerms: frequentSearchResults.map((s) => ({
        term: s.term,
        keyword: keywordMap.get(s.keywordId),
      })),
      localPorts,
    };
  }

  /**
   * Get local ports sorted by visit frequency then port number.
   * Uses the LocalPortsScannerService with a 30-second cache TTL.
   * Optionally filters by input prefix (e.g. "localhost:3" only shows ports starting with 3).
   */
  private async getLocalPorts(
    input?: string,
    limit = 3,
  ): Promise<OmniboxSuggestions['localPorts']> {
    try {
      // Check if cache is stale, trigger a scan if needed
      const cacheAge = Date.now() - this.localPortsScanner.getLastScanTime();
      if (cacheAge > LOCAL_PORTS_CACHE_TTL_MS) {
        await this.localPortsScanner.scan();
      }

      let entries = this.localPortsScanner.getCachedEntries();

      // Filter by input if provided (match against url or localhost:port)
      if (input) {
        const normalizedInput = input.replace(/^http:\/\//i, '').toLowerCase();
        entries = entries.filter((e) =>
          `localhost:${e.port}`.startsWith(normalizedInput),
        );
      }

      // Look up visit stats for each port
      const portsWithStats = await Promise.all(
        entries.map(async (entry) => {
          const stats = await this.historyService.getVisitStatsForOrigin(
            entry.url,
          );
          return { ...entry, ...stats };
        }),
      );

      // Sort by visit count desc, then by port number asc
      portsWithStats.sort((a, b) => {
        if (b.visitCount !== a.visitCount) {
          return b.visitCount - a.visitCount;
        }
        return a.port - b.port;
      });

      const top = portsWithStats.slice(0, limit);

      // Fetch favicons for ports that have a last-visited URL
      const urlsForFavicons = top
        .map((p) => p.lastUrl)
        .filter((u): u is string => u != null);
      const faviconMap =
        await this.faviconService.getFaviconsForUrls(urlsForFavicons);

      return top.map((p) => ({
        port: p.port,
        url: p.url,
        visitCount: p.visitCount,
        lastVisitTime: p.lastVisitTime,
        lastTitle: p.lastTitle,
        faviconUrl: p.lastUrl ? (faviconMap.get(p.lastUrl) ?? null) : null,
      }));
    } catch (error) {
      this.logger.warn(
        '[OmniboxSuggestionsService] Failed to get local ports',
        error,
      );
      return [];
    }
  }
}
