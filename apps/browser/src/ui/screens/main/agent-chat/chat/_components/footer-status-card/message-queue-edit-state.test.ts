import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@shared/karton-contracts/ui/agent';
import {
  canSaveQueuedMessageDraft,
  replaceQueuedMessageText,
} from './message-queue-edit-state';

function message(): AgentMessage & { role: 'user' } {
  return {
    id: 'queued-1',
    role: 'user',
    parts: [
      { type: 'text', text: 'before' },
      {
        type: 'file',
        mediaType: 'text/plain',
        filename: 'notes.txt',
        url: 'data:text/plain,notes',
      },
    ],
    metadata: {
      createdAt: new Date('2026-07-27T00:00:00.000Z'),
      partsMetadata: [],
      swarmMode: true,
      swarmModeVariant: 'battle',
      attachments: [
        {
          path: 'att/attachment-1',
          originalFileName: 'notes.txt',
        },
      ],
    },
  };
}

describe('message queue edit state', () => {
  it('changes only the first text part and preserves identity, metadata, and non-text parts', () => {
    const original = message();
    const updated = replaceQueuedMessageText(original, 'after');

    expect(updated.id).toBe(original.id);
    expect(updated.role).toBe('user');
    expect(updated.metadata).toBe(original.metadata);
    expect(updated.parts[0]).toEqual({ type: 'text', text: 'after' });
    expect(updated.parts[1]).toBe(original.parts[1]);
    expect(original.parts[0]).toEqual({ type: 'text', text: 'before' });
  });

  it('inserts a text part when a queued message has none', () => {
    const original = message();
    original.parts = original.parts.filter((part) => part.type !== 'text');

    const updated = replaceQueuedMessageText(original, 'new instruction');

    expect(updated.parts[0]).toEqual({
      type: 'text',
      text: 'new instruction',
    });
    expect(updated.parts).toHaveLength(2);
  });

  it('rejects empty drafts but keeps meaningful punctuation', () => {
    expect(canSaveQueuedMessageDraft('   ')).toBe(false);
    expect(canSaveQueuedMessageDraft('.')).toBe(true);
  });
});
