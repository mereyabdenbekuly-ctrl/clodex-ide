import { describe, expect, it } from 'vitest';
import {
  parseRealtimeServerEvent,
  RealtimeTranscriptAssembler,
} from './dictation-realtime';

describe('RealtimeTranscriptAssembler', () => {
  it('streams deltas and replaces them with the final transcript', () => {
    const assembler = new RealtimeTranscriptAssembler();

    expect(
      assembler.consume({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item-1',
        delta: 'Hello, ',
      }).partialTranscript,
    ).toBe('Hello,');
    expect(
      assembler.consume({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item-1',
        delta: 'world',
      }).partialTranscript,
    ).toBe('Hello, world');

    const completed = assembler.consume({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'Hello, world.',
    });
    expect(completed.completedItem).toEqual({
      itemId: 'item-1',
      transcript: 'Hello, world.',
    });
    expect(completed.partialTranscript).toBe('Hello, world.');
  });

  it('keeps committed item order when completions arrive out of order', () => {
    const assembler = new RealtimeTranscriptAssembler();
    assembler.consume({
      type: 'input_audio_buffer.committed',
      item_id: 'item-1',
    });
    assembler.consume({
      type: 'input_audio_buffer.committed',
      item_id: 'item-2',
    });
    assembler.consume({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-2',
      transcript: 'Second.',
    });
    assembler.consume({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'First.',
    });

    expect(assembler.getCombinedTranscript()).toBe('First. Second.');
  });

  it('maps provider failures to a content-free error', () => {
    const assembler = new RealtimeTranscriptAssembler();
    const snapshot = assembler.consume({
      type: 'error',
      error: { message: 'provider payload must not escape' },
    });

    expect(snapshot.error).toBe('Realtime transcription failed.');
    expect(JSON.stringify(snapshot)).not.toContain('provider payload');
  });

  it('parses data-channel JSON without throwing on malformed payloads', () => {
    expect(parseRealtimeServerEvent('{"type":"session.created"}')).toEqual({
      type: 'session.created',
    });
    expect(parseRealtimeServerEvent('not-json')).toBeNull();
  });
});
