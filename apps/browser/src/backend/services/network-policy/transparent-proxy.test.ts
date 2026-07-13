import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { NetworkPolicy } from '@shared/network-policy';
import { afterEach, describe, expect, it } from 'vitest';
import { NetworkPolicyEngine } from '.';
import { parseNetworkPolicyAuditRecords } from './audit-ledger';
import {
  type EgressProxyCapability,
  TransparentEgressProxy,
} from './transparent-proxy';

const teardowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(teardowns.splice(0).map((teardown) => teardown()));
});

describe('TransparentEgressProxy', () => {
  it('requires a capability and stops accepting it after revocation', async () => {
    const { proxy, capability } = await makeProxy(80);

    expect(
      await proxyStatus(proxyUrl(capability), 'http://service.test/'),
    ).toBe(407);
    proxy.revokeCapability(capability);
    expect(
      await proxyStatus(
        proxyUrl(capability),
        'http://service.test/',
        capability.authorization,
      ),
    ).toBe(407);
  });

  it('forwards HTTP to the pinned address without leaking proxy credentials', async () => {
    let received:
      | {
          host: string | undefined;
          path: string | undefined;
          proxyAuth: unknown;
        }
      | undefined;
    const upstream = http.createServer((request, response) => {
      received = {
        host: request.headers.host,
        path: request.url,
        proxyAuth: request.headers['proxy-authorization'],
      };
      response.end('proxied');
    });
    const port = await listen(upstream);
    const { capability } = await makeProxy(port);

    const result = await proxyRequest(
      capability,
      `http://service.test:${port}/private?token=secret`,
    );

    expect(result).toEqual({ status: 200, body: 'proxied' });
    expect(received).toEqual({
      host: `service.test:${port}`,
      path: '/private?token=secret',
      proxyAuth: undefined,
    });
  });

  it('allows only an exact loopback grant and denies a second local port without connecting', async () => {
    const allowedBody = 'allowed-private-response';
    let allowedRequests = 0;
    const allowed = http.createServer((_request, response) => {
      allowedRequests += 1;
      response.end(allowedBody);
    });
    const allowedPort = await listen(allowed);

    let deniedConnections = 0;
    let deniedRequests = 0;
    let deniedBodyBytes = 0;
    const denied = http.createServer((request, response) => {
      deniedRequests += 1;
      request.on('data', (chunk: Buffer) => {
        deniedBodyBytes += chunk.length;
      });
      response.end('denied-private-response');
    });
    denied.on('connection', () => {
      deniedConnections += 1;
    });
    const deniedPort = await listen(denied);

    const { capability, auditPath } = await makeProxy(allowedPort, {
      id: 'exact-loopback-grant-test',
      version: 1,
      mode: 'allowlist',
      allowedHosts: [],
      allowedPorts: [],
      allowedDestinations: [
        { protocol: 'http', hostname: '127.0.0.1', port: allowedPort },
      ],
      allowPrivateNetworks: false,
      allowLoopback: false,
      allowIpLiterals: false,
    });
    const allowedDestination = `http://127.0.0.1:${allowedPort}/allowed-private?token=allow-secret`;
    const deniedDestination = `http://127.0.0.1:${deniedPort}/denied-private?token=deny-secret`;

    await expect(proxyRequest(capability, allowedDestination)).resolves.toEqual(
      { status: 200, body: allowedBody },
    );
    await expect(proxyRequest(capability, deniedDestination)).resolves.toEqual({
      status: 403,
      body: '',
    });
    expect(allowedRequests).toBe(1);
    expect(deniedConnections).toBe(0);
    expect(deniedRequests).toBe(0);
    expect(deniedBodyBytes).toBe(0);

    const auditContent = await fs.readFile(auditPath, 'utf8');
    expect(parseNetworkPolicyAuditRecords(auditContent)).toEqual([
      expect.objectContaining({
        destinationPort: allowedPort,
        protocol: 'http',
        decision: 'allow',
        reason: 'exact-destination-grant',
      }),
      expect.objectContaining({
        destinationPort: deniedPort,
        protocol: 'http',
        decision: 'deny',
        reason: 'loopback-denied',
      }),
    ]);
    for (const rawValue of [
      allowedDestination,
      deniedDestination,
      '127.0.0.1',
      '/allowed-private',
      '/denied-private',
      'allow-secret',
      'deny-secret',
      allowedBody,
      'denied-private-response',
    ]) {
      expect(auditContent).not.toContain(rawValue);
    }
  });

  it('establishes CONNECT tunnels to the DNS-pinned socket', async () => {
    const upstream = net.createServer((socket) => {
      socket.on('data', (chunk) => socket.write(`echo:${chunk.toString()}`));
    });
    const port = await listen(upstream);
    const { capability } = await makeProxy(port);
    const proxyAddress = new URL(capability.url);
    const socket = net.connect({
      host: proxyAddress.hostname,
      port: Number(proxyAddress.port),
    });
    teardowns.push(async () => {
      socket.destroy();
    });

    socket.write(
      `CONNECT service.test:${port} HTTP/1.1\r\nHost: service.test:${port}\r\nProxy-Authorization: ${capability.authorization}\r\n\r\n`,
    );
    const connected = await readUntil(socket, '\r\n\r\n');
    expect(connected).toContain('200 Connection Established');

    socket.write('ping');
    expect(await readUntil(socket, 'echo:ping')).toContain('echo:ping');
  });
});

async function makeProxy(
  port: number,
  policyOverride?: NetworkPolicy,
): Promise<{
  proxy: TransparentEgressProxy;
  capability: EgressProxyCapability;
  auditPath: string;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clodex-proxy-'));
  const auditPath = path.join(directory, 'audit.jsonl');
  const policy: NetworkPolicy =
    policyOverride ??
    ({
      id: 'proxy-test',
      version: 1,
      mode: 'allowlist',
      allowedHosts: ['service.test'],
      allowedPorts: [port],
      allowedDestinations: [],
      allowPrivateNetworks: true,
      allowLoopback: true,
      allowIpLiterals: false,
    } satisfies NetworkPolicy);
  const engine = await NetworkPolicyEngine.create({
    auditPath,
    resolvePolicy: () => policy,
    resolveDns: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  const proxy = await TransparentEgressProxy.create({ engine });
  teardowns.push(async () => {
    await proxy.teardown();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    proxy,
    auditPath,
    capability: proxy.issueCapability({
      principalKind: 'mcp',
      principalId: 'test-server',
    }),
  };
}

function proxyUrl(capability: EgressProxyCapability): URL {
  return new URL(capability.url);
}

async function proxyStatus(
  proxy: URL,
  destination: string,
  authorization?: string,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const request = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port),
      path: destination,
      headers: authorization
        ? { 'Proxy-Authorization': authorization }
        : undefined,
    });
    request.once('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once('error', reject);
    request.end();
  });
}

async function proxyRequest(
  capability: EgressProxyCapability,
  destination: string,
): Promise<{ status: number; body: string }> {
  const proxy = new URL(capability.url);
  return await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port),
      path: destination,
      headers: { 'Proxy-Authorization': capability.authorization },
    });
    request.once('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    request.once('error', reject);
    request.end();
  });
}

async function listen(server: http.Server | net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  teardowns.push(
    async () =>
      await new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return (server.address() as AddressInfo).port;
}

async function readUntil(socket: net.Socket, marker: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let content = '';
    const onData = (chunk: Buffer) => {
      content += chunk.toString('utf8');
      if (!content.includes(marker)) return;
      cleanup();
      resolve(content);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}
