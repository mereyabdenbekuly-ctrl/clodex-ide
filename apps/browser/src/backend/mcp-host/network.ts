import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

export function createOriginBoundFetch(
  expectedOrigin: string,
  fetchImpl: FetchLike = globalThis.fetch,
): FetchLike {
  return async (input, init) => {
    const url = toUrl(input);
    if (url.origin !== expectedOrigin) {
      throw new Error(
        `MCP request origin ${url.origin} does not match configured origin ${expectedOrigin}`,
      );
    }
    const response = await fetchImpl(input, {
      ...init,
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`MCP endpoint redirect was blocked (${response.status})`);
    }
    return response;
  };
}

export function createOAuthOriginBoundFetch(
  serverOrigin: string,
  allowedAuthorizationOrigins: string[],
  fetchImpl: FetchLike = globalThis.fetch,
): FetchLike {
  const allowed = new Set([
    serverOrigin,
    ...allowedAuthorizationOrigins.map((value) => new URL(value).origin),
  ]);
  return async (input, init) => {
    const url = toUrl(input);
    if (!allowed.has(url.origin)) {
      throw new Error(
        `MCP OAuth request origin ${url.origin} is outside the registered origin set`,
      );
    }
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))
    ) {
      throw new Error('MCP OAuth requests require HTTPS or loopback HTTP');
    }
    if (url.username || url.password || url.hash) {
      throw new Error(
        'MCP OAuth requests may not contain credentials or fragments',
      );
    }
    const requestInit =
      url.origin === serverOrigin
        ? init
        : {
            ...init,
            headers: keepOAuthProtocolHeaders(init?.headers),
          };
    const response = await fetchImpl(input, {
      ...requestInit,
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`MCP OAuth redirect was blocked (${response.status})`);
    }
    return response;
  };
}

function keepOAuthProtocolHeaders(
  headersInit: HeadersInit | undefined,
): Headers {
  const source = new Headers(headersInit);
  const result = new Headers();
  for (const key of ['accept', 'authorization', 'content-type']) {
    const value = source.get(key);
    if (value !== null) result.set(key, value);
  }
  return result;
}

function toUrl(input: Parameters<FetchLike>[0]): URL {
  if (typeof input === 'string') return new URL(input);
  return input;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}
