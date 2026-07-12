import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { NetworkPolicyScope } from '@shared/network-policy';
import type { NetworkPolicyEngine } from '.';

const PROXY_USERNAME = 'clodex';
const MAX_CAPABILITIES = 1_024;
const CONNECT_TIMEOUT_MS = 10_000;

export interface EgressProxyCapability {
  url: string;
  authorization: string;
}

export interface TransparentEgressProxyOptions {
  engine: NetworkPolicyEngine;
  hostname?: string;
}

export class TransparentEgressProxy {
  private readonly server: http.Server;
  private readonly capabilities = new Map<string, NetworkPolicyScope>();
  private readonly sockets = new Set<net.Socket>();
  private port = 0;

  private constructor(
    private readonly engine: NetworkPolicyEngine,
    private readonly hostname: string,
  ) {
    this.server = http.createServer((request, response) => {
      void this.handleHttpRequest(request, response).catch(() => {
        if (!response.headersSent) {
          response.writeHead(502, { Connection: 'close' });
        }
        response.end();
      });
    });
    this.server.on('connect', (request, socket, head) => {
      void this.handleConnect(request, socket, head).catch(() => {
        if (!socket.destroyed) {
          socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        }
      });
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
  }

  public static async create(
    options: TransparentEgressProxyOptions,
  ): Promise<TransparentEgressProxy> {
    const proxy = new TransparentEgressProxy(
      options.engine,
      options.hostname ?? '127.0.0.1',
    );
    await proxy.listen();
    return proxy;
  }

  public issueCapability(scope: NetworkPolicyScope): EgressProxyCapability {
    if (this.capabilities.size >= MAX_CAPABILITIES) {
      throw new Error('Transparent egress proxy capability limit reached');
    }
    const token = randomBytes(32).toString('base64url');
    this.capabilities.set(token, structuredClone(scope));
    return {
      url: `http://${this.hostname}:${this.port}`,
      authorization: `Basic ${Buffer.from(
        `${PROXY_USERNAME}:${token}`,
      ).toString('base64')}`,
    };
  }

  public revokeCapability(capability: EgressProxyCapability): void {
    const token = parseAuthorizationToken(capability.authorization);
    if (token) this.capabilities.delete(token);
  }

  public async teardown(): Promise<void> {
    this.capabilities.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        const address = this.server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Transparent egress proxy has no TCP address'));
          return;
        }
        this.port = address.port;
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(0, this.hostname);
    });
  }

  private authenticate(
    request: http.IncomingMessage,
  ): NetworkPolicyScope | null {
    const token = parseAuthorizationToken(
      request.headers['proxy-authorization'],
    );
    return token ? (this.capabilities.get(token) ?? null) : null;
  }

  private async handleConnect(
    request: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const scope = this.authenticate(request);
    if (!scope) {
      clientSocket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="clodex-egress"\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    const authority = parseConnectAuthority(request.url);
    if (!authority) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }

    const resolution = await this.engine.resolveAndEvaluate({
      scope,
      destination: `https://${formatAuthority(
        authority.hostname,
        authority.port,
      )}`,
    });
    if (resolution.decision.decision !== 'allow' || !resolution.pinnedAddress) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }

    const upstream = net.connect({
      host: resolution.pinnedAddress.address,
      port: authority.port,
    });
    const timeout = setTimeout(() => {
      upstream.destroy(new Error('Egress proxy upstream connect timed out'));
    }, CONNECT_TIMEOUT_MS);
    upstream.once('connect', () => {
      clearTimeout(timeout);
      clientSocket.write(
        'HTTP/1.1 200 Connection Established\r\nProxy-Agent: clodex-egress\r\n\r\n',
      );
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.once('error', () => {
      clearTimeout(timeout);
      if (!clientSocket.destroyed) {
        clientSocket.end(
          'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n',
        );
      }
    });
    clientSocket.once('error', () => upstream.destroy());
    clientSocket.once('close', () => upstream.destroy());
  }

  private async handleHttpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const scope = this.authenticate(request);
    if (!scope) {
      response.writeHead(407, {
        'Proxy-Authenticate': 'Basic realm="clodex-egress"',
        Connection: 'close',
      });
      response.end();
      return;
    }

    let destination: URL;
    try {
      destination = new URL(request.url ?? '');
    } catch {
      response.writeHead(400, { Connection: 'close' });
      response.end();
      return;
    }
    if (destination.protocol !== 'http:') {
      response.writeHead(400, { Connection: 'close' });
      response.end();
      return;
    }

    const resolution = await this.engine.resolveAndEvaluate({
      scope,
      destination: destination.href,
    });
    if (resolution.decision.decision !== 'allow' || !resolution.pinnedAddress) {
      response.writeHead(403, { Connection: 'close' });
      response.end();
      return;
    }

    const headers = sanitizeForwardHeaders(request.headers);
    headers.host = destination.host;
    const upstream = http.request(
      {
        host: resolution.pinnedAddress.address,
        family: resolution.pinnedAddress.family,
        port: Number(destination.port || 80),
        method: request.method,
        path: `${destination.pathname}${destination.search}`,
        headers,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          sanitizeForwardHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
      },
    );
    upstream.once('error', () => {
      if (!response.headersSent) {
        response.writeHead(502, { Connection: 'close' });
      }
      response.end();
    });
    request.once('aborted', () => upstream.destroy());
    request.pipe(upstream);
  }
}

function parseAuthorizationToken(
  authorization: string | string[] | undefined,
): string | null {
  if (typeof authorization !== 'string') return null;
  const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(authorization);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1] ?? '', 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (
    separator < 0 ||
    decoded.slice(0, separator) !== PROXY_USERNAME ||
    decoded.length - separator - 1 < 32
  ) {
    return null;
  }
  return decoded.slice(separator + 1);
}

function parseConnectAuthority(
  value: string | undefined,
): { hostname: string; port: number } | null {
  if (!value || value.includes('@') || value.includes('/')) return null;
  try {
    const url = new URL(`https://${value}`);
    const port = Number(url.port || 443);
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return null;
    }
    return { hostname: url.hostname.replace(/^\[|\]$/g, ''), port };
  } catch {
    return null;
  }
}

function formatAuthority(hostname: string, port: number): string {
  return `${net.isIP(hostname) === 6 ? `[${hostname}]` : hostname}:${port}`;
}

function sanitizeForwardHeaders(
  source: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(source)) {
    if (
      value === undefined ||
      [
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'proxy-connection',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
      ].includes(name.toLowerCase())
    ) {
      continue;
    }
    headers[name] = value;
  }
  return headers;
}
