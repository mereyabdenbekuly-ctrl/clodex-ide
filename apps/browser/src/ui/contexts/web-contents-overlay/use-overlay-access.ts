import { useRef, useEffect, useCallback } from 'react';
import { useWebContentsOverlay } from './context';
import type { AccessHandle, RequestAccessOptions } from './types';

/**
 * Hook for requesting overlay access with automatic cleanup on unmount.
 *
 * @example
 * ```tsx
 * const { requestAccess, canGetAccess, overlayRef } = useOverlayAccess();
 *
 * const start = () => {
 *   const handle = requestAccess({
 *     exclusive: false,
 *     cursor: 'crosshair',
 *     handlers: {
 *       mousemove: (e) => handleMove(e.originalEvent),
 *       click: (e) => handleClick(e.originalEvent),
 *     },
 *   });
 *   if (handle) handleRef.current = handle;
 * };
 *
 * const stop = () => handleRef.current?.release();
 * ```
 */
export function useOverlayAccess() {
  const context = useWebContentsOverlay();
  const activeHandleRef = useRef<AccessHandle | null>(null);

  const {
    requestAccess: contextRequestAccess,
    releaseAccess: contextReleaseAccess,
    canGetAccess,
    canGetExclusiveAccess,
    overlayRef,
  } = context;

  /**
   * Request access to the overlay.
   * Returns the handle if access was granted, null otherwise.
   * The returned handle is tracked for automatic cleanup on unmount.
   */
  const requestAccess = useCallback(
    (options: RequestAccessOptions): AccessHandle | null => {
      // Release any existing handle first
      if (activeHandleRef.current) {
        contextReleaseAccess(activeHandleRef.current);
        activeHandleRef.current = null;
      }

      const handle = contextRequestAccess(options);
      if (handle) {
        activeHandleRef.current = handle;
      }
      return handle;
    },
    [contextRequestAccess, contextReleaseAccess],
  );

  /**
   * Release the current access handle.
   */
  const releaseAccess = useCallback(
    (handle?: AccessHandle) => {
      const handleToRelease = handle ?? activeHandleRef.current;
      if (handleToRelease) {
        if (activeHandleRef.current?.id === handleToRelease.id) {
          activeHandleRef.current = null;
        }
        contextReleaseAccess(handleToRelease);
      }
    },
    [contextReleaseAccess],
  );

  // Auto-release on unmount (orphan cleanup)
  useEffect(() => {
    return () => {
      if (activeHandleRef.current) {
        contextReleaseAccess(activeHandleRef.current);
        activeHandleRef.current = null;
      }
    };
  }, [contextReleaseAccess]);

  return {
    requestAccess,
    releaseAccess,
    canGetAccess,
    canGetExclusiveAccess,
    overlayRef,
  };
}
