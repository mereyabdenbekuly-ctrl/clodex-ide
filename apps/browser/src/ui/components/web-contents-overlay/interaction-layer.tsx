import { useCallback, type MouseEvent, type WheelEvent } from 'react';
import { cn } from '@ui/utils';
import {
  useWebContentsOverlay,
  dispatchOverlayEvent,
  type WebContentsOverlayEventType,
} from '@ui/contexts/web-contents-overlay';

/**
 * The interaction layer captures all mouse/pointer/wheel events
 * and dispatches them to registered handlers in LIFO order.
 */
export function InteractionLayer() {
  const { overlayRef, _registrationsRef, _removePendingRegistrations } =
    useWebContentsOverlay();

  const registrations = _registrationsRef.current;
  const hasRegistrations = registrations.length > 0;

  // Determine cursor from the most recent registration that has one
  const cursor =
    [...registrations].reverse().find((r) => r.cursor)?.cursor ?? 'default';

  // Helper to dispatch events (only to active registrations, not pending removal)
  const dispatch = useCallback(
    (
      eventType: WebContentsOverlayEventType,
      event: MouseEvent<HTMLDivElement> | WheelEvent<HTMLDivElement>,
    ) => {
      const active = _registrationsRef.current.filter((r) => !r.pendingRemoval);
      dispatchOverlayEvent(active, eventType, event);
    },
    [_registrationsRef],
  );

  const handleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      dispatch('click', event);
    },
    [dispatch],
  );

  const handleMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      // Prevent focus switching
      event.preventDefault();
      dispatch('mousedown', event);
      dispatch('pointerdown', event);
    },
    [dispatch],
  );

  const handleMouseUp = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      dispatch('mouseup', event);
      dispatch('pointerup', event);
    },
    [dispatch],
  );

  const handleMouseMove = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      dispatch('mousemove', event);
      dispatch('pointermove', event);
    },
    [dispatch],
  );

  const handleMouseLeave = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      dispatch('mouseleave', event);
      dispatch('pointerleave', event);
      // Remove any registrations that were soft-released (pending removal)
      _removePendingRegistrations();
    },
    [dispatch, _removePendingRegistrations],
  );

  const handleMouseEnter = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      dispatch('mouseenter', event);
      dispatch('pointerenter', event);
    },
    [dispatch],
  );

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      dispatch('wheel', event);
    },
    [dispatch],
  );

  return (
    <div
      ref={overlayRef}
      data-web-contents-overlay
      // data-element-selector-overlay tells WebContentsBoundsSyncer to keep UI on top
      // when the overlay is active, preventing the webcontents from stealing z-order
      {...(hasRegistrations ? { 'data-element-selector-overlay': true } : {})}
      className={cn(
        'absolute inset-0 z-40',
        hasRegistrations ? 'pointer-events-auto' : 'pointer-events-none',
      )}
      style={{
        cursor: hasRegistrations ? cursor : 'default',
      }}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onMouseEnter={handleMouseEnter}
      onWheel={handleWheel}
    />
  );
}
