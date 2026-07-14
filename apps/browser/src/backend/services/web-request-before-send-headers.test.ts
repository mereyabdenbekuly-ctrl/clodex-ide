import type {
  BeforeSendResponse,
  OnBeforeSendHeadersListenerDetails,
  Session,
} from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { registerBeforeSendHeadersMutator } from './web-request-before-send-headers';

describe('registerBeforeSendHeadersMutator', () => {
  it('composes security and stealth mutations through one Electron listener', () => {
    type Listener = (
      details: OnBeforeSendHeadersListenerDetails,
      callback: (response: BeforeSendResponse) => void,
    ) => void;
    let listener: Listener | null = null;
    const onBeforeSendHeaders = vi.fn((next: Listener) => (listener = next));
    const session = {
      webRequest: { onBeforeSendHeaders },
    } as unknown as Session;

    const unregisterSecurity = registerBeforeSendHeadersMutator(
      session,
      (_details, headers) => {
        delete headers['X-Renderer-Spoof'];
        headers['X-Security'] = 'bound';
      },
    );
    registerBeforeSendHeadersMutator(session, (_details, headers) => {
      headers['Sec-CH-UA'] = 'Chrome';
    });

    expect(onBeforeSendHeaders).toHaveBeenCalledTimes(1);
    const invoke = listener as unknown as Listener;
    let response: BeforeSendResponse | null = null;
    invoke(
      {
        id: 1,
        url: 'app://agents-example/agent/app/app.js',
        method: 'GET',
        resourceType: 'script',
        referrer: '',
        timestamp: 1,
        requestHeaders: {
          'X-Renderer-Spoof': 'forged',
          'Sec-CH-UA': 'Electron',
        },
      },
      (result: BeforeSendResponse) => (response = result),
    );
    expect((response as BeforeSendResponse | null)?.requestHeaders).toEqual({
      'Sec-CH-UA': 'Chrome',
      'X-Security': 'bound',
    });

    unregisterSecurity();
    response = null;
    invoke(
      {
        id: 2,
        url: 'https://example.com/',
        method: 'GET',
        resourceType: 'xhr',
        referrer: '',
        timestamp: 2,
        requestHeaders: { 'X-Renderer-Spoof': 'preserved' },
      },
      (result: BeforeSendResponse) => (response = result),
    );
    expect((response as BeforeSendResponse | null)?.requestHeaders).toEqual({
      'X-Renderer-Spoof': 'preserved',
      'Sec-CH-UA': 'Chrome',
    });
  });
});
