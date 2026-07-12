import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  collectMcpCatalogPages,
  collectCredentialReferences,
  EMPTY_MCP_REGISTRY_CONFIG,
  mcpRegistryConfigSchema,
  mcpServerConfigSchema,
  type McpConfigValue,
  type McpElicitationRequest,
  type McpElicitationResult,
  type McpOAuthHostRequest,
  type McpPromptDescriptor,
  type McpRegistryConfig,
  type McpResourceDescriptor,
  type McpResourceTemplateDescriptor,
  type McpServerConfig,
  type McpServerPolicy,
  type McpToolDescriptor,
  type ResolvedMcpTransport,
} from '@clodex/mcp-runtime';
import type { SecretEntry } from '@shared/credential-types';
import { DisposableService } from '../disposable';
import type { CredentialsService } from '../credentials';
import type { Logger } from '../logger';
import {
  readPersistedData,
  writePersistedData,
} from '../../utils/persisted-data';
import {
  McpHostSupervisor,
  type McpHostSupervisorOptions,
} from '../../mcp-host';
import type { McpOAuthService } from './oauth';

const STORAGE_NAME = 'mcp-registry' as const;
const STORAGE_OPTIONS = {
  encrypt: true,
  requireEncryption: true,
  allowPlaintextMigration: true,
} as const;
const MAX_LOG_ENTRIES = 100;
const MAX_LOG_MESSAGE_LENGTH = 16_384;

export type McpServerRuntimeStatus =
  | 'disabled'
  | 'disconnected'
  | 'connecting'
  | 'authorization-required'
  | 'connected'
  | 'degraded'
  | 'failed';

export interface McpServerRuntimeState {
  serverId: string;
  status: McpServerRuntimeStatus;
  lastError: string | null;
  connectedAt: number | null;
  updatedAt: number;
  restartCount: number;
  catalogRevision: number;
}

export interface McpServerLogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export interface McpHostController {
  connectServer(
    serverId: string,
    transport: ResolvedMcpTransport,
    secretValues?: string[],
  ): Promise<'connected' | 'authorization-required'>;
  disconnectServer(serverId: string): Promise<void>;
  listTools(serverId: string): Promise<McpToolDescriptor[]>;
  listResources(
    serverId: string,
    cursor?: string,
  ): Promise<{
    resources: McpResourceDescriptor[];
    nextCursor?: string;
  }>;
  listResourceTemplates(
    serverId: string,
    cursor?: string,
  ): Promise<{
    resourceTemplates: McpResourceTemplateDescriptor[];
    nextCursor?: string;
  }>;
  readResource(
    serverId: string,
    uri: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  listPrompts(
    serverId: string,
    cursor?: string,
  ): Promise<{ prompts: McpPromptDescriptor[]; nextCursor?: string }>;
  getPrompt(
    serverId: string,
    promptName: string,
    args: Record<string, string>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      agentInstanceId?: string;
    },
  ): Promise<unknown>;
  finishOAuth(serverId: string, authorizationCode: string): Promise<void>;
  teardown(): Promise<void>;
}

export interface McpRegistryServiceOptions {
  logger: Logger;
  credentialsService: CredentialsService;
  oauthService?: McpOAuthService;
  createHost?: (
    options: Pick<
      McpHostSupervisorOptions,
      | 'onConnectionState'
      | 'onServerLog'
      | 'onHostRestart'
      | 'onOAuthRequest'
      | 'onElicitationRequest'
      | 'onListChanged'
    >,
  ) => Promise<McpHostController>;
}

export class McpRegistryService extends DisposableService {
  private config: McpRegistryConfig = structuredClone(
    EMPTY_MCP_REGISTRY_CONFIG,
  );
  private host: McpHostController | null = null;
  private hostPromise: Promise<McpHostController> | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly runtimeStates = new Map<string, McpServerRuntimeState>();
  private readonly logs = new Map<string, McpServerLogEntry[]>();
  private readonly toolCache = new Map<string, McpToolDescriptor[]>();
  private readonly resourceCache = new Map<string, McpResourceDescriptor[]>();
  private readonly resourceTemplateCache = new Map<
    string,
    McpResourceTemplateDescriptor[]
  >();
  private readonly promptCache = new Map<string, McpPromptDescriptor[]>();
  private readonly createHost: NonNullable<
    McpRegistryServiceOptions['createHost']
  >;
  private elicitationHandler:
    | ((
        serverId: string,
        agentInstanceId: string,
        request: McpElicitationRequest,
        signal: AbortSignal,
      ) => Promise<McpElicitationResult>)
    | null = null;

  private constructor(private readonly options: McpRegistryServiceOptions) {
    super();
    this.createHost =
      options.createHost ??
      (async (hostOptions) =>
        await McpHostSupervisor.create(options.logger, hostOptions));
  }

  public static async create(
    options: McpRegistryServiceOptions,
  ): Promise<McpRegistryService> {
    const service = new McpRegistryService(options);
    await service.initialize();
    return service;
  }

  public snapshot(): McpRegistryConfig {
    this.assertNotDisposed();
    return structuredClone(this.config);
  }

  public setElicitationHandler(
    handler:
      | ((
          serverId: string,
          agentInstanceId: string,
          request: McpElicitationRequest,
          signal: AbortSignal,
        ) => Promise<McpElicitationResult>)
      | null,
  ): void {
    this.assertNotDisposed();
    this.elicitationHandler = handler;
  }

  public listRuntimeStates(): McpServerRuntimeState[] {
    this.assertNotDisposed();
    return Object.values(this.config.servers).map(
      (server) =>
        this.runtimeStates.get(server.id) ?? {
          serverId: server.id,
          status: server.enabled ? 'disconnected' : 'disabled',
          lastError: null,
          connectedAt: null,
          updatedAt: Date.now(),
          restartCount: 0,
          catalogRevision: 0,
        },
    );
  }

  public getLogs(serverId: string): McpServerLogEntry[] {
    this.assertNotDisposed();
    return structuredClone(this.logs.get(serverId) ?? []);
  }

  public getOAuthStatus(serverId: string): {
    configured: boolean;
    authorizationPending: boolean;
  } | null {
    this.assertNotDisposed();
    const server = this.requireServer(serverId);
    if (server.transport.type === 'stdio' || !server.transport.oauth) {
      return null;
    }
    return (
      this.options.oauthService?.getStatus(serverId) ?? {
        configured: false,
        authorizationPending: false,
      }
    );
  }

  public async upsertServer(input: McpServerConfig): Promise<McpServerConfig> {
    this.assertNotDisposed();
    const server = mcpServerConfigSchema.parse(input);
    assertServerCredentialBoundary(server);
    if (server.source.kind === 'builtin') {
      throw new Error('Builtin MCP servers are managed by the application');
    }

    const previous = this.config.servers[server.id];
    if (previous && this.host) {
      await this.host.disconnectServer(server.id).catch(() => undefined);
    }
    if (previous) this.clearCatalogCache(server.id);
    if (
      previous &&
      JSON.stringify(
        previous.transport.type === 'stdio'
          ? undefined
          : previous.transport.oauth,
      ) !==
        JSON.stringify(
          server.transport.type === 'stdio'
            ? undefined
            : server.transport.oauth,
        )
    ) {
      await this.options.oauthService?.clearServer(server.id);
    }
    this.config.servers[server.id] = server;
    this.setRuntimeState(server.id, {
      status: server.enabled ? 'disconnected' : 'disabled',
      lastError: null,
      connectedAt: null,
    });
    await this.save();
    if (server.enabled) await this.connectServer(server.id);
    return structuredClone(server);
  }

  public async removeServer(serverId: string): Promise<void> {
    this.assertNotDisposed();
    const server = this.requireServer(serverId);
    if (server.source.kind === 'builtin') {
      throw new Error('Builtin MCP servers cannot be removed');
    }
    await this.host?.disconnectServer(serverId).catch(() => undefined);
    delete this.config.servers[serverId];
    this.runtimeStates.delete(serverId);
    this.logs.delete(serverId);
    this.clearCatalogCache(serverId);
    await this.options.oauthService?.clearServer(serverId);
    await this.save();
  }

  public async syncPluginServers(
    discoveredServers: McpServerConfig[],
  ): Promise<void> {
    this.assertNotDisposed();
    const parsedServers = discoveredServers.map((server) => {
      const parsed = mcpServerConfigSchema.parse(server);
      assertServerCredentialBoundary(parsed);
      if (parsed.source.kind !== 'plugin') {
        throw new Error(
          'syncPluginServers accepts plugin-sourced servers only',
        );
      }
      return parsed;
    });
    const nextIds = new Set(parsedServers.map((server) => server.id));
    const removedIds = Object.values(this.config.servers)
      .filter(
        (server) => server.source.kind === 'plugin' && !nextIds.has(server.id),
      )
      .map((server) => server.id);

    for (const serverId of removedIds) {
      await this.host?.disconnectServer(serverId).catch(() => undefined);
      delete this.config.servers[serverId];
      this.runtimeStates.delete(serverId);
      this.logs.delete(serverId);
      this.clearCatalogCache(serverId);
    }

    for (const discovered of parsedServers) {
      const existing = this.config.servers[discovered.id];
      const merged: McpServerConfig =
        existing?.source.kind === 'plugin'
          ? {
              ...discovered,
              enabled: existing.enabled,
              policy: existing.policy,
            }
          : discovered;
      if (existing && JSON.stringify(existing) !== JSON.stringify(merged)) {
        await this.host?.disconnectServer(discovered.id).catch(() => undefined);
        this.clearCatalogCache(discovered.id);
      }
      this.config.servers[discovered.id] = merged;
      this.setRuntimeState(discovered.id, {
        status: merged.enabled ? 'disconnected' : 'disabled',
        lastError: null,
        connectedAt: null,
      });
    }

    await this.save();
    await Promise.all(
      parsedServers
        .map((server) => this.config.servers[server.id])
        .filter((server): server is McpServerConfig => server?.enabled === true)
        .map((server) =>
          this.connectServer(server.id).catch((error) => {
            this.options.logger.warn(
              `[McpRegistry] Failed to connect plugin MCP ${server.id}`,
              { error },
            );
          }),
        ),
    );
  }

  public async setEnabled(serverId: string, enabled: boolean): Promise<void> {
    this.assertNotDisposed();
    const server = this.requireServer(serverId);
    server.enabled = enabled;
    await this.save();
    if (!enabled) {
      await this.host?.disconnectServer(serverId).catch(() => undefined);
      this.setRuntimeState(serverId, {
        status: 'disabled',
        lastError: null,
        connectedAt: null,
      });
      return;
    }
    this.setRuntimeState(serverId, {
      status: 'disconnected',
      lastError: null,
      connectedAt: null,
    });
    await this.connectServer(serverId);
  }

  public async setPolicy(
    serverId: string,
    policy: McpServerPolicy,
  ): Promise<void> {
    this.assertNotDisposed();
    const server = this.requireServer(serverId);
    server.policy = structuredClone(policy);
    await this.save();
  }

  public async connectServer(serverId: string): Promise<void> {
    this.assertNotDisposed();
    const server = this.requireServer(serverId);
    if (!server.enabled)
      throw new Error(`MCP server "${serverId}" is disabled`);

    this.clearCatalogCache(serverId);
    this.setRuntimeState(serverId, {
      status: 'connecting',
      lastError: null,
      connectedAt: null,
    });
    try {
      const resolved = await this.resolveTransport(server);
      const host = await this.ensureHost();
      const connectionState = await host.connectServer(
        serverId,
        resolved.transport,
        resolved.secretValues,
      );
      this.setRuntimeState(serverId, {
        status: connectionState,
        lastError: null,
        connectedAt: connectionState === 'connected' ? Date.now() : null,
      });
    } catch (error) {
      const message = toSafeErrorMessage(error);
      this.setRuntimeState(serverId, {
        status: 'failed',
        lastError: message,
        connectedAt: null,
      });
      throw error;
    }
  }

  public async disconnectServer(serverId: string): Promise<void> {
    this.assertNotDisposed();
    const server = this.requireServer(serverId);
    await this.host?.disconnectServer(serverId);
    this.setRuntimeState(serverId, {
      status: server.enabled ? 'disconnected' : 'disabled',
      lastError: null,
      connectedAt: null,
    });
  }

  public async restartServer(serverId: string): Promise<void> {
    this.assertNotDisposed();
    const server = this.requireServer(serverId);
    if (!server.enabled) {
      throw new Error(`MCP server "${serverId}" is disabled`);
    }
    await this.host?.disconnectServer(serverId).catch(() => undefined);
    this.setRuntimeState(serverId, {
      status: 'disconnected',
      lastError: null,
      connectedAt: null,
    });
    await this.connectServer(serverId);
  }

  public async testConnection(serverId: string): Promise<McpToolDescriptor[]> {
    this.assertNotDisposed();
    const server = this.requireServer(serverId);
    if (server.enabled) {
      await this.restartServer(serverId);
      return await this.listTools(serverId);
    }

    this.setRuntimeState(serverId, {
      status: 'connecting',
      lastError: null,
      connectedAt: null,
    });
    try {
      const resolved = await this.resolveTransport(server);
      const host = await this.ensureHost();
      const connectionState = await host.connectServer(
        serverId,
        resolved.transport,
        resolved.secretValues,
      );
      if (connectionState === 'authorization-required') {
        this.setRuntimeState(serverId, {
          status: 'authorization-required',
          lastError: null,
          connectedAt: null,
        });
        throw new Error(
          'OAuth authorization is required. Complete the browser flow and retry.',
        );
      }
      const tools = await host.listTools(serverId);
      await host.disconnectServer(serverId).catch(() => undefined);
      this.setRuntimeState(serverId, {
        status: 'disabled',
        lastError: null,
        connectedAt: null,
      });
      return tools;
    } catch (error) {
      await this.host?.disconnectServer(serverId).catch(() => undefined);
      this.setRuntimeState(serverId, {
        status: 'failed',
        lastError: toSafeErrorMessage(error),
        connectedAt: null,
      });
      throw error;
    }
  }

  public async listTools(serverId: string): Promise<McpToolDescriptor[]> {
    this.assertNotDisposed();
    await this.ensureConnected(serverId);
    const cached = this.toolCache.get(serverId);
    if (cached) return structuredClone(cached);
    const host = await this.ensureHost();
    const tools = await host.listTools(serverId);
    this.toolCache.set(serverId, structuredClone(tools));
    return tools;
  }

  public async listResources(
    serverId: string,
  ): Promise<McpResourceDescriptor[]> {
    this.assertNotDisposed();
    await this.ensureConnected(serverId);
    const cached = this.resourceCache.get(serverId);
    if (cached) return structuredClone(cached);
    const host = await this.ensureHost();
    const resources = await collectMcpCatalogPages(async (cursor) => {
      const page = await host.listResources(serverId, cursor);
      return { items: page.resources, nextCursor: page.nextCursor };
    });
    this.resourceCache.set(serverId, structuredClone(resources));
    return resources;
  }

  public async listResourceTemplates(
    serverId: string,
  ): Promise<McpResourceTemplateDescriptor[]> {
    this.assertNotDisposed();
    await this.ensureConnected(serverId);
    const cached = this.resourceTemplateCache.get(serverId);
    if (cached) return structuredClone(cached);
    const host = await this.ensureHost();
    const resourceTemplates = await collectMcpCatalogPages(async (cursor) => {
      const page = await host.listResourceTemplates(serverId, cursor);
      return {
        items: page.resourceTemplates,
        nextCursor: page.nextCursor,
      };
    });
    this.resourceTemplateCache.set(
      serverId,
      structuredClone(resourceTemplates),
    );
    return resourceTemplates;
  }

  public async readResource(
    serverId: string,
    uri: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    this.assertNotDisposed();
    await this.ensureConnected(serverId);
    return await (await this.ensureHost()).readResource(serverId, uri, options);
  }

  public async listPrompts(serverId: string): Promise<McpPromptDescriptor[]> {
    this.assertNotDisposed();
    await this.ensureConnected(serverId);
    const cached = this.promptCache.get(serverId);
    if (cached) return structuredClone(cached);
    const host = await this.ensureHost();
    const prompts = await collectMcpCatalogPages(async (cursor) => {
      const page = await host.listPrompts(serverId, cursor);
      return { items: page.prompts, nextCursor: page.nextCursor };
    });
    this.promptCache.set(serverId, structuredClone(prompts));
    return prompts;
  }

  public async getPrompt(
    serverId: string,
    promptName: string,
    args: Record<string, string>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    this.assertNotDisposed();
    await this.ensureConnected(serverId);
    return await (await this.ensureHost()).getPrompt(
      serverId,
      promptName,
      args,
      options,
    );
  }

  public async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      agentInstanceId?: string;
    } = {},
  ): Promise<unknown> {
    this.assertNotDisposed();
    await this.ensureConnected(serverId);
    const host = await this.ensureHost();
    return await host.callTool(serverId, toolName, args, options);
  }

  public async handleOAuthCallback(url: string): Promise<boolean> {
    this.assertNotDisposed();
    if (!this.options.oauthService) return false;
    const callback = await this.options.oauthService.consumeCallback(url);
    const server = this.requireServer(callback.serverId);
    if (
      server.transport.type === 'stdio' ||
      !server.transport.oauth ||
      !server.enabled
    ) {
      await this.options.oauthService.clearServer(callback.serverId);
      throw new Error('MCP OAuth callback does not match an enabled server');
    }
    const host = await this.ensureHost();
    try {
      await host.finishOAuth(callback.serverId, callback.authorizationCode);
      await this.connectServer(callback.serverId);
      return true;
    } catch (error) {
      this.setRuntimeState(callback.serverId, {
        status: 'failed',
        lastError: toSafeErrorMessage(error),
        connectedAt: null,
      });
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    this.config = await readPersistedData(
      STORAGE_NAME,
      mcpRegistryConfigSchema,
      structuredClone(EMPTY_MCP_REGISTRY_CONFIG),
      STORAGE_OPTIONS,
    );
    for (const server of Object.values(this.config.servers)) {
      this.setRuntimeState(server.id, {
        status: server.enabled ? 'disconnected' : 'disabled',
        lastError: null,
        connectedAt: null,
      });
    }
  }

  private async ensureHost(): Promise<McpHostController> {
    if (this.host) return this.host;
    if (!this.hostPromise) {
      this.hostPromise = this.createHost({
        onConnectionState: (serverId, state, error) => {
          this.setRuntimeState(serverId, {
            status: state,
            lastError: error ? toSafeErrorMessage(error) : null,
            connectedAt:
              state === 'connected'
                ? Date.now()
                : (this.runtimeStates.get(serverId)?.connectedAt ?? null),
          });
        },
        onServerLog: (serverId, level, message) => {
          this.appendLog(serverId, level, message);
        },
        onHostRestart: (_restartCount, error) => {
          for (const server of Object.values(this.config.servers)) {
            if (!server.enabled) continue;
            this.clearCatalogCache(server.id);
            const current = this.runtimeStates.get(server.id);
            this.setRuntimeState(server.id, {
              status: 'degraded',
              lastError: toSafeErrorMessage(error),
              connectedAt: current?.connectedAt ?? null,
              restartCount: (current?.restartCount ?? 0) + 1,
            });
          }
        },
        onOAuthRequest: async (
          serverId: string,
          request: McpOAuthHostRequest,
        ) => {
          const oauthService = this.options.oauthService;
          if (!oauthService) {
            throw new Error('MCP OAuth is unavailable');
          }
          return await oauthService.handleHostRequest(
            this.requireServer(serverId),
            request,
          );
        },
        onElicitationRequest: async (
          serverId,
          agentInstanceId,
          request,
          signal,
        ) =>
          this.elicitationHandler
            ? await this.elicitationHandler(
                serverId,
                agentInstanceId,
                request,
                signal,
              )
            : { action: 'cancel' },
        onListChanged: (serverId, kind, items) => {
          if (kind === 'tools') {
            this.toolCache.set(
              serverId,
              structuredClone(items as McpToolDescriptor[]),
            );
          } else if (kind === 'resources') {
            this.resourceCache.set(
              serverId,
              structuredClone(items as McpResourceDescriptor[]),
            );
            this.resourceTemplateCache.delete(serverId);
          } else {
            this.promptCache.set(
              serverId,
              structuredClone(items as McpPromptDescriptor[]),
            );
          }
          const current = this.runtimeStates.get(serverId);
          if (current) {
            this.runtimeStates.set(serverId, {
              ...current,
              updatedAt: Date.now(),
              catalogRevision: current.catalogRevision + 1,
            });
          }
        },
      }).then((host) => {
        this.host = host;
        return host;
      });
    }
    try {
      return await this.hostPromise;
    } finally {
      this.hostPromise = null;
    }
  }

  private async ensureConnected(serverId: string): Promise<void> {
    const state = this.runtimeStates.get(serverId);
    if (state?.status === 'connected') return;
    await this.connectServer(serverId);
  }

  private async resolveTransport(
    server: McpServerConfig,
  ): Promise<{ transport: ResolvedMcpTransport; secretValues: string[] }> {
    const { transport } = server;
    const secretValues: string[] = [];
    if (transport.type === 'stdio') {
      const env = {
        ...getDefaultEnvironment(),
        ...(await this.resolveConfigValues(transport.env, null, secretValues)),
      };
      return {
        transport: {
          type: 'stdio',
          command: transport.command,
          args: [...transport.args],
          cwd: transport.cwd,
          env,
          runtimePolicy:
            server.source.kind === 'plugin'
              ? server.source.executableRuntimePolicy
              : undefined,
        },
        secretValues,
      };
    }

    const origin = new URL(transport.url).origin;
    const headers = await this.resolveConfigValues(
      transport.headers,
      origin,
      secretValues,
    );
    return {
      transport: {
        type: transport.type,
        url: transport.url,
        headers,
        oauth: transport.oauth
          ? (this.options.oauthService?.resolveRuntimeConfig(server) ??
            (() => {
              throw new Error('MCP OAuth is unavailable');
            })())
          : undefined,
      },
      secretValues,
    };
  }

  private async resolveConfigValues(
    values: Record<string, McpConfigValue>,
    requiredOrigin: string | null,
    secretValues: string[],
  ): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value.kind === 'literal') {
        resolved[key] = value.value;
        continue;
      }
      const secret = await this.options.credentialsService.resolveSecretField(
        value.credentialId,
        value.field,
      );
      if (!secret) {
        throw new Error(
          `Credential "${value.credentialId}.${value.field}" is unavailable`,
        );
      }
      assertCredentialOrigin(secret, requiredOrigin, value.credentialId);
      resolved[key] = secret.value;
      secretValues.push(secret.value);
    }
    return resolved;
  }

  private requireServer(serverId: string): McpServerConfig {
    const server = this.config.servers[serverId];
    if (!server) throw new Error(`Unknown MCP server "${serverId}"`);
    return server;
  }

  private setRuntimeState(
    serverId: string,
    state: Omit<
      McpServerRuntimeState,
      'serverId' | 'updatedAt' | 'restartCount' | 'catalogRevision'
    > & {
      restartCount?: number;
    },
  ): void {
    const previous = this.runtimeStates.get(serverId);
    this.runtimeStates.set(serverId, {
      serverId,
      ...state,
      updatedAt: Date.now(),
      restartCount: state.restartCount ?? previous?.restartCount ?? 0,
      catalogRevision: previous?.catalogRevision ?? 0,
    });
  }

  private appendLog(
    serverId: string,
    level: McpServerLogEntry['level'],
    message: string,
  ): void {
    const entries = this.logs.get(serverId) ?? [];
    entries.push({
      timestamp: Date.now(),
      level,
      message: capText(message, MAX_LOG_MESSAGE_LENGTH),
    });
    if (entries.length > MAX_LOG_ENTRIES) {
      entries.splice(0, entries.length - MAX_LOG_ENTRIES);
    }
    this.logs.set(serverId, entries);
  }

  private async save(): Promise<void> {
    const snapshot = mcpRegistryConfigSchema.parse(this.config);
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(() =>
        writePersistedData(
          STORAGE_NAME,
          mcpRegistryConfigSchema,
          snapshot,
          STORAGE_OPTIONS,
        ),
      );
    await this.saveQueue;
  }

  protected async onTeardown(): Promise<void> {
    await this.saveQueue.catch(() => undefined);
    const host = this.host;
    this.host = null;
    await host?.teardown();
    this.runtimeStates.clear();
    this.logs.clear();
    this.toolCache.clear();
    this.resourceCache.clear();
    this.resourceTemplateCache.clear();
    this.promptCache.clear();
    this.elicitationHandler = null;
  }

  private clearCatalogCache(serverId: string): void {
    this.toolCache.delete(serverId);
    this.resourceCache.delete(serverId);
    this.resourceTemplateCache.delete(serverId);
    this.promptCache.delete(serverId);
  }
}

function assertCredentialOrigin(
  secret: SecretEntry,
  requiredOrigin: string | null,
  credentialId: string,
): void {
  if (!requiredOrigin) return;
  if (secret.allowedOrigins.includes(requiredOrigin)) return;
  throw new Error(
    `Credential "${credentialId}" is not allowed for origin ${requiredOrigin}`,
  );
}

function assertServerCredentialBoundary(server: McpServerConfig): void {
  if (server.source.kind === 'builtin') return;
  if (
    collectCredentialReferences(server.transport).some(
      (reference) => reference.credentialId === 'clodex-auth',
    )
  ) {
    throw new Error(
      'The Clodex session credential is reserved for built-in services',
    );
  }
}

function toSafeErrorMessage(error: unknown): string {
  return capText(error instanceof Error ? error.message : String(error));
}

function capText(value: string, maxLength = MAX_LOG_MESSAGE_LENGTH): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…[truncated]`;
}
