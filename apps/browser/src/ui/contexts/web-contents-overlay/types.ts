import type { MouseEvent, PointerEvent, WheelEvent } from 'react';

/**
 * Event types supported by the web contents overlay
 */
export type WebContentsOverlayEventType =
  | 'click'
  | 'mousedown'
  | 'mouseup'
  | 'mousemove'
  | 'mouseleave'
  | 'mouseenter'
  | 'pointerdown'
  | 'pointerup'
  | 'pointermove'
  | 'pointerleave'
  | 'pointerenter'
  | 'wheel';

/**
 * Wrapper for overlay events with propagation control
 */
export interface OverlayEvent<T = HTMLDivElement> {
  originalEvent: MouseEvent<T> | PointerEvent<T> | WheelEvent<T>;
  propagationStopped: boolean;
  stopPropagation: () => void;
}

/**
 * Unique identifier for an access handle
 */
export type AccessHandleId = string;

/**
 * Options for requesting overlay access
 */
export interface RequestAccessOptions {
  /** Whether this request needs exclusive access (blocks others) */
  exclusive?: boolean;
  /** CSS cursor to display when this handle is active */
  cursor?: string;
  /** Event handlers to register */
  handlers: Partial<
    Record<WebContentsOverlayEventType, (e: OverlayEvent) => void>
  >;
}

/**
 * Handle returned when access is granted
 */
export interface AccessHandle {
  /** Unique identifier for this handle */
  id: AccessHandleId;
  /** Whether this handle has exclusive access */
  isExclusive: boolean;
  /** Release this handle's access */
  release: () => void;
  /**
   * Soft release - keeps the overlay "active" for z-order purposes but stops
   * dispatching events. The registration will be fully removed when the mouse
   * leaves the overlay area. Useful for preventing z-order changes after an
   * interaction completes.
   */
  softRelease: () => void;
}

/**
 * Internal registration stored in the context
 */
export interface Registration {
  id: AccessHandleId;
  isExclusive: boolean;
  cursor?: string;
  handlers: Partial<
    Record<WebContentsOverlayEventType, (e: OverlayEvent) => void>
  >;
  /**
   * When true, this registration keeps the overlay active for z-order but
   * doesn't dispatch events. It will be removed on mouse leave.
   */
  pendingRemoval?: boolean;
}
