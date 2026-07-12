export {
  WebContentsOverlayProvider,
  useWebContentsOverlay,
  dispatchOverlayEvent,
  type WebContentsOverlayContextValue,
} from './context';

export { useOverlayAccess } from './use-overlay-access';

export type {
  WebContentsOverlayEventType,
  OverlayEvent,
  AccessHandleId,
  RequestAccessOptions,
  AccessHandle,
  Registration,
} from './types';
