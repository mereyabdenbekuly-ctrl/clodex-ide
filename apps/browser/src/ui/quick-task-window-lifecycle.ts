import type { QuickTaskWindowContext } from '@shared/quick-task-window';

export function selectNewestQuickTaskContext(
  current: QuickTaskWindowContext | null,
  incoming: QuickTaskWindowContext,
): QuickTaskWindowContext {
  return current && current.requestId > incoming.requestId ? current : incoming;
}

export function isPlainEscape(
  event: Pick<
    KeyboardEvent,
    'key' | 'defaultPrevented' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
  >,
): boolean {
  return (
    event.key === 'Escape' &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}
