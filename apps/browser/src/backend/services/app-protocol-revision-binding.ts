import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OnBeforeSendHeadersListenerDetails, Session } from 'electron';
import {
  buildIsolatedAppOrigin,
  parseAppUrlIdentity,
} from '@shared/isolated-app-origin';
import {
  CLODEX_APP_REVISION_PATTERN,
  parseCanonicalAppContentRevision,
} from './app-protocol-security';

export const CLODEX_APP_REVISION_BINDING_HEADER =
  'X-Clodex-App-Revision-Binding' as const;
export const CLODEX_APP_NAVIGATION_TICKET_HEADER =
  'X-Clodex-App-Navigation-Ticket' as const;

const REVISION_BINDING_VERSION = 'v1';
const REVISION_BINDING_DOMAIN = 'clodex.app-protocol.revision-binding.v1';
const NAVIGATION_TICKET_DOMAIN = 'clodex.app-protocol.navigation-ticket.v1';
const DOCUMENT_NONCE_PATTERN = /^[a-f0-9]{32}$/;
const PROVISIONAL_BINDING_TTL_MS = 30_000;

export type AppRevisionBindingInspection =
  | { status: 'none' }
  | { status: 'invalid' }
  | { status: 'valid'; revision: string };

export type IsolatedAppFrameAddress = Readonly<{
  webContentsId: number;
  frameTreeNodeId: number;
  processId: number;
  frameToken: string;
}>;

export type IsolatedAppDocumentBinding = IsolatedAppFrameAddress &
  Readonly<{
    /** Exact backend-owned document/session generation; never renderer-chosen. */
    documentToken: string;
    origin: string;
    agentId: string;
    appId: string;
    revision: string;
  }>;

export type ProvisionalIsolatedAppDocument = Readonly<{
  origin: string;
  agentId: string;
  appId: string;
  revision: string;
}>;

type StoredDocumentBinding = IsolatedAppDocumentBinding & {
  nonce: string;
  state: 'provisional' | 'trusted';
  expiresAt: number | null;
};

type PendingNavigation = {
  address: IsolatedAppFrameAddress;
  requestUrl: string;
  revision: string;
  nonce: string;
  expiresAt: number;
};

type NavigationStartHook = (address: IsolatedAppFrameAddress) => void;

const sessionBindings = new WeakMap<Session, IsolatedAppRevisionBinding>();

function deleteHeaderCaseInsensitive(
  requestHeaders: Record<string, string>,
  headerName: string,
): void {
  const expected = headerName.toLowerCase();
  for (const name of Object.keys(requestHeaders)) {
    if (name.toLowerCase() === expected) delete requestHeaders[name];
  }
}

function isSafeIntegerId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertFrameAddress(address: IsolatedAppFrameAddress): void {
  if (
    !isSafeIntegerId(address.webContentsId) ||
    !isSafeIntegerId(address.frameTreeNodeId) ||
    !isSafeIntegerId(address.processId) ||
    address.frameToken.length === 0 ||
    address.frameToken.length > 512
  ) {
    throw new TypeError('Invalid isolated app frame address');
  }
}

function frameKey(address: IsolatedAppFrameAddress): string {
  return [
    address.webContentsId,
    address.frameTreeNodeId,
    address.processId,
    address.frameToken,
  ].join('\0');
}

function frameAddressFromDetails(
  details: OnBeforeSendHeadersListenerDetails,
): IsolatedAppFrameAddress | null {
  try {
    const frame = details.frame;
    if (!frame || details.webContentsId === undefined) return null;
    const address = {
      webContentsId: details.webContentsId,
      frameTreeNodeId: frame.frameTreeNodeId,
      processId: frame.processId,
      frameToken: frame.frameToken,
    };
    assertFrameAddress(address);
    return address;
  } catch {
    return null;
  }
}

function safeFrameUrl(
  details: OnBeforeSendHeadersListenerDetails,
): string | null {
  try {
    return details.frame?.url ?? null;
  } catch {
    return null;
  }
}

function encodeBinding(
  secret: Uint8Array,
  requestUrl: string,
  revision: string,
  nonce: string,
): string {
  const signature = createHmac('sha256', secret)
    .update(REVISION_BINDING_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(revision, 'utf8')
    .update('\0', 'utf8')
    .update(nonce, 'utf8')
    .update('\0', 'utf8')
    .update(requestUrl, 'utf8')
    .digest('hex');
  return `${REVISION_BINDING_VERSION}.${revision}.${nonce}.${signature}`;
}

function encodeNavigationTicket(
  secret: Uint8Array,
  pending: PendingNavigation,
): string {
  const signature = createHmac('sha256', secret)
    .update(NAVIGATION_TICKET_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(frameKey(pending.address), 'utf8')
    .update('\0', 'utf8')
    .update(pending.requestUrl, 'utf8')
    .update('\0', 'utf8')
    .update(pending.revision, 'utf8')
    .update('\0', 'utf8')
    .update(pending.nonce, 'utf8')
    .digest('hex');
  return `${REVISION_BINDING_VERSION}.${pending.revision}.${pending.nonce}.${signature}`;
}

function signaturesMatch(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(
    Buffer.from(left, 'ascii'),
    Buffer.from(right, 'ascii'),
  );
}

/**
 * Session-local authenticator for authority-bearing app subresources.
 *
 * The immutable revision is installed provisionally only after the protocol
 * resolves and validates an exact byte snapshot, then upgraded by the trusted
 * preload/broker handshake. It is keyed by WebContents + FrameTreeNode +
 * renderer process + frame token. Mutable `details.frame.url` and
 * renderer-controlled referrers never mint authority.
 */
export class IsolatedAppRevisionBinding {
  private readonly secret: Uint8Array;
  private readonly documents = new Map<string, StoredDocumentBinding>();
  private readonly pendingNavigations = new Map<string, PendingNavigation>();
  private readonly navigationStartHooks = new Set<NavigationStartHook>();
  private readonly now: () => number;

  public constructor(
    secret: Uint8Array = randomBytes(32),
    now: () => number = Date.now,
  ) {
    if (secret.byteLength < 32) {
      throw new TypeError(
        'App revision binding secret must be at least 32 bytes',
      );
    }
    this.secret = Uint8Array.from(secret);
    this.now = now;
  }

  public bindDocument(input: IsolatedAppDocumentBinding): void {
    assertFrameAddress(input);
    if (
      input.documentToken.length === 0 ||
      input.documentToken.length > 512 ||
      !CLODEX_APP_REVISION_PATTERN.test(input.revision) ||
      input.origin !==
        buildIsolatedAppOrigin({
          namespace: 'agents',
          entityId: input.agentId,
          appId: input.appId,
        })
    ) {
      throw new TypeError('Invalid isolated app document binding');
    }

    const key = frameKey(input);
    const current = this.getCurrentDocument(key);
    if (
      current?.state === 'trusted' &&
      current.documentToken === input.documentToken &&
      current.origin === input.origin &&
      current.agentId === input.agentId &&
      current.appId === input.appId &&
      current.revision === input.revision
    ) {
      return;
    }
    if (!current) {
      throw new Error(
        'Trusted document binding requires an active provisional',
      );
    }
    if (
      current.state !== 'provisional' ||
      current.origin !== input.origin ||
      current.agentId !== input.agentId ||
      current.appId !== input.appId ||
      current.revision !== input.revision
    ) {
      throw new Error(
        'Trusted document binding does not match provisional state',
      );
    }

    this.documents.set(key, {
      ...input,
      nonce: current.nonce,
      state: 'trusted',
      expiresAt: null,
    });
  }

  public onNavigationStart(hook: NavigationStartHook): () => void {
    this.navigationStartHooks.add(hook);
    return () => this.navigationStartHooks.delete(hook);
  }

  /** Same-document reconnect: rotate only from the exact trusted generation. */
  public rotateTrustedDocument(
    input: IsolatedAppDocumentBinding,
    previousDocumentToken: string,
  ): void {
    assertFrameAddress(input);
    if (input.documentToken.length === 0 || input.documentToken.length > 512) {
      throw new TypeError('Invalid isolated app document token');
    }
    const key = frameKey(input);
    const current = this.getCurrentDocument(key);
    if (
      !current ||
      current.state !== 'trusted' ||
      current.documentToken !== previousDocumentToken ||
      current.origin !== input.origin ||
      current.agentId !== input.agentId ||
      current.appId !== input.appId ||
      current.revision !== input.revision
    ) {
      throw new Error('Trusted document rotation does not match active state');
    }
    this.documents.set(key, {
      ...current,
      documentToken: input.documentToken,
    });
  }

  /** Remove only the exact document generation; a stale close cannot evict a reload. */
  public unbindDocument(
    address: IsolatedAppFrameAddress,
    documentToken: string,
  ): boolean {
    assertFrameAddress(address);
    const key = frameKey(address);
    const current = this.getCurrentDocument(key);
    if (!current || current.documentToken !== documentToken) return false;
    return this.documents.delete(key);
  }

  /** Navigation-start/destroy hook: fail closed before a replacement can request bytes. */
  public clearFrame(address: IsolatedAppFrameAddress): boolean {
    assertFrameAddress(address);
    const key = frameKey(address);
    let removed = this.documents.delete(key);
    for (const [nonce, pending] of this.pendingNavigations) {
      if (frameKey(pending.address) !== key) continue;
      this.pendingNavigations.delete(nonce);
      removed = true;
    }
    return removed;
  }

  public clearWebContents(webContentsId: number): number {
    if (!isSafeIntegerId(webContentsId)) {
      throw new TypeError('Invalid WebContents id');
    }
    let removed = 0;
    for (const [key, binding] of this.documents) {
      if (binding.webContentsId !== webContentsId) continue;
      this.documents.delete(key);
      removed += 1;
    }
    for (const [nonce, pending] of this.pendingNavigations) {
      if (pending.address.webContentsId !== webContentsId) continue;
      this.pendingNavigations.delete(nonce);
      removed += 1;
    }
    return removed;
  }

  public mutateRequestHeaders(
    details: OnBeforeSendHeadersListenerDetails,
    requestHeaders: Record<string, string>,
  ): void {
    deleteHeaderCaseInsensitive(
      requestHeaders,
      CLODEX_APP_REVISION_BINDING_HEADER,
    );
    deleteHeaderCaseInsensitive(
      requestHeaders,
      CLODEX_APP_NAVIGATION_TICKET_HEADER,
    );

    const target = parseAppUrlIdentity(details.url);
    if (
      target?.classification !== 'isolated' ||
      target.identity.namespace !== 'agents'
    ) {
      return;
    }

    const address = frameAddressFromDetails(details);
    if (!address) return;

    if (
      details.resourceType === 'mainFrame' ||
      details.resourceType === 'subFrame'
    ) {
      if (!this.beginNavigation(address)) return;
      const revision = parseCanonicalAppContentRevision(details.url);
      if (!revision) return;
      this.pruneExpiredPendingNavigations();
      const pending = {
        address,
        requestUrl: details.url,
        revision,
        nonce: randomBytes(16).toString('hex'),
        expiresAt: this.now() + PROVISIONAL_BINDING_TTL_MS,
      } satisfies PendingNavigation;
      this.pendingNavigations.set(pending.nonce, pending);
      requestHeaders[CLODEX_APP_NAVIGATION_TICKET_HEADER] =
        encodeNavigationTicket(this.secret, pending);
      return;
    }

    const document = this.getCurrentDocument(frameKey(address));
    if (
      !document ||
      document.origin !== target.origin ||
      document.agentId !== target.identity.entityId ||
      document.appId !== target.identity.appId
    ) {
      return;
    }

    if (document.state === 'provisional') {
      const frameUrl = safeFrameUrl(details);
      const frameIdentity = frameUrl ? parseAppUrlIdentity(frameUrl) : null;
      if (
        !frameUrl ||
        parseCanonicalAppContentRevision(frameUrl) !== document.revision ||
        frameIdentity?.classification !== 'isolated' ||
        frameIdentity.origin !== document.origin ||
        frameIdentity.identity.namespace !== 'agents' ||
        frameIdentity.identity.entityId !== document.agentId ||
        frameIdentity.identity.appId !== document.appId
      ) {
        return;
      }
    }

    requestHeaders[CLODEX_APP_REVISION_BINDING_HEADER] = encodeBinding(
      this.secret,
      details.url,
      document.revision,
      document.nonce,
    );
  }

  /**
   * Consume a one-shot navigation ticket only after the protocol handler has
   * resolved the exact snapshot and matched its current whole-tree revision.
   * This bind exists early enough for parser CSS/JS, but it carries no Artifact
   * Bridge authority and must be upgraded by the trusted preload/broker hello.
   */
  public commitProvisionalNavigation(
    requestUrl: string,
    headers: Pick<Headers, 'has' | 'get'>,
    expected: ProvisionalIsolatedAppDocument,
  ): IsolatedAppFrameAddress | null {
    if (!headers.has(CLODEX_APP_NAVIGATION_TICKET_HEADER)) return null;
    const encoded = headers.get(CLODEX_APP_NAVIGATION_TICKET_HEADER);
    if (!encoded) return null;
    const parts = encoded.split('.');
    if (
      parts.length !== 4 ||
      parts[0] !== REVISION_BINDING_VERSION ||
      !CLODEX_APP_REVISION_PATTERN.test(parts[1] ?? '') ||
      !DOCUMENT_NONCE_PATTERN.test(parts[2] ?? '') ||
      !/^[a-f0-9]{64}$/.test(parts[3] ?? '')
    ) {
      return null;
    }

    const revision = parts[1] ?? '';
    const nonce = parts[2] ?? '';
    const pending = this.pendingNavigations.get(nonce);
    if (!pending) return null;
    // One attempt consumes the ticket before any further validation.
    this.pendingNavigations.delete(nonce);
    if (
      pending.expiresAt < this.now() ||
      pending.requestUrl !== requestUrl ||
      pending.revision !== revision ||
      expected.revision !== revision ||
      !signaturesMatch(encoded, encodeNavigationTicket(this.secret, pending))
    ) {
      return null;
    }

    const target = parseAppUrlIdentity(requestUrl);
    if (
      target?.classification !== 'isolated' ||
      target.identity.namespace !== 'agents' ||
      target.origin !== expected.origin ||
      target.identity.entityId !== expected.agentId ||
      target.identity.appId !== expected.appId ||
      expected.origin !==
        buildIsolatedAppOrigin({
          namespace: 'agents',
          entityId: expected.agentId,
          appId: expected.appId,
        })
    ) {
      return null;
    }

    const key = frameKey(pending.address);
    if (this.getCurrentDocument(key)) return null;
    this.documents.set(key, {
      ...pending.address,
      documentToken: `provisional:${nonce}`,
      origin: expected.origin,
      agentId: expected.agentId,
      appId: expected.appId,
      revision,
      nonce: randomBytes(16).toString('hex'),
      state: 'provisional',
      expiresAt: pending.expiresAt,
    });
    return pending.address;
  }

  public inspect(
    requestUrl: string,
    headers: Pick<Headers, 'has' | 'get'>,
  ): AppRevisionBindingInspection {
    if (!headers.has(CLODEX_APP_REVISION_BINDING_HEADER)) {
      return { status: 'none' };
    }
    const encoded = headers.get(CLODEX_APP_REVISION_BINDING_HEADER);
    if (!encoded) return { status: 'invalid' };
    const parts = encoded.split('.');
    if (
      parts.length !== 4 ||
      parts[0] !== REVISION_BINDING_VERSION ||
      !CLODEX_APP_REVISION_PATTERN.test(parts[1] ?? '') ||
      !DOCUMENT_NONCE_PATTERN.test(parts[2] ?? '') ||
      !/^[a-f0-9]{64}$/.test(parts[3] ?? '')
    ) {
      return { status: 'invalid' };
    }
    const revision = parts[1] ?? '';
    const nonce = parts[2] ?? '';
    const expected = encodeBinding(this.secret, requestUrl, revision, nonce);
    if (!signaturesMatch(encoded, expected)) return { status: 'invalid' };

    const target = parseAppUrlIdentity(requestUrl);
    if (
      target?.classification !== 'isolated' ||
      target.identity.namespace !== 'agents'
    ) {
      return { status: 'invalid' };
    }
    for (const [key] of this.documents) {
      const document = this.getCurrentDocument(key);
      if (
        document?.nonce === nonce &&
        document.revision === revision &&
        document.origin === target.origin &&
        document.agentId === target.identity.entityId &&
        document.appId === target.identity.appId
      ) {
        return { status: 'valid', revision };
      }
    }
    return { status: 'invalid' };
  }

  private beginNavigation(address: IsolatedAppFrameAddress): boolean {
    this.clearFrame(address);
    try {
      for (const hook of this.navigationStartHooks) hook(address);
      return true;
    } catch {
      return false;
    }
  }

  private getCurrentDocument(key: string): StoredDocumentBinding | null {
    const current = this.documents.get(key);
    if (!current) return null;
    if (current.expiresAt !== null && current.expiresAt < this.now()) {
      this.documents.delete(key);
      return null;
    }
    return current;
  }

  private pruneExpiredPendingNavigations(): void {
    const now = this.now();
    for (const [nonce, pending] of this.pendingNavigations) {
      if (pending.expiresAt < now) this.pendingNavigations.delete(nonce);
    }
  }
}

/** Shared instance used by protocol serving and the trusted frame broker. */
export function getIsolatedAppRevisionBinding(
  targetSession: Session,
): IsolatedAppRevisionBinding {
  const existing = sessionBindings.get(targetSession);
  if (existing) return existing;
  const created = new IsolatedAppRevisionBinding();
  sessionBindings.set(targetSession, created);
  return created;
}
