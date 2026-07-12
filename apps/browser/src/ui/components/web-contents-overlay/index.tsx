import { InteractionLayer } from './interaction-layer';

/**
 * WebContentsOverlay component that renders an overlay on top of the web content.
 * This overlay is used by devtools (color picker, etc.) and DOM selection features.
 *
 * Features:
 * - Handle-based access control (exclusive vs non-exclusive)
 * - LIFO event dispatch with stopPropagation support
 * - Automatic cursor management
 * - Auto-cleanup on unmount
 */
export function WebContentsOverlay() {
  return <InteractionLayer />;
}
