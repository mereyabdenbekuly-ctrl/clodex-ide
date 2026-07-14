import { EventEmitter } from 'node:events';
import type {
  IpcMain,
  IpcMainEvent,
  MessagePortMain,
  WebContents,
  WebFrameMain,
} from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ARTIFACT_BRIDGE_FRAME_CONNECT_CHANNEL,
  type ArtifactBridgeContext,
} from '@shared/artifact-bridge';
import {
  buildIsolatedAppOrigin,
  buildIsolatedAppUrl,
  type AppUrlIdentity,
} from '@shared/isolated-app-origin';
import { CLODEX_APP_REVISION_QUERY } from '../app-protocol-security';
import {
  ArtifactBridgeFrameBroker,
  type ArtifactBridgeFrameBrokerOptions,
} from './frame-broker';

const ASSET_HASH_V1 = 'a'.repeat(64);
const ASSET_HASH_V2 = 'b'.repeat(64);

const HELLO = {
  __clodexArtifactBridge: 2,
  type: 'hello',
  contentRevision: ASSET_HASH_V1,
} as const;

function buildRevisionedAppUrl(
  identity: AppUrlIdentity,
  assetHash = ASSET_HASH_V1,
): string {
  const url = new URL(buildIsolatedAppUrl(identity, ['index.html']));
  url.searchParams.set(CLODEX_APP_REVISION_QUERY, assetHash);
  return url.toString();
}

function withQueryValue(urlValue: string, key: string, value: string): string {
  const url = new URL(urlValue);
  url.searchParams.set(key, value);
  return url.toString();
}

const DOCUMENT_SLOT_IDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
] as const;

class FakeMessagePort extends EventEmitter {
  public readonly posted: unknown[] = [];
  public started = false;
  public closed = false;

  public postMessage(message: unknown): void {
    if (this.closed) throw new Error('port is closed');
    this.posted.push(message);
  }

  public start(): void {
    if (this.closed) throw new Error('port is closed');
    this.started = true;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  public receive(data: unknown, ports: readonly FakeMessagePort[] = []): void {
    this.emit('message', {
      data,
      ports: ports.map((port) => port.asElectronPort()),
    });
  }

  public asElectronPort(): MessagePortMain {
    return this as unknown as MessagePortMain;
  }
}

class FakeFrame {
  public detached = false;
  public destroyed = false;
  public parent: FakeFrame | null = null;
  public top: FakeFrame | null = null;
  public frames: FakeFrame[] = [];

  public constructor(
    public readonly frameTreeNodeId: number,
    public processId: number,
    public routingId: number,
    public frameToken: string,
    public url: string,
    public origin: string,
  ) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public asElectronFrame(): WebFrameMain {
    return this as unknown as WebFrameMain;
  }
}

class FakeWebContents extends EventEmitter {
  public destroyed = false;

  public constructor(
    public readonly id: number,
    public mainFrame: FakeFrame,
  ) {
    super();
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public asElectronWebContents(): WebContents {
    return this as unknown as WebContents;
  }
}

interface FrameFixture {
  parent: FakeFrame;
  child: FakeFrame;
  sender: FakeWebContents;
  port: FakeMessagePort;
  event: IpcMainEvent;
  identity: AppUrlIdentity;
}

function createFrameFixture({
  senderId = 7,
  frameTreeNodeId = 2,
  namespace = 'agents',
  entityId = 'agent-1',
  agentId = 'agent-1',
  appId = 'dashboard',
  pluginId,
  cacheBust,
  title,
  assetHash = ASSET_HASH_V1,
}: {
  senderId?: number;
  frameTreeNodeId?: number;
  namespace?: AppUrlIdentity['namespace'];
  entityId?: string;
  agentId?: string;
  appId?: string;
  pluginId?: string;
  cacheBust?: string;
  title?: string;
  assetHash?: string;
} = {}): FrameFixture {
  const identity = { namespace, entityId, appId } satisfies AppUrlIdentity;
  const query = new URLSearchParams({ agentId });
  if (pluginId) query.set('pluginId', pluginId);
  if (cacheBust) query.set('t', cacheBust);
  if (title) query.set('title', title);
  const parent = new FakeFrame(
    1,
    10,
    1,
    `parent-token-${senderId}`,
    `clodex://internal/preview/${encodeURIComponent(appId)}?${query.toString()}`,
    'clodex://internal',
  );
  parent.top = parent;
  const child = new FakeFrame(
    frameTreeNodeId,
    20,
    2,
    `child-token-${senderId}-${frameTreeNodeId}`,
    buildRevisionedAppUrl(identity, assetHash),
    buildIsolatedAppOrigin(identity),
  );
  child.parent = parent;
  child.top = parent;
  parent.frames = [child];

  const sender = new FakeWebContents(senderId, parent);
  const port = new FakeMessagePort();
  const event = {
    frameId: child.routingId,
    ports: [port.asElectronPort()],
    processId: child.processId,
    reply: vi.fn(),
    sender: sender.asElectronWebContents(),
    senderFrame: child.asElectronFrame(),
    type: 'frame',
  } as unknown as IpcMainEvent;

  return { parent, child, sender, port, event, identity };
}

function createHostService(initialAssetHash = ASSET_HASH_V1) {
  const slots = new Map<
    string,
    {
      context: ArtifactBridgeContext;
      epoch: number;
      sessionId: string;
      active: boolean;
    }
  >();
  let nextSlotIndex = 0;
  let nextSession = 1;
  let assetHash = initialAssetHash;

  const openHostSession = vi.fn(
    async (context: ArtifactBridgeContext, existingSlotId?: string) => {
      const documentSlotId =
        existingSlotId ?? DOCUMENT_SLOT_IDS[nextSlotIndex++];
      if (!documentSlotId) throw new Error('test document slot pool exhausted');
      const previous = slots.get(documentSlotId);
      if (existingSlotId && !previous) {
        throw new Error('slot is inactive');
      }
      const navigationEpoch = (previous?.epoch ?? 0) + 1;
      const sessionId = `20000000-0000-4000-8000-${String(nextSession++).padStart(12, '0')}`;
      slots.set(documentSlotId, {
        context,
        epoch: navigationEpoch,
        sessionId,
        active: true,
      });
      return {
        documentSlotId,
        sessionId,
        navigationEpoch,
        openedAt: '2026-07-14T00:00:00.000Z',
        assetHash,
      };
    },
  );
  const invokeHostSession = vi.fn(async () => ({ allowed: true }));
  const suspendHostSession = vi.fn(
    async (
      _context: ArtifactBridgeContext,
      documentSlotId: string,
      sessionId: string,
      navigationEpoch: number,
    ) => {
      const active = slots.get(documentSlotId);
      if (
        !active?.active ||
        active.sessionId !== sessionId ||
        active.epoch !== navigationEpoch
      ) {
        throw new Error('binding is inactive');
      }
      active.active = false;
    },
  );
  const closeHostSession = vi.fn(
    async (
      _context: ArtifactBridgeContext,
      documentSlotId: string,
      sessionId: string,
      navigationEpoch: number,
    ) => {
      const active = slots.get(documentSlotId);
      if (
        !active ||
        active.sessionId !== sessionId ||
        active.epoch !== navigationEpoch
      ) {
        throw new Error('binding is inactive');
      }
      slots.delete(documentSlotId);
    },
  );

  return {
    api: {
      openHostSession,
      invokeHostSession,
      suspendHostSession,
      closeHostSession,
    } as ArtifactBridgeFrameBrokerOptions['artifactBridge'],
    openHostSession,
    invokeHostSession,
    suspendHostSession,
    closeHostSession,
    setAssetHash: (value: string) => {
      assetHash = value;
    },
  };
}

function createRevisionBindingService() {
  type FrameAddress = {
    webContentsId: number;
    frameTreeNodeId: number;
    processId: number;
    frameToken: string;
  };
  const navigationHooks = new Set<(address: FrameAddress) => void>();
  const bindDocument = vi.fn((_input: unknown) => undefined);
  const rotateTrustedDocument = vi.fn(
    (_input: unknown, _previousDocumentToken: string) => undefined,
  );
  const unbindDocument = vi.fn(
    (_address: FrameAddress, _documentToken: string) => true,
  );
  const clearFrame = vi.fn((_address: FrameAddress) => true);
  const clearWebContents = vi.fn((_webContentsId: number) => 0);
  const onNavigationStart = vi.fn((hook: (address: FrameAddress) => void) => {
    navigationHooks.add(hook);
    return () => {
      navigationHooks.delete(hook);
    };
  });
  return {
    api: {
      bindDocument,
      rotateTrustedDocument,
      unbindDocument,
      clearFrame,
      clearWebContents,
      onNavigationStart,
    },
    bindDocument,
    rotateTrustedDocument,
    unbindDocument,
    clearFrame,
    clearWebContents,
    triggerNavigation: (address: FrameAddress) => {
      for (const hook of navigationHooks) hook(address);
    },
  };
}

function createBroker(
  host = createHostService(),
  reconnectGraceMs = 0,
  revisionBinding = createRevisionBindingService(),
) {
  const ipc = new EventEmitter();
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const broker = new ArtifactBridgeFrameBroker({
    ipc: ipc as unknown as Pick<IpcMain, 'on' | 'off'>,
    artifactBridge: host.api,
    logger: logger as unknown as ArtifactBridgeFrameBrokerOptions['logger'],
    reconnectGraceMs,
    revisionBindingFor: () => revisionBinding.api,
  });
  return { broker, host, ipc, logger, revisionBinding };
}

function requestFor(connect: Record<string, unknown>, id = 'request-1') {
  return {
    __clodexArtifactBridge: 2,
    type: 'request',
    sessionId: connect.sessionId,
    navigationEpoch: connect.navigationEpoch,
    request: {
      id,
      method: 'getCapabilities',
      params: {},
    },
  };
}

const brokers: ArtifactBridgeFrameBroker[] = [];

afterEach(async () => {
  await Promise.all(brokers.splice(0).map(async (broker) => broker.teardown()));
});

describe('ArtifactBridgeFrameBroker', () => {
  it.each([
    {
      label: 'wrong parent route',
      mutate: (fixture: FrameFixture) => {
        fixture.parent.url = 'clodex://internal/history';
      },
    },
    {
      label: 'wrong child origin',
      mutate: (fixture: FrameFixture) => {
        fixture.child.origin = 'app://agents-wrong';
      },
    },
    {
      label: 'child identity does not match the parent path',
      mutate: (fixture: FrameFixture) => {
        const other = {
          namespace: 'agents',
          entityId: 'agent-1',
          appId: 'other-app',
        } as const satisfies AppUrlIdentity;
        fixture.child.url = buildRevisionedAppUrl(other);
        fixture.child.origin = buildIsolatedAppOrigin(other);
      },
    },
    {
      label: 'legacy app origin',
      mutate: (fixture: FrameFixture) => {
        fixture.child.url = 'app://agents/agent-1/dashboard/index.html';
        fixture.child.origin = 'app://agents';
      },
    },
    {
      label: 'nested rather than direct child frame',
      mutate: (fixture: FrameFixture) => {
        const wrapper = new FakeFrame(
          9,
          10,
          9,
          'wrapper-token',
          'clodex://internal/wrapper',
          'clodex://internal',
        );
        wrapper.parent = fixture.parent;
        wrapper.top = fixture.parent;
        wrapper.frames = [fixture.child];
        fixture.child.parent = wrapper;
        fixture.parent.frames = [wrapper];
      },
    },
    {
      label: 'duplicate preview title metadata',
      mutate: (fixture: FrameFixture) => {
        const url = new URL(fixture.parent.url);
        url.searchParams.set('title', 'first');
        url.searchParams.append('title', 'second');
        fixture.parent.url = url.toString();
      },
    },
    {
      label: 'oversized preview title metadata',
      mutate: (fixture: FrameFixture) => {
        const url = new URL(fixture.parent.url);
        url.searchParams.set('title', 'x'.repeat(1_025));
        fixture.parent.url = url.toString();
      },
    },
    {
      label: 'unknown preview query metadata',
      mutate: (fixture: FrameFixture) => {
        const url = new URL(fixture.parent.url);
        url.searchParams.set('unexpected', 'value');
        fixture.parent.url = url.toString();
      },
    },
  ])('rejects $label', async ({ mutate }) => {
    const fixture = createFrameFixture();
    mutate(fixture);
    const { broker, host } = createBroker();
    brokers.push(broker);

    await broker.handleFrameConnect(fixture.event, [HELLO]);

    expect(host.openHostSession).not.toHaveBeenCalled();
    expect(fixture.port.closed).toBe(true);
  });

  it.each([
    {
      label: 'missing content revision',
      mutate: (url: URL) => {
        url.searchParams.delete(CLODEX_APP_REVISION_QUERY);
      },
    },
    {
      label: 'duplicate content revision',
      mutate: (url: URL) => {
        url.searchParams.append(CLODEX_APP_REVISION_QUERY, ASSET_HASH_V1);
      },
    },
    {
      label: 'case-aliased content revision key',
      mutate: (url: URL) => {
        url.searchParams.delete(CLODEX_APP_REVISION_QUERY);
        url.searchParams.set('ClodexRev', ASSET_HASH_V1);
      },
    },
    {
      label: 'noncanonical uppercase content revision',
      mutate: (url: URL) => {
        url.searchParams.set(
          CLODEX_APP_REVISION_QUERY,
          ASSET_HASH_V1.toUpperCase(),
        );
      },
    },
    {
      label: 'percent-encoded content revision alias',
      mutate: (url: URL) => {
        url.search = `?${CLODEX_APP_REVISION_QUERY}=%61${'a'.repeat(63)}`;
      },
    },
  ])('rejects $label before opening a host session', async ({ mutate }) => {
    const fixture = createFrameFixture();
    const childUrl = new URL(fixture.child.url);
    mutate(childUrl);
    fixture.child.url = childUrl.toString();
    const { broker, host } = createBroker();
    brokers.push(broker);

    await broker.handleFrameConnect(fixture.event, [HELLO]);

    expect(host.openHostSession).not.toHaveBeenCalled();
    expect(fixture.port.started).toBe(false);
    expect(fixture.port.posted).toHaveLength(0);
    expect(fixture.port.closed).toBe(true);
  });

  it('rejects a same-document revision swap after trusted preload capture', async () => {
    const fixture = createFrameFixture();
    fixture.child.url = withQueryValue(
      fixture.child.url,
      CLODEX_APP_REVISION_QUERY,
      ASSET_HASH_V2,
    );
    const { broker, host } = createBroker(createHostService(ASSET_HASH_V2));
    brokers.push(broker);

    await broker.handleFrameConnect(fixture.event, [HELLO]);

    expect(host.openHostSession).not.toHaveBeenCalled();
    expect(fixture.port.started).toBe(false);
    expect(fixture.port.posted).toHaveLength(0);
    expect(fixture.port.closed).toBe(true);
  });

  it('allows only a content revision equal to the exact host-session asset hash', async () => {
    const fixture = createFrameFixture({ assetHash: ASSET_HASH_V1 });
    const host = createHostService(ASSET_HASH_V1);
    const { broker } = createBroker(host);
    brokers.push(broker);

    await broker.handleFrameConnect(fixture.event, [HELLO]);

    expect(host.openHostSession).toHaveBeenCalledOnce();
    expect(fixture.port.started).toBe(true);
    expect(fixture.port.posted[0]).toMatchObject({
      type: 'connect',
      navigationEpoch: 1,
    });
    expect(host.closeHostSession).not.toHaveBeenCalled();
  });

  it('upgrades the exact provisional frame revision before exposing the port', async () => {
    const fixture = createFrameFixture();
    const { broker, host, revisionBinding } = createBroker();
    brokers.push(broker);

    await broker.handleFrameConnect(fixture.event, [HELLO]);

    const hostBinding = await host.openHostSession.mock.results[0]?.value;
    expect(revisionBinding.bindDocument).toHaveBeenCalledWith({
      webContentsId: fixture.sender.id,
      frameTreeNodeId: fixture.child.frameTreeNodeId,
      processId: fixture.child.processId,
      frameToken: fixture.child.frameToken,
      documentToken: `${hostBinding?.documentSlotId}:${hostBinding?.sessionId}:${hostBinding?.navigationEpoch}`,
      origin: fixture.child.origin,
      agentId: 'agent-1',
      appId: 'dashboard',
      revision: ASSET_HASH_V1,
    });
    expect(fixture.port.started).toBe(true);
  });

  it('fails closed when the provisional document bind is missing or stale', async () => {
    const fixture = createFrameFixture();
    const revisionBinding = createRevisionBindingService();
    revisionBinding.bindDocument.mockImplementationOnce(() => {
      throw new Error('provisional expired');
    });
    const { broker, host } = createBroker(
      createHostService(),
      0,
      revisionBinding,
    );
    brokers.push(broker);

    await broker.handleFrameConnect(fixture.event, [HELLO]);

    expect(fixture.port.started).toBe(false);
    expect(fixture.port.closed).toBe(true);
    expect(host.closeHostSession).toHaveBeenCalledOnce();
  });

  it('revokes the old port synchronously at will-frame-navigate', async () => {
    const fixture = createFrameFixture();
    const { broker, host, revisionBinding } = createBroker();
    brokers.push(broker);
    await broker.handleFrameConnect(fixture.event, [HELLO]);
    const connect = fixture.port.posted[0] as Record<string, unknown>;

    fixture.sender.emit('will-frame-navigate', {
      frame: fixture.child.asElectronFrame(),
      initiator: fixture.child.asElectronFrame(),
      isMainFrame: false,
      isSameDocument: false,
      preventDefault: vi.fn(),
      url: buildRevisionedAppUrl(fixture.identity, ASSET_HASH_V2),
    });

    expect(revisionBinding.clearFrame).toHaveBeenCalledWith({
      webContentsId: fixture.sender.id,
      frameTreeNodeId: fixture.child.frameTreeNodeId,
      processId: fixture.child.processId,
      frameToken: fixture.child.frameToken,
    });
    expect(fixture.port.closed).toBe(true);
    fixture.port.receive(requestFor(connect, 'after-navigation'));
    expect(host.invokeHostSession).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(host.closeHostSession).toHaveBeenCalledOnce(),
    );
  });

  it('clears document binds and revokes the port when WebContents is destroyed', async () => {
    const fixture = createFrameFixture();
    const { broker, host, revisionBinding } = createBroker();
    brokers.push(broker);
    await broker.handleFrameConnect(fixture.event, [HELLO]);

    fixture.sender.destroyed = true;
    fixture.sender.emit('destroyed');

    expect(revisionBinding.clearWebContents).toHaveBeenCalledWith(
      fixture.sender.id,
    );
    expect(fixture.port.closed).toBe(true);
    await vi.waitFor(() =>
      expect(host.closeHostSession).toHaveBeenCalledOnce(),
    );
  });

  it('rotates only the exact trusted document token on same-document reconnect', async () => {
    const fixture = createFrameFixture();
    const host = createHostService();
    const { broker, revisionBinding } = createBroker(host, 1_000);
    brokers.push(broker);
    await broker.handleFrameConnect(fixture.event, [HELLO]);
    const firstHost = await host.openHostSession.mock.results[0]?.value;

    const replacementPort = new FakeMessagePort();
    const reconnectEvent = {
      ...fixture.event,
      ports: [replacementPort.asElectronPort()],
    } as unknown as IpcMainEvent;
    await broker.handleFrameConnect(reconnectEvent, [HELLO]);

    const secondHost = await host.openHostSession.mock.results[1]?.value;
    expect(revisionBinding.rotateTrustedDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        documentToken: `${secondHost?.documentSlotId}:${secondHost?.sessionId}:${secondHost?.navigationEpoch}`,
        revision: ASSET_HASH_V1,
      }),
      `${firstHost?.documentSlotId}:${firstHost?.sessionId}:${firstHost?.navigationEpoch}`,
    );
    expect(revisionBinding.bindDocument).toHaveBeenCalledTimes(1);
    expect(replacementPort.started).toBe(true);
  });

  it('closes a stale host binding before exposing session authority to the child', async () => {
    const fixture = createFrameFixture({ assetHash: ASSET_HASH_V1 });
    const host = createHostService(ASSET_HASH_V2);
    const { broker } = createBroker(host);
    brokers.push(broker);

    await broker.handleFrameConnect(fixture.event, [HELLO]);

    expect(host.openHostSession).toHaveBeenCalledOnce();
    const binding = await host.openHostSession.mock.results[0]?.value;
    expect(binding?.assetHash).toBe(ASSET_HASH_V2);
    expect(host.closeHostSession).toHaveBeenCalledWith(
      {
        kind: 'agent',
        agentId: 'agent-1',
        appId: 'dashboard',
      },
      binding?.documentSlotId,
      binding?.sessionId,
      binding?.navigationEpoch,
    );
    expect(fixture.port.started).toBe(false);
    expect(fixture.port.posted).toHaveLength(0);
    expect(fixture.port.closed).toBe(true);
  });

  it('requires one strict hello argument and exactly one transferred port', async () => {
    const fixture = createFrameFixture();
    const extraPort = new FakeMessagePort();
    const { broker, host } = createBroker();
    brokers.push(broker);

    const malformedHello = { ...HELLO, unexpected: true };
    await broker.handleFrameConnect(fixture.event, [malformedHello]);
    expect(fixture.port.closed).toBe(true);

    const second = createFrameFixture({ senderId: 8 });
    second.event.ports.push(extraPort.asElectronPort());
    await broker.handleFrameConnect(second.event, [HELLO]);

    expect(second.port.closed).toBe(true);
    expect(extraPort.closed).toBe(true);
    expect(host.openHostSession).not.toHaveBeenCalled();
  });

  it('registers the injected IPC listener and serves requests only on the frame port', async () => {
    const fixture = createFrameFixture();
    const { broker, host, ipc } = createBroker();
    brokers.push(broker);
    broker.start();

    ipc.emit(ARTIFACT_BRIDGE_FRAME_CONNECT_CHANNEL, fixture.event, HELLO);
    await vi.waitFor(() => expect(host.openHostSession).toHaveBeenCalledOnce());

    expect(fixture.port.started).toBe(true);
    expect(fixture.port.posted).toHaveLength(1);
    const connect = fixture.port.posted[0] as Record<string, unknown>;
    expect(connect).toMatchObject({
      __clodexArtifactBridge: 2,
      type: 'connect',
      navigationEpoch: 1,
    });
    expect(host.openHostSession).toHaveBeenCalledWith({
      kind: 'agent',
      agentId: 'agent-1',
      appId: 'dashboard',
    });

    fixture.port.receive(requestFor(connect));
    await vi.waitFor(() =>
      expect(host.invokeHostSession).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() => expect(fixture.port.posted).toHaveLength(2));
    expect(fixture.port.posted[1]).toMatchObject({
      __clodexArtifactBridge: 2,
      type: 'response',
      sessionId: connect.sessionId,
      navigationEpoch: connect.navigationEpoch,
      id: 'request-1',
      ok: true,
      result: { allowed: true },
    });
  });

  it('derives plugin ownership from the isolated child and exact parent query', async () => {
    const fixture = createFrameFixture({
      namespace: 'plugins',
      entityId: 'plugin-publisher',
      agentId: 'agent-1',
      pluginId: 'plugin-publisher',
      cacheBust: '1720915200000',
      title: Buffer.from('Plugin dashboard', 'utf8').toString('base64url'),
    });
    const { broker, host } = createBroker();
    brokers.push(broker);

    await broker.handleFrameConnect(fixture.event, [HELLO]);

    expect(host.openHostSession).toHaveBeenCalledWith({
      kind: 'agent',
      agentId: 'agent-1',
      appId: 'dashboard',
      pluginId: 'plugin-publisher',
    });
  });

  it('rejects a plugin preview when its owning agent ID is missing', async () => {
    const fixture = createFrameFixture({
      namespace: 'plugins',
      entityId: 'plugin-publisher',
      agentId: 'agent-1',
      pluginId: 'plugin-publisher',
      cacheBust: '1720915200000',
    });
    const parentUrl = new URL(fixture.parent.url);
    parentUrl.searchParams.delete('agentId');
    fixture.parent.url = parentUrl.toString();
    const { broker, host } = createBroker();
    brokers.push(broker);

    await broker.handleFrameConnect(fixture.event, [HELLO]);

    expect(host.openHostSession).not.toHaveBeenCalled();
    expect(fixture.port.closed).toBe(true);
  });

  it('drops an asynchronous response when the frame revision changes', async () => {
    const fixture = createFrameFixture();
    const host = createHostService();
    let resolveInvocation!: (value: { allowed: boolean }) => void;
    host.invokeHostSession.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveInvocation = resolve;
        }),
    );
    const { broker } = createBroker(host);
    brokers.push(broker);
    await broker.handleFrameConnect(fixture.event, [HELLO]);
    const connect = fixture.port.posted[0] as Record<string, unknown>;

    fixture.port.receive(requestFor(connect));
    await vi.waitFor(() =>
      expect(host.invokeHostSession).toHaveBeenCalledOnce(),
    );

    const replacement = new FakeFrame(
      fixture.child.frameTreeNodeId,
      fixture.child.processId,
      fixture.child.routingId + 1,
      'replacement-token',
      fixture.child.url,
      fixture.child.origin,
    );
    replacement.parent = fixture.parent;
    replacement.top = fixture.parent;
    fixture.parent.frames = [replacement];
    resolveInvocation({ allowed: false });

    await vi.waitFor(() =>
      expect(host.closeHostSession).toHaveBeenCalledOnce(),
    );
    expect(fixture.port.posted).toHaveLength(1);
    expect(fixture.port.closed).toBe(true);
  });

  it('closes a candidate port when backend session opening fails', async () => {
    const fixture = createFrameFixture();
    const host = createHostService();
    host.openHostSession.mockRejectedValueOnce(new Error('feature disabled'));
    const { broker } = createBroker(host);
    brokers.push(broker);

    await expect(
      broker.handleFrameConnect(fixture.event, [HELLO]),
    ).rejects.toThrow('feature disabled');

    expect(fixture.port.closed).toBe(true);
    expect(fixture.port.posted).toHaveLength(0);
  });

  it('suspends effect authority immediately and closes after reconnect grace', async () => {
    const fixture = createFrameFixture();
    const { broker, host } = createBroker();
    brokers.push(broker);
    await broker.handleFrameConnect(fixture.event, [HELLO]);
    const connect = fixture.port.posted[0] as Record<string, unknown>;
    const opened = host.openHostSession.mock.results[0]?.value;
    const binding = await opened;

    fixture.port.close();

    await vi.waitFor(() =>
      expect(host.suspendHostSession).toHaveBeenCalledOnce(),
    );
    expect(host.suspendHostSession).toHaveBeenCalledWith(
      {
        kind: 'agent',
        agentId: 'agent-1',
        appId: 'dashboard',
      },
      binding?.documentSlotId,
      connect.sessionId,
      connect.navigationEpoch,
    );
    await vi.waitFor(() =>
      expect(host.closeHostSession).toHaveBeenCalledOnce(),
    );
    expect(host.closeHostSession).toHaveBeenCalledWith(
      {
        kind: 'agent',
        agentId: 'agent-1',
        appId: 'dashboard',
      },
      binding?.documentSlotId,
      connect.sessionId,
      connect.navigationEpoch,
    );
  });

  it('keeps concurrent same-context documents in independent backend slots', async () => {
    const first = createFrameFixture({ senderId: 7 });
    const second = createFrameFixture({ senderId: 8 });
    const { broker, host } = createBroker();
    brokers.push(broker);

    await Promise.all([
      broker.handleFrameConnect(first.event, [HELLO]),
      broker.handleFrameConnect(second.event, [HELLO]),
    ]);

    expect(host.openHostSession).toHaveBeenCalledTimes(2);
    expect(host.openHostSession.mock.calls[0]?.[1]).toBeUndefined();
    expect(host.openHostSession.mock.calls[1]?.[1]).toBeUndefined();
    const firstBinding = await host.openHostSession.mock.results[0]?.value;
    const secondBinding = await host.openHostSession.mock.results[1]?.value;
    expect(firstBinding?.documentSlotId).not.toBe(
      secondBinding?.documentSlotId,
    );
    expect(first.port.posted[0]).toMatchObject({ navigationEpoch: 1 });
    expect(second.port.posted[0]).toMatchObject({ navigationEpoch: 1 });
  });

  it('retains and rotates the slot when reload closes the old port before reconnect', async () => {
    const fixture = createFrameFixture();
    const host = createHostService();
    const { broker } = createBroker(host, 1_000);
    brokers.push(broker);
    await broker.handleFrameConnect(fixture.event, [HELLO]);
    const firstBinding = await host.openHostSession.mock.results[0]?.value;

    const replacement = new FakeFrame(
      fixture.child.frameTreeNodeId,
      fixture.child.processId,
      fixture.child.routingId + 1,
      'reloaded-document-token',
      withQueryValue(fixture.child.url, '_t', '2'),
      fixture.child.origin,
    );
    replacement.parent = fixture.parent;
    replacement.top = fixture.parent;
    fixture.parent.frames = [replacement];
    const replacementPort = new FakeMessagePort();
    const replacementEvent = {
      ...fixture.event,
      frameId: replacement.routingId,
      ports: [replacementPort.asElectronPort()],
      processId: replacement.processId,
      senderFrame: replacement.asElectronFrame(),
    } as unknown as IpcMainEvent;

    fixture.port.close();
    await broker.handleFrameConnect(replacementEvent, [HELLO]);

    expect(host.suspendHostSession).toHaveBeenCalledOnce();
    expect(host.openHostSession).toHaveBeenCalledTimes(2);
    expect(host.openHostSession.mock.calls[1]?.[1]).toBe(
      firstBinding?.documentSlotId,
    );
    expect(fixture.port.closed).toBe(true);
    expect(host.closeHostSession).not.toHaveBeenCalled();
    expect(replacementPort.posted[0]).toMatchObject({
      type: 'connect',
      navigationEpoch: 2,
    });
  });

  it('rotates from v1 to an exact v2 document after immediate suspension', async () => {
    const fixture = createFrameFixture({ assetHash: ASSET_HASH_V1 });
    const host = createHostService(ASSET_HASH_V1);
    const { broker } = createBroker(host, 1_000);
    brokers.push(broker);
    await broker.handleFrameConnect(fixture.event, [HELLO]);
    const firstBinding = await host.openHostSession.mock.results[0]?.value;

    host.setAssetHash(ASSET_HASH_V2);
    const replacementUrl = withQueryValue(
      fixture.child.url,
      CLODEX_APP_REVISION_QUERY,
      ASSET_HASH_V2,
    );
    const replacement = new FakeFrame(
      fixture.child.frameTreeNodeId,
      fixture.child.processId,
      fixture.child.routingId + 1,
      'v2-document-token',
      replacementUrl,
      fixture.child.origin,
    );
    replacement.parent = fixture.parent;
    replacement.top = fixture.parent;
    fixture.parent.frames = [replacement];
    const replacementPort = new FakeMessagePort();
    const replacementEvent = {
      ...fixture.event,
      frameId: replacement.routingId,
      ports: [replacementPort.asElectronPort()],
      processId: replacement.processId,
      senderFrame: replacement.asElectronFrame(),
    } as unknown as IpcMainEvent;

    fixture.port.close();
    await broker.handleFrameConnect(replacementEvent, [
      { ...HELLO, contentRevision: ASSET_HASH_V2 },
    ]);

    expect(host.suspendHostSession).toHaveBeenCalledOnce();
    expect(host.openHostSession).toHaveBeenCalledTimes(2);
    expect(host.openHostSession.mock.calls[1]?.[1]).toBe(
      firstBinding?.documentSlotId,
    );
    expect(replacementPort.posted[0]).toMatchObject({
      type: 'connect',
      navigationEpoch: 2,
    });
    expect(host.closeHostSession).not.toHaveBeenCalled();
  });

  it('does not let a v1 reload inherit a v2 host binding during slot rotation', async () => {
    const fixture = createFrameFixture({ assetHash: ASSET_HASH_V1 });
    const host = createHostService(ASSET_HASH_V1);
    const { broker } = createBroker(host, 1_000);
    brokers.push(broker);
    await broker.handleFrameConnect(fixture.event, [HELLO]);
    const firstBinding = await host.openHostSession.mock.results[0]?.value;
    expect(fixture.port.posted[0]).toMatchObject({ navigationEpoch: 1 });

    host.setAssetHash(ASSET_HASH_V2);
    const replacement = new FakeFrame(
      fixture.child.frameTreeNodeId,
      fixture.child.processId,
      fixture.child.routingId + 1,
      'stale-v1-reload-token',
      withQueryValue(fixture.child.url, '_t', 'stale-v1'),
      fixture.child.origin,
    );
    replacement.parent = fixture.parent;
    replacement.top = fixture.parent;
    fixture.parent.frames = [replacement];
    const replacementPort = new FakeMessagePort();
    const replacementEvent = {
      ...fixture.event,
      frameId: replacement.routingId,
      ports: [replacementPort.asElectronPort()],
      processId: replacement.processId,
      senderFrame: replacement.asElectronFrame(),
    } as unknown as IpcMainEvent;

    fixture.port.close();
    await broker.handleFrameConnect(replacementEvent, [HELLO]);

    expect(host.openHostSession).toHaveBeenCalledTimes(2);
    expect(host.openHostSession.mock.calls[1]?.[1]).toBe(
      firstBinding?.documentSlotId,
    );
    const rotated = await host.openHostSession.mock.results[1]?.value;
    expect(rotated).toMatchObject({
      assetHash: ASSET_HASH_V2,
      navigationEpoch: 2,
    });
    expect(host.closeHostSession).toHaveBeenCalledWith(
      {
        kind: 'agent',
        agentId: 'agent-1',
        appId: 'dashboard',
      },
      rotated?.documentSlotId,
      rotated?.sessionId,
      rotated?.navigationEpoch,
    );
    expect(replacementPort.started).toBe(false);
    expect(replacementPort.posted).toHaveLength(0);
    expect(replacementPort.closed).toBe(true);
  });

  it('revokes a retired backend binding when reconnect grace expires', async () => {
    const fixture = createFrameFixture();
    const host = createHostService();
    const { broker } = createBroker(host, 5);
    brokers.push(broker);
    await broker.handleFrameConnect(fixture.event, [HELLO]);
    const binding = await host.openHostSession.mock.results[0]?.value;

    fixture.port.close();

    await vi.waitFor(() =>
      expect(host.suspendHostSession).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() =>
      expect(host.closeHostSession).toHaveBeenCalledOnce(),
    );
    expect(host.closeHostSession).toHaveBeenCalledWith(
      {
        kind: 'agent',
        agentId: 'agent-1',
        appId: 'dashboard',
      },
      binding?.documentSlotId,
      binding?.sessionId,
      binding?.navigationEpoch,
    );
  });

  it('drops an old asynchronous response after reconnect rotates the slot', async () => {
    const fixture = createFrameFixture();
    const host = createHostService();
    let resolveInvocation!: (value: { allowed: boolean }) => void;
    host.invokeHostSession.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveInvocation = resolve;
        }),
    );
    const { broker } = createBroker(host, 1_000);
    brokers.push(broker);
    await broker.handleFrameConnect(fixture.event, [HELLO]);
    const oldConnect = fixture.port.posted[0] as Record<string, unknown>;
    fixture.port.receive(requestFor(oldConnect, 'old-request'));
    await vi.waitFor(() =>
      expect(host.invokeHostSession).toHaveBeenCalledOnce(),
    );

    const replacement = new FakeFrame(
      fixture.child.frameTreeNodeId,
      fixture.child.processId,
      fixture.child.routingId + 1,
      'replacement-after-pending-invoke',
      withQueryValue(fixture.child.url, '_t', '3'),
      fixture.child.origin,
    );
    replacement.parent = fixture.parent;
    replacement.top = fixture.parent;
    fixture.parent.frames = [replacement];
    const replacementPort = new FakeMessagePort();
    const replacementEvent = {
      ...fixture.event,
      frameId: replacement.routingId,
      ports: [replacementPort.asElectronPort()],
      processId: replacement.processId,
      senderFrame: replacement.asElectronFrame(),
    } as unknown as IpcMainEvent;

    fixture.port.close();
    await broker.handleFrameConnect(replacementEvent, [HELLO]);
    const newConnect = replacementPort.posted[0] as Record<string, unknown>;
    expect(newConnect.navigationEpoch).toBe(2);

    resolveInvocation({ allowed: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.port.posted).toHaveLength(1);
    expect(replacementPort.posted).toHaveLength(1);

    replacementPort.receive(requestFor(newConnect, 'new-request'));
    await vi.waitFor(() => expect(replacementPort.posted).toHaveLength(2));
    expect(replacementPort.posted[1]).toMatchObject({
      id: 'new-request',
      ok: true,
    });
  });

  it('teardown closes active authority and drops a pending response', async () => {
    const fixture = createFrameFixture();
    const host = createHostService();
    let resolveInvocation!: (value: { allowed: boolean }) => void;
    host.invokeHostSession.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveInvocation = resolve;
        }),
    );
    const { broker } = createBroker(host);
    brokers.push(broker);
    await broker.handleFrameConnect(fixture.event, [HELLO]);
    const connect = fixture.port.posted[0] as Record<string, unknown>;
    fixture.port.receive(requestFor(connect, 'pending-at-teardown'));
    await vi.waitFor(() =>
      expect(host.invokeHostSession).toHaveBeenCalledOnce(),
    );

    const teardown = broker.teardown();
    await vi.waitFor(() =>
      expect(host.closeHostSession).toHaveBeenCalledOnce(),
    );
    expect(fixture.port.closed).toBe(true);

    resolveInvocation({ allowed: true });
    await teardown;
    expect(fixture.port.posted).toHaveLength(1);
  });
});
