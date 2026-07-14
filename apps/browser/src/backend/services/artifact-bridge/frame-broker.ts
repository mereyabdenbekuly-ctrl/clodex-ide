import type {
  IpcMain,
  IpcMainEvent,
  MessagePortMain,
  WebContents,
  WebFrameMain,
} from 'electron';
import {
  ARTIFACT_BRIDGE_FRAME_CONNECT_CHANNEL,
  artifactBridgeConnectSchema,
  artifactBridgeContextSchema,
  artifactBridgeEnvelopeSchema,
  artifactBridgeHelloSchema,
  artifactBridgeResponseSchema,
  type ArtifactBridgeContext,
} from '@shared/artifact-bridge';
import { parseAppUrlIdentity } from '@shared/isolated-app-origin';
import { parseCanonicalAppContentRevision } from '../app-protocol-security';
import {
  getIsolatedAppRevisionBinding,
  type IsolatedAppDocumentBinding,
  type IsolatedAppFrameAddress,
  type IsolatedAppRevisionBinding,
} from '../app-protocol-revision-binding';
import type { Logger } from '../logger';
import type {
  ArtifactBridgeHostSessionBinding,
  ArtifactBridgeService,
} from './index';
import { redactSensitiveText } from './sensitive-egress';

type ArtifactBridgeHostSessionService = Pick<
  ArtifactBridgeService,
  | 'openHostSession'
  | 'invokeHostSession'
  | 'suspendHostSession'
  | 'closeHostSession'
>;

type ArtifactBridgeRevisionBinding = Pick<
  IsolatedAppRevisionBinding,
  | 'bindDocument'
  | 'rotateTrustedDocument'
  | 'unbindDocument'
  | 'clearFrame'
  | 'clearWebContents'
  | 'onNavigationStart'
>;

export interface ArtifactBridgeFrameBrokerOptions {
  ipc: Pick<IpcMain, 'on' | 'off'>;
  artifactBridge: ArtifactBridgeHostSessionService;
  logger: Pick<Logger, 'debug' | 'warn' | 'error'>;
  reconnectGraceMs?: number;
  revisionBindingFor?: (sender: WebContents) => ArtifactBridgeRevisionBinding;
}

interface FrameRevision {
  processId: number;
  routingId: number;
  frameToken: string;
  url: string;
  origin: string;
}

interface ValidatedFrameConnect {
  sender: WebContents;
  port: MessagePortMain;
  slotKey: string;
  frameTreeNodeId: number;
  context: ArtifactBridgeContext;
  contentRevision: string;
  document: FrameRevision;
  parent: FrameRevision;
  revisionBinding: ArtifactBridgeRevisionBinding;
}

interface ActiveFrameBinding extends ValidatedFrameConnect {
  host: ArtifactBridgeHostSessionBinding;
  revisionDocumentToken: string;
  state: 'active' | 'replaced' | 'retired' | 'revoked';
  onMessage: (event: Electron.MessageEvent) => void;
  onClose: () => void;
}

interface RetiredFrameBinding {
  binding: ActiveFrameBinding;
  timer: ReturnType<typeof setTimeout>;
}

interface SenderLifecycle {
  sender: WebContents;
  onDestroyed: () => void;
  onWillFrameNavigate: (
    details: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>,
  ) => void;
}

interface PreviewRouteBinding {
  agentId: string;
  appId: string;
  pluginId?: string;
}

interface DerivedFrameAuthority {
  context: ArtifactBridgeContext;
  contentRevision: string;
}

const ALLOWED_PREVIEW_QUERY_KEYS = new Set([
  'agentId',
  'pluginId',
  't',
  'title',
]);
const MAX_ID_LENGTH = 256;
const MAX_CACHE_BUST_LENGTH = 1_024;
const MAX_TITLE_LENGTH = 1_024;
const DEFAULT_RECONNECT_GRACE_MS = 1_000;

function isSafeDecodedId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0')
  );
}

function readSingleQueryValue(
  search: URLSearchParams,
  key: string,
  required: boolean,
  maxLength: number,
): string | undefined | null {
  const values = search.getAll(key);
  if (values.length === 0) return required ? null : undefined;
  if (values.length !== 1) return null;
  const value = values[0];
  if (!value || value.length > maxLength) return null;
  return value;
}

function parsePreviewRoute(urlValue: string): PreviewRouteBinding | null {
  if (!urlValue.startsWith('clodex://internal/')) return null;

  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return null;
  }

  if (
    url.protocol !== 'clodex:' ||
    url.hostname !== 'internal' ||
    url.host !== 'internal' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== ''
  ) {
    return null;
  }

  const pathParts = url.pathname.split('/');
  if (
    pathParts.length !== 3 ||
    pathParts[0] !== '' ||
    pathParts[1] !== 'preview' ||
    !pathParts[2]
  ) {
    return null;
  }

  let appId: string;
  try {
    appId = decodeURIComponent(pathParts[2]);
  } catch {
    return null;
  }
  if (!isSafeDecodedId(appId)) return null;

  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_PREVIEW_QUERY_KEYS.has(key)) return null;
  }

  const agentId = readSingleQueryValue(
    url.searchParams,
    'agentId',
    true,
    MAX_ID_LENGTH,
  );
  const pluginId = readSingleQueryValue(
    url.searchParams,
    'pluginId',
    false,
    MAX_ID_LENGTH,
  );
  const cacheBust = readSingleQueryValue(
    url.searchParams,
    't',
    false,
    MAX_CACHE_BUST_LENGTH,
  );
  const title = readSingleQueryValue(
    url.searchParams,
    'title',
    false,
    MAX_TITLE_LENGTH,
  );
  if (
    agentId === null ||
    pluginId === null ||
    cacheBust === null ||
    title === null
  ) {
    return null;
  }
  if (!agentId || !isSafeDecodedId(agentId)) return null;
  if (pluginId !== undefined && !isSafeDecodedId(pluginId)) return null;

  return { agentId, appId, pluginId };
}

function captureFrameRevision(frame: WebFrameMain): FrameRevision | null {
  try {
    if (frame.isDestroyed() || frame.detached) return null;
    return {
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
    left.processId === right.processId &&
    left.routingId === right.routingId &&
    left.frameToken === right.frameToken &&
    left.url === right.url &&
    left.origin === right.origin
  );
}

function framesReferToSameDocument(
  left: WebFrameMain,
  right: WebFrameMain,
): boolean {
  const leftRevision = captureFrameRevision(left);
  const rightRevision = captureFrameRevision(right);
  return Boolean(
    leftRevision &&
      rightRevision &&
      left.frameTreeNodeId === right.frameTreeNodeId &&
      revisionsEqual(leftRevision, rightRevision),
  );
}

function contextsEqual(
  left: ArtifactBridgeContext,
  right: ArtifactBridgeContext,
): boolean {
  if (left.kind !== right.kind || left.appId !== right.appId) return false;
  if (left.kind === 'package' && right.kind === 'package') {
    return left.packageId === right.packageId;
  }
  if (left.kind === 'agent' && right.kind === 'agent') {
    return left.agentId === right.agentId && left.pluginId === right.pluginId;
  }
  return false;
}

function frameAddressOf(
  binding: Pick<
    ValidatedFrameConnect,
    'sender' | 'frameTreeNodeId' | 'document'
  >,
): IsolatedAppFrameAddress {
  return {
    webContentsId: binding.sender.id,
    frameTreeNodeId: binding.frameTreeNodeId,
    processId: binding.document.processId,
    frameToken: binding.document.frameToken,
  };
}

function revisionDocumentToken(host: ArtifactBridgeHostSessionBinding): string {
  return `${host.documentSlotId}:${host.sessionId}:${host.navigationEpoch}`;
}

function revisionDocumentBinding(
  validated: ValidatedFrameConnect,
  host: ArtifactBridgeHostSessionBinding,
): IsolatedAppDocumentBinding | null {
  if (
    validated.context.kind !== 'agent' ||
    validated.context.pluginId !== undefined
  ) {
    return null;
  }
  return {
    ...frameAddressOf(validated),
    documentToken: revisionDocumentToken(host),
    origin: validated.document.origin,
    agentId: validated.context.agentId,
    appId: validated.context.appId,
    revision: validated.contentRevision,
  };
}

function sameFrameDocument(
  left: ValidatedFrameConnect,
  right: ValidatedFrameConnect,
): boolean {
  return (
    left.sender === right.sender &&
    left.frameTreeNodeId === right.frameTreeNodeId &&
    revisionsEqual(left.document, right.document)
  );
}

function deriveFrameAuthority(
  parentRevision: FrameRevision,
  childRevision: FrameRevision,
): DerivedFrameAuthority | null {
  if (parentRevision.origin !== 'clodex://internal') return null;
  const route = parsePreviewRoute(parentRevision.url);
  const childIdentity = parseAppUrlIdentity(childRevision.url);
  // Require the same canonical query form as the app protocol before any
  // backend host session is opened. Equality to the trusted identity snapshot
  // is checked only after openHostSession returns it.
  const contentRevision = parseCanonicalAppContentRevision(childRevision.url);
  if (
    !route ||
    childIdentity?.classification !== 'isolated' ||
    !contentRevision ||
    childRevision.origin !== childIdentity.origin ||
    route.appId !== childIdentity.identity.appId
  ) {
    return null;
  }

  if (childIdentity.identity.namespace === 'agents') {
    if (
      route.pluginId !== undefined ||
      childIdentity.identity.entityId !== route.agentId
    ) {
      return null;
    }
  } else if (
    route.pluginId === undefined ||
    childIdentity.identity.entityId !== route.pluginId
  ) {
    return null;
  }

  const parsed = artifactBridgeContextSchema.safeParse({
    kind: 'agent',
    agentId: route.agentId,
    appId: route.appId,
    pluginId: route.pluginId,
  });
  return parsed.success ? { context: parsed.data, contentRevision } : null;
}

function closePorts(ports: readonly MessagePortMain[]): void {
  for (const port of ports) {
    try {
      port.close();
    } catch {
      // A transferred or already-disconnected port is already unusable.
    }
  }
}

function errorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown generated app capability error';
  return redactSensitiveText(message).slice(0, 500);
}

/**
 * Main-process broker for a generated-app frame's document-bound capability
 * channel. The untrusted frame can initiate a hello, but only Electron's
 * senderFrame identity and the transferred MessagePort carry authority.
 */
export class ArtifactBridgeFrameBroker {
  private readonly activeBindings = new Map<string, ActiveFrameBinding>();
  private readonly retiredBindings = new Map<string, RetiredFrameBinding>();
  private readonly slotQueues = new Map<string, Promise<void>>();
  private readonly pendingTasks = new Set<Promise<void>>();
  private readonly revisionBindingDisposers = new Map<
    ArtifactBridgeRevisionBinding,
    () => void
  >();
  private readonly senderLifecycles = new Map<number, SenderLifecycle>();
  private readonly reconnectGraceMs: number;
  private started = false;
  private disposed = false;

  private readonly connectListener = (
    event: IpcMainEvent,
    ...args: unknown[]
  ): void => {
    this.track(this.handleFrameConnect(event, args));
  };

  public constructor(
    private readonly options: ArtifactBridgeFrameBrokerOptions,
  ) {
    this.reconnectGraceMs = Math.max(
      0,
      options.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS,
    );
  }

  public start(): this {
    if (this.disposed) throw new Error('ArtifactBridgeFrameBroker is disposed');
    if (this.started) return this;
    this.options.ipc.on(
      ARTIFACT_BRIDGE_FRAME_CONNECT_CHANNEL,
      this.connectListener,
    );
    this.started = true;
    return this;
  }

  public async handleFrameConnect(
    event: IpcMainEvent,
    args: readonly unknown[],
  ): Promise<void> {
    if (this.disposed) {
      closePorts(event.ports);
      return;
    }

    const hello =
      args.length === 1 ? artifactBridgeHelloSchema.safeParse(args[0]) : null;
    if (!hello?.success || event.ports.length !== 1) {
      closePorts(event.ports);
      this.options.logger.warn(
        '[ArtifactBridgeFrameBroker] Rejected malformed frame hello',
      );
      return;
    }

    const port = event.ports[0];
    if (!port) return;
    const validated = this.validateConnectEvent(
      event,
      port,
      hello.data.contentRevision,
    );
    if (!validated) {
      closePorts([port]);
      this.options.logger.warn(
        '[ArtifactBridgeFrameBroker] Rejected untrusted frame hello',
      );
      return;
    }

    let candidateClosed = false;
    const onCandidateClose = () => {
      candidateClosed = true;
    };
    port.once('close', onCandidateClose);

    await this.enqueueSlot(validated.slotKey, async () => {
      try {
        if (
          candidateClosed ||
          this.disposed ||
          !this.isCurrentDocument(validated)
        ) {
          closePorts([port]);
          return;
        }
        await this.activateBinding(validated, () => candidateClosed);
      } catch (error) {
        closePorts([port]);
        throw error;
      } finally {
        port.off('close', onCandidateClose);
      }
    });
  }

  public async teardown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) {
      this.options.ipc.off(
        ARTIFACT_BRIDGE_FRAME_CONNECT_CHANNEL,
        this.connectListener,
      );
      this.started = false;
    }

    const bindings = [...this.activeBindings.values()];
    const retired = [...this.retiredBindings.values()];
    this.activeBindings.clear();
    this.retiredBindings.clear();
    for (const entry of retired) clearTimeout(entry.timer);
    for (const lifecycle of this.senderLifecycles.values()) {
      lifecycle.sender.off('destroyed', lifecycle.onDestroyed);
      lifecycle.sender.off(
        'will-frame-navigate',
        lifecycle.onWillFrameNavigate,
      );
    }
    this.senderLifecycles.clear();
    for (const dispose of this.revisionBindingDisposers.values()) dispose();
    this.revisionBindingDisposers.clear();
    await Promise.allSettled(
      [...bindings, ...retired.map((entry) => entry.binding)].map(
        async (binding) => {
          this.deactivateTransport(binding, true, 'revoked');
          this.releaseRevisionBinding(binding);
          await this.closeBackendBinding(binding);
        },
      ),
    );
    await Promise.allSettled([...this.pendingTasks]);
  }

  private validateConnectEvent(
    event: IpcMainEvent,
    port: MessagePortMain,
    preloadContentRevision: string,
  ): ValidatedFrameConnect | null {
    try {
      const sender = event.sender;
      const child = event.senderFrame;
      if (!child || sender.isDestroyed()) return null;
      const parent = child.parent;
      const top = child.top;
      const mainFrame = sender.mainFrame;
      if (
        !parent ||
        !top ||
        !framesReferToSameDocument(parent, mainFrame) ||
        !framesReferToSameDocument(top, mainFrame) ||
        event.processId !== child.processId ||
        event.frameId !== child.routingId
      ) {
        return null;
      }

      const currentChild = mainFrame.frames.find(
        (frame) => frame.frameTreeNodeId === child.frameTreeNodeId,
      );
      if (!currentChild || !framesReferToSameDocument(currentChild, child)) {
        return null;
      }

      const document = captureFrameRevision(child);
      const parentRevision = captureFrameRevision(parent);
      if (!document || !parentRevision) return null;
      const authority = deriveFrameAuthority(parentRevision, document);
      if (!authority || authority.contentRevision !== preloadContentRevision) {
        return null;
      }

      const revisionBinding = this.options.revisionBindingFor
        ? this.options.revisionBindingFor(sender)
        : getIsolatedAppRevisionBinding(sender.session);
      this.ensureRevisionBindingLifecycle(revisionBinding);
      this.ensureSenderLifecycle(sender, revisionBinding);

      return {
        sender,
        port,
        slotKey: `${sender.id}:${child.frameTreeNodeId}`,
        frameTreeNodeId: child.frameTreeNodeId,
        context: authority.context,
        contentRevision: authority.contentRevision,
        document,
        parent: parentRevision,
        revisionBinding,
      };
    } catch {
      return null;
    }
  }

  private async activateBinding(
    validated: ValidatedFrameConnect,
    candidateClosed: () => boolean,
  ): Promise<void> {
    const previous = this.activeBindings.get(validated.slotKey);
    const retired = this.takeRetiredBinding(validated.slotKey);
    const previousForRotation = previous ?? retired?.binding;
    const sameDocumentReconnect = Boolean(
      previousForRotation && sameFrameDocument(previousForRotation, validated),
    );
    let host: ArtifactBridgeHostSessionBinding;

    if (
      previousForRotation &&
      contextsEqual(previousForRotation.context, validated.context)
    ) {
      if (previous) {
        this.activeBindings.delete(previous.slotKey);
        this.deactivateTransport(previous, true, 'replaced');
      }
      if (!sameDocumentReconnect) {
        this.releaseRevisionBinding(previousForRotation);
      }
      try {
        host = await this.options.artifactBridge.openHostSession(
          validated.context,
          previousForRotation.host.documentSlotId,
        );
      } catch (error) {
        this.releaseRevisionBinding(previousForRotation);
        await this.closeBackendBinding(previousForRotation);
        throw error;
      }
    } else {
      if (previous) {
        this.activeBindings.delete(previous.slotKey);
        this.deactivateTransport(previous, true, 'replaced');
        this.releaseRevisionBinding(previous);
        await this.closeBackendBinding(previous);
      }
      if (retired) {
        this.releaseRevisionBinding(retired.binding);
        await this.closeBackendBinding(retired.binding);
      }
      host = await this.options.artifactBridge.openHostSession(
        validated.context,
      );
    }

    // This asset hash is the identity snapshot captured by openHostSession,
    // not a second resolver read. Do not expose the port/session binding unless
    // the bytes named by the loaded document URL are that exact snapshot.
    if (host.assetHash !== validated.contentRevision) {
      if (previousForRotation) {
        this.releaseRevisionBinding(previousForRotation);
      }
      await this.closeRawBackendBinding(validated.context, host);
      closePorts([validated.port]);
      this.options.logger.warn(
        '[ArtifactBridgeFrameBroker] Rejected stale app content revision',
      );
      return;
    }

    if (
      candidateClosed() ||
      this.disposed ||
      !this.isCurrentDocument(validated)
    ) {
      if (previousForRotation) {
        this.releaseRevisionBinding(previousForRotation);
      }
      await this.closeRawBackendBinding(validated.context, host);
      closePorts([validated.port]);
      return;
    }

    const revisionDocument = revisionDocumentBinding(validated, host);
    if (!revisionDocument) {
      if (previousForRotation) {
        this.releaseRevisionBinding(previousForRotation);
      }
      await this.closeRawBackendBinding(validated.context, host);
      closePorts([validated.port]);
      this.options.logger.warn(
        '[ArtifactBridgeFrameBroker] Rejected unsupported revision binding',
      );
      return;
    }
    try {
      if (sameDocumentReconnect && previousForRotation) {
        validated.revisionBinding.rotateTrustedDocument(
          revisionDocument,
          previousForRotation.revisionDocumentToken,
        );
      } else {
        validated.revisionBinding.bindDocument(revisionDocument);
      }
    } catch (error) {
      if (previousForRotation) {
        this.releaseRevisionBinding(previousForRotation);
      }
      await this.closeRawBackendBinding(validated.context, host);
      closePorts([validated.port]);
      this.options.logger.warn(
        '[ArtifactBridgeFrameBroker] Rejected missing or stale document bind',
        { error },
      );
      return;
    }

    const binding: ActiveFrameBinding = {
      ...validated,
      host,
      revisionDocumentToken: revisionDocument.documentToken,
      state: 'active',
      onMessage: () => undefined,
      onClose: () => undefined,
    };
    binding.onMessage = (event) => {
      this.track(this.handlePortMessage(binding, event));
    };
    binding.onClose = () => {
      this.track(
        this.enqueueSlot(binding.slotKey, async () => {
          await this.retireIfActive(binding, false);
        }),
      );
    };

    this.activeBindings.set(binding.slotKey, binding);
    binding.port.on('message', binding.onMessage);
    binding.port.on('close', binding.onClose);

    try {
      binding.port.start();
      binding.port.postMessage(
        artifactBridgeConnectSchema.parse({
          __clodexArtifactBridge: 2,
          type: 'connect',
          sessionId: binding.host.sessionId,
          navigationEpoch: binding.host.navigationEpoch,
        }),
      );
    } catch (error) {
      this.options.logger.warn(
        '[ArtifactBridgeFrameBroker] Failed to establish frame port',
        { error },
      );
      await this.revokeIfActive(binding, true);
    }
  }

  private async handlePortMessage(
    binding: ActiveFrameBinding,
    event: Electron.MessageEvent,
  ): Promise<void> {
    if (!this.isActiveBinding(binding)) return;
    if (!this.isCurrentDocument(binding)) {
      await this.enqueueSlot(binding.slotKey, async () => {
        await this.retireIfActive(binding, true);
      });
      return;
    }
    if (event.ports.length !== 0) {
      closePorts(event.ports);
      await this.enqueueSlot(binding.slotKey, async () => {
        await this.revokeIfActive(binding, true);
      });
      return;
    }

    const envelope = artifactBridgeEnvelopeSchema.safeParse(event.data);
    if (
      !envelope.success ||
      envelope.data.sessionId !== binding.host.sessionId ||
      envelope.data.navigationEpoch !== binding.host.navigationEpoch
    ) {
      await this.enqueueSlot(binding.slotKey, async () => {
        await this.revokeIfActive(binding, true);
      });
      return;
    }

    let response: unknown;
    try {
      const result = await this.options.artifactBridge.invokeHostSession(
        binding.context,
        envelope.data.request,
        binding.host.sessionId,
        binding.host.navigationEpoch,
      );
      response = artifactBridgeResponseSchema.parse({
        __clodexArtifactBridge: 2,
        type: 'response',
        sessionId: binding.host.sessionId,
        navigationEpoch: binding.host.navigationEpoch,
        id: envelope.data.request.id,
        ok: true,
        result,
      });
    } catch (error) {
      response = artifactBridgeResponseSchema.parse({
        __clodexArtifactBridge: 2,
        type: 'response',
        sessionId: binding.host.sessionId,
        navigationEpoch: binding.host.navigationEpoch,
        id: envelope.data.request.id,
        ok: false,
        error: errorMessage(error),
      });
    }

    if (!this.isActiveBinding(binding)) return;
    if (!this.isCurrentDocument(binding)) {
      await this.enqueueSlot(binding.slotKey, async () => {
        await this.retireIfActive(binding, true);
      });
      return;
    }
    try {
      binding.port.postMessage(response);
    } catch (error) {
      this.options.logger.warn(
        '[ArtifactBridgeFrameBroker] Failed to deliver frame response',
        { error },
      );
      await this.enqueueSlot(binding.slotKey, async () => {
        await this.revokeIfActive(binding, true);
      });
    }
  }

  private isActiveBinding(binding: ActiveFrameBinding): boolean {
    return (
      !this.disposed &&
      binding.state === 'active' &&
      this.activeBindings.get(binding.slotKey) === binding
    );
  }

  private isCurrentDocument(binding: ValidatedFrameConnect): boolean {
    try {
      if (binding.sender.isDestroyed()) return false;
      const mainFrame = binding.sender.mainFrame;
      const mainRevision = captureFrameRevision(mainFrame);
      if (!mainRevision || !revisionsEqual(mainRevision, binding.parent)) {
        return false;
      }
      const currentChild = mainFrame.frames.find(
        (frame) => frame.frameTreeNodeId === binding.frameTreeNodeId,
      );
      const childRevision = currentChild
        ? captureFrameRevision(currentChild)
        : null;
      return Boolean(
        currentChild &&
          childRevision &&
          revisionsEqual(childRevision, binding.document) &&
          currentChild.parent &&
          framesReferToSameDocument(currentChild.parent, mainFrame),
      );
    } catch {
      return false;
    }
  }

  private deactivateTransport(
    binding: ActiveFrameBinding,
    closePort: boolean,
    state: 'replaced' | 'retired' | 'revoked',
  ): void {
    binding.state = state;
    binding.port.off('message', binding.onMessage);
    binding.port.off('close', binding.onClose);
    if (closePort) closePorts([binding.port]);
  }

  private async revokeIfActive(
    binding: ActiveFrameBinding,
    closePort: boolean,
  ): Promise<void> {
    if (this.activeBindings.get(binding.slotKey) !== binding) return;
    this.activeBindings.delete(binding.slotKey);
    this.deactivateTransport(binding, closePort, 'revoked');
    this.releaseRevisionBinding(binding);
    await this.closeBackendBinding(binding);
  }

  private async retireIfActive(
    binding: ActiveFrameBinding,
    closePort: boolean,
  ): Promise<void> {
    if (this.activeBindings.get(binding.slotKey) !== binding) return;
    this.activeBindings.delete(binding.slotKey);
    this.deactivateTransport(binding, closePort, 'retired');

    try {
      await this.options.artifactBridge.suspendHostSession(
        binding.context,
        binding.host.documentSlotId,
        binding.host.sessionId,
        binding.host.navigationEpoch,
      );
    } catch (error) {
      binding.state = 'revoked';
      this.releaseRevisionBinding(binding);
      await this.closeBackendBinding(binding);
      this.options.logger.debug(
        '[ArtifactBridgeFrameBroker] Host session could not be suspended',
        { error },
      );
      return;
    }

    const existing = this.takeRetiredBinding(binding.slotKey);
    if (existing) {
      this.releaseRevisionBinding(existing.binding);
      this.track(this.closeBackendBinding(existing.binding));
    }

    const retired: RetiredFrameBinding = {
      binding,
      timer: setTimeout(() => {
        this.track(
          this.enqueueSlot(binding.slotKey, async () => {
            if (this.retiredBindings.get(binding.slotKey) !== retired) return;
            this.retiredBindings.delete(binding.slotKey);
            this.releaseRevisionBinding(binding);
            await this.closeBackendBinding(binding);
          }),
        );
      }, this.reconnectGraceMs),
    };
    this.retiredBindings.set(binding.slotKey, retired);
  }

  private takeRetiredBinding(slotKey: string): RetiredFrameBinding | undefined {
    const retired = this.retiredBindings.get(slotKey);
    if (!retired) return undefined;
    this.retiredBindings.delete(slotKey);
    clearTimeout(retired.timer);
    return retired;
  }

  private async closeBackendBinding(
    binding: ActiveFrameBinding,
  ): Promise<void> {
    await this.closeRawBackendBinding(binding.context, binding.host);
  }

  private async closeRawBackendBinding(
    context: ArtifactBridgeContext,
    host: ArtifactBridgeHostSessionBinding,
  ): Promise<void> {
    try {
      await this.options.artifactBridge.closeHostSession(
        context,
        host.documentSlotId,
        host.sessionId,
        host.navigationEpoch,
      );
    } catch (error) {
      this.options.logger.debug(
        '[ArtifactBridgeFrameBroker] Host session was already inactive',
        { error },
      );
    }
  }

  private releaseRevisionBinding(binding: ActiveFrameBinding): void {
    try {
      binding.revisionBinding.unbindDocument(
        frameAddressOf(binding),
        binding.revisionDocumentToken,
      );
    } catch (error) {
      this.options.logger.debug(
        '[ArtifactBridgeFrameBroker] Document revision bind was already inactive',
        { error },
      );
    }
  }

  private ensureRevisionBindingLifecycle(
    revisionBinding: ArtifactBridgeRevisionBinding,
  ): void {
    if (this.revisionBindingDisposers.has(revisionBinding)) return;
    const dispose = revisionBinding.onNavigationStart((address) => {
      this.handleNavigationStart(address);
    });
    this.revisionBindingDisposers.set(revisionBinding, dispose);
  }

  private ensureSenderLifecycle(
    sender: WebContents,
    revisionBinding: ArtifactBridgeRevisionBinding,
  ): void {
    const existing = this.senderLifecycles.get(sender.id);
    if (existing?.sender === sender) return;
    if (existing) {
      existing.sender.off('destroyed', existing.onDestroyed);
      existing.sender.off('will-frame-navigate', existing.onWillFrameNavigate);
    }
    const onWillFrameNavigate = (
      details: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>,
    ) => {
      const frame = details.frame;
      if (!frame) return;
      try {
        const address = {
          webContentsId: sender.id,
          frameTreeNodeId: frame.frameTreeNodeId,
          processId: frame.processId,
          frameToken: frame.frameToken,
        } satisfies IsolatedAppFrameAddress;
        revisionBinding.clearFrame(address);
        this.handleNavigationStart(address);
      } catch (error) {
        this.options.logger.debug(
          '[ArtifactBridgeFrameBroker] Navigation revision bind was already inactive',
          { error },
        );
      }
    };
    const onDestroyed = () => {
      this.senderLifecycles.delete(sender.id);
      try {
        revisionBinding.clearWebContents(sender.id);
      } catch (error) {
        this.options.logger.debug(
          '[ArtifactBridgeFrameBroker] WebContents revision binds were already inactive',
          { error },
        );
      }
      this.revokeWebContents(sender.id);
    };
    sender.on('will-frame-navigate', onWillFrameNavigate);
    sender.once('destroyed', onDestroyed);
    this.senderLifecycles.set(sender.id, {
      sender,
      onDestroyed,
      onWillFrameNavigate,
    });
  }

  private handleNavigationStart(address: IsolatedAppFrameAddress): void {
    if (this.disposed) return;
    const slotKey = `${address.webContentsId}:${address.frameTreeNodeId}`;
    const active = this.activeBindings.get(slotKey);
    if (active && this.bindingMatchesAddress(active, address)) {
      this.activeBindings.delete(slotKey);
      this.deactivateTransport(active, true, 'revoked');
      this.track(
        this.enqueueSlot(slotKey, async () => {
          await this.closeBackendBinding(active);
        }),
      );
    }
    const retired = this.retiredBindings.get(slotKey);
    if (retired && this.bindingMatchesAddress(retired.binding, address)) {
      this.retiredBindings.delete(slotKey);
      clearTimeout(retired.timer);
      this.track(
        this.enqueueSlot(slotKey, async () => {
          await this.closeBackendBinding(retired.binding);
        }),
      );
    }
  }

  private revokeWebContents(webContentsId: number): void {
    for (const binding of [...this.activeBindings.values()]) {
      if (binding.sender.id !== webContentsId) continue;
      this.activeBindings.delete(binding.slotKey);
      this.deactivateTransport(binding, true, 'revoked');
      this.track(
        this.enqueueSlot(binding.slotKey, async () => {
          await this.closeBackendBinding(binding);
        }),
      );
    }
    for (const [slotKey, retired] of [...this.retiredBindings]) {
      if (retired.binding.sender.id !== webContentsId) continue;
      this.retiredBindings.delete(slotKey);
      clearTimeout(retired.timer);
      this.track(
        this.enqueueSlot(slotKey, async () => {
          await this.closeBackendBinding(retired.binding);
        }),
      );
    }
  }

  private bindingMatchesAddress(
    binding: ActiveFrameBinding,
    address: IsolatedAppFrameAddress,
  ): boolean {
    const current = frameAddressOf(binding);
    return (
      current.webContentsId === address.webContentsId &&
      current.frameTreeNodeId === address.frameTreeNodeId &&
      current.processId === address.processId &&
      current.frameToken === address.frameToken
    );
  }

  private async enqueueSlot(
    slotKey: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.slotQueues.get(slotKey) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(operation);
    const settled = queued.then(
      () => undefined,
      () => undefined,
    );
    this.slotQueues.set(slotKey, settled);
    try {
      await queued;
    } finally {
      if (this.slotQueues.get(slotKey) === settled) {
        this.slotQueues.delete(slotKey);
      }
    }
  }

  private track(task: Promise<void>): void {
    this.pendingTasks.add(task);
    void task
      .catch((error) => {
        this.options.logger.error(
          '[ArtifactBridgeFrameBroker] Asynchronous broker task failed',
          { error },
        );
      })
      .finally(() => {
        this.pendingTasks.delete(task);
      });
  }
}
