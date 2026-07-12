import { describe, expect, it, vi } from 'vitest';
import type { ChronicleEvent } from '@shared/agent-os';
import {
  createChronicleContext,
  resolveDroppedSkillPath,
  schedulePrefillWhenChatReady,
} from './agent-os-settings-model';

describe('Agent OS settings model', () => {
  it('formats Chronicle events for chat attachment', () => {
    const events = [
      {
        id: 'event-1',
        capturedAt: Date.UTC(2026, 6, 10, 12, 30),
        source: 'manual',
        text: 'Reviewed the Agent OS settings.',
        privacyFiltered: true,
      },
    ] satisfies ChronicleEvent[];

    expect(createChronicleContext(events)).toBe(
      '<chronicle-context>\n' +
        '- 2026-07-10T12:30:00.000Z: Reviewed the Agent OS settings.\n' +
        '</chronicle-context>\n\n',
    );
  });

  it('waits for the chat composer before dispatching a prefill', () => {
    const frames: Array<() => void> = [];
    const requestPrefill = vi.fn();
    let ready = false;

    schedulePrefillWhenChatReady({
      isReady: () => ready,
      requestPrefill,
      scheduleFrame: (callback) => frames.push(callback),
    });

    frames.shift()?.();
    expect(requestPrefill).not.toHaveBeenCalled();

    ready = true;
    frames.shift()?.();
    expect(requestPrefill).toHaveBeenCalledOnce();
  });

  it('falls back after the configured frame budget', () => {
    const frames: Array<() => void> = [];
    const requestPrefill = vi.fn();

    schedulePrefillWhenChatReady({
      isReady: () => false,
      requestPrefill,
      scheduleFrame: (callback) => frames.push(callback),
      maxWaitFrames: 2,
    });

    while (frames.length > 0) frames.shift()?.();
    expect(requestPrefill).toHaveBeenCalledOnce();
  });

  it('prefers Electron native paths and falls back to file URI data', () => {
    const nativeTransfer = {
      files: [{ name: 'native.skill' }],
      getData: () => '',
    };
    expect(
      resolveDroppedSkillPath(nativeTransfer, () => '/tmp/native.skill'),
    ).toBe('/tmp/native.skill');

    const uriTransfer = {
      files: [{ name: 'synthetic.skill' }],
      getData: (format: string) =>
        format === 'text/uri-list'
          ? '# local package\nfile:///tmp/synthetic%20skill.skill'
          : '',
    };
    expect(resolveDroppedSkillPath(uriTransfer, () => '')).toBe(
      '/tmp/synthetic skill.skill',
    );
  });

  it('rejects non-local or malformed drop URIs', () => {
    const transfer = (uri: string) => ({
      files: [] as object[],
      getData: () => uri,
    });

    expect(
      resolveDroppedSkillPath(
        transfer('https://example.com/test.skill'),
        () => '',
      ),
    ).toBeNull();
    expect(
      resolveDroppedSkillPath(
        transfer('file://remote-host/test.skill'),
        () => '',
      ),
    ).toBeNull();
    expect(
      resolveDroppedSkillPath(transfer('%not-a-url'), () => ''),
    ).toBeNull();
  });
});
