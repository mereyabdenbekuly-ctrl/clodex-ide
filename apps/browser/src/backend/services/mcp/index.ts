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
import type { GuardianPolicyChecker } from '@shared/guardian';
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
import {
  assertTrustedMcpDescriptorCommitment,
  assertTrustedMcpDispatchCommitment,
  authorizeTrustedMcpDispatch,
  createTrustedRegistryMcpDescriptorCommitment,
  createTrustedMcpDispatchCommitment,
  type TrustedMcpDescriptorCommitment,
  type TrustedMcpDispatchCommitment,
  type TrustedMcpFinalAuthority,
} from './trusted-dispatch-gateway';

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

export interface McpToolDispatchSnapshot {
  server: McpServerConfig;
  runtime: Pick<McpServerRuntimeState, 'restartCount' | 'catalogRevision'> & {
    configurationRevision: number;
  };
  descriptor: McpToolDescriptor;
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
      beforeDispatch?: () => void;
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
  private readonly serverConfigurationRevisions = new Map<string, number>();
  private readonly serverConnectionQueues = new Map<string, Promise<void>>();
  private readonly logs = new Map<string, McpServerLogEntry[]>();
  private readonly toolCache = new Map<string, McpToolDescriptor[]>();
  private readonly resourceCache = new Map<string, McpResourceDescriptor[]>();
  private readonly resourceTemplateCache = new Map<
    string,
    McpResourceTemplateDescriptor[]
  >();
  private readonly promptCache = new Map<string, McpPromptDescriptor[]>();
  private guardianPolicyChecker: GuardianPolicyChecker | null = null;
  private guardianPolicyRevision = 0;
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

  /**
   * Returns only already-resolved synchronous state for a final-dispatch
   * commitment check. It deliberately refuses to fetch or reconnect: callers
   * must use listTools first, then re-read this snapshot at the adapter fence.
   */
  public getToolDispatchSnapshot(
    serverId: string,
    toolName: string,
  ): McpToolDispatchSnapshot {
    this.assertNotDisposed();
    const server = this.requireServer(serverId);
    const runtime = this.runtimeStates.get(serverId);
    if (!server.enabled || runtime?.status !== 'connected') {
      throw new Error(`MCP server "${serverId}" is not dispatch-ready`);
    }
    const descriptor = this.toolCache
      .get(serverId)
      ?.find((candidate) => candidate.name === toolName);
    if (!descriptor) {
      throw new Error(`MCP tool "${serverId}/${toolName}" is not committed`);
    }
    return {
      server: structuredClone(server),
      runtime: {
        restartCount: runtime.restartCount,
        catalogRevision: runtime.catalogRevision,
        configurationRevision:
          this.serverConfigurationRevisions.get(serverId) ?? 0,
      },
      descriptor: structuredClone(descriptor),
    };
  }

  public getToolDispatchCommitment(
    serverId: string,
    toolName: string,
  ): TrustedMcpDispatchCommitment {
    return createRegistryToolDispatchCommitments(
      this.getToolDispatchSnapshot(serverId, toolName),
      this.guardianPolicyRevision,
    ).dispatch;
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

  public setGuardianPolicyChecker(checker: GuardianPolicyChecker | null): void {
    this.assertNotDisposed();
    if (this.guardianPolicyRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('MCP Guardian policy revision space is exhausted');
    }
    this.guardianPolicyChecker = checker;
    this.guardianPolicyRevision += 1;
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
    this.bumpServerConfigurationRevision(server.id);
    if (previous && this.host)
      await this.disconnectServer(server.id).catch(() => undefined);
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
    this.bumpServerConfigurationRevision(serverId);
    await this.disconnectServer(serverId).catch(() => undefined);
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
      this.bumpServerConfigurationRevision(serverId);
      await this.disconnectServer(serverId).catch(() => undefined);
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
      const changed =
        !existing || JSON.stringify(existing) !== JSON.stringify(merged);
      if (changed) this.bumpServerConfigurationRevision(discovered.id);
      if (existing && changed) {
        await this.disconnectServer(discovered.id).catch(() => undefined);
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
    this.bumpServerConfigurationRevision(serverId);
    server.enabled = enabled;
    await this.save();
    if (!enabled) {
      await this.disconnectServer(serverId).catch(() => undefined);
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
    this.bumpServerConfigurationRevision(serverId);
    server.policy = structuredClone(policy);
    await this.save();
  }

  public async connectServer(serverId: string): Promise<void> {
    this.assertNotDisposed();
    const server = structuredClone(this.requireServer(serverId));
    if (!server.enabled)
      throw new Error(`MCP server "${serverId}" is disabled`);

    const requestedRevision = this.bumpServerConfigurationRevision(serverId);
    this.clearCatalogCache(serverId);
    this.setRuntimeState(serverId, {
      status: 'connecting',
      lastError: null,
      connectedAt: null,
    });
    await this.withServerConnectionMutation(serverId, async () => {
      try {
        this.assertNotDisposed();
        this.requireCurrentServerConfigurationRevision(
          serverId,
          requestedRevision,
        );
        const resolved = await this.resolveTransport(server);
        this.assertNotDisposed();
        this.requireCurrentServerConfigurationRevision(
          serverId,
          requestedRevision,
        );
        const host = await this.ensureHost();
        this.assertNotDisposed();
        this.requireCurrentServerConfigurationRevision(
          serverId,
          requestedRevision,
        );
        const connectionState = await host.connectServer(
          serverId,
          resolved.transport,
          resolved.secretValues,
        );
        this.assertNotDisposed();
        if (
          !this.isCurrentServerConfigurationRevision(
            serverId,
            requestedRevision,
          )
        ) {
          // No newer registry connection can enter the per-server critical
          // section before this cleanup. Remove the stale host replacement
          // before the current request is allowed to connect.
          await host.disconnectServer(serverId).catch(() => undefined);
          this.throwSupersededServerConnection(serverId);
        }
        this.bumpServerConfigurationRevision(serverId);
        this.setRuntimeState(serverId, {
          status: connectionState,
          lastError: null,
          connectedAt: connectionState === 'connected' ? Date.now() : null,
        });
      } catch (error) {
        if (
          this.isCurrentServerConfigurationRevision(serverId, requestedRevision)
        ) {
          this.setRuntimeState(serverId, {
            status: 'failed',
            lastError: toSafeErrorMessage(error),
            connectedAt: null,
          });
        }
        throw error;
      }
    });
  }

  public async disconnectServer(serverId: string): Promise<void> {
    this.assertNotDisposed();
    const server = this.requireServer(serverId);
    this.setRuntimeState(serverId, {
      status: server.enabled ? 'disconnected' : 'disabled',
      lastError: null,
      connectedAt: null,
    });
    const requestedRevision = this.bumpServerConfigurationRevision(serverId);
    this.clearCatalogCache(serverId);
    await this.withServerConnectionMutation(serverId, async () => {
      this.assertNotDisposed();
      if (
        !this.isCurrentServerConfigurationRevision(serverId, requestedRevision)
      ) {
        return;
      }
      await this.host?.disconnectServer(serverId);
    });
  }

  public async restartServer(serverId: string): Promise<void> {
    this.assertNotDisposed();
    const server = this.requireServer(serverId);
    if (!server.enabled) {
      throw new Error(`MCP server "${serverId}" is disabled`);
    }
    await this.disconnectServer(serverId).catch(() => undefined);
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
    const requestedRevision = this.captureServerConfigurationRevision(serverId);
    const cached = this.toolCache.get(serverId);
    if (cached) return structuredClone(cached);
    const host = await this.ensureHost();
    const tools = await host.listTools(serverId);
    this.requireCurrentServerConfigurationRevision(serverId, requestedRevision);
    const committed = commitUniqueMcpToolDescriptors(tools);
    this.toolCache.set(serverId, committed);
    return structuredClone(committed);
  }

  public async listResources(
    serverId: string,
  ): Promise<McpResourceDescriptor[]> {
    this.assertNotDisposed();
    await this.ensureConnected(serverId);
    const requestedRevision = this.captureServerConfigurationRevision(serverId);
    const cached = this.resourceCache.get(serverId);
    if (cached) return structuredClone(cached);
    const host = await this.ensureHost();
    const resources = await collectMcpCatalogPages(async (cursor) => {
      this.requireCurrentServerConfigurationRevision(
        serverId,
        requestedRevision,
      );
      const page = await host.listResources(serverId, cursor);
      this.requireCurrentServerConfigurationRevision(
        serverId,
        requestedRevision,
      );
      return { items: page.resources, nextCursor: page.nextCursor };
    });
    this.requireCurrentServerConfigurationRevision(serverId, requestedRevision);
    this.resourceCache.set(serverId, structuredClone(resources));
    return resources;
  }

  public async listResourceTemplates(
    serverId: string,
  ): Promise<McpResourceTemplateDescriptor[]> {
    this.assertNotDisposed();
    await this.ensureConnected(serverId);
    const requestedRevision = this.captureServerConfigurationRevision(serverId);
    const cached = this.resourceTemplateCache.get(serverId);
    if (cached) return structuredClone(cached);
    const host = await this.ensureHost();
    const resourceTemplates = await collectMcpCatalogPages(async (cursor) => {
      this.requireCurrentServerConfigurationRevision(
        serverId,
        requestedRevision,
      );
      const page = await host.listResourceTemplates(serverId, cursor);
      this.requireCurrentServerConfigurationRevision(
        serverId,
        requestedRevision,
      );
      return {
        items: page.resourceTemplates,
        nextCursor: page.nextCursor,
      };
    });
    this.requireCurrentServerConfigurationRevision(serverId, requestedRevision);
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
    const requestedRevision = this.captureServerConfigurationRevision(serverId);
    const result = await (await this.ensureHost()).readResource(
      serverId,
      uri,
      options,
    );
    this.requireCurrentServerConfigurationRevision(serverId, requestedRevision);
    return result;
  }

  public async listPrompts(serverId: string): Promise<McpPromptDescriptor[]> {
    this.assertNotDisposed();
    await this.ensureConnected(serverId);
    const requestedRevision = this.captureServerConfigurationRevision(serverId);
    const cached = this.promptCache.get(serverId);
    if (cached) return structuredClone(cached);
    const host = await this.ensureHost();
    const prompts = await collectMcpCatalogPages(async (cursor) => {
      this.requireCurrentServerConfigurationRevision(
        serverId,
        requestedRevision,
      );
      const page = await host.listPrompts(serverId, cursor);
      this.requireCurrentServerConfigurationRevision(
        serverId,
        requestedRevision,
      );
      return { items: page.prompts, nextCursor: page.nextCursor };
    });
    this.requireCurrentServerConfigurationRevision(serverId, requestedRevision);
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
    const requestedRevision = this.captureServerConfigurationRevision(serverId);
    const result = await (await this.ensureHost()).getPrompt(
      serverId,
      promptName,
      args,
      options,
    );
    this.requireCurrentServerConfigurationRevision(serverId, requestedRevision);
    return result;
  }

  public async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      agentInstanceId?: string;
      toolCallId?: string;
      finalAuthority?: TrustedMcpFinalAuthority;
      expectedDescriptorCommitment?: TrustedMcpDescriptorCommitment;
      expectedDispatchCommitment?: TrustedMcpDispatchCommitment;
      beforeDispatch?: () => void;
    } = {},
  ): Promise<unknown> {
    this.assertNotDisposed();
    await this.ensureConnected(serverId);
    const host = await this.ensureHost();
    const reviewed = createRegistryToolDispatchCommitments(
      this.getToolDispatchSnapshot(serverId, toolName),
      this.guardianPolicyRevision,
    );
    if (!options.expectedDispatchCommitment && !options.finalAuthority) {
      throw new Error('MCP dispatch is missing trusted descriptor authority');
    }
    if (options.expectedDispatchCommitment) {
      assertTrustedMcpDispatchCommitment(
        options.expectedDispatchCommitment,
        reviewed.dispatch,
      );
    }
    if (options.expectedDescriptorCommitment) {
      assertTrustedMcpDescriptorCommitment(
        options.expectedDescriptorCommitment,
        reviewed.descriptor,
      );
    }
    const authorization = await authorizeTrustedMcpDispatch({
      commitment: reviewed.dispatch,
      assessGuardian: this.guardianPolicyChecker,
      finalAuthority: options.finalAuthority,
      effect: options.finalAuthority
        ? {
            principalId: options.agentInstanceId ?? 'mcp-registry',
            toolCallId: options.toolCallId ?? 'external-dispatch',
            arguments: args,
          }
        : undefined,
    });
    const callerFence = options.beforeDispatch;
    const hostOptions = {
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.agentInstanceId
        ? { agentInstanceId: options.agentInstanceId }
        : {}),
    };

    return await host.callTool(serverId, toolName, args, {
      ...hostOptions,
      beforeDispatch: () => {
        callerFence?.();
        authorization.prepareFinalCheck();
        const current = createRegistryToolDispatchCommitments(
          this.getToolDispatchSnapshot(serverId, toolName),
          this.guardianPolicyRevision,
        );
        authorization.assertCurrent(current.dispatch);
      },
    });
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
    this.assertNotDisposed();
    if (this.host) return this.host;
    if (!this.hostPromise) {
      const hostPromise = this.createHost({
        onConnectionState: (serverId, state, error) => {
          if (this.disposed) return;
          // Request-scoped connection state is published by connectServer only
          // after its generation check. Unsolicited host state (for example a
          // restored connection after host restart) still flows through here.
          if (this.serverConnectionQueues.has(serverId)) return;
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
          if (this.disposed) return;
          this.appendLog(serverId, level, message);
        },
        onHostRestart: (_restartCount, error) => {
          if (this.disposed) return;
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
          this.assertNotDisposed();
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
        ) => {
          if (this.disposed) return { action: 'cancel' };
          return this.elicitationHandler
            ? await this.elicitationHandler(
                serverId,
                agentInstanceId,
                request,
                signal,
              )
            : { action: 'cancel' };
        },
        onListChanged: (serverId, kind, items) => {
          if (this.disposed) return;
          // A registry-side reconnect can begin before the supervisor has
          // replaced its host connection token. Drop notifications throughout
          // that critical section; a subsequent explicit list call repopulates
          // the cache from the committed connection.
          if (this.serverConnectionQueues.has(serverId)) return;
          if (kind === 'tools') {
            try {
              this.toolCache.set(
                serverId,
                commitUniqueMcpToolDescriptors(items as McpToolDescriptor[]),
              );
            } catch (error) {
              this.toolCache.delete(serverId);
              this.appendLog(serverId, 'error', toSafeErrorMessage(error));
              return;
            }
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
        if (!this.disposed) this.host = host;
        return host;
      });
      this.hostPromise = hostPromise;
    }
    const hostPromise = this.hostPromise;
    try {
      const host = await hostPromise;
      this.assertNotDisposed();
      return host;
    } finally {
      if (this.hostPromise === hostPromise) this.hostPromise = null;
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
    const connectionQueues = [...this.serverConnectionQueues.values()];
    for (const serverId of this.serverConnectionQueues.keys()) {
      // Poison every captured connection generation before any teardown await.
      this.serverConfigurationRevisions.delete(serverId);
    }
    const hostPromise = this.hostPromise;
    this.hostPromise = null;
    const host = this.host;
    this.host = null;

    await this.saveQueue.catch(() => undefined);
    await Promise.allSettled(connectionQueues);
    const pendingHost = await hostPromise?.catch(() => null);
    const hosts = new Set(
      [host, pendingHost].filter(
        (candidate): candidate is McpHostController => candidate != null,
      ),
    );
    for (const currentHost of hosts) await currentHost.teardown();
    this.runtimeStates.clear();
    this.logs.clear();
    this.toolCache.clear();
    this.resourceCache.clear();
    this.resourceTemplateCache.clear();
    this.promptCache.clear();
    this.serverConfigurationRevisions.clear();
    this.serverConnectionQueues.clear();
    this.elicitationHandler = null;
  }

  private clearCatalogCache(serverId: string): void {
    this.toolCache.delete(serverId);
    this.resourceCache.delete(serverId);
    this.resourceTemplateCache.delete(serverId);
    this.promptCache.delete(serverId);
  }

  private bumpServerConfigurationRevision(serverId: string): number {
    const current = this.serverConfigurationRevisions.get(serverId) ?? 0;
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`MCP server "${serverId}" revision space is exhausted`);
    }
    const next = current + 1;
    this.serverConfigurationRevisions.set(serverId, next);
    return next;
  }

  private captureServerConfigurationRevision(serverId: string): number {
    const revision = this.serverConfigurationRevisions.get(serverId);
    if (revision === undefined) {
      throw new Error(
        `MCP server "${serverId}" connection generation is unavailable`,
      );
    }
    return revision;
  }

  private isCurrentServerConfigurationRevision(
    serverId: string,
    revision: number,
  ): boolean {
    return this.serverConfigurationRevisions.get(serverId) === revision;
  }

  private requireCurrentServerConfigurationRevision(
    serverId: string,
    revision: number,
  ): void {
    if (!this.isCurrentServerConfigurationRevision(serverId, revision)) {
      this.throwSupersededServerConnection(serverId);
    }
  }

  private throwSupersededServerConnection(serverId: string): never {
    throw new Error(`MCP server "${serverId}" connection was superseded`);
  }

  private async withServerConnectionMutation<T>(
    serverId: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.serverConnectionQueues.get(serverId);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => await released);
    this.serverConnectionQueues.set(serverId, queued);

    if (previous) await previous.catch(() => undefined);
    try {
      return await mutation();
    } finally {
      release();
      if (this.serverConnectionQueues.get(serverId) === queued) {
        this.serverConnectionQueues.delete(serverId);
      }
    }
  }
}

function createRegistryToolDispatchCommitments(
  snapshot: McpToolDispatchSnapshot,
  guardianPolicyRevision: number,
) {
  const trusted = createTrustedRegistryMcpDescriptorCommitment(
    snapshot.server,
    snapshot.descriptor,
  );
  if (trusted.evaluation.policy.decision === 'deny') {
    throw new Error(
      `MCP policy denied "${snapshot.server.id}/${snapshot.descriptor.name}"`,
    );
  }

  return {
    descriptor: trusted.descriptor,
    dispatch: createTrustedMcpDispatchCommitment(trusted.descriptor, {
      runtime: snapshot.runtime,
      guardianPolicyRevision,
    }),
  };
}

function commitUniqueMcpToolDescriptors(
  descriptors: McpToolDescriptor[],
): McpToolDescriptor[] {
  const committed = structuredClone(descriptors);
  const names = new Set<string>();
  for (const descriptor of committed) {
    if (names.has(descriptor.name)) {
      throw new Error(
        `MCP catalog contains duplicate tool name "${descriptor.name}"`,
      );
    }
    names.add(descriptor.name);
  }
  return committed;
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
