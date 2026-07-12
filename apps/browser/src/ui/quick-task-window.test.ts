import { describe, expect, it } from 'vitest';
import type { QuickTaskWindowContext } from '@shared/quick-task-window';
import {
  isPlainEscape,
  selectNewestQuickTaskContext,
} from './quick-task-window-lifecycle';

function createContext(requestId: number): QuickTaskWindowContext {
  return {
    requestId,
    initialPrompt: '',
    modelLabel: 'Test model',
    approvalLabel: 'Default',
    workspaceLabels: [],
    hasCurrentWorkspace: false,
  };
}

describe('Quick Task window lifecycle helpers', () => {
  it('ignores stale contexts delivered after a newer reopen request', () => {
    const newest = createContext(4);
    expect(selectNewestQuickTaskContext(newest, createContext(3))).toBe(newest);
    expect(
      selectNewestQuickTaskContext(newest, createContext(5)).requestId,
    ).toBe(5);
  });

  it('dismisses only an unmodified, otherwise unhandled Escape key', () => {
    const baseEvent = {
      key: 'Escape',
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };

    expect(isPlainEscape(baseEvent)).toBe(true);
    expect(isPlainEscape({ ...baseEvent, defaultPrevented: true })).toBe(false);
    expect(isPlainEscape({ ...baseEvent, metaKey: true })).toBe(false);
    expect(isPlainEscape({ ...baseEvent, key: 'Enter' })).toBe(false);
  });
});
