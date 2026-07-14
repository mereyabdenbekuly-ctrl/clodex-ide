import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildIsolatedAppUrl } from '@shared/isolated-app-origin';
import {
  CLODEX_APP_REVISION_QUERY,
  ISOLATED_APP_CONTENT_SECURITY_POLICY,
  ISOLATED_APP_RESPONSE_HEADERS,
  decideAppContentRevision,
  hardenIsolatedAppHtml,
  shouldBlockIsolatedAppFrameNavigation,
  shouldBlockIsolatedAppRequest,
} from './app-protocol-security';

const IDENTITY = {
  namespace: 'agents' as const,
  entityId: 'agent-a',
  appId: 'dashboard',
};
const CURRENT_HASH = 'a'.repeat(64);

function appUrl(
  relativePath: string,
  identity: typeof IDENTITY = IDENTITY,
): string {
  return buildIsolatedAppUrl(identity, relativePath.split('/'));
}

describe('app protocol content revision', () => {
  it('redirects an unrevisioned HTML navigation to the same canonical URL', () => {
    const initial = `${appUrl('index.html')}?theme=dark`;

    const decision = decideAppContentRevision(initial, CURRENT_HASH);

    expect(decision.action).toBe('redirect');
    if (decision.action !== 'redirect') return;
    const redirected = new URL(decision.location);
    expect(redirected.origin).toBe(new URL(initial).origin);
    expect(redirected.pathname).toBe(new URL(initial).pathname);
    expect(redirected.searchParams.get('theme')).toBe('dark');
    expect(redirected.searchParams.get(CLODEX_APP_REVISION_QUERY)).toBe(
      CURRENT_HASH,
    );
  });

  it('allows only the exact current lowercase full-tree revision', () => {
    const revisioned = new URL(appUrl('index.html'));
    revisioned.searchParams.set(CLODEX_APP_REVISION_QUERY, CURRENT_HASH);

    expect(
      decideAppContentRevision(revisioned.toString(), CURRENT_HASH),
    ).toEqual({ action: 'allow' });
    expect(
      decideAppContentRevision(revisioned.toString(), 'b'.repeat(64)),
    ).toEqual({ action: 'deny', reason: 'mismatch' });
  });

  it.each([
    ['uppercase hash', 'A'.repeat(64)],
    ['short hash', 'a'.repeat(63)],
    ['non-hex hash', `${'a'.repeat(63)}z`],
  ])('denies an invalid %s', (_label, revision) => {
    const url = new URL(appUrl('index.html'));
    url.searchParams.set(CLODEX_APP_REVISION_QUERY, revision);
    expect(decideAppContentRevision(url.toString(), CURRENT_HASH)).toEqual({
      action: 'deny',
      reason: 'invalid',
    });
  });

  it('denies duplicate and case-aliased reserved revision parameters', () => {
    const duplicate = new URL(appUrl('index.html'));
    duplicate.searchParams.append(CLODEX_APP_REVISION_QUERY, CURRENT_HASH);
    duplicate.searchParams.append(CLODEX_APP_REVISION_QUERY, CURRENT_HASH);
    expect(
      decideAppContentRevision(duplicate.toString(), CURRENT_HASH),
    ).toEqual({ action: 'deny', reason: 'invalid' });

    const alias = new URL(appUrl('index.html'));
    alias.searchParams.set('ClodexRev', CURRENT_HASH);
    expect(decideAppContentRevision(alias.toString(), CURRENT_HASH)).toEqual({
      action: 'deny',
      reason: 'invalid',
    });

    expect(
      decideAppContentRevision(
        `${appUrl('index.html')}?clodex%52ev=${CURRENT_HASH}`,
        CURRENT_HASH,
      ),
    ).toEqual({ action: 'deny', reason: 'invalid' });
    expect(
      decideAppContentRevision(
        `${appUrl('index.html')}?${CLODEX_APP_REVISION_QUERY}=%61${'a'.repeat(63)}`,
        CURRENT_HASH,
      ),
    ).toEqual({ action: 'deny', reason: 'invalid' });
  });
});

describe('isolated app request boundary', () => {
  const frameUrl = `${appUrl('index.html')}?${CLODEX_APP_REVISION_QUERY}=${CURRENT_HASH}`;

  it.each([
    ['fetch', 'https://example.com/api', 'xhr'],
    ['image', 'https://example.com/pixel.png', 'image'],
    ['script', 'https://cdn.example.com/app.js', 'script'],
    ['ping', 'https://example.com/ping', 'ping'],
    ['WebSocket', 'wss://example.com/socket', 'webSocket'],
    ['direct navigation', 'https://example.com/leave', 'subFrame'],
  ])('blocks external %s traffic', (_label, url, resourceType) => {
    expect(shouldBlockIsolatedAppRequest({ url, frameUrl, resourceType })).toBe(
      true,
    );
  });

  it('uses an isolated app referrer when the requesting frame is unavailable', () => {
    expect(
      shouldBlockIsolatedAppRequest({
        url: 'https://example.com/beacon',
        frameUrl: null,
        referrer: frameUrl,
        resourceType: 'ping',
      }),
    ).toBe(true);
  });

  it('allows same-app app:// subresources without requiring a revision query', () => {
    expect(
      shouldBlockIsolatedAppRequest({
        url: appUrl('assets/logo.png'),
        frameUrl,
        referrer: frameUrl,
        resourceType: 'image',
      }),
    ).toBe(false);
  });

  it('blocks cross-app app:// reads', () => {
    expect(
      shouldBlockIsolatedAppRequest({
        url: appUrl('index.html', { ...IDENTITY, appId: 'other-app' }),
        frameUrl,
        resourceType: 'subFrame',
      }),
    ).toBe(true);
  });

  it('does not affect non-app browser traffic', () => {
    expect(
      shouldBlockIsolatedAppRequest({
        url: 'https://example.com/api',
        frameUrl: 'https://example.com/page',
        referrer: 'https://example.com/page',
        resourceType: 'xhr',
      }),
    ).toBe(false);
    expect(
      shouldBlockIsolatedAppRequest({
        url: 'https://example.com/api',
        frameUrl: 'clodex://internal/preview/dashboard?agentId=agent-a',
        referrer: 'clodex://internal/',
        resourceType: 'xhr',
      }),
    ).toBe(false);
  });
});

describe('isolated app frame navigation boundary', () => {
  const isolatedFrameUrl = `${appUrl('index.html')}?${CLODEX_APP_REVISION_QUERY}=${CURRENT_HASH}`;

  it('denies mailto navigation from an isolated app frame', () => {
    expect(
      shouldBlockIsolatedAppFrameNavigation({
        initiatorUrl: isolatedFrameUrl,
        targetUrl: 'mailto:security@example.com',
      }),
    ).toBe(true);
  });

  it('denies arbitrary custom-scheme navigation from an isolated app frame', () => {
    expect(
      shouldBlockIsolatedAppFrameNavigation({
        initiatorUrl: isolatedFrameUrl,
        targetUrl: 'vscode://file/tmp/secret.txt',
      }),
    ).toBe(true);
  });

  it('denies external navigation from an isolated app frame', () => {
    expect(
      shouldBlockIsolatedAppFrameNavigation({
        initiatorUrl: isolatedFrameUrl,
        targetUrl: 'https://example.com/leave',
      }),
    ).toBe(true);
  });

  it('allows navigation within the same isolated app identity', () => {
    expect(
      shouldBlockIsolatedAppFrameNavigation({
        initiatorUrl: isolatedFrameUrl,
        targetUrl: appUrl('settings.html'),
      }),
    ).toBe(false);
  });

  it('does not affect custom or external navigation from non-app frames', () => {
    for (const targetUrl of [
      'mailto:security@example.com',
      'vscode://file/tmp/project',
      'https://example.com/leave',
    ]) {
      expect(
        shouldBlockIsolatedAppFrameNavigation({
          initiatorUrl: 'https://example.com/page',
          frameUrl: 'https://example.com/page',
          targetUrl,
        }),
      ).toBe(false);
    }
  });

  it('uses the current isolated frame when the initiator is unavailable', () => {
    expect(
      shouldBlockIsolatedAppFrameNavigation({
        frameUrl: isolatedFrameUrl,
        targetUrl: 'tel:+15555550100',
      }),
    ).toBe(true);
  });

  it('denies cross-app and privileged-scheme navigation', () => {
    for (const targetUrl of [
      appUrl('index.html', { ...IDENTITY, appId: 'other-app' }),
      'clodex://internal/',
      'file:///tmp/secret.txt',
    ]) {
      expect(
        shouldBlockIsolatedAppFrameNavigation({
          initiatorUrl: isolatedFrameUrl,
          targetUrl,
        }),
      ).toBe(true);
    }
  });
});

describe('isolated app HTML hardening', () => {
  it('injects the fail-closed network bootstrap before every app script', () => {
    const original =
      '<!doctype html><html><head><script id="app-script">run()</script></head><body></body></html>';

    const hardened = hardenIsolatedAppHtml(original);

    expect(hardened.toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(hardened.indexOf('data-clodex-isolated-bootstrap')).toBeGreaterThan(
      hardened.toLowerCase().indexOf('<!doctype html>'),
    );
    expect(hardened.indexOf('data-clodex-isolated-bootstrap')).toBeLessThan(
      hardened.indexOf('id="app-script"'),
    );
    expect(hardened).toContain('RTCPeerConnection');
    expect(hardened).toContain('WebTransport');
    expect(hardened).toContain('window.stop()');
  });

  it('locks History URLs to the exact initial authority revision before app scripts', () => {
    const initialUrl = `${appUrl('index.html')}?${CLODEX_APP_REVISION_QUERY}=${CURRENT_HASH}`;
    const hardened = hardenIsolatedAppHtml(
      '<!doctype html><script>app()</script>',
      CURRENT_HASH,
    );
    const source =
      /<script data-clodex-isolated-bootstrap>([\s\S]*?)<\/script>/.exec(
        hardened,
      )?.[1];
    expect(source).toBeDefined();

    const location = { href: initialUrl };
    class FakeHistory {
      public pushState(_state: unknown, _unused: string, next?: string): void {
        if (next !== undefined) {
          location.href = new URL(next, location.href).href;
        }
      }

      public replaceState(
        _state: unknown,
        _unused: string,
        next?: string,
      ): void {
        if (next !== undefined) {
          location.href = new URL(next, location.href).href;
        }
      }
    }
    const history = new FakeHistory();
    const documentWrites: string[] = [];
    runInNewContext(source ?? '', {
      URL,
      History: FakeHistory,
      history,
      location,
      navigator: {},
      window: { stop: () => undefined },
      document: {
        open: () => undefined,
        write: (value: string) => documentWrites.push(value),
        close: () => undefined,
      },
    });

    history.replaceState(
      {},
      '',
      `?theme=dark&${CLODEX_APP_REVISION_QUERY}=${CURRENT_HASH}`,
    );
    expect(location.href).toContain(`theme=dark`);
    expect(() => history.replaceState({}, '', '?theme=light')).toThrow(
      'CLODEx app revision is immutable',
    );
    expect(() =>
      history.replaceState(
        {},
        '',
        `?${CLODEX_APP_REVISION_QUERY}=${'b'.repeat(64)}`,
      ),
    ).toThrow('CLODEx app revision is immutable');
    expect(() =>
      history.pushState({}, '', `?clodex%52ev=${CURRENT_HASH}`),
    ).toThrow('CLODEx app revision is immutable');

    for (const name of ['pushState', 'replaceState'] as const) {
      const prototypeDescriptor = Object.getOwnPropertyDescriptor(
        FakeHistory.prototype,
        name,
      );
      const objectDescriptor = Object.getOwnPropertyDescriptor(history, name);
      expect(prototypeDescriptor).toMatchObject({
        configurable: false,
        writable: false,
      });
      expect(objectDescriptor).toMatchObject({
        configurable: false,
        writable: false,
      });
    }
    expect(documentWrites).toEqual([]);
  });

  it('does not add authority history guards to unrevisioned legacy HTML', () => {
    const hardened = hardenIsolatedAppHtml('<!doctype html>legacy');
    expect(hardened).not.toContain('expectedRevision=');
    expect(hardened).not.toContain('CLODEx app revision is immutable');
  });

  it('publishes a compatible whole-tree-authority CSP and isolation headers', () => {
    expect(ISOLATED_APP_CONTENT_SECURITY_POLICY).toBe(
      [
        "default-src 'none'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "connect-src 'self'",
        "manifest-src 'self'",
        "worker-src 'none'",
        "child-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        'frame-ancestors clodex:',
      ].join('; '),
    );
    expect(ISOLATED_APP_CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'");
    expect(ISOLATED_APP_CONTENT_SECURITY_POLICY).not.toContain('sha256-');
    expect(ISOLATED_APP_CONTENT_SECURITY_POLICY).not.toContain('https:');
    expect(ISOLATED_APP_RESPONSE_HEADERS['Referrer-Policy']).toBe(
      'same-origin',
    );
    expect(ISOLATED_APP_RESPONSE_HEADERS['X-DNS-Prefetch-Control']).toBe('off');
  });
});
