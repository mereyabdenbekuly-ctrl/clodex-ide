import { EventEmitter } from 'node:events';
import type { AuthInfo, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../logger';
import { TabAuthenticationHandler } from '.';

describe('TabAuthenticationHandler', () => {
  it('consumes managed proxy challenges without exposing them to the UI', () => {
    const webContents = new EventEmitter() as WebContents & EventEmitter;
    const onAuthRequestUpdate = vi.fn();
    const proxyAuthenticationHandler = vi.fn(
      (
        authInfo: AuthInfo,
        callback: (username?: string, password?: string) => void,
      ) => {
        if (!authInfo.isProxy) return false;
        callback('clodex', 'managed-secret');
        return true;
      },
    );
    const handler = new TabAuthenticationHandler(
      'tab-1',
      webContents,
      {
        debug: vi.fn(),
        warn: vi.fn(),
      } as unknown as Logger,
      { onAuthRequestUpdate },
      proxyAuthenticationHandler,
    );
    const preventDefault = vi.fn();
    const callback = vi.fn();

    webContents.emit(
      'login',
      { preventDefault },
      { url: 'https://example.com', pid: 1 },
      {
        isProxy: true,
        scheme: 'basic',
        host: '127.0.0.1',
        port: 4319,
        realm: 'clodex-egress',
      } satisfies AuthInfo,
      callback,
    );

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith('clodex', 'managed-secret');
    expect(onAuthRequestUpdate).not.toHaveBeenCalled();
    handler.destroy();
  });

  it('preserves the existing user prompt for origin authentication', () => {
    const webContents = new EventEmitter() as WebContents & EventEmitter;
    const onAuthRequestUpdate = vi.fn();
    const handler = new TabAuthenticationHandler(
      'tab-1',
      webContents,
      {
        debug: vi.fn(),
        warn: vi.fn(),
      } as unknown as Logger,
      { onAuthRequestUpdate },
      () => false,
    );
    const preventDefault = vi.fn();
    const callback = vi.fn();

    webContents.emit(
      'login',
      { preventDefault },
      { url: 'https://private.example.com', pid: 1 },
      {
        isProxy: false,
        scheme: 'basic',
        host: 'private.example.com',
        port: 443,
        realm: 'members',
      } satisfies AuthInfo,
      callback,
    );

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
    expect(onAuthRequestUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'https://private.example.com',
        host: 'private.example.com',
      }),
    );
    handler.destroy();
    expect(callback).toHaveBeenCalledWith();
  });
});
