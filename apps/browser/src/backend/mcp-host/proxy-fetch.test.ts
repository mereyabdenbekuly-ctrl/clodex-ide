import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createNetworkProxyFetch } from './proxy-fetch';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe('createNetworkProxyFetch', () => {
  it('uses absolute-form HTTP requests and authenticates only to the proxy', async () => {
    let observed:
      | { url: string | undefined; authorization: string | undefined }
      | undefined;
    const proxy = http.createServer((request, response) => {
      observed = {
        url: request.url,
        authorization: request.headers['proxy-authorization'],
      };
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end('{"ok":true}');
    });
    const port = await listen(proxy);
    const fetch = createNetworkProxyFetch({
      url: `http://127.0.0.1:${port}`,
      authorization: 'Basic managed-secret',
    });

    const response = await fetch('http://mcp.example.com/v1?secret=value', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer server-secret',
        'Content-Type': 'application/json',
        'Proxy-Authorization': 'Basic attacker-controlled',
      },
      body: '{"hello":"world"}',
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(observed).toEqual({
      url: 'http://mcp.example.com/v1?secret=value',
      authorization: 'Basic managed-secret',
    });
  });

  it('uses an authenticated CONNECT tunnel for HTTPS requests', async () => {
    let observed:
      | { url: string | undefined; authorization: string | undefined }
      | undefined;
    const proxy = http.createServer();
    proxy.on('connect', (request, socket) => {
      observed = {
        url: request.url,
        authorization: request.headers['proxy-authorization'],
      };
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    const port = await listen(proxy);
    const fetch = createNetworkProxyFetch({
      url: `http://127.0.0.1:${port}`,
      authorization: 'Basic managed-secret',
    });

    expect((await fetch('https://mcp.example.com/v1')).status).toBe(502);
    expect(observed).toEqual({
      url: 'mcp.example.com:443',
      authorization: 'Basic managed-secret',
    });
  });
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}
