import {
  artifactBridgeConnectSchema,
  artifactBridgeEnvelopeSchema,
  artifactBridgeRequestSchema,
  artifactBridgeResponseSchema,
  type ArtifactBridgeRequest,
  type ArtifactBridgeSessionBinding,
} from '@shared/artifact-bridge';

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

export interface ArtifactBridgeRendererPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type ArtifactBridgeRequestMethod = ArtifactBridgeRequest['method'];
export type ArtifactBridgeRequestParams<M extends ArtifactBridgeRequestMethod> =
  Extract<ArtifactBridgeRequest, { method: M }>['params'];

/**
 * Document-local client retained only by the isolated preload world.
 * The generated app receives a frozen request function, never the port or the
 * backend-issued session binding.
 */
export class ArtifactBridgePortClient {
  private binding: ArtifactBridgeSessionBinding | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly readyPromise: Promise<ArtifactBridgeSessionBinding>;
  private resolveReady!: (binding: ArtifactBridgeSessionBinding) => void;
  private rejectReady!: (error: Error) => void;
  private connectTimeout: ReturnType<typeof setTimeout> | null;
  private disposed = false;

  constructor(
    private readonly port: ArtifactBridgeRendererPort,
    options: {
      connectTimeoutMs?: number;
      requestTimeoutMs?: number;
    } = {},
  ) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // The bridge may be closed before app code makes its first request. Keep
    // that lifecycle rejection observed while preserving rejection for later
    // callers awaiting the original promise.
    void this.readyPromise.catch(() => undefined);
    this.connectTimeout = setTimeout(
      () => this.dispose(new Error('Artifact Bridge connection timed out')),
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    );
    this.port.onmessage = (event) => this.handleMessage(event.data);
    this.port.onmessageerror = () => {
      this.dispose(new Error('Artifact Bridge message channel failed'));
    };
    this.port.start();
  }

  private readonly requestTimeoutMs: number;

  public async request<M extends ArtifactBridgeRequestMethod>(
    method: M,
    params: ArtifactBridgeRequestParams<M>,
  ): Promise<unknown> {
    if (this.disposed) throw new Error('Artifact Bridge is unavailable');
    const binding = await this.readyPromise;
    if (this.disposed || this.binding !== binding) {
      throw new Error('Artifact Bridge session is no longer active');
    }

    const request = artifactBridgeRequestSchema.parse({
      id: crypto.randomUUID(),
      method,
      params,
    });
    const envelope = artifactBridgeEnvelopeSchema.parse({
      __clodexArtifactBridge: 2,
      type: 'request',
      ...binding,
      request,
    });

    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error('Artifact Bridge request timed out'));
      }, this.requestTimeoutMs);
      this.pending.set(request.id, { resolve, reject, timeout });
      try {
        this.port.postMessage(envelope);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(request.id);
        reject(
          error instanceof Error
            ? error
            : new Error('Artifact Bridge request could not be sent'),
        );
      }
    });
  }

  public dispose(
    reason: Error = new Error('Artifact Bridge session closed'),
  ): void {
    if (this.disposed) return;
    this.disposed = true;
    this.binding = null;
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    this.rejectReady(reason);
    this.pending.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    });
    this.pending.clear();
    this.port.onmessage = null;
    this.port.onmessageerror = null;
    try {
      this.port.close();
    } catch {
      // The document or remote endpoint may already have closed the port.
    }
  }

  private handleMessage(rawMessage: unknown): void {
    if (this.disposed) return;

    if (!this.binding) {
      const connect = artifactBridgeConnectSchema.safeParse(rawMessage);
      if (!connect.success) {
        this.dispose(new Error('Invalid Artifact Bridge connect message'));
        return;
      }
      this.binding = {
        sessionId: connect.data.sessionId,
        navigationEpoch: connect.data.navigationEpoch,
      };
      if (this.connectTimeout) {
        clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
      }
      this.resolveReady(this.binding);
      return;
    }

    const response = artifactBridgeResponseSchema.safeParse(rawMessage);
    if (
      !response.success ||
      response.data.sessionId !== this.binding.sessionId ||
      response.data.navigationEpoch !== this.binding.navigationEpoch
    ) {
      this.dispose(new Error('Invalid Artifact Bridge response binding'));
      return;
    }

    const pending = this.pending.get(response.data.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(response.data.id);
    if (response.data.ok) pending.resolve(response.data.result);
    else pending.reject(new Error(response.data.error));
  }
}
