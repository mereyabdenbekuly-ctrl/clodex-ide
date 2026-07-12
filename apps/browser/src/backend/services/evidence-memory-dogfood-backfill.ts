import fs from 'node:fs/promises';
import path from 'node:path';
import {
  resolveEvidenceMemoryIncrementalTokenBudget,
  type EvidenceMemoryClaimSearchHit,
  type EvidenceMemoryLiveDogfoodResult,
  type EvidenceMemoryService,
} from '@clodex/agent-core/evidence-memory';
import {
  protectedFileContext,
  type ProtectedFileStorage,
} from '@clodex/agent-core/host';

const MAX_HISTORY_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVES = 100;
const DEFAULT_MAX_OBSERVATIONS = 250;

type DogfoodBackfillStore = Pick<
  EvidenceMemoryService,
  | 'buildContextPack'
  | 'evaluateContextPackForDogfood'
  | 'recordLiveDogfoodComparison'
  | 'getLatestRepositoryRevision'
  | 'searchClaims'
>;

export interface EvidenceMemoryDogfoodBackfillResult {
  archivesScanned: number;
  archivesWithCompression: number;
  observationsReplayed: number;
  observationsSkipped: number;
  failures: number;
}

export interface EvidenceMemoryDogfoodBackfillOptions {
  memoryDir: string;
  protectedFiles?: ProtectedFileStorage;
  evidenceMemory: DogfoodBackfillStore;
  now?: () => number;
}

export interface EvidenceMemoryDogfoodBackfillRunInput {
  maxArchives?: number;
  maxObservations?: number;
  /** Restrict replay to an explicit workload cohort instead of rescanning all archives. */
  agentIds?: readonly string[];
  /** Replays only the first checkpoint per task, which is the restart probe. */
  firstCompressionOnly?: boolean;
  /** Treat every persisted compression checkpoint as an independent restart probe. */
  classifyEveryCompressionAsRestart?: boolean;
  /** Disable additional supersession probes when a run needs exact coverage. */
  includeSupersessionProbes?: boolean;
  /** Raw run identity; it is hashed before entering a content-free observation. */
  cohortIdSeed?: string;
  /** Namespaces deterministic scenario ids so independent runs never dedupe. */
  scenarioNamespace?: string;
}

interface ArchivedMessage {
  sequence: number;
  serializedAt: number;
  message: {
    role?: unknown;
    parts?: unknown;
    metadata?: unknown;
  };
}

export class EvidenceMemoryDogfoodBackfill {
  private readonly now: () => number;

  public constructor(
    private readonly options: EvidenceMemoryDogfoodBackfillOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  public async run(
    input: EvidenceMemoryDogfoodBackfillRunInput = {},
  ): Promise<EvidenceMemoryDogfoodBackfillResult> {
    const maxArchives = boundedPositive(
      input.maxArchives ?? DEFAULT_MAX_ARCHIVES,
      DEFAULT_MAX_ARCHIVES,
    );
    const maxObservations = boundedPositive(
      input.maxObservations ?? DEFAULT_MAX_OBSERVATIONS,
      DEFAULT_MAX_OBSERVATIONS,
    );
    const availableAgentIds = await this.listAgentIds();
    const requestedAgentIds =
      input.agentIds === undefined
        ? null
        : new Set(input.agentIds.filter(isSafeAgentId));
    const agentIds = availableAgentIds
      .filter(
        (agentId) =>
          requestedAgentIds === null || requestedAgentIds.has(agentId),
      )
      .slice(0, maxArchives);
    const result: EvidenceMemoryDogfoodBackfillResult = {
      archivesScanned: 0,
      archivesWithCompression: 0,
      observationsReplayed: 0,
      observationsSkipped: 0,
      failures: 0,
    };
    for (const agentId of agentIds) {
      if (result.observationsReplayed >= maxObservations) break;
      result.archivesScanned += 1;
      try {
        const archived = await this.readArchive(agentId);
        let compressed = archived.filter(
          (entry) => getCompressedHistory(entry.message) !== null,
        );
        if (input.firstCompressionOnly) compressed = compressed.slice(0, 1);
        if (compressed.length === 0) continue;
        result.archivesWithCompression += 1;
        const repositoryRevision =
          await this.options.evidenceMemory.getLatestRepositoryRevision(
            agentId,
          );
        // The production admission policy intentionally fails closed without
        // a repository revision. Counting such a rejection as zero recall
        // would measure missing task provenance rather than retrieval quality
        // and poison the paired cohort. Keep the archive eligible for a later
        // replay once revision evidence has been recorded.
        if (!repositoryRevision) {
          result.observationsSkipped += compressed.length;
          continue;
        }
        let firstReplay = true;
        for (const entry of compressed) {
          if (result.observationsReplayed >= maxObservations) break;
          const summary = getCompressedHistory(entry.message);
          if (!summary) continue;
          const query = buildReplayQuery(archived, entry.sequence);
          if (!query) {
            result.observationsSkipped += 1;
            continue;
          }
          const replay = await this.replay({
            agentId,
            sequence: entry.sequence,
            serializedAt: entry.serializedAt,
            summary,
            query,
            repositoryRevision,
            category:
              input.classifyEveryCompressionAsRestart || firstReplay
                ? 'restart'
                : undefined,
            cohortIdSeed: input.cohortIdSeed,
            scenarioNamespace: input.scenarioNamespace,
          });
          firstReplay = false;
          if (replay) result.observationsReplayed += 1;
          else result.observationsSkipped += 1;

          if (
            result.observationsReplayed >= maxObservations ||
            input.includeSupersessionProbes === false
          ) {
            continue;
          }
          const superseded = await this.findSupersededClaims(agentId, query);
          if (superseded.length === 0) continue;
          const supersessionReplay = await this.replay({
            agentId,
            sequence: entry.sequence,
            serializedAt: entry.serializedAt,
            summary,
            query,
            repositoryRevision,
            category: 'supersession',
            forbiddenClaimIds: superseded.map((hit) => hit.claim.id),
            cohortIdSeed: input.cohortIdSeed,
            scenarioNamespace: input.scenarioNamespace,
          });
          if (supersessionReplay) result.observationsReplayed += 1;
          else result.observationsSkipped += 1;
        }
      } catch {
        result.failures += 1;
      }
    }
    return result;
  }

  private async replay(input: {
    agentId: string;
    sequence: number;
    serializedAt: number;
    summary: string;
    query: string;
    repositoryRevision: string;
    category?: 'restart' | 'supersession';
    forbiddenClaimIds?: readonly string[];
    cohortIdSeed?: string;
    scenarioNamespace?: string;
  }): Promise<EvidenceMemoryLiveDogfoodResult | null> {
    const guardedStartedAt = performance.now();
    const tokenBudget = resolveEvidenceMemoryIncrementalTokenBudget(
      input.summary,
    );
    let pack = await this.options.evidenceMemory.buildContextPack({
      taskId: input.agentId,
      query: input.query,
      repositoryRevision: input.repositoryRevision,
      maxClaims: input.category === 'restart' ? 1 : undefined,
      recordShadowRun: false,
    });
    if (
      pack.items.length === 0 &&
      pack.excludedStaleClaimIds.length === 0 &&
      (input.forbiddenClaimIds?.length ?? 0) === 0
    ) {
      const fallbackQuery = buildRestartFallbackQuery(
        input.query,
        input.summary,
      );
      if (fallbackQuery !== input.query) {
        pack = await this.options.evidenceMemory.buildContextPack({
          taskId: input.agentId,
          query: fallbackQuery,
          repositoryRevision: input.repositoryRevision,
          maxClaims: input.category === 'restart' ? 1 : undefined,
          recordShadowRun: false,
        });
      }
    }
    if (
      pack.items.length === 0 &&
      pack.excludedStaleClaimIds.length === 0 &&
      (input.forbiddenClaimIds?.length ?? 0) === 0
    ) {
      return null;
    }
    const admission =
      await this.options.evidenceMemory.evaluateContextPackForDogfood({
        pack,
        repositoryRevision: input.repositoryRevision,
        baselineContext: input.summary,
        tokenBudget,
        maxClaims: input.category === 'restart' ? 1 : undefined,
      });
    return await this.options.evidenceMemory.recordLiveDogfoodComparison({
      pack,
      admission,
      expectedClaimIds:
        input.category === 'restart'
          ? pack.items.slice(0, 1).map((item) => item.claim.id)
          : undefined,
      compressedHistory: input.summary,
      compressedHistoryLatencyMs: 0,
      guardedMemoryLatencyMs: Math.max(0, performance.now() - guardedStartedAt),
      forbiddenClaimIds: input.forbiddenClaimIds,
      categoryOverride: input.category,
      scenarioIdSeed: `${input.scenarioNamespace ?? 'historical-backfill-v3'}:${input.agentId}:${input.sequence}:${input.category ?? 'recall'}`,
      cohortIdSeed: input.cohortIdSeed,
      observedAt: input.serializedAt,
    });
  }

  private async findSupersededClaims(
    taskId: string,
    query: string,
  ): Promise<EvidenceMemoryClaimSearchHit[]> {
    const hits = await this.options.evidenceMemory.searchClaims({
      taskId,
      query,
      includeStale: true,
      limit: 25,
    });
    return hits.filter(
      (hit) =>
        hit.claim.status === 'superseded' || hit.claim.status === 'invalidated',
    );
  }

  private async listAgentIds(): Promise<string[]> {
    try {
      const parsed = JSON.parse(
        await this.readMemoryFile('index.json'),
      ) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'agents' in parsed &&
        typeof parsed.agents === 'object' &&
        parsed.agents !== null
      ) {
        return Object.keys(parsed.agents)
          .filter(isSafeAgentId)
          .sort((left, right) => left.localeCompare(right));
      }
    } catch {
      // Fall back to the archive directory when the registry is recoverable.
    }
    const agentsDir = path.join(this.options.memoryDir, 'agents');
    const entries = await fs
      .readdir(agentsDir, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' ? [] : Promise.reject(error),
      );
    return entries
      .filter((entry) => entry.isDirectory() && isSafeAgentId(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  private async readArchive(agentId: string): Promise<ArchivedMessage[]> {
    const raw = await this.readMemoryFile(
      path.posix.join('agents', agentId, 'history.jsonl'),
    );
    if (Buffer.byteLength(raw, 'utf8') > MAX_HISTORY_BYTES) {
      throw new Error('Agent memory archive exceeds dogfood backfill limit');
    }
    const entries: ArchivedMessage[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as {
          sequence?: unknown;
          serializedAt?: unknown;
          message?: unknown;
        };
        if (
          !Number.isSafeInteger(parsed.sequence) ||
          typeof parsed.message !== 'object' ||
          parsed.message === null
        ) {
          continue;
        }
        const serializedAt = Date.parse(String(parsed.serializedAt ?? ''));
        entries.push({
          sequence: parsed.sequence as number,
          serializedAt: Number.isFinite(serializedAt)
            ? serializedAt
            : this.now(),
          message: parsed.message as ArchivedMessage['message'],
        });
      } catch {
        // Corrupt lines are isolated; valid append-only entries still replay.
      }
    }
    return entries.sort((left, right) => left.sequence - right.sequence);
  }

  private async readMemoryFile(relativePath: string): Promise<string> {
    const normalized = relativePath.replaceAll('\\', '/');
    const absolutePath = path.resolve(this.options.memoryDir, normalized);
    const root = path.resolve(this.options.memoryDir);
    if (
      absolutePath === root ||
      !absolutePath.startsWith(`${root}${path.sep}`)
    ) {
      throw new Error('Memory archive path escapes the memory root');
    }
    const value = this.options.protectedFiles
      ? await this.options.protectedFiles.readFile(
          absolutePath,
          protectedFileContext.memory(normalized),
        )
      : await fs.readFile(absolutePath);
    return value.toString('utf8');
  }
}

function getCompressedHistory(
  message: ArchivedMessage['message'],
): string | null {
  const metadata = message.metadata;
  if (typeof metadata !== 'object' || metadata === null) return null;
  const compressedHistory = (metadata as { compressedHistory?: unknown })
    .compressedHistory;
  return typeof compressedHistory === 'string' && compressedHistory.length > 0
    ? compressedHistory
    : null;
}

function buildReplayQuery(
  entries: readonly ArchivedMessage[],
  boundarySequence: number,
): string {
  return entries
    .filter(
      (entry) =>
        entry.sequence >= boundarySequence &&
        (entry.message.role === 'user' || entry.message.role === 'assistant'),
    )
    .slice(0, 3)
    .map((entry) => getMessageText(entry.message))
    .filter(Boolean)
    .join('\n')
    .slice(0, 16_384);
}

function getMessageText(message: ArchivedMessage['message']): string {
  if (!Array.isArray(message.parts)) return '';
  return message.parts
    .flatMap((part) =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
        ? [(part as { text: string }).text]
        : [],
    )
    .join('\n');
}

function isSafeAgentId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..'
  );
}

function boundedPositive(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1) return maximum;
  return Math.min(value, maximum);
}

function buildRestartFallbackQuery(query: string, summary: string): string {
  const normalizedSummary = summary.trim();
  if (!normalizedSummary || query.includes(normalizedSummary)) return query;
  return `${query}\n${normalizedSummary}`.slice(0, 16_384);
}
