import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLoopbackAuthServer,
  type LoopbackAuthServer,
} from './loopback-auth';

let activeServer: LoopbackAuthServer | null = null;

afterEach(async () => {
  await activeServer?.dispose();
  activeServer = null;
});

describe('RFC 8252 loopback auth receiver', () => {
  it('accepts one exact state-bound opaque authorization code', async () => {
    const onCallback = vi.fn(async () => true);
    activeServer = await createLoopbackAuthServer({
      expectedState: 'expected-state',
      onCallback,
    });

    const url = new URL(activeServer.callbackUrl);
    url.searchParams.set('code', 'opaque_code-123');
    url.searchParams.set('state', 'expected-state');
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
    expect(await response.text()).not.toContain('opaque_code-123');
    expect(onCallback).toHaveBeenCalledWith({
      code: 'opaque_code-123',
      kind: 'authorization',
      state: 'expected-state',
    });
  });

  it.each([
    ['wrong state', '?code=opaque-code&state=wrong-state'],
    [
      'duplicate code',
      '?code=opaque-code&code=second-code&state=expected-state',
    ],
    ['unknown parameter', '?code=opaque-code&state=expected-state&token=x'],
    ['code and error', '?code=opaque-code&error=denied&state=expected-state'],
    ['non-opaque code', '?code=not%20opaque&state=expected-state'],
  ])('rejects %s without consuming the receiver', async (_label, query) => {
    const onCallback = vi.fn(async () => true);
    activeServer = await createLoopbackAuthServer({
      expectedState: 'expected-state',
      onCallback,
    });

    const invalid = await fetch(`${activeServer.callbackUrl}${query}`);
    expect(invalid.status).toBe(400);
    expect(onCallback).not.toHaveBeenCalled();

    const valid = await fetch(
      `${activeServer.callbackUrl}?code=valid-code&state=expected-state`,
    );
    expect(valid.status).toBe(200);
    expect(onCallback).toHaveBeenCalledOnce();
  });

  it('rejects non-GET callbacks and returns a generic failure page', async () => {
    const onCallback = vi.fn(async () => false);
    activeServer = await createLoopbackAuthServer({
      expectedState: 'expected-state',
      onCallback,
    });

    const post = await fetch(activeServer.callbackUrl, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');

    const failed = await fetch(
      `${activeServer.callbackUrl}?error=access_denied&state=expected-state`,
    );
    expect(failed.status).toBe(400);
    expect(await failed.text()).not.toContain('access_denied');
    expect(onCallback).toHaveBeenCalledWith({
      error: 'access_denied',
      kind: 'error',
      state: 'expected-state',
    });
  });
});
