import type { McpNetworkProxyConfig } from '@clodex/mcp-runtime';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

export function createNetworkProxyFetch(
  proxy: McpNetworkProxyConfig,
): FetchLike {
  const httpsAgent = new HttpsProxyAgent(proxy.url, {
    headers: () => ({
      'Proxy-Authorization': proxy.authorization,
    }),
  });

  return async (input, init) => {
    const url = toUrl(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Managed MCP proxy supports only HTTP and HTTPS');
    }
    const request = await normalizeRequest(init);
    return await new Promise<Response>((resolve, reject) => {
      const headers = Object.fromEntries(request.headers.entries());
      const options: http.RequestOptions = {
        method: request.method,
        headers,
        signal: request.signal,
      };
      let outbound: http.ClientRequest;
      if (url.protocol === 'https:') {
        outbound = https.request(url, { ...options, agent: httpsAgent });
      } else {
        const proxyUrl = new URL(proxy.url);
        outbound = http.request({
          ...options,
          hostname: proxyUrl.hostname,
          port: Number(proxyUrl.port || 80),
          path: url.href,
          headers: {
            ...headers,
            host: url.host,
            'proxy-authorization': proxy.authorization,
          },
        });
      }
      outbound.once('response', (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item);
          } else if (value !== undefined) {
            responseHeaders.set(name, value);
          }
        }
        resolve(
          new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
            status: incoming.statusCode ?? 502,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          }),
        );
      });
      outbound.once('error', reject);
      if (request.body.length > 0) outbound.write(request.body);
      outbound.end();
    });
  };
}

async function normalizeRequest(init: Parameters<FetchLike>[1]): Promise<{
  method: string;
  headers: Headers;
  body: Buffer;
  signal: AbortSignal | undefined;
}> {
  const method = init?.method ?? 'GET';
  const headers = new Headers();
  new Headers(init?.headers).forEach((value, name) => {
    headers.set(name, value);
  });
  headers.delete('proxy-authorization');

  const bodySource = init?.body;
  let body = Buffer.alloc(0);
  if (bodySource !== undefined && bodySource !== null) {
    body = Buffer.from(await new Response(bodySource).arrayBuffer());
  }
  return {
    method,
    headers,
    body,
    signal: init?.signal ?? undefined,
  };
}

function toUrl(input: Parameters<FetchLike>[0]): URL {
  return typeof input === 'string' ? new URL(input) : input;
}
