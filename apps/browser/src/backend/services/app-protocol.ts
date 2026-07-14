import { net, type Session } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  getAgentAppsDir,
  getInstalledPluginsDir,
  getPluginsPath,
} from '@/utils/paths';
import {
  parseAppUrlIdentity,
  type ParsedAppUrlIdentity,
} from '@shared/isolated-app-origin';
import { inferMimeType } from '@shared/mime-utils';
import {
  CLODEX_APP_REVISION_QUERY,
  ISOLATED_APP_RESPONSE_HEADERS,
  decideAppContentRevision,
  hardenIsolatedAppHtml,
  parseCanonicalAppContentRevision,
  shouldBlockIsolatedAppRequest,
} from './app-protocol-security';
import { GeneratedAppIdentityResolver } from './generated-app-library/identity-resolver';
import { getIsolatedAppRevisionBinding } from './app-protocol-revision-binding';
import { registerBeforeSendHeadersMutator } from './web-request-before-send-headers';
import type { Logger } from './logger';

type AppProtocolIdentityResolver = Pick<
  GeneratedAppIdentityResolver,
  'resolveAsset'
>;

export type AppProtocolRegistrationOptions = {
  identityResolver?: AppProtocolIdentityResolver;
};

const networkGuardedSessions = new WeakSet<Session>();
const revisionBindingRegisteredSessions = new WeakSet<Session>();

function decodePathParts(pathname: string): string[] | null {
  try {
    return pathname
      .replace(/^\//, '')
      .split('/')
      .map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

function isSafePathPart(part: string): boolean {
  return (
    part.length > 0 &&
    part !== '.' &&
    part !== '..' &&
    !part.includes('/') &&
    !part.includes('\\') &&
    !part.includes('\0')
  );
}

function isNavigationRequest(request: Request): boolean {
  const secFetchDest = request.headers.get('Sec-Fetch-Dest');
  const secFetchMode = request.headers.get('Sec-Fetch-Mode');
  return (
    secFetchMode === 'navigate' ||
    secFetchDest === 'iframe' ||
    secFetchDest === 'document'
  );
}

function isTrustedClodexReferer(value: string): boolean {
  try {
    const url = new URL(value);
    if (!value.startsWith('clodex://')) return false;
    const authorityEnd = value.slice('clodex://'.length).search(/[/?#]/);
    const authority =
      authorityEnd === -1
        ? value.slice('clodex://'.length)
        : value.slice('clodex://'.length, 'clodex://'.length + authorityEnd);
    return (
      authority === 'internal' &&
      url.protocol === 'clodex:' &&
      url.hostname === 'internal' &&
      url.host === 'internal' &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}

async function hasCanonicalFilesystemIdentity(
  entityDir: string,
  appDir: string,
  entityId: string,
  appId: string,
): Promise<boolean> {
  try {
    const [entityEntries, appEntries, entityStat, appsStat, appStat] =
      await Promise.all([
        fs.readdir(path.dirname(entityDir)),
        fs.readdir(path.dirname(appDir)),
        fs.lstat(entityDir),
        fs.lstat(path.dirname(appDir)),
        fs.lstat(appDir),
      ]);
    return (
      entityEntries.includes(entityId) &&
      appEntries.includes(appId) &&
      !entityStat.isSymbolicLink() &&
      !appsStat.isSymbolicLink() &&
      !appStat.isSymbolicLink()
    );
  } catch {
    return false;
  }
}

function isSameAppReferer(
  referer: string,
  target: ParsedAppUrlIdentity,
): boolean {
  try {
    const refererUrl = new URL(referer);
    if (refererUrl.protocol === 'clodex:') {
      return isTrustedClodexReferer(referer);
    }
    if (refererUrl.protocol !== 'app:') return false;

    const refererIdentity = parseAppUrlIdentity(referer);
    return (
      refererIdentity?.classification === target.classification &&
      refererIdentity.host === target.host &&
      refererIdentity.identity.namespace === target.identity.namespace &&
      refererIdentity.identity.entityId === target.identity.entityId &&
      refererIdentity.identity.appId === target.identity.appId
    );
  } catch {
    return false;
  }
}

function isTrustedAppProtocolRequest(
  request: Request,
  target: ParsedAppUrlIdentity,
): boolean {
  const isNavigation = isNavigationRequest(request);
  const referer = request.headers.get('Referer');
  const hasTrustedReferer = referer ? isSameAppReferer(referer, target) : false;

  const secFetchSite = request.headers.get('Sec-Fetch-Site');
  if (secFetchSite === 'cross-site' && !isNavigation && !hasTrustedReferer)
    return false;

  const origin = request.headers.get('Origin');
  if (origin && origin !== 'null') {
    try {
      const originProtocol = new URL(origin).protocol;
      if (originProtocol === 'clodex:') return origin === 'clodex://internal';
      if (originProtocol !== 'app:') return false;
      return origin === target.origin && hasTrustedReferer;
    } catch {
      return false;
    }
  }

  if (referer) return hasTrustedReferer;

  // Electron custom-protocol iframe navigations can omit Fetch Metadata,
  // Origin, and Referer entirely. Only navigation gets that narrow exception;
  // a subresource with no trustworthy initiator context fails closed.
  return isNavigation;
}

function hasReservedRevisionParameter(url: URL): boolean {
  return [...url.searchParams.keys()].some(
    (key) => key.toLowerCase() === CLODEX_APP_REVISION_QUERY.toLowerCase(),
  );
}

function getSameIsolatedAppReferer(
  request: Request,
  target: ParsedAppUrlIdentity,
): string | null {
  const referer = request.headers.get('Referer');
  if (!referer) return null;
  const parsed = parseAppUrlIdentity(referer);
  return parsed?.classification === 'isolated' &&
    parsed.host === target.host &&
    parsed.identity.namespace === target.identity.namespace &&
    parsed.identity.entityId === target.identity.entityId &&
    parsed.identity.appId === target.identity.appId
    ? referer
    : null;
}

function registerIsolatedAppNetworkGuard(targetSession: Session): void {
  if (networkGuardedSessions.has(targetSession)) return;
  networkGuardedSessions.add(targetSession);
  targetSession.webRequest.onBeforeRequest((details, callback) => {
    let frameUrl: string | null = null;
    try {
      frameUrl = details.frame?.url ?? null;
    } catch {
      // A destroyed frame is still attributable through its referrer, if any.
    }
    callback({
      cancel: shouldBlockIsolatedAppRequest({
        url: details.url,
        frameUrl,
        referrer: details.referrer,
        resourceType: details.resourceType,
      }),
    });
  });
}

/**
 * Register the app:// protocol handler on a specific Electron session.
 *
 * Isolated URL format:
 *   app://agents-{digest}/{agentId}/{appId}/{relativePath}
 *   app://plugins-{digest}/{pluginId}/{appId}/{relativePath}
 *
 * Legacy serve-only compatibility:
 *   app://agents/{agentId}/{appId}/{relativePath}
 *   app://plugins/{pluginId}/{appId}/{relativePath}
 */
export function registerAppProtocol(
  targetSession: Session,
  logger: Logger,
  options: AppProtocolRegistrationOptions = {},
): void {
  const identityResolver =
    options.identityResolver ?? new GeneratedAppIdentityResolver();
  const revisionBinding = getIsolatedAppRevisionBinding(targetSession);
  if (!revisionBindingRegisteredSessions.has(targetSession)) {
    revisionBindingRegisteredSessions.add(targetSession);
    registerBeforeSendHeadersMutator(
      targetSession,
      revisionBinding.mutateRequestHeaders.bind(revisionBinding),
    );
  }
  registerIsolatedAppNetworkGuard(targetSession);
  targetSession.protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      const target = parseAppUrlIdentity(request.url);
      if (!target) return new Response('Invalid app URL', { status: 400 });

      if (!isTrustedAppProtocolRequest(request, target)) {
        return new Response('Forbidden', { status: 403 });
      }

      const pathParts = decodePathParts(url.pathname);
      if (!pathParts) return new Response('Invalid app URL', { status: 400 });

      const { namespace, entityId, appId } = target.identity;
      const relativePathParts = pathParts.slice(2);

      if (
        !entityId ||
        !appId ||
        relativePathParts.length === 0 ||
        !isSafePathPart(entityId) ||
        !isSafePathPart(appId) ||
        relativePathParts.some((part) => !isSafePathPart(part))
      ) {
        return new Response('Invalid app URL', { status: 400 });
      }

      let entityDir: string;
      let appDir: string;
      if (namespace === 'agents') {
        entityDir = path.resolve(getAgentAppsDir(entityId), '..');
        appDir = path.resolve(entityDir, 'apps', appId);
      } else if (namespace === 'plugins') {
        const bundledPluginRoot = path.resolve(getPluginsPath(), entityId);
        const installedPluginRoot = path.resolve(
          getInstalledPluginsDir(),
          entityId,
        );
        let pluginRoot = bundledPluginRoot;
        try {
          await fs.realpath(bundledPluginRoot);
        } catch {
          pluginRoot = installedPluginRoot;
        }
        entityDir = pluginRoot;
        appDir = path.resolve(entityDir, 'apps', appId);
      } else return new Response('Unknown app namespace', { status: 400 });

      // APFS and other case-/normalization-insensitive filesystems can resolve
      // multiple spellings to the same directory. Require the exact directory
      // entries and reject identity-component symlinks so one physical app
      // cannot acquire multiple isolated origins through path aliases.
      if (
        !(await hasCanonicalFilesystemIdentity(
          entityDir,
          appDir,
          entityId,
          appId,
        ))
      ) {
        return new Response('Invalid app URL', { status: 400 });
      }

      const relativePath = relativePathParts.join('/');
      const requestedPath = path.resolve(appDir, ...relativePathParts);
      if (!requestedPath.startsWith(appDir + path.sep))
        return new Response('Path traversal denied', { status: 400 });

      const mime = inferMimeType(relativePath);
      const isolated = target.classification === 'isolated';
      const responseHeaders = {
        'Content-Type': mime,
        'Cache-Control': 'no-store',
        ...(isolated
          ? ISOLATED_APP_RESPONSE_HEADERS
          : { 'Referrer-Policy': 'same-origin' }),
      };

      if (isolated && namespace === 'agents') {
        const explicitRevision = parseCanonicalAppContentRevision(request.url);
        const hasReservedRevision = hasReservedRevisionParameter(url);
        let inheritedRevision = revisionBinding.inspect(
          request.url,
          request.headers,
        );
        const sameAppReferer = getSameIsolatedAppReferer(request, target);
        if (
          (hasReservedRevision && !explicitRevision) ||
          inheritedRevision.status === 'invalid'
        ) {
          return new Response('App content revision is invalid', {
            status: 400,
            headers: {
              'Cache-Control': 'no-store',
              'Referrer-Policy': 'same-origin',
            },
          });
        }

        const resolved = await identityResolver.resolveAsset(
          {
            kind: 'agent',
            agentId: entityId,
            appId,
          },
          relativePath,
        );
        if (resolved) {
          inheritedRevision = revisionBinding.inspect(
            request.url,
            request.headers,
          );
          if (inheritedRevision.status === 'invalid') {
            return new Response('App content revision binding is stale', {
              status: 409,
              headers: {
                'Cache-Control': 'no-store',
                'Referrer-Policy': 'same-origin',
              },
            });
          }
          const currentRevision = resolved.identity.assetHash;
          if (isNavigationRequest(request)) {
            const decision = decideAppContentRevision(
              request.url,
              currentRevision,
            );
            if (decision.action === 'redirect') {
              return new Response(null, {
                status: 307,
                headers: {
                  Location: decision.location,
                  'Cache-Control': 'no-store',
                  'Referrer-Policy': 'same-origin',
                },
              });
            }
            if (decision.action === 'deny') {
              return new Response('App content revision is invalid or stale', {
                status: decision.reason === 'mismatch' ? 409 : 400,
                headers: {
                  'Cache-Control': 'no-store',
                  'Referrer-Policy': 'same-origin',
                },
              });
            }
            if (
              !revisionBinding.commitProvisionalNavigation(
                request.url,
                request.headers,
                {
                  origin: target.origin,
                  agentId: entityId,
                  appId,
                  revision: currentRevision,
                },
              )
            ) {
              return new Response(
                'App navigation revision binding is missing or invalid',
                {
                  status: 400,
                  headers: {
                    'Cache-Control': 'no-store',
                    'Referrer-Policy': 'same-origin',
                  },
                },
              );
            }
          } else {
            const boundRevision =
              inheritedRevision.status === 'valid'
                ? inheritedRevision.revision
                : null;
            if (
              explicitRevision &&
              boundRevision &&
              explicitRevision !== boundRevision
            ) {
              return new Response('App content revisions conflict', {
                status: 409,
                headers: {
                  'Cache-Control': 'no-store',
                  'Referrer-Policy': 'same-origin',
                },
              });
            }
            if (sameAppReferer && inheritedRevision.status !== 'valid') {
              return new Response('App content revision binding is missing', {
                status: 400,
                headers: {
                  'Cache-Control': 'no-store',
                  'Referrer-Policy': 'same-origin',
                },
              });
            }
            const effectiveRevision = boundRevision ?? explicitRevision;
            if (!effectiveRevision) {
              return new Response('App content revision is missing', {
                status: 400,
                headers: {
                  'Cache-Control': 'no-store',
                  'Referrer-Policy': 'same-origin',
                },
              });
            }
            if (effectiveRevision !== currentRevision) {
              return new Response('App content revision is stale', {
                status: 409,
                headers: {
                  'Cache-Control': 'no-store',
                  'Referrer-Policy': 'same-origin',
                },
              });
            }
          }

          if (mime === 'text/html') {
            const html = Buffer.from(resolved.asset.bytes).toString('utf8');
            return new Response(hardenIsolatedAppHtml(html, currentRevision), {
              status: 200,
              headers: responseHeaders,
            });
          }

          return new Response(Buffer.from(resolved.asset.bytes), {
            status: 200,
            headers: responseHeaders,
          });
        }

        // A revision claim is authority-bearing. Never fall back to a live
        // filesystem read when no exact snapshot can validate that claim.
        if (
          hasReservedRevision ||
          inheritedRevision.status !== 'none' ||
          (sameAppReferer &&
            hasReservedRevisionParameter(new URL(sameAppReferer)))
        ) {
          return new Response('App content revision cannot be resolved', {
            status: 409,
            headers: {
              'Cache-Control': 'no-store',
              'Referrer-Policy': 'same-origin',
            },
          });
        }
      }

      // Legacy/plugin/invalid agent apps have no Artifact Bridge authority.
      // They may render in the isolated sandbox, but only from a live path
      // after all canonical containment checks above and below succeed.
      let realAppDir: string;
      let realRequestedPath: string;
      try {
        [realAppDir, realRequestedPath] = await Promise.all([
          fs.realpath(appDir),
          fs.realpath(requestedPath),
        ]);
      } catch {
        return new Response('File not found', { status: 404 });
      }

      if (!realRequestedPath.startsWith(realAppDir + path.sep))
        return new Response('Path traversal denied', { status: 400 });

      const fileUrl = pathToFileURL(realRequestedPath).href;
      const fileResponse = await net.fetch(fileUrl);

      if (mime === 'text/html') {
        const html = await fileResponse.text();
        const patched = isolated
          ? hardenIsolatedAppHtml(html)
          : html.includes('</head>')
            ? html.replace(
                '</head>',
                '<style>*,*::before,*::after{scrollbar-width:thin;scrollbar-color:var(--color-surface-2,rgba(255,255,255,.15)) transparent}</style></head>',
              )
            : `<style>*,*::before,*::after{scrollbar-width:thin;scrollbar-color:var(--color-surface-2,rgba(255,255,255,.15)) transparent}</style>${html}`;
        return new Response(patched, {
          status: 200,
          headers: responseHeaders,
        });
      }

      return new Response(fileResponse.body, {
        status: 200,
        headers: responseHeaders,
      });
    } catch (err) {
      logger.error('[AppProtocol] app protocol error', {
        error: err,
        url: request.url,
      });
      return new Response('Internal error', { status: 500 });
    }
  });
}
