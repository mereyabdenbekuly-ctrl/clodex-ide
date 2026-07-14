import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BeforeSendResponse,
  OnBeforeSendHeadersListenerDetails,
  Session,
  WebFrameMain,
} from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERATED_APP_MANIFEST_FILE } from '@shared/generated-app-manifest';
import {
  buildIsolatedAppOrigin,
  buildIsolatedAppUrl,
  type AppUrlIdentity,
} from '@shared/isolated-app-origin';
import {
  registerAppProtocol,
  type AppProtocolRegistrationOptions,
} from './app-protocol';
import { CLODEX_APP_REVISION_QUERY } from './app-protocol-security';
import {
  getIsolatedAppRevisionBinding,
  type IsolatedAppFrameAddress,
} from './app-protocol-revision-binding';
import { GeneratedAppIdentityResolver } from './generated-app-library/identity-resolver';
import type { Logger } from './logger';

const electronMocks = vi.hoisted(() => ({
  netFetch: vi.fn(),
}));
const pathMocks = vi.hoisted(() => ({
  agentsDir: '/tmp/clodex-app-protocol-unset',
  bundledPluginsDir: '/tmp/clodex-app-protocol-bundled-plugins',
  installedPluginsDir: '/tmp/clodex-app-protocol-installed-plugins',
}));

vi.mock('electron', () => ({
  net: { fetch: electronMocks.netFetch },
}));

vi.mock('@/utils/paths', () => ({
  getAgentsDir: () => pathMocks.agentsDir,
  getAgentAppsDir: (agentId: string) =>
    `${pathMocks.agentsDir}/${agentId}/apps`,
  getPluginsPath: () => pathMocks.bundledPluginsDir,
  getInstalledPluginsDir: () => pathMocks.installedPluginsDir,
}));

const APP_A = {
  namespace: 'agents' as const,
  entityId: 'agent-a',
  appId: 'dashboard',
};
const APP_B = {
  namespace: 'agents' as const,
  entityId: 'agent-b',
  appId: 'notes',
};
const FRAME_A = {
  webContentsId: 71,
  frameTreeNodeId: 171,
  processId: 271,
  frameToken: 'protocol-frame-a',
};
const FRAME_B = {
  webContentsId: 72,
  frameTreeNodeId: 172,
  processId: 272,
  frameToken: 'protocol-frame-b',
};

type ProtocolHandler = (request: Request) => Promise<Response>;
type BeforeHeadersListener = (
  details: OnBeforeSendHeadersListenerDetails,
  callback: (response: BeforeSendResponse) => void,
) => void;

type ProtocolHarness = {
  session: Session;
  handle: ProtocolHandler;
  mutateHeaders: (
    input: {
      url: string;
      resourceType: OnBeforeSendHeadersListenerDetails['resourceType'];
      address: IsolatedAppFrameAddress;
      frameUrl: string;
      referrer?: string;
    },
    initial?: Record<string, string>,
  ) => Record<string, string>;
};

function appUrl(
  identity: AppUrlIdentity,
  relativePath: string,
  revision?: string,
): string {
  const url = new URL(buildIsolatedAppUrl(identity, relativePath.split('/')));
  if (revision) url.searchParams.set(CLODEX_APP_REVISION_QUERY, revision);
  return url.toString();
}

function navigationRequest(
  url: string,
  internalHeaders: Record<string, string> = {},
): Request {
  return new Request(url, {
    headers: {
      ...internalHeaders,
      Referer: 'clodex://internal/preview',
      'Sec-Fetch-Dest': 'iframe',
      'Sec-Fetch-Mode': 'navigate',
    },
  });
}

function subresourceRequest(
  url: string,
  frameUrl: string,
  internalHeaders: Record<string, string> = {},
): Request {
  return new Request(url, {
    headers: {
      ...internalHeaders,
      Referer: frameUrl,
      'Sec-Fetch-Dest': 'script',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'same-origin',
    },
  });
}

describe('app protocol exact snapshot serving', () => {
  let root: string;
  let agentsDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'clodex-app-protocol-'));
    agentsDir = path.join(root, 'agents');
    pathMocks.agentsDir = agentsDir;
    pathMocks.bundledPluginsDir = path.join(root, 'bundled-plugins');
    pathMocks.installedPluginsDir = path.join(root, 'installed-plugins');
    await Promise.all([
      fs.mkdir(agentsDir),
      fs.mkdir(pathMocks.bundledPluginsDir),
      fs.mkdir(pathMocks.installedPluginsDir),
    ]);
    electronMocks.netFetch.mockReset();
    electronMocks.netFetch.mockImplementation(async (input: string) => {
      return new Response(
        await fs.readFile(fileURLToPath(input), { encoding: 'utf8' }),
      );
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeApp(
    input: {
      identity?: typeof APP_A | typeof APP_B;
      html?: string;
      script?: string;
      css?: string;
      manifestValue?: unknown;
    } = {},
  ): Promise<string> {
    const identity = input.identity ?? APP_A;
    const appRoot = path.join(
      agentsDir,
      identity.entityId,
      'apps',
      identity.appId,
    );
    await fs.mkdir(appRoot, { recursive: true });
    const manifestValue =
      input.manifestValue ??
      ({
        schemaVersion: 1,
        id: identity.appId,
        name: identity.appId,
        version: '1.0.0',
        entrypoint: 'index.html',
        capabilities: [],
      } satisfies Record<string, unknown>);
    await fs.writeFile(
      path.join(appRoot, GENERATED_APP_MANIFEST_FILE),
      typeof manifestValue === 'string'
        ? manifestValue
        : JSON.stringify(manifestValue),
    );
    await fs.writeFile(
      path.join(appRoot, 'index.html'),
      input.html ??
        '<!doctype html><link rel="stylesheet" href="styles.css"><script src="app.js"></script><main>ORIGINAL_HTML</main>',
    );
    await fs.writeFile(
      path.join(appRoot, 'app.js'),
      input.script ?? 'globalThis.ORIGINAL_SCRIPT = true;',
    );
    await fs.writeFile(
      path.join(appRoot, 'styles.css'),
      input.css ?? 'body { color: rgb(1, 2, 3); }',
    );
    return appRoot;
  }

  function makeHarness(
    identityResolver: AppProtocolRegistrationOptions['identityResolver'],
  ): ProtocolHarness {
    let protocolHandler: ProtocolHandler | null = null;
    let beforeHeadersListener: BeforeHeadersListener | null = null;
    const session = {
      protocol: {
        handle: vi.fn(
          (_scheme: string, handler: ProtocolHandler) =>
            (protocolHandler = handler),
        ),
      },
      webRequest: {
        onBeforeRequest: vi.fn(),
        onBeforeSendHeaders: vi.fn(
          (listener: BeforeHeadersListener) =>
            (beforeHeadersListener = listener),
        ),
      },
    } as unknown as Session;
    registerAppProtocol(session, { error: vi.fn() } as unknown as Logger, {
      identityResolver,
    });
    if (!protocolHandler || !beforeHeadersListener) {
      throw new Error('App protocol harness did not register listeners');
    }

    return {
      session,
      handle: protocolHandler,
      mutateHeaders: (input, initial = {}) => {
        let result: BeforeSendResponse | null = null;
        beforeHeadersListener?.(
          {
            id: 1,
            method: 'GET',
            timestamp: 1,
            requestHeaders: initial,
            url: input.url,
            resourceType: input.resourceType,
            referrer: input.referrer ?? input.frameUrl,
            webContentsId: input.address.webContentsId,
            frame: {
              url: input.frameUrl,
              frameTreeNodeId: input.address.frameTreeNodeId,
              processId: input.address.processId,
              frameToken: input.address.frameToken,
            } as WebFrameMain,
          },
          (response) => (result = response),
        );
        const output = (result as BeforeSendResponse | null)?.requestHeaders;
        const normalized: Record<string, string> = {};
        for (const [name, value] of Object.entries(output ?? {})) {
          normalized[name] = Array.isArray(value)
            ? value.join(', ')
            : String(value);
        }
        return normalized;
      },
    };
  }

  async function currentHash(
    resolver: GeneratedAppIdentityResolver,
    identity: typeof APP_A | typeof APP_B = APP_A,
  ): Promise<string> {
    const resolved = await resolver.resolve({
      kind: 'agent',
      agentId: identity.entityId,
      appId: identity.appId,
    });
    if (!resolved) throw new Error('Expected generated app identity');
    return resolved.identity.assetHash;
  }

  async function openRevisionedDocument(input: {
    harness: ProtocolHarness;
    identity?: typeof APP_A | typeof APP_B;
    address?: IsolatedAppFrameAddress;
    revision: string;
  }): Promise<{ frameUrl: string; response: Response }> {
    const identity = input.identity ?? APP_A;
    const address = input.address ?? FRAME_A;
    const frameUrl = appUrl(identity, 'index.html', input.revision);
    const headers = input.harness.mutateHeaders({
      url: frameUrl,
      resourceType: 'subFrame',
      address,
      frameUrl: 'clodex://internal/preview',
    });
    return {
      frameUrl,
      response: await input.harness.handle(
        navigationRequest(frameUrl, headers),
      ),
    };
  }

  it('serves initial parser CSS/JS from the exact provisional snapshot before hello', async () => {
    await writeApp();
    const resolver = new GeneratedAppIdentityResolver({ agentsDir });
    const harness = makeHarness(resolver);
    const revision = await currentHash(resolver);
    const opened = await openRevisionedDocument({
      harness,
      revision,
    });
    expect(opened.response.status).toBe(200);

    const cssUrl = appUrl(APP_A, 'styles.css');
    const jsUrl = appUrl(APP_A, 'app.js');
    const cssHeaders = harness.mutateHeaders({
      url: cssUrl,
      resourceType: 'stylesheet',
      address: FRAME_A,
      frameUrl: opened.frameUrl,
    });
    const jsHeaders = harness.mutateHeaders({
      url: jsUrl,
      resourceType: 'script',
      address: FRAME_A,
      frameUrl: opened.frameUrl,
    });

    // Exact broker hello upgrade happens after the parser issued both requests.
    getIsolatedAppRevisionBinding(harness.session).bindDocument({
      ...FRAME_A,
      documentToken: 'broker-session-a',
      origin: buildIsolatedAppOrigin(APP_A),
      agentId: APP_A.entityId,
      appId: APP_A.appId,
      revision,
    });
    const [cssResponse, jsResponse] = await Promise.all([
      harness.handle(subresourceRequest(cssUrl, opened.frameUrl, cssHeaders)),
      harness.handle(subresourceRequest(jsUrl, opened.frameUrl, jsHeaders)),
    ]);

    expect(cssResponse.status).toBe(200);
    expect(await cssResponse.text()).toBe('body { color: rgb(1, 2, 3); }');
    expect(jsResponse.status).toBe(200);
    expect(await jsResponse.text()).toBe('globalThis.ORIGINAL_SCRIPT = true;');
    expect(electronMocks.netFetch).not.toHaveBeenCalled();
  });

  it('serves captured H HTML across an H→M→H filesystem ABA', async () => {
    const appRoot = await writeApp();
    const resolver = new GeneratedAppIdentityResolver({ agentsDir });
    const harness = makeHarness(resolver);
    const revision = await currentHash(resolver);
    const originalResolveAsset = resolver.resolveAsset.bind(resolver);
    vi.spyOn(resolver, 'resolveAsset').mockImplementation(
      async (context, relativePath) => {
        const captured = await originalResolveAsset(context, relativePath);
        if (relativePath === 'index.html') {
          await fs.writeFile(
            path.join(appRoot, 'index.html'),
            '<!doctype html><script>MALICIOUS_HTML()</script>',
          );
          await fs.writeFile(
            path.join(appRoot, 'index.html'),
            '<!doctype html><main>ORIGINAL_HTML</main>',
          );
        }
        return captured;
      },
    );

    const opened = await openRevisionedDocument({ harness, revision });
    expect(opened.response.status).toBe(200);
    const body = await opened.response.text();
    expect(body).toContain('ORIGINAL_HTML');
    expect(body).not.toContain('MALICIOUS_HTML');
    expect(body).toContain(`expectedRevision="${revision}"`);
    expect(electronMocks.netFetch).not.toHaveBeenCalled();
  });

  it('denies an H subresource when M is captured even if disk returns to H before dispatch', async () => {
    const appRoot = await writeApp();
    const resolver = new GeneratedAppIdentityResolver({ agentsDir });
    const harness = makeHarness(resolver);
    const revision = await currentHash(resolver);
    const opened = await openRevisionedDocument({ harness, revision });
    expect(opened.response.status).toBe(200);
    getIsolatedAppRevisionBinding(harness.session).bindDocument({
      ...FRAME_A,
      documentToken: 'broker-session-a',
      origin: buildIsolatedAppOrigin(APP_A),
      agentId: APP_A.entityId,
      appId: APP_A.appId,
      revision,
    });

    const scriptUrl = appUrl(APP_A, 'app.js');
    const scriptHeaders = harness.mutateHeaders({
      url: scriptUrl,
      resourceType: 'script',
      address: FRAME_A,
      frameUrl: opened.frameUrl,
    });
    const original = 'globalThis.ORIGINAL_SCRIPT = true;';
    await fs.writeFile(
      path.join(appRoot, 'app.js'),
      'globalThis.MALICIOUS_SCRIPT = true;',
    );
    const originalResolveAsset = resolver.resolveAsset.bind(resolver);
    vi.spyOn(resolver, 'resolveAsset').mockImplementation(
      async (context, relativePath) => {
        const captured = await originalResolveAsset(context, relativePath);
        if (relativePath === 'app.js') {
          await fs.writeFile(path.join(appRoot, 'app.js'), original);
        }
        return captured;
      },
    );

    const response = await harness.handle(
      subresourceRequest(scriptUrl, opened.frameUrl, scriptHeaders),
    );
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('MALICIOUS_SCRIPT');
    expect(await fs.readFile(path.join(appRoot, 'app.js'), 'utf8')).toBe(
      original,
    );
    expect(electronMocks.netFetch).not.toHaveBeenCalled();
  });

  it('denies null, stale, and missing revision authority while legacy remains sandboxed', async () => {
    const appRoot = await writeApp();
    const resolver = new GeneratedAppIdentityResolver({ agentsDir });
    const harness = makeHarness(resolver);
    const revision = await currentHash(resolver);

    const missingUrl = appUrl(APP_A, 'app.js');
    const missingResponse = await harness.handle(
      subresourceRequest(missingUrl, appUrl(APP_A, 'index.html', revision)),
    );
    expect(missingResponse.status).toBe(400);

    await fs.writeFile(
      path.join(appRoot, 'app.js'),
      'globalThis.NEW_REVISION = true;',
    );
    const stale = await openRevisionedDocument({ harness, revision });
    expect(stale.response.status).toBe(409);

    const nullHarness = makeHarness({
      resolveAsset: vi.fn().mockResolvedValue(null),
    });
    const nullResponse = await openRevisionedDocument({
      harness: nullHarness,
      revision,
    });
    expect(nullResponse.response.status).toBe(409);

    await fs.writeFile(
      path.join(appRoot, GENERATED_APP_MANIFEST_FILE),
      '{malformed',
    );
    const legacyHarness = makeHarness(
      new GeneratedAppIdentityResolver({ agentsDir }),
    );
    const legacyUrl = appUrl(APP_A, 'index.html');
    const legacyResponse = await legacyHarness.handle(
      navigationRequest(legacyUrl),
    );
    expect(legacyResponse.status).toBe(200);
    const legacyBody = await legacyResponse.text();
    expect(legacyBody).toContain('data-clodex-isolated-bootstrap');
    expect(legacyBody).not.toContain('expectedRevision=');
    expect(electronMocks.netFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps concurrent previews and their snapshot revisions independent', async () => {
    await writeApp({ identity: APP_A, script: 'globalThis.APP = "A";' });
    await writeApp({ identity: APP_B, script: 'globalThis.APP = "B";' });
    const resolver = new GeneratedAppIdentityResolver({ agentsDir });
    const harness = makeHarness(resolver);
    const [revisionA, revisionB] = await Promise.all([
      currentHash(resolver, APP_A),
      currentHash(resolver, APP_B),
    ]);
    const [openedA, openedB] = await Promise.all([
      openRevisionedDocument({
        harness,
        identity: APP_A,
        address: FRAME_A,
        revision: revisionA,
      }),
      openRevisionedDocument({
        harness,
        identity: APP_B,
        address: FRAME_B,
        revision: revisionB,
      }),
    ]);
    expect(openedA.response.status).toBe(200);
    expect(openedB.response.status).toBe(200);

    const scriptA = appUrl(APP_A, 'app.js');
    const scriptB = appUrl(APP_B, 'app.js');
    const headersA = harness.mutateHeaders({
      url: scriptA,
      resourceType: 'script',
      address: FRAME_A,
      frameUrl: openedA.frameUrl,
    });
    const headersB = harness.mutateHeaders({
      url: scriptB,
      resourceType: 'script',
      address: FRAME_B,
      frameUrl: openedB.frameUrl,
    });
    const [responseA, responseB] = await Promise.all([
      harness.handle(subresourceRequest(scriptA, openedA.frameUrl, headersA)),
      harness.handle(subresourceRequest(scriptB, openedB.frameUrl, headersB)),
    ]);
    expect(await responseA.text()).toBe('globalThis.APP = "A";');
    expect(await responseB.text()).toBe('globalThis.APP = "B";');
    expect(electronMocks.netFetch).not.toHaveBeenCalled();
  });
});
