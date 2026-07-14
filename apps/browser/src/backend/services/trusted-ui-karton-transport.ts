import type {
  IpcMain,
  IpcMainEvent,
  MessagePortMain,
  WebContents,
  WebFrameMain,
} from 'electron';
import { TRUSTED_UI_KARTON_CONNECT_CHANNEL } from '@shared/trusted-ui-karton';
import type { Logger } from './logger';

export const TRUSTED_UI_REVIEWER_CONNECTION_ID = 'ui-main';

export type GenericKartonConnectionKind = 'tab' | 'pages-api';

export interface TrustedUiLocation {
  url: string;
  origin: string;
}

interface FrameRevision {
  frameTreeNodeId: number;
  processId: number;
  routingId: number;
  frameToken: string;
  url: string;
  origin: string;
}

export type TrustedUiKartonAdmissionFailure =
  | 'disposed'
  | 'invalid-message'
  | 'invalid-port-count'
  | 'missing-current-ui'
  | 'stale-or-foreign-web-contents'
  | 'subframe-or-stale-frame'
  | 'wrong-ui-location'
  | 'transport-rejected';

export type TrustedUiKartonAdmissionDecision =
  | { ok: true; port: MessagePortMain }
  | { ok: false; reason: TrustedUiKartonAdmissionFailure };

export interface TrustedUiKartonTransportAdmissionOptions {
  ipc: Pick<IpcMain, 'on' | 'off'>;
  getCurrentUiWebContents: () => WebContents | null;
  getAllowedUiLocation: () => TrustedUiLocation | null;
  acceptPort: (port: MessagePortMain) => string;
  logger: Pick<Logger, 'debug' | 'warn' | 'error'>;
}

export function createTrustedUiLocation(urlValue: string): TrustedUiLocation {
  const url = new URL(urlValue);
  if (url.username || url.password || url.hash) {
    throw new Error('Trusted UI URL contains a forbidden component');
  }
  // Electron 40 serializes WebFrameMain.origin for a packaged file UI as
  // `file://`, while WHATWG URL in Node reports the opaque origin `null`.
  const origin = url.protocol === 'file:' ? 'file://' : url.origin;
  return { url: url.href, origin };
}

/** Generic renderer-selected Karton roles never include trusted UI authority. */
export function parseGenericKartonConnectionKind(
  value: unknown,
): GenericKartonConnectionKind | null {
  return value === 'tab' || value === 'pages-api' ? value : null;
}

export function closeTransferredPorts(ports: readonly MessagePortMain[]): void {
  for (const port of ports) {
    try {
      port.close();
    } catch {
      // A transferred or already-disconnected port is already unusable.
    }
  }
}

function captureFrameRevision(frame: WebFrameMain): FrameRevision | null {
  try {
    if (frame.isDestroyed() || frame.detached) return null;
    return {
      frameTreeNodeId: frame.frameTreeNodeId,
      processId: frame.processId,
      routingId: frame.routingId,
      frameToken: frame.frameToken,
      url: frame.url,
      origin: frame.origin,
    };
  } catch {
    return null;
  }
}

function revisionsEqual(left: FrameRevision, right: FrameRevision): boolean {
  return (
    left.frameTreeNodeId === right.frameTreeNodeId &&
    left.processId === right.processId &&
    left.routingId === right.routingId &&
    left.frameToken === right.frameToken &&
    left.url === right.url &&
    left.origin === right.origin
  );
}

export function evaluateTrustedUiKartonConnect(
  event: IpcMainEvent,
  args: readonly unknown[],
  currentUi: WebContents | null,
  allowedLocation: TrustedUiLocation | null,
): TrustedUiKartonAdmissionDecision {
  if (args.length !== 1 || args[0] !== null) {
    return { ok: false, reason: 'invalid-message' };
  }
  if (event.ports.length !== 1) {
    return { ok: false, reason: 'invalid-port-count' };
  }
  if (!currentUi || !allowedLocation || currentUi.isDestroyed()) {
    return { ok: false, reason: 'missing-current-ui' };
  }
  if (event.sender !== currentUi || event.sender.id !== currentUi.id) {
    return { ok: false, reason: 'stale-or-foreign-web-contents' };
  }

  try {
    const senderFrame = event.senderFrame;
    const currentMainFrame = currentUi.mainFrame;
    if (!senderFrame || senderFrame.parent !== null) {
      return { ok: false, reason: 'subframe-or-stale-frame' };
    }

    const senderRevision = captureFrameRevision(senderFrame);
    const currentRevision = captureFrameRevision(currentMainFrame);
    if (
      !senderRevision ||
      !currentRevision ||
      !revisionsEqual(senderRevision, currentRevision) ||
      event.processId !== senderRevision.processId ||
      event.frameId !== senderRevision.routingId
    ) {
      return { ok: false, reason: 'subframe-or-stale-frame' };
    }

    if (
      senderRevision.url !== allowedLocation.url ||
      senderRevision.origin !== allowedLocation.origin ||
      currentUi.getURL() !== allowedLocation.url
    ) {
      return { ok: false, reason: 'wrong-ui-location' };
    }
  } catch {
    return { ok: false, reason: 'subframe-or-stale-frame' };
  }

  const port = event.ports[0];
  return port
    ? { ok: true, port }
    : { ok: false, reason: 'invalid-port-count' };
}

/**
 * Admits the main UI Karton port only through trusted Electron identity.
 * The renderer never selects the `ui-main` reviewer connection ID.
 */
export class TrustedUiKartonTransportAdmission {
  private started = false;
  private disposed = false;

  private readonly listener = (
    event: IpcMainEvent,
    ...args: unknown[]
  ): void => {
    this.handleConnect(event, args);
  };

  public constructor(
    private readonly options: TrustedUiKartonTransportAdmissionOptions,
  ) {}

  public start(): this {
    if (this.disposed) {
      throw new Error('TrustedUiKartonTransportAdmission is disposed');
    }
    if (this.started) return this;
    this.options.ipc.on(TRUSTED_UI_KARTON_CONNECT_CHANNEL, this.listener);
    this.started = true;
    return this;
  }

  public handleConnect(event: IpcMainEvent, args: readonly unknown[]): boolean {
    if (this.disposed) {
      closeTransferredPorts(event.ports);
      return false;
    }

    let currentUi: WebContents | null = null;
    let allowedLocation: TrustedUiLocation | null = null;
    try {
      currentUi = this.options.getCurrentUiWebContents();
      allowedLocation = this.options.getAllowedUiLocation();
    } catch {
      // A torn-down/recreated UI boundary is not admissible.
    }

    const decision = evaluateTrustedUiKartonConnect(
      event,
      args,
      currentUi,
      allowedLocation,
    );
    if (!decision.ok) {
      closeTransferredPorts(event.ports);
      this.options.logger.warn(
        '[TrustedUiKarton] Rejected UI transport admission',
        { reason: decision.reason },
      );
      return false;
    }

    try {
      const connectionId = this.options.acceptPort(decision.port);
      if (connectionId !== TRUSTED_UI_REVIEWER_CONNECTION_ID) {
        closeTransferredPorts([decision.port]);
        this.options.logger.error(
          '[TrustedUiKarton] Backend injected an unexpected connection ID',
        );
        return false;
      }
      this.options.logger.debug(
        '[TrustedUiKarton] Accepted current main UI transport',
      );
      return true;
    } catch (error) {
      closeTransferredPorts([decision.port]);
      this.options.logger.error(
        '[TrustedUiKarton] Failed to accept current main UI transport',
        { error },
      );
      return false;
    }
  }

  public teardown(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) {
      this.options.ipc.off(TRUSTED_UI_KARTON_CONNECT_CHANNEL, this.listener);
      this.started = false;
    }
  }
}
