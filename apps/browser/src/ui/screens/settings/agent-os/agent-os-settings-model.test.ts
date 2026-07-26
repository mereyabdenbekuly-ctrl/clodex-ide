import { describe, expect, it, vi } from 'vitest';
import type { ChronicleEvent } from '@shared/agent-os';
import {
  createChronicleContext,
  getHookExecutionAvailability,
  getHookRunDisplay,
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

  it('does not advertise helper-agent hooks without a configured runner', () => {
    expect(
      getHookExecutionAvailability(
        { trigger: 'after-turn', kind: 'agent' },
        false,
      ),
    ).toEqual({
      canEnable: false,
      canTest: false,
      explanation:
        'Inactive: this build has no trusted helper-agent runner configured.',
    });

    expect(
      getHookExecutionAvailability(
        { trigger: 'after-turn', kind: 'agent' },
        true,
      ),
    ).toEqual({ canEnable: true, canTest: true, explanation: null });

    expect(
      getHookExecutionAvailability(
        { trigger: 'after-turn', kind: 'agent' },
        true,
        false,
      ),
    ).toEqual({
      canEnable: true,
      canTest: false,
      explanation:
        'Open an agent chat before testing this helper hook manually.',
    });
  });

  it('keeps before-turn helper agents manual-only but testable', () => {
    expect(
      getHookExecutionAvailability(
        { trigger: 'before-turn', kind: 'agent' },
        true,
        true,
      ),
    ).toEqual({
      canEnable: false,
      canTest: true,
      explanation:
        'Manual test only: Before turn helper-agent hooks do not run automatically; use a Before turn prompt hook to affect the admitted message.',
    });

    expect(
      getHookExecutionAvailability(
        { trigger: 'before-turn', kind: 'agent' },
        true,
        false,
      ),
    ).toEqual({
      canEnable: false,
      canTest: false,
      explanation:
        'Manual test only: Before turn helper-agent hooks do not run automatically. Open an agent chat to test this hook.',
    });
  });

  it('keeps unwired prompts manual-only and command execution unavailable', () => {
    expect(
      getHookExecutionAvailability(
        { trigger: 'before-file-edit', kind: 'prompt' },
        false,
      ),
    ).toMatchObject({ canEnable: false, canTest: true });
    expect(
      getHookExecutionAvailability(
        { trigger: 'before-command', kind: 'command' },
        false,
      ),
    ).toMatchObject({ canEnable: false, canTest: false });
  });

  it('surfaces the stored reason for a skipped hook run', () => {
    expect(
      getHookRunDisplay({
        id: 'run-1',
        hookId: 'hook-1',
        trigger: 'after-turn',
        startedAt: 100,
        finishedAt: 100,
        status: 'skipped',
        error: 'Helper-agent hook runner is not configured in this build',
      }),
    ).toEqual({
      summary: 'not run · 0 ms',
      detail: 'Helper-agent hook runner is not configured in this build',
      detailKind: 'error',
    });
  });

  it('shows successful helper-agent output in recent runs', () => {
    expect(
      getHookRunDisplay({
        id: 'run-2',
        hookId: 'hook-2',
        trigger: 'after-turn',
        startedAt: 100,
        finishedAt: 275,
        status: 'succeeded',
        output: 'The agent stopped after a recoverable tool-input failure.',
      }),
    ).toEqual({
      summary: 'succeeded · 175 ms',
      detail: 'The agent stopped after a recoverable tool-input failure.',
      detailKind: 'output',
    });
  });
});
