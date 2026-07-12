import { createHash } from 'node:crypto';
import type {
  EvidenceMemoryEvent,
  EvidenceMemoryEventType,
  EvidenceMemoryJson,
} from './index';

export const EVIDENCE_MEMORY_SHORT_SUMMARY_WINDOW_MS = 10 * 60 * 1_000;
export const EVIDENCE_MEMORY_LONG_SUMMARY_WINDOW_MS = 6 * 60 * 60 * 1_000;

export type EvidenceMemorySummaryTier = '10m' | '6h';

export interface EvidenceMemorySummaryEntry {
  id: string;
  timestamp: number;
  type: EvidenceMemoryEventType | 'summary';
  text: string;
  sourceEventIds: string[];
}

export interface EvidenceMemorySummary {
  tier: EvidenceMemorySummaryTier;
  windowStartedAt: number;
  windowEndedAt: number;
  markdown: string;
  sourceEventIds: string[];
  sourceHash: string;
}

export interface EvidenceMemorySummarizerInput {
  tier: EvidenceMemorySummaryTier;
  windowStartedAt: number;
  windowEndedAt: number;
  entries: readonly EvidenceMemorySummaryEntry[];
}

export type EvidenceMemorySummarizer = (
  input: EvidenceMemorySummarizerInput,
) => Promise<string>;

const NON_MATERIAL_EVENT_TYPES = new Set<EvidenceMemoryEventType>([
  'memory_summary_materialized',
  'memory_pruning_completed',
  'context_pack_built',
  'context_pack_injection_admitted',
  'context_pack_injection_rejected',
  'context_pack_injection_consumed',
  'fingerprint_refresh_current',
  'fingerprint_refresh_stale',
  'fingerprint_refresh_failed',
  'memory_dogfood_observed',
  'memory_dogfood_evaluated',
]);

/**
 * Builds a two-level summary tree without granting summaries instruction
 * authority. A cheap model can be supplied by the host; the deterministic
 * fallback keeps tests, offline mode, and failure recovery available.
 */
export async function buildRecursiveEvidenceSummaries(input: {
  events: readonly EvidenceMemoryEvent[];
  summarize?: EvidenceMemorySummarizer;
  closedBeforeOrAt?: number;
  existingSourceHashes?: ReadonlySet<string>;
  shortSummarySeeds?: readonly EvidenceMemorySummary[];
}): Promise<{
  short: EvidenceMemorySummary[];
  long: EvidenceMemorySummary[];
}> {
  const summarize = input.summarize ?? deterministicEvidenceSummarizer;
  const materialEntries = input.events
    .filter((event) => !NON_MATERIAL_EVENT_TYPES.has(event.type))
    .sort(compareByTimestampAndId)
    .map(toSummaryEntry);
  const short = await summarizeWindows(
    materialEntries,
    '10m',
    EVIDENCE_MEMORY_SHORT_SUMMARY_WINDOW_MS,
    summarize,
    input.closedBeforeOrAt,
    input.existingSourceHashes,
  );
  const longEntries = [...(input.shortSummarySeeds ?? []), ...short]
    .filter((summary) => summary.tier === '10m')
    .sort(
      (left, right) =>
        left.windowStartedAt - right.windowStartedAt ||
        left.sourceHash.localeCompare(right.sourceHash),
    )
    .filter(
      (summary, index, summaries) =>
        index === 0 ||
        summarySourceIdentity(
          summary.tier,
          summary.windowStartedAt,
          summary.sourceHash,
        ) !==
          summarySourceIdentity(
            summaries[index - 1]!.tier,
            summaries[index - 1]!.windowStartedAt,
            summaries[index - 1]!.sourceHash,
          ),
    )
    .map((summary) => ({
      id: `summary:${summary.tier}:${summary.windowStartedAt}:${summary.sourceHash}`,
      timestamp: summary.windowStartedAt,
      type: 'summary' as const,
      text: summary.markdown,
      sourceEventIds: summary.sourceEventIds,
    }));
  const long = await summarizeWindows(
    longEntries,
    '6h',
    EVIDENCE_MEMORY_LONG_SUMMARY_WINDOW_MS,
    summarize,
    input.closedBeforeOrAt,
    input.existingSourceHashes,
  );
  return { short, long };
}

export async function deterministicEvidenceSummarizer(
  input: EvidenceMemorySummarizerInput,
): Promise<string> {
  const lines = [
    `## ${input.tier} evidence summary`,
    '',
    `Window: ${new Date(input.windowStartedAt).toISOString()} — ${new Date(
      input.windowEndedAt,
    ).toISOString()}`,
    '',
  ];
  for (const entry of input.entries) {
    lines.push(`- ${entry.text}`);
  }
  return lines.join('\n');
}

async function summarizeWindows(
  entries: readonly EvidenceMemorySummaryEntry[],
  tier: EvidenceMemorySummaryTier,
  windowSizeMs: number,
  summarize: EvidenceMemorySummarizer,
  closedBeforeOrAt: number | undefined,
  existingSourceHashes: ReadonlySet<string> | undefined,
): Promise<EvidenceMemorySummary[]> {
  const windows = new Map<number, EvidenceMemorySummaryEntry[]>();
  for (const entry of entries) {
    const windowStartedAt =
      Math.floor(entry.timestamp / windowSizeMs) * windowSizeMs;
    const window = windows.get(windowStartedAt) ?? [];
    window.push(entry);
    windows.set(windowStartedAt, window);
  }

  const summaries: EvidenceMemorySummary[] = [];
  for (const [windowStartedAt, windowEntries] of [...windows].sort(
    ([left], [right]) => left - right,
  )) {
    const windowEndedAt = windowStartedAt + windowSizeMs;
    if (closedBeforeOrAt !== undefined && windowEndedAt > closedBeforeOrAt) {
      continue;
    }
    const sourceEventIds = [
      ...new Set(windowEntries.flatMap((entry) => entry.sourceEventIds)),
    ];
    const sourceHash = hashSummarySource(tier, sourceEventIds);
    if (
      existingSourceHashes?.has(
        summarySourceIdentity(tier, windowStartedAt, sourceHash),
      )
    ) {
      continue;
    }
    const markdown = (
      await summarize({
        tier,
        windowStartedAt,
        windowEndedAt,
        entries: windowEntries,
      })
    ).trim();
    if (!markdown) continue;
    summaries.push({
      tier,
      windowStartedAt,
      windowEndedAt,
      markdown,
      sourceEventIds,
      sourceHash,
    });
  }
  return summaries;
}

export function summarySourceIdentity(
  tier: EvidenceMemorySummaryTier,
  windowStartedAt: number,
  sourceHash: string,
): string {
  return `${tier}:${windowStartedAt}:${sourceHash}`;
}

function hashSummarySource(
  tier: EvidenceMemorySummaryTier,
  sourceEventIds: readonly string[],
): string {
  return createHash('sha256')
    .update(tier)
    .update('\0')
    .update(sourceEventIds.join('\0'))
    .digest('hex');
}

function toSummaryEntry(
  event: EvidenceMemoryEvent,
): EvidenceMemorySummaryEntry {
  return {
    id: event.id,
    timestamp: event.timestamp,
    type: event.type,
    text: `${event.type}: ${summarizePayload(event.payload)}`,
    sourceEventIds: [event.id],
  };
}

function summarizePayload(payload: EvidenceMemoryJson): string {
  if (payload === null) return 'null';
  if (
    typeof payload === 'string' ||
    typeof payload === 'number' ||
    typeof payload === 'boolean'
  ) {
    return String(payload).slice(0, 240);
  }
  const serialized = JSON.stringify(payload);
  return serialized.length <= 240 ? serialized : `${serialized.slice(0, 239)}…`;
}

function compareByTimestampAndId(
  left: EvidenceMemoryEvent,
  right: EvidenceMemoryEvent,
): number {
  return left.timestamp - right.timestamp || left.id.localeCompare(right.id);
}
