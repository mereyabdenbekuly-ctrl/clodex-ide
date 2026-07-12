import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('update server HTTP routes', () => {
  let server: Server;
  let origin: string;

  beforeEach(async () => {
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('serves the health endpoint through Express 5', async () => {
    const response = await fetch(`${origin}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('rejects an unknown application before querying GitHub', async () => {
    const response = await fetch(
      `${origin}/download/not-clodex/release/macos/arm64`,
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe('App not found');
  });

  it('rejects an invalid channel before querying GitHub', async () => {
    const response = await fetch(
      `${origin}/download/clodex/invalid/macos/arm64`,
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe('Invalid channel');
  });
});
