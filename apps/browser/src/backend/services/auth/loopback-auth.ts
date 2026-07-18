import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

const LOOPBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/auth/callback';
const SERVER_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_CALLBACK_URL_BYTES = 2048;
const MAX_CODE_LENGTH = 512;
const MAX_ERROR_LENGTH = 256;

export type LoopbackAuthCallback =
  | { code: string; kind: 'authorization'; state: string }
  | { error: string; kind: 'error'; state: string };

export type LoopbackAuthServer = {
  callbackUrl: string;
  dispose: () => Promise<void>;
};

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    'Cache-Control': 'no-store, max-age=0',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Content-Type': contentType,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function sendText(
  res: ServerResponse<IncomingMessage>,
  status: number,
  message: string,
): void {
  res.writeHead(status, securityHeaders('text/plain; charset=utf-8'));
  res.end(message);
}

function sendCompletionPage(
  res: ServerResponse<IncomingMessage>,
  success: boolean,
): void {
  res.writeHead(
    success ? 200 : 400,
    securityHeaders('text/html; charset=utf-8'),
  );
  res.end(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>CLODEx sign-in</title></head>
  <body><p>${
    success
      ? 'Authentication complete. You can close this window and return to CLODEx.'
      : 'Authentication could not be completed. Return to CLODEx and try again.'
  }</p></body>
</html>`);
}

function hasOnlyAllowedParameters(url: URL): boolean {
  const allowed = new Set(['code', 'state', 'error', 'error_description']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      return false;
    }
  }
  return true;
}

function parseCallback(
  req: IncomingMessage,
  expectedHost: string,
  expectedState: string,
): LoopbackAuthCallback | null {
  const rawUrl = req.url ?? '';
  if (Buffer.byteLength(rawUrl, 'utf8') > MAX_CALLBACK_URL_BYTES) return null;
  if (req.headers.host !== expectedHost) return null;

  let url: URL;
  try {
    url = new URL(rawUrl, `http://${expectedHost}`);
  } catch {
    return null;
  }

  if (
    url.protocol !== 'http:' ||
    url.hostname !== LOOPBACK_HOST ||
    url.host !== expectedHost ||
    url.username ||
    url.password ||
    url.pathname !== CALLBACK_PATH ||
    url.hash ||
    !hasOnlyAllowedParameters(url)
  ) {
    return null;
  }

  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const error =
    url.searchParams.get('error_description') ?? url.searchParams.get('error');

  if (state !== expectedState || Boolean(code) === Boolean(error)) return null;
  if (code) {
    if (code.length > MAX_CODE_LENGTH || !/^[A-Za-z0-9_-]+$/.test(code)) {
      return null;
    }
    return { code, kind: 'authorization', state };
  }
  if (!error || error.length > MAX_ERROR_LENGTH) return null;
  return { error, kind: 'error', state };
}

/**
 * Starts a production-safe RFC 8252 loopback receiver. It binds only to the
 * IPv4 loopback interface, validates the exact Host/path/state/query schema,
 * accepts one callback, and never exposes the resulting authorization code to
 * the renderer process.
 */
export async function createLoopbackAuthServer(options: {
  expectedState: string;
  onCallback: (callback: LoopbackAuthCallback) => Promise<boolean>;
}): Promise<LoopbackAuthServer> {
  let timeout: NodeJS.Timeout | null = null;
  let disposed = false;
  let callbackClaimed = false;
  let expectedHost = '';

  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, {
        ...securityHeaders('text/plain; charset=utf-8'),
        Allow: 'GET',
      });
      res.end('Method not allowed');
      return;
    }

    const callback = parseCallback(req, expectedHost, options.expectedState);
    if (!callback) {
      sendText(res, 400, 'Invalid authentication callback.');
      return;
    }
    if (callbackClaimed) {
      sendText(res, 409, 'Authentication callback was already used.');
      return;
    }
    callbackClaimed = true;

    void options
      .onCallback(callback)
      .then((handled) => sendCompletionPage(res, handled))
      .catch(() => sendCompletionPage(res, false))
      .finally(() => {
        setImmediate(() => {
          void dispose();
        });
      });
  });

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    await closeServer(server);
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await dispose();
    throw new Error('Failed to bind the CLODEx loopback callback server.');
  }

  expectedHost = `${LOOPBACK_HOST}:${address.port}`;
  timeout = setTimeout(() => {
    void dispose();
  }, SERVER_TIMEOUT_MS);

  return {
    callbackUrl: `http://${expectedHost}${CALLBACK_PATH}`,
    dispose,
  };
}
