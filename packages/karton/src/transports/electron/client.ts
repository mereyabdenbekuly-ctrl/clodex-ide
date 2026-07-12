import type { Transport, KartonMessage } from '../../shared/transport.js';

export interface MessagePortProxy {
  setOnMessage: (handler: (message: KartonMessage) => void) => void;
  postMessage: (message: KartonMessage) => void;
}

/**
 * Client-side transport for Electron using a bridge to MessagePort.
 *
 * The actual MessagePort lives in the preload script. This transport
 * communicates with it through the bridge interface exposed via contextBridge.
 *
 * Connection readiness:
 * - The connection is only considered "open" after receiving the first message
 *   from the server. This ensures the server has called port.start() and is
 *   ready to receive messages, preventing a race condition where the client
 *   sends RPC calls before the server is listening.
 *
 * Error handling:
 * - State sync messages (send) fail silently when the port is not ready
 * - RPC calls will receive proper error responses via the RPC layer
 */
export class ElectronClientTransport implements Transport {
  private messageHandler: ((message: KartonMessage) => void) | null = null;
  private closeHandler:
    | ((event?: { code: number; reason: string }) => void)
    | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private unsubscribeMessage: (() => void) | null = null;
  private portProxy: MessagePortProxy;

  /**
   * Whether the connection is ready (first message received from server).
   * This prevents RPC calls from being sent before the server is listening.
   */
  private _isReady = false;

  /**
   * Stored onOpen handler to be called when connection becomes ready.
   */
  private _onOpenHandler: (() => void) | null = null;

  constructor({ messagePort }: { messagePort: MessagePortProxy }) {
    this.portProxy = messagePort;
  }

  /**
   * Send a message through the bridge.
   * For state sync, this fails silently if the bridge is not ready.
   * For RPC, the calling code should check isOpen() first.
   */
  send(message: KartonMessage): void {
    try {
      this.portProxy.postMessage(message);
    } catch (err) {
      this.errorHandler?.(
        err instanceof Error ? err : new Error('Failed to send message'),
      );
    }
  }

  onMessage(handler: (message: KartonMessage) => void): () => void {
    this.messageHandler = handler;
    return () => {
      this.messageHandler = null;
    };
  }

  close(): void {
    this._isReady = false;
    this.unsubscribeMessage?.();
    this.closeHandler?.();
  }

  isOpen(): boolean {
    return this._isReady;
  }

  onOpen(handler: () => void): () => void {
    // Store the handler - it will be called when first message is received
    this._onOpenHandler = handler;

    // If already ready (e.g., handler registered after first message), call immediately
    if (this._isReady) handler();

    return () => {
      this._onOpenHandler = null;
    };
  }

  onClose(
    handler: (event?: { code: number; reason: string }) => void,
  ): () => void {
    this.closeHandler = handler;
    return () => {
      this.closeHandler = null;
    };
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandler = handler;
    return () => {
      this.errorHandler = null;
    };
  }

  startTransport(): void {
    this.portProxy.setOnMessage((message) => {
      // Ignore empty messages
      if (!message) return;

      // First message received = server is ready and listening
      // This proves the server has called port.start() and can receive our messages
      if (!this._isReady) {
        this._isReady = true;
        this._onOpenHandler?.();
      }

      try {
        this.messageHandler?.(message);
      } catch (err) {
        this.errorHandler?.(
          err instanceof Error
            ? err
            : new Error('Failed to deserialize message'),
        );
      }
    });
  }
}
