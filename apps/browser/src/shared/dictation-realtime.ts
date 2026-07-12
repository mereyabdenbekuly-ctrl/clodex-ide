const DELTA_EVENT =
  'conversation.item.input_audio_transcription.delta' as const;
const COMPLETED_EVENT =
  'conversation.item.input_audio_transcription.completed' as const;
const FAILED_EVENT =
  'conversation.item.input_audio_transcription.failed' as const;
const COMMITTED_EVENT = 'input_audio_buffer.committed' as const;

interface TranscriptItem {
  order: number;
  delta: string;
  transcript?: string;
  completed: boolean;
}

export interface RealtimeTranscriptSnapshot {
  partialTranscript: string;
  committedItemId?: string;
  completedItem?: {
    itemId: string;
    transcript: string;
  };
  error?: string;
}

/**
 * Content-only event reducer for the Realtime data channel.
 *
 * It deliberately ignores SDP, audio and provider error payloads. Committed
 * item order is retained so final events may arrive out of order without
 * reordering the visible transcript.
 */
export class RealtimeTranscriptAssembler {
  private readonly items = new Map<string, TranscriptItem>();
  private readonly committedOrder: string[] = [];
  private nextOrder = 0;

  public consume(rawEvent: unknown): RealtimeTranscriptSnapshot {
    const event = asRecord(rawEvent);
    const type = typeof event?.type === 'string' ? event.type : '';

    if (type === 'error' || type === FAILED_EVENT) {
      return {
        partialTranscript: this.getCombinedTranscript(),
        error: 'Realtime transcription failed.',
      };
    }

    if (type === COMMITTED_EVENT) {
      const itemId = readString(event, 'item_id');
      if (!itemId) return this.snapshot();
      if (!this.committedOrder.includes(itemId)) {
        this.committedOrder.push(itemId);
      }
      this.ensureItem(itemId);
      return {
        ...this.snapshot(),
        committedItemId: itemId,
      };
    }

    if (type === DELTA_EVENT) {
      const itemId = readString(event, 'item_id');
      const delta = readString(event, 'delta');
      if (!itemId || delta === undefined) return this.snapshot();
      const item = this.ensureItem(itemId);
      item.delta += delta;
      return this.snapshot();
    }

    if (type === COMPLETED_EVENT) {
      const itemId = readString(event, 'item_id');
      const transcript = readString(event, 'transcript');
      if (!itemId || transcript === undefined) return this.snapshot();
      const item = this.ensureItem(itemId);
      item.completed = true;
      item.transcript = transcript.trim();
      return {
        ...this.snapshot(),
        completedItem: {
          itemId,
          transcript: item.transcript,
        },
      };
    }

    return this.snapshot();
  }

  public getCombinedTranscript(): string {
    const committedRank = new Map(
      this.committedOrder.map((itemId, index) => [itemId, index]),
    );
    return Array.from(this.items.entries())
      .sort(([leftId, left], [rightId, right]) => {
        const leftRank = committedRank.get(leftId);
        const rightRank = committedRank.get(rightId);
        if (leftRank !== undefined && rightRank !== undefined) {
          return leftRank - rightRank;
        }
        if (leftRank !== undefined) return -1;
        if (rightRank !== undefined) return 1;
        return left.order - right.order;
      })
      .map(([, item]) =>
        (item.completed ? item.transcript : item.delta)?.trim(),
      )
      .filter((text): text is string => Boolean(text))
      .join(' ')
      .trim();
  }

  private snapshot(): RealtimeTranscriptSnapshot {
    return {
      partialTranscript: this.getCombinedTranscript(),
    };
  }

  private ensureItem(itemId: string): TranscriptItem {
    const existing = this.items.get(itemId);
    if (existing) return existing;
    const item: TranscriptItem = {
      order: this.nextOrder++,
      delta: '',
      completed: false,
    };
    this.items.set(itemId, item);
    return item;
  }
}

export function parseRealtimeServerEvent(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readString(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}
