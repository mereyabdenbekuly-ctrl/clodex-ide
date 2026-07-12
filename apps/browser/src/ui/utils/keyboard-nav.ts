/**
 * Translates Ctrl+N / Ctrl+P into synthetic ArrowDown / ArrowUp keydown
 * events, matching Chrome/Emacs-style navigation conventions.
 *
 * Dispatches the synthetic event on `e.target` (the focused element) so
 * it bubbles through the same DOM path a real arrow keypress would take.
 * This is important when the handler lives on a wrapper element above the
 * actual interactive widget (e.g. a container div around a RadioGroup).
 *
 * @returns `true` if the event was handled (callers should early-return).
 */
export function dispatchArrowFromCtrl(
  e: React.KeyboardEvent | KeyboardEvent,
): boolean {
  if (!e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;

  const arrowKey =
    e.key === 'n' ? 'ArrowDown' : e.key === 'p' ? 'ArrowUp' : null;
  if (!arrowKey) return false;

  e.preventDefault();
  e.stopPropagation();

  const target = e.target ?? e.currentTarget;
  (target as EventTarget).dispatchEvent(
    new KeyboardEvent('keydown', {
      key: arrowKey,
      code: arrowKey,
      bubbles: true,
      cancelable: true,
    }),
  );

  return true;
}
