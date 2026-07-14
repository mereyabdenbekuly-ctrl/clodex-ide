import type {
  OnBeforeSendHeadersListenerDetails,
  WebFrameMain,
} from 'electron';
import { describe, expect, it } from 'vitest';
import {
  buildIsolatedAppOrigin,
  buildIsolatedAppUrl,
} from '@shared/isolated-app-origin';
import { CLODEX_APP_REVISION_QUERY } from './app-protocol-security';
import {
  CLODEX_APP_REVISION_BINDING_HEADER,
  CLODEX_APP_NAVIGATION_TICKET_HEADER,
  IsolatedAppRevisionBinding,
} from './app-protocol-revision-binding';

const APP_A = {
  namespace: 'agents' as const,
  entityId: 'agent-a',
  appId: 'dashboard',
};
const APP_B = {
  namespace: 'agents' as const,
  entityId: 'agent-b',
  appId: 'notes',
};
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const FRAME_A = {
  webContentsId: 41,
  frameTreeNodeId: 101,
  processId: 501,
  frameToken: 'frame-a',
};
const FRAME_B = {
  webContentsId: 42,
  frameTreeNodeId: 102,
  processId: 502,
  frameToken: 'frame-b',
};

function appUrl(
  identity: typeof APP_A | typeof APP_B,
  relativePath: string,
  revision?: string,
): string {
  const url = new URL(buildIsolatedAppUrl(identity, relativePath.split('/')));
  if (revision) url.searchParams.set(CLODEX_APP_REVISION_QUERY, revision);
  return url.toString();
}

function details(input: {
  url: string;
  frameUrl?: string | null;
  referrer?: string;
  resourceType?: OnBeforeSendHeadersListenerDetails['resourceType'];
  address?: typeof FRAME_A;
}): OnBeforeSendHeadersListenerDetails {
  const address = input.address ?? FRAME_A;
  return {
    id: 1,
    method: 'GET',
    timestamp: 1,
    requestHeaders: {},
    url: input.url,
    resourceType: input.resourceType ?? 'script',
    referrer: input.referrer ?? '',
    webContentsId: address.webContentsId,
    frame:
      input.frameUrl === undefined
        ? undefined
        : input.frameUrl === null
          ? null
          : ({
              url: input.frameUrl,
              frameTreeNodeId: address.frameTreeNodeId,
              processId: address.processId,
              frameToken: address.frameToken,
            } as WebFrameMain),
  };
}

function bindDocument(
  binding: IsolatedAppRevisionBinding,
  input: {
    identity?: typeof APP_A | typeof APP_B;
    revision?: string;
    address?: typeof FRAME_A;
    documentToken?: string;
    existingProvisional?: boolean;
  } = {},
): void {
  const identity = input.identity ?? APP_A;
  const address = input.address ?? FRAME_A;
  const revision = input.revision ?? HASH_A;
  if (!input.existingProvisional) {
    commitProvisional(binding, { identity, revision, address });
  }
  binding.bindDocument({
    ...address,
    documentToken: input.documentToken ?? 'document-1',
    origin: buildIsolatedAppOrigin(identity),
    agentId: identity.entityId,
    appId: identity.appId,
    revision,
  });
}

function commitProvisional(
  binding: IsolatedAppRevisionBinding,
  input: {
    identity?: typeof APP_A | typeof APP_B;
    revision?: string;
    address?: typeof FRAME_A;
    oldFrameUrl?: string;
  } = {},
): { navigationUrl: string; address: typeof FRAME_A } {
  const identity = input.identity ?? APP_A;
  const revision = input.revision ?? HASH_A;
  const address = input.address ?? FRAME_A;
  const navigationUrl = appUrl(identity, 'index.html', revision);
  const navigationHeaders: Record<string, string> = {};
  binding.mutateRequestHeaders(
    details({
      url: navigationUrl,
      frameUrl: input.oldFrameUrl ?? navigationUrl,
      resourceType: 'subFrame',
      address,
    }),
    navigationHeaders,
  );
  expect(navigationHeaders[CLODEX_APP_NAVIGATION_TICKET_HEADER]).toBeDefined();
  expect(
    binding.commitProvisionalNavigation(
      navigationUrl,
      new Headers(navigationHeaders),
      {
        origin: buildIsolatedAppOrigin(identity),
        agentId: identity.entityId,
        appId: identity.appId,
        revision,
      },
    ),
  ).toEqual(address);
  return { navigationUrl, address };
}

describe('IsolatedAppRevisionBinding', () => {
  it('overwrites a renderer-spoofed header with a target-bound session signature', () => {
    const binding = new IsolatedAppRevisionBinding(Buffer.alloc(32, 7));
    bindDocument(binding);
    const frameUrl = appUrl(APP_A, 'index.html', HASH_A);
    const targetUrl = appUrl(APP_A, 'app.js');
    const requestHeaders: Record<string, string> = {
      'x-CLODEX-app-revision-binding': 'renderer-controlled',
    };

    binding.mutateRequestHeaders(
      details({ url: targetUrl, frameUrl }),
      requestHeaders,
    );

    expect(requestHeaders['x-CLODEX-app-revision-binding']).toBeUndefined();
    expect(requestHeaders[CLODEX_APP_REVISION_BINDING_HEADER]).toBeDefined();
    expect(binding.inspect(targetUrl, new Headers(requestHeaders))).toEqual({
      status: 'valid',
      revision: HASH_A,
    });
    expect(
      binding.inspect(appUrl(APP_A, 'other.js'), new Headers(requestHeaders)),
    ).toEqual({ status: 'invalid' });
  });

  it('binds CSS-nested resources through the document frame revision', () => {
    const binding = new IsolatedAppRevisionBinding(Buffer.alloc(32, 8));
    bindDocument(binding);
    const frameUrl = appUrl(APP_A, 'index.html', HASH_A);
    const stylesheetUrl = appUrl(APP_A, 'styles/main.css');
    const imageUrl = appUrl(APP_A, 'assets/background.png');
    const stylesheetHeaders: Record<string, string> = {};
    const imageHeaders: Record<string, string> = {};

    binding.mutateRequestHeaders(
      details({
        url: stylesheetUrl,
        frameUrl,
        resourceType: 'stylesheet',
      }),
      stylesheetHeaders,
    );
    binding.mutateRequestHeaders(
      details({
        url: imageUrl,
        frameUrl,
        referrer: stylesheetUrl,
        resourceType: 'image',
      }),
      imageHeaders,
    );

    expect(
      binding.inspect(stylesheetUrl, new Headers(stylesheetHeaders)),
    ).toEqual({ status: 'valid', revision: HASH_A });
    expect(binding.inspect(imageUrl, new Headers(imageHeaders))).toEqual({
      status: 'valid',
      revision: HASH_A,
    });
  });

  it('fails closed when the exact bound frame identity is unavailable', () => {
    const binding = new IsolatedAppRevisionBinding(Buffer.alloc(32, 9));
    bindDocument(binding);
    const frameUrl = appUrl(APP_A, 'index.html', HASH_A);
    const targetUrl = appUrl(APP_A, 'assets/icon.svg');
    const requestHeaders: Record<string, string> = {};

    binding.mutateRequestHeaders(
      details({
        url: targetUrl,
        frameUrl: null,
        referrer: frameUrl,
        resourceType: 'image',
      }),
      requestHeaders,
    );

    expect(requestHeaders).toEqual({});
  });

  it('never signs navigation, cross-app, external, or unbound-frame requests', () => {
    const binding = new IsolatedAppRevisionBinding(Buffer.alloc(32, 10));
    bindDocument(binding);
    const frameUrl = appUrl(APP_A, 'index.html', HASH_A);
    const cases = [
      details({
        url: appUrl(APP_A, 'settings.html'),
        frameUrl,
        resourceType: 'subFrame',
      }),
      details({ url: appUrl(APP_B, 'app.js'), frameUrl }),
      details({ url: 'https://example.com/pixel', frameUrl }),
      details({
        url: appUrl(APP_A, 'app.js'),
        frameUrl: appUrl(APP_A, 'index.html'),
        address: { ...FRAME_A, frameToken: 'unbound-frame' },
      }),
    ];

    for (const requestDetails of cases) {
      const requestHeaders = {
        [CLODEX_APP_REVISION_BINDING_HEADER]: 'spoofed',
      };
      binding.mutateRequestHeaders(requestDetails, requestHeaders);
      expect(requestHeaders).toEqual({});
    }
  });

  it('keeps concurrent preview revisions and targets independent', () => {
    const binding = new IsolatedAppRevisionBinding(Buffer.alloc(32, 11));
    bindDocument(binding);
    bindDocument(binding, {
      identity: APP_B,
      revision: HASH_B,
      address: FRAME_B,
      documentToken: 'document-2',
    });
    const targetA = appUrl(APP_A, 'app.js');
    const targetB = appUrl(APP_B, 'app.js');
    const headersA: Record<string, string> = {};
    const headersB: Record<string, string> = {};

    binding.mutateRequestHeaders(
      details({ url: targetA, frameUrl: appUrl(APP_A, 'index.html', HASH_A) }),
      headersA,
    );
    binding.mutateRequestHeaders(
      details({
        url: targetB,
        frameUrl: appUrl(APP_B, 'index.html', HASH_B),
        address: FRAME_B,
      }),
      headersB,
    );

    expect(binding.inspect(targetA, new Headers(headersA))).toEqual({
      status: 'valid',
      revision: HASH_A,
    });
    expect(binding.inspect(targetB, new Headers(headersB))).toEqual({
      status: 'valid',
      revision: HASH_B,
    });
    expect(binding.inspect(targetA, new Headers(headersB))).toEqual({
      status: 'invalid',
    });
    expect(binding.inspect(targetB, new Headers(headersA))).toEqual({
      status: 'invalid',
    });
  });

  it('ignores history-mutated frame URLs and retains the broker-bound revision', () => {
    const binding = new IsolatedAppRevisionBinding(Buffer.alloc(32, 12));
    bindDocument(binding, { revision: HASH_A });
    const targetUrl = appUrl(APP_A, 'malicious.js', HASH_B);
    const requestHeaders: Record<string, string> = {};

    // Main-world history.replaceState can mutate this observable URL, but it
    // cannot replace the trusted document binding established for FRAME_A.
    binding.mutateRequestHeaders(
      details({
        url: targetUrl,
        frameUrl: appUrl(APP_A, 'index.html', HASH_B),
      }),
      requestHeaders,
    );

    expect(binding.inspect(targetUrl, new Headers(requestHeaders))).toEqual({
      status: 'valid',
      revision: HASH_A,
    });
  });

  it('uses exact document tokens so stale cleanup cannot evict a reload', () => {
    const binding = new IsolatedAppRevisionBinding(Buffer.alloc(32, 13));
    bindDocument(binding, { documentToken: 'document-old', revision: HASH_A });
    expect(binding.clearFrame(FRAME_A)).toBe(true);
    bindDocument(binding, { documentToken: 'document-new', revision: HASH_B });

    expect(binding.unbindDocument(FRAME_A, 'document-old')).toBe(false);
    const targetUrl = appUrl(APP_A, 'app.js');
    const requestHeaders: Record<string, string> = {};
    binding.mutateRequestHeaders(
      details({
        url: targetUrl,
        frameUrl: appUrl(APP_A, 'index.html', HASH_A),
      }),
      requestHeaders,
    );
    expect(binding.inspect(targetUrl, new Headers(requestHeaders))).toEqual({
      status: 'valid',
      revision: HASH_B,
    });
    expect(binding.unbindDocument(FRAME_A, 'document-new')).toBe(true);
  });

  it('serves initial parser CSS/JS from a provisional bind and upgrades exactly on hello', () => {
    const binding = new IsolatedAppRevisionBinding(Buffer.alloc(32, 14));
    const { navigationUrl } = commitProvisional(binding);
    let headerIssuedBeforeUpgrade:
      | { targetUrl: string; requestHeaders: Record<string, string> }
      | undefined;

    for (const [relativePath, resourceType] of [
      ['styles.css', 'stylesheet'],
      ['app.js', 'script'],
    ] as const) {
      const targetUrl = appUrl(APP_A, relativePath);
      const requestHeaders: Record<string, string> = {};
      binding.mutateRequestHeaders(
        details({ url: targetUrl, frameUrl: navigationUrl, resourceType }),
        requestHeaders,
      );
      expect(binding.inspect(targetUrl, new Headers(requestHeaders))).toEqual({
        status: 'valid',
        revision: HASH_A,
      });
      headerIssuedBeforeUpgrade ??= { targetUrl, requestHeaders };
    }

    bindDocument(binding, {
      documentToken: 'broker-document',
      existingProvisional: true,
    });
    expect(
      binding.inspect(
        headerIssuedBeforeUpgrade?.targetUrl ?? '',
        new Headers(headerIssuedBeforeUpgrade?.requestHeaders),
      ),
    ).toEqual({ status: 'valid', revision: HASH_A });
    const targetUrl = appUrl(APP_A, 'app.js');
    const requestHeaders: Record<string, string> = {};
    binding.mutateRequestHeaders(
      details({
        url: targetUrl,
        // Trusted state ignores mutable main-world history URL observations.
        frameUrl: appUrl(APP_A, 'index.html', HASH_B),
      }),
      requestHeaders,
    );
    expect(binding.inspect(targetUrl, new Headers(requestHeaders))).toEqual({
      status: 'valid',
      revision: HASH_A,
    });
  });

  it('revokes H1 before H2 provisional commit and never signs H2 for the old H1 document', () => {
    const binding = new IsolatedAppRevisionBinding(Buffer.alloc(32, 15));
    bindDocument(binding, { documentToken: 'h1-document', revision: HASH_A });
    const navigationStarts: string[] = [];
    binding.onNavigationStart((address) => {
      navigationStarts.push(address.frameToken);
    });

    const navigationUrl = appUrl(APP_A, 'index.html', HASH_B);
    const navigationHeaders: Record<string, string> = {};
    binding.mutateRequestHeaders(
      details({
        url: navigationUrl,
        frameUrl: appUrl(APP_A, 'index.html', HASH_A),
        resourceType: 'subFrame',
      }),
      navigationHeaders,
    );
    expect(navigationStarts).toEqual([FRAME_A.frameToken]);

    const targetUrl = appUrl(APP_A, 'app.js');
    const beforeCommitHeaders: Record<string, string> = {};
    binding.mutateRequestHeaders(
      details({
        url: targetUrl,
        frameUrl: appUrl(APP_A, 'index.html', HASH_A),
      }),
      beforeCommitHeaders,
    );
    expect(beforeCommitHeaders).toEqual({});

    expect(
      binding.commitProvisionalNavigation(
        navigationUrl,
        new Headers(navigationHeaders),
        {
          origin: buildIsolatedAppOrigin(APP_A),
          agentId: APP_A.entityId,
          appId: APP_A.appId,
          revision: HASH_B,
        },
      ),
    ).toEqual(FRAME_A);

    const oldDocumentHeaders: Record<string, string> = {};
    binding.mutateRequestHeaders(
      details({
        url: targetUrl,
        frameUrl: appUrl(APP_A, 'index.html', HASH_A),
      }),
      oldDocumentHeaders,
    );
    expect(oldDocumentHeaders).toEqual({});

    const newDocumentHeaders: Record<string, string> = {};
    binding.mutateRequestHeaders(
      details({ url: targetUrl, frameUrl: navigationUrl }),
      newDocumentHeaders,
    );
    expect(binding.inspect(targetUrl, new Headers(newDocumentHeaders))).toEqual(
      { status: 'valid', revision: HASH_B },
    );
    bindDocument(binding, {
      documentToken: 'h2-document',
      revision: HASH_B,
      existingProvisional: true,
    });
    expect(binding.unbindDocument(FRAME_A, 'h1-document')).toBe(false);
  });

  it('invalidates already-issued headers after unbind, clear, and rotation', () => {
    const binding = new IsolatedAppRevisionBinding(Buffer.alloc(32, 16));
    const targetUrl = appUrl(APP_A, 'app.js');
    bindDocument(binding, { documentToken: 'document-1' });
    const issued: Record<string, string> = {};
    binding.mutateRequestHeaders(
      details({
        url: targetUrl,
        frameUrl: appUrl(APP_A, 'index.html', HASH_A),
      }),
      issued,
    );
    expect(binding.inspect(targetUrl, new Headers(issued)).status).toBe(
      'valid',
    );

    expect(binding.unbindDocument(FRAME_A, 'document-1')).toBe(true);
    expect(binding.inspect(targetUrl, new Headers(issued))).toEqual({
      status: 'invalid',
    });

    bindDocument(binding, { documentToken: 'document-2' });
    const rotated: Record<string, string> = {};
    binding.mutateRequestHeaders(
      details({
        url: targetUrl,
        frameUrl: appUrl(APP_A, 'index.html', HASH_A),
      }),
      rotated,
    );
    expect(binding.inspect(targetUrl, new Headers(rotated)).status).toBe(
      'valid',
    );
    expect(binding.clearWebContents(FRAME_A.webContentsId)).toBe(1);
    expect(binding.inspect(targetUrl, new Headers(rotated))).toEqual({
      status: 'invalid',
    });
  });

  it('does not resurrect a cleared or expired provisional through a late hello', () => {
    let now = 0;
    const binding = new IsolatedAppRevisionBinding(
      Buffer.alloc(32, 17),
      () => now,
    );
    const trusted = {
      ...FRAME_A,
      documentToken: 'late-broker-hello',
      origin: buildIsolatedAppOrigin(APP_A),
      agentId: APP_A.entityId,
      appId: APP_A.appId,
      revision: HASH_A,
    };

    commitProvisional(binding);
    expect(binding.clearFrame(FRAME_A)).toBe(true);
    expect(() => binding.bindDocument(trusted)).toThrow(
      'requires an active provisional',
    );

    commitProvisional(binding);
    now = 30_001;
    expect(() => binding.bindDocument(trusted)).toThrow(
      'requires an active provisional',
    );
  });
});
