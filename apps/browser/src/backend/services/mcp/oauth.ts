import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  mcpServerIdSchema,
  type McpOAuthHostRequest,
  type McpServerConfig,
  type ResolvedMcpOAuthConfig,
} from '@clodex/mcp-runtime';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { shell } from 'electron';
import { z } from 'zod';
import { DisposableService } from '../disposable';
import type { Logger } from '../logger';
import {
  readPersistedData,
  writePersistedData,
} from '../../utils/persisted-data';

const STORAGE_NAME = 'mcp-oauth-sessions' as const;
const STORAGE_OPTIONS = {
  encrypt: true,
  requireEncryption: true,
  allowPlaintextMigration: false,
} as const;
const STORAGE_SCHEMA_VERSION = 1;
const AUTHORIZATION_TTL_MS = 10 * 60_000;
const MAX_STORED_VALUE_BYTES = 256 * 1024;
const DEFAULT_CALLBACK_URL = 'clodex-ide://mcp/oauth/callback';
const DYNAMIC_REGISTRATION_ID = 'clodex-dynamic';

const oauthClientInformationSchema = z.union([
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
]);

const oauthDiscoveryStateSchema = z
  .object({
    authorizationServerUrl: z.string().url().max(4_096),
    resourceMetadataUrl: z.string().url().max(4_096).optional(),
    resourceMetadata: OAuthProtectedResourceMetadataSchema.optional(),
    authorizationServerMetadata: z
      .union([OAuthMetadataSchema, OpenIdProviderDiscoveryMetadataSchema])
      .optional(),
  })
  .strict();

const oauthSessionSchema = z
  .object({
    clientInformation: oauthClientInformationSchema.optional(),
    tokens: OAuthTokensSchema.optional(),
    codeVerifier: z.string().min(43).max(128).optional(),
    discoveryState: oauthDiscoveryStateSchema.optional(),
    pendingAuthorization: z
      .object({
        state: z.string().min(32).max(256),
        createdAt: z.number().int().nonnegative(),
        consumedAt: z.number().int().nonnegative().optional(),
        authorizationOrigin: z.string().url().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const oauthStoreSchema = z
  .object({
    schemaVersion: z.literal(STORAGE_SCHEMA_VERSION),
    sessions: z.record(mcpServerIdSchema, oauthSessionSchema),
  })
  .strict();

type McpOAuthSession = z.infer<typeof oauthSessionSchema>;
type McpOAuthStore = z.infer<typeof oauthStoreSchema>;

export interface McpOAuthRegistration {
  id: string;
  redirectUrl: string;
  allowedAuthorizationOrigins: string[] | ((serverUrl: URL) => string[]);
  clientMetadata:
    | OAuthClientMetadata
    | ((scopes: string[]) => OAuthClientMetadata);
  clientInformation?: OAuthClientInformationMixed;
}

export interface McpOAuthServiceOptions {
  logger: Logger;
  openExternal?: (url: string) => Promise<void>;
  registrations?: McpOAuthRegistration[];
}

export type McpOAuthCallbackResult = {
  serverId: string;
  authorizationCode: string;
};

export class McpOAuthService extends DisposableService {
  private store: McpOAuthStore = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    sessions: {},
  };
  private readonly registrations = new Map<string, McpOAuthRegistration>();
  private readonly openExternal: (url: string) => Promise<void>;
  private saveQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly options: McpOAuthServiceOptions) {
    super();
    this.openExternal =
      options.openExternal ??
      (async (url) => {
        await shell.openExternal(url, { activate: true });
      });
    for (const registration of [
      createDynamicRegistration(),
      ...(options.registrations ?? []),
    ]) {
      if (this.registrations.has(registration.id)) {
        throw new Error(
          `Duplicate MCP OAuth registration "${registration.id}"`,
        );
      }
      this.registrations.set(registration.id, registration);
    }
  }

  public static async create(
    options: McpOAuthServiceOptions,
  ): Promise<McpOAuthService> {
    const service = new McpOAuthService(options);
    service.store = await readPersistedData(
      STORAGE_NAME,
      oauthStoreSchema,
      {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        sessions: {},
      },
      STORAGE_OPTIONS,
    );
    service.pruneExpiredAuthorizations();
    return service;
  }

  public resolveRuntimeConfig(server: McpServerConfig): ResolvedMcpOAuthConfig {
    this.assertNotDisposed();
    if (server.transport.type === 'stdio' || !server.transport.oauth) {
      throw new Error(`MCP server "${server.id}" does not use OAuth`);
    }
    const registration = this.requireRegistration(
      server.transport.oauth.clientRegistrationId,
    );
    const serverUrl = new URL(server.transport.url);
    const scopes = [...server.transport.oauth.scopes];
    const metadata =
      typeof registration.clientMetadata === 'function'
        ? registration.clientMetadata(scopes)
        : registration.clientMetadata;
    const allowedAuthorizationOrigins = (
      typeof registration.allowedAuthorizationOrigins === 'function'
        ? registration.allowedAuthorizationOrigins(serverUrl)
        : registration.allowedAuthorizationOrigins
    ).map(normalizeOrigin);
    if (allowedAuthorizationOrigins.length === 0) {
      throw new Error(
        `MCP OAuth registration "${registration.id}" has no allowed authorization origins`,
      );
    }
    if (!metadata.redirect_uris.includes(registration.redirectUrl)) {
      throw new Error(
        `MCP OAuth registration "${registration.id}" does not bind its callback URL`,
      );
    }
    return {
      clientRegistrationId: registration.id,
      redirectUrl: registration.redirectUrl,
      scopes,
      clientMetadata: structuredClone(metadata) as Record<string, unknown>,
      allowedAuthorizationOrigins,
    };
  }

  public async handleHostRequest(
    server: McpServerConfig,
    request: McpOAuthHostRequest,
  ): Promise<unknown> {
    this.assertNotDisposed();
    const runtime = this.resolveRuntimeConfig(server);
    const session = this.getSession(server.id);

    switch (request.operation) {
      case 'load-client-information':
        return (
          session.clientInformation ??
          this.requireRegistration(runtime.clientRegistrationId)
            .clientInformation ??
          undefined
        );
      case 'save-client-information':
        session.clientInformation = parseBounded(
          oauthClientInformationSchema,
          request.value,
          'OAuth client information',
        );
        await this.save();
        return undefined;
      case 'load-tokens':
        return session.tokens;
      case 'save-tokens':
        session.tokens = parseBounded(
          OAuthTokensSchema,
          request.value,
          'OAuth tokens',
        );
        delete session.codeVerifier;
        delete session.pendingAuthorization;
        await this.save();
        return undefined;
      case 'prepare-state': {
        const state = randomBytes(32).toString('base64url');
        session.pendingAuthorization = {
          state,
          createdAt: Date.now(),
        };
        delete session.codeVerifier;
        await this.save();
        return state;
      }
      case 'open-authorization':
        await this.openAuthorization(server, runtime, request.authorizationUrl);
        return undefined;
      case 'save-code-verifier':
        requirePendingAuthorization(session, server.id);
        session.codeVerifier = request.codeVerifier;
        await this.save();
        return undefined;
      case 'load-code-verifier':
        requirePendingAuthorization(session, server.id);
        if (!session.codeVerifier) {
          throw new Error(
            `OAuth code verifier is unavailable for MCP server "${server.id}"`,
          );
        }
        return session.codeVerifier;
      case 'save-discovery-state': {
        const discovery = parseBounded(
          oauthDiscoveryStateSchema,
          request.value,
          'OAuth discovery state',
        );
        assertDiscoveryOrigins(server, runtime, discovery);
        session.discoveryState = discovery;
        await this.save();
        return undefined;
      }
      case 'load-discovery-state':
        return session.discoveryState;
      case 'invalidate-credentials':
        invalidateSession(session, request.scope);
        await this.save();
        return undefined;
    }
  }

  public async consumeCallback(url: string): Promise<McpOAuthCallbackResult> {
    this.assertNotDisposed();
    const parsed = new URL(url);
    const expectedCallback = new URL(DEFAULT_CALLBACK_URL);
    if (
      parsed.protocol !== expectedCallback.protocol ||
      toRoutePath(parsed) !== '/mcp/oauth/callback'
    ) {
      throw new Error('Unexpected MCP OAuth callback route');
    }
    const state = parsed.searchParams.get('state');
    if (!state || state.length > 256) {
      throw new Error('MCP OAuth callback has no valid state');
    }

    this.pruneExpiredAuthorizations();
    const matches = Object.entries(this.store.sessions).filter(
      ([, session]) =>
        session.pendingAuthorization &&
        !session.pendingAuthorization.consumedAt &&
        safeEqual(session.pendingAuthorization.state, state),
    );
    if (matches.length !== 1) {
      throw new Error('MCP OAuth callback state is invalid or already used');
    }

    const [serverId, session] = matches[0]!;
    session.pendingAuthorization!.consumedAt = Date.now();
    const oauthError = parsed.searchParams.get('error');
    if (oauthError) {
      delete session.pendingAuthorization;
      delete session.codeVerifier;
      await this.save();
      throw new Error(
        `MCP OAuth authorization failed: ${oauthError.slice(0, 256)}`,
      );
    }
    const authorizationCode = parsed.searchParams.get('code');
    if (
      !authorizationCode ||
      authorizationCode.length > 8_192 ||
      /[\r\n\0]/.test(authorizationCode)
    ) {
      delete session.pendingAuthorization;
      delete session.codeVerifier;
      await this.save();
      throw new Error('MCP OAuth callback has no valid authorization code');
    }
    await this.save();
    return { serverId, authorizationCode };
  }

  public async clearServer(serverId: string): Promise<void> {
    this.assertNotDisposed();
    if (!(serverId in this.store.sessions)) return;
    delete this.store.sessions[serverId];
    await this.save();
  }

  public getStatus(serverId: string): {
    configured: boolean;
    authorizationPending: boolean;
  } {
    this.assertNotDisposed();
    const session = this.store.sessions[serverId];
    return {
      configured: Boolean(session?.tokens),
      authorizationPending: Boolean(
        session?.pendingAuthorization &&
          !session.pendingAuthorization.consumedAt &&
          Date.now() - session.pendingAuthorization.createdAt <
            AUTHORIZATION_TTL_MS,
      ),
    };
  }

  private async openAuthorization(
    server: McpServerConfig,
    runtime: ResolvedMcpOAuthConfig,
    authorizationUrl: string,
  ): Promise<void> {
    const session = this.getSession(server.id);
    const pending = requirePendingAuthorization(session, server.id);
    if (pending.consumedAt) {
      throw new Error('MCP OAuth authorization state was already consumed');
    }
    const url = new URL(authorizationUrl);
    assertAllowedAuthorizationOrigin(url, runtime);
    if (url.searchParams.get('state') !== pending.state) {
      throw new Error('MCP OAuth authorization URL state does not match');
    }
    if (url.searchParams.get('redirect_uri') !== runtime.redirectUrl) {
      throw new Error(
        'MCP OAuth authorization URL redirect URI does not match',
      );
    }
    if (url.searchParams.get('response_type') !== 'code') {
      throw new Error('MCP OAuth authorization URL must request code flow');
    }
    if (
      url.searchParams.get('code_challenge_method') !== 'S256' ||
      !url.searchParams.get('code_challenge')
    ) {
      throw new Error('MCP OAuth authorization URL must use PKCE S256');
    }
    if (!url.searchParams.get('client_id')) {
      throw new Error('MCP OAuth authorization URL has no client ID');
    }
    pending.authorizationOrigin = url.origin;
    await this.save();
    await this.openExternal(url.toString());
    this.options.logger.info(
      `[McpOAuth] Opened authorization flow for ${server.id}`,
    );
  }

  private requireRegistration(id: string): McpOAuthRegistration {
    const registration = this.registrations.get(id);
    if (!registration) {
      throw new Error(`Unknown MCP OAuth client registration "${id}"`);
    }
    return registration;
  }

  private getSession(serverId: string): McpOAuthSession {
    const existing = this.store.sessions[serverId];
    if (existing) return existing;
    const created: McpOAuthSession = {};
    this.store.sessions[serverId] = created;
    return created;
  }

  private pruneExpiredAuthorizations(): void {
    const now = Date.now();
    let changed = false;
    for (const session of Object.values(this.store.sessions)) {
      if (
        session.pendingAuthorization &&
        now - session.pendingAuthorization.createdAt >= AUTHORIZATION_TTL_MS
      ) {
        delete session.pendingAuthorization;
        delete session.codeVerifier;
        changed = true;
      }
    }
    if (changed) void this.save();
  }

  private async save(): Promise<void> {
    const snapshot = oauthStoreSchema.parse(this.store);
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(() =>
        writePersistedData(
          STORAGE_NAME,
          oauthStoreSchema,
          snapshot,
          STORAGE_OPTIONS,
        ),
      );
    await this.saveQueue;
  }

  protected async onTeardown(): Promise<void> {
    await this.saveQueue.catch(() => undefined);
  }
}

function createDynamicRegistration(): McpOAuthRegistration {
  return {
    id: DYNAMIC_REGISTRATION_ID,
    redirectUrl: DEFAULT_CALLBACK_URL,
    allowedAuthorizationOrigins: (serverUrl) => [serverUrl.origin],
    clientMetadata: (scopes) => ({
      redirect_uris: [DEFAULT_CALLBACK_URL],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Clodex IDE',
      client_uri: 'https://clodex.xyz',
      software_id: 'clodex-ide',
      scope: scopes.length > 0 ? scopes.join(' ') : undefined,
    }),
  };
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`OAuth authorization origin must not contain a path`);
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))
  ) {
    throw new Error('OAuth authorization origins must use HTTPS or loopback');
  }
  return url.origin;
}

function assertAllowedAuthorizationOrigin(
  url: URL,
  runtime: ResolvedMcpOAuthConfig,
): void {
  if (!runtime.allowedAuthorizationOrigins.includes(url.origin)) {
    throw new Error(
      `OAuth endpoint origin ${url.origin} is not allowed for this MCP client registration`,
    );
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))
  ) {
    throw new Error('OAuth endpoints must use HTTPS or loopback HTTP');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('OAuth endpoints may not contain credentials or fragments');
  }
}

function assertDiscoveryOrigins(
  server: McpServerConfig,
  runtime: ResolvedMcpOAuthConfig,
  discovery: OAuthDiscoveryState,
): void {
  const serverUrl = new URL(
    server.transport.type === 'stdio'
      ? 'https://invalid.local'
      : server.transport.url,
  );
  assertAllowedAuthorizationOrigin(
    new URL(discovery.authorizationServerUrl),
    runtime,
  );
  if (discovery.resourceMetadataUrl) {
    const resourceMetadataUrl = new URL(discovery.resourceMetadataUrl);
    if (resourceMetadataUrl.origin !== serverUrl.origin) {
      throw new Error(
        'OAuth protected-resource metadata must remain on the MCP server origin',
      );
    }
  }
  const metadata = discovery.authorizationServerMetadata;
  if (metadata) {
    for (const value of [
      metadata.issuer,
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.registration_endpoint,
    ]) {
      if (value) {
        assertAllowedAuthorizationOrigin(new URL(value), runtime);
      }
    }
  }
  if (discovery.resourceMetadata?.resource) {
    const resource = new URL(discovery.resourceMetadata.resource);
    if (resource.origin !== serverUrl.origin) {
      throw new Error(
        'OAuth protected resource does not match the MCP server origin',
      );
    }
  }
}

function requirePendingAuthorization(
  session: McpOAuthSession,
  serverId: string,
): NonNullable<McpOAuthSession['pendingAuthorization']> {
  const pending = session.pendingAuthorization;
  if (!pending || Date.now() - pending.createdAt >= AUTHORIZATION_TTL_MS) {
    delete session.pendingAuthorization;
    delete session.codeVerifier;
    throw new Error(
      `OAuth authorization session expired for MCP server "${serverId}"`,
    );
  }
  return pending;
}

function invalidateSession(
  session: McpOAuthSession,
  scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
): void {
  if (scope === 'all' || scope === 'client') delete session.clientInformation;
  if (scope === 'all' || scope === 'tokens') delete session.tokens;
  if (scope === 'all' || scope === 'verifier') {
    delete session.codeVerifier;
    delete session.pendingAuthorization;
  }
  if (scope === 'all' || scope === 'discovery') delete session.discoveryState;
}

function parseBounded<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  label: string,
): z.infer<T> {
  const encoded = JSON.stringify(value);
  if (encoded.length > MAX_STORED_VALUE_BYTES) {
    throw new Error(`${label} exceeds the storage limit`);
  }
  return schema.parse(value);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function toRoutePath(url: URL): string {
  return url.hostname ? `/${url.hostname}${url.pathname}` : url.pathname;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}
