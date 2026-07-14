import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { jsonSchema, tool, type Tool } from 'ai';
import type { AuthService } from '@/services/auth';
import type { Logger } from '@/services/logger';
import { capToolOutput, rethrowCappedToolOutputError } from '../../utils';
import type {
  ClodexMcpCapabilityStatus,
  ClodexMcpCapabilityTool,
} from '@shared/karton-contracts/ui';
import type {
  GuardianAssessment,
  GuardianPolicyChecker,
} from '@shared/guardian';
import { createMcpGuardianRequest } from '@/services/guardian/requests';
import {
  assertTrustedMcpDispatchCommitment,
  assertTrustedMcpDescriptorCommitment,
  authorizeTrustedMcpDispatch,
  createTrustedMcpDescriptorCommitment,
  createTrustedMcpDispatchCommitment,
  type TrustedMcpDescriptorCommitment,
  type TrustedMcpDispatchAuthorization,
  type TrustedMcpFinalAuthority,
} from '@/services/mcp/trusted-dispatch-gateway';
import type {
  ClaimTrustedMcpApprovalInput,
  StageTrustedMcpApprovalInput,
} from '@/services/mcp/approval-broker';

const DEFAULT_CLODEX_MCP_GATEWAY_URL = 'https://clodex.xyz/tools-gateway/mcp';
const READ_ONLY_TOOL_ALLOWLIST = new Set(['tcp_check']);
const APPROVAL_REQUIRED_TOOL_ALLOWLIST = new Set(['ssh_exec']);
const TOOL_LIST_CACHE_TTL_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 8_000;
const LIST_TOOLS_TIMEOUT_MS = 8_000;
const CALL_TOOL_TIMEOUT_MS = 60_000;

type McpToolDefinition = Awaited<
  ReturnType<Client['listTools']>
>['tools'][number];

interface ClodexMcpDispatchSnapshot {
  client: Client;
  token: string;
  connectionGeneration: number;
  catalogRevision: number;
  descriptor: McpToolDefinition;
}

export interface ClodexMcpServiceDeps {
  authService: AuthService;
  logger: Logger;
  gatewayUrl?: string;
  isEnabled?: () => boolean;
  recordPendingApproval?: (
    agentInstanceId: string,
    toolCallId: string,
    explanation: string,
  ) => void;
  assessGuardian?: GuardianPolicyChecker;
  claimApprovalAuthority?: (
    input: ClaimTrustedMcpApprovalInput,
  ) => TrustedMcpFinalAuthority | null;
  stageApproval?: (input: StageTrustedMcpApprovalInput) => void;
}

export class ClodexMcpService {
  private readonly authService: AuthService;
  private readonly logger: Logger;
  private readonly gatewayUrl: string;
  private readonly isEnabled: () => boolean;
  private readonly recordPendingApproval?:
    | ((
        agentInstanceId: string,
        toolCallId: string,
        explanation: string,
      ) => void)
    | undefined;
  private readonly assessGuardian: GuardianPolicyChecker | undefined;
  private readonly claimApprovalAuthority:
    | ClodexMcpServiceDeps['claimApprovalAuthority']
    | undefined;
  private readonly stageApproval:
    | ClodexMcpServiceDeps['stageApproval']
    | undefined;
  private client: Client | null = null;
  private transport: SSEClientTransport | null = null;
  private connectedToken: string | null = null;
  private connectionGeneration = 0;
  private toolCatalogRevision = 0;
  private toolDefinitionsCache: {
    token: string;
    loadedAt: number;
    connectionGeneration: number;
    catalogRevision: number;
    tools: McpToolDefinition[];
  } | null = null;

  constructor(deps: ClodexMcpServiceDeps) {
    this.authService = deps.authService;
    this.logger = deps.logger;
    this.gatewayUrl = requireSafeGatewayUrl(
      deps.gatewayUrl?.trim() ||
        process.env.CLODEX_MCP_GATEWAY_URL ||
        DEFAULT_CLODEX_MCP_GATEWAY_URL,
    );
    this.isEnabled = deps.isEnabled ?? (() => true);
    this.recordPendingApproval = deps.recordPendingApproval;
    this.assessGuardian = deps.assessGuardian;
    this.claimApprovalAuthority = deps.claimApprovalAuthority;
    this.stageApproval = deps.stageApproval;
  }

  public async getTools(
    agentInstanceId: string,
  ): Promise<Record<string, Tool>> {
    if (!this.isEnabled()) {
      this.clearToolDefinitionsCache();
      await this.resetConnection();
      return {};
    }
    const token = await this.authService.ensureModelAccessToken();
    if (!token) {
      this.clearToolDefinitionsCache();
      await this.resetConnection();
      return {};
    }

    try {
      const toolDefinitions = await this.getRegistrableToolDefinitions(token);
      const registrationCache = this.toolDefinitionsCache;
      if (
        !registrationCache ||
        registrationCache.token !== token ||
        registrationCache.connectionGeneration !== this.connectionGeneration
      ) {
        throw new Error('Clodex MCP tool catalog is not committed');
      }
      const entries = toolDefinitions.map(
        (mcpTool) =>
          [
            toAiToolName(mcpTool.name),
            this.toAiTool(
              mcpTool,
              agentInstanceId,
              registrationCache.connectionGeneration,
              registrationCache.catalogRevision,
            ),
          ] as const,
      );
      return Object.fromEntries(entries);
    } catch (error) {
      this.logger.warn(`[ClodexMcpService] Failed to load MCP tools: ${error}`);
      await this.resetConnection();
      return {};
    }
  }

  public async teardown(): Promise<void> {
    this.clearToolDefinitionsCache();
    await this.resetConnection();
  }

  public async getCapabilityStatus(
    refresh = false,
  ): Promise<ClodexMcpCapabilityStatus> {
    const checkedAt = new Date();
    if (!this.isEnabled()) {
      this.clearToolDefinitionsCache();
      await this.resetConnection();
      return {
        state: 'signed-out',
        gatewayUrl: sanitizeGatewayUrl(this.gatewayUrl),
        checkedAt,
        cacheExpiresAt: null,
        tools: [],
      };
    }
    if (refresh) {
      this.clearToolDefinitionsCache();
      await this.resetConnection();
    }

    const token = await this.authService.ensureModelAccessToken();
    if (!token) {
      this.clearToolDefinitionsCache();
      await this.resetConnection();
      return {
        state: 'signed-out',
        gatewayUrl: sanitizeGatewayUrl(this.gatewayUrl),
        checkedAt,
        cacheExpiresAt: null,
        tools: [],
      };
    }

    try {
      const definitions = await this.getRegistrableToolDefinitions(token);
      const loadedAt =
        this.toolDefinitionsCache?.loadedAt ?? checkedAt.getTime();
      return {
        state: 'connected',
        gatewayUrl: sanitizeGatewayUrl(this.gatewayUrl),
        checkedAt,
        cacheExpiresAt: new Date(loadedAt + TOOL_LIST_CACHE_TTL_MS),
        tools: definitions.map(toCapabilityTool),
      };
    } catch (error) {
      this.logger.warn(
        `[ClodexMcpService] Failed to inspect MCP capability: ${error}`,
      );
      await this.resetConnection();
      return {
        state: 'unavailable',
        gatewayUrl: sanitizeGatewayUrl(this.gatewayUrl),
        checkedAt,
        cacheExpiresAt: null,
        tools: [],
        error: 'Unable to connect to the Clodex Tools Gateway.',
      };
    }
  }

  private async connect(token: string): Promise<Client> {
    if (this.client && this.connectedToken === token) {
      return this.client;
    }

    await this.resetConnection();

    const client = new Client(
      { name: 'clodex-ide', version: '1.0.0' },
      { capabilities: {} },
    );
    const transport = new SSEClientTransport(new URL(this.gatewayUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    this.advanceConnectionGeneration();
    this.client = client;
    this.transport = transport;
    this.connectedToken = token;
    this.clearToolDefinitionsCache();
    this.logger.debug('[ClodexMcpService] Connected to Clodex MCP Gateway');
    return client;
  }

  private async resetConnection(): Promise<void> {
    const transport = this.transport;
    const hadConnection =
      this.client !== null ||
      this.transport !== null ||
      this.connectedToken !== null;
    this.client = null;
    this.transport = null;
    this.connectedToken = null;
    if (hadConnection) {
      this.advanceConnectionGeneration();
      this.clearToolDefinitionsCache();
    }
    if (!transport) return;
    try {
      await transport.close();
    } catch (error) {
      this.logger.debug('[ClodexMcpService] Failed to close MCP transport', {
        error,
      });
    }
  }

  private async getRegistrableToolDefinitions(
    token: string,
  ): Promise<McpToolDefinition[]> {
    if (
      this.toolDefinitionsCache?.token === token &&
      this.toolDefinitionsCache.connectionGeneration ===
        this.connectionGeneration &&
      Date.now() - this.toolDefinitionsCache.loadedAt < TOOL_LIST_CACHE_TTL_MS
    ) {
      return structuredClone(this.toolDefinitionsCache.tools);
    }

    const client = await this.connect(token);
    const { tools } = await client.listTools(undefined, {
      timeout: LIST_TOOLS_TIMEOUT_MS,
    });
    if (this.client !== client || this.connectedToken !== token) {
      throw new Error('Clodex MCP connection changed while listing tools');
    }
    const safeTools = commitRegistrableToolDefinitions(tools);
    const catalogRevision = this.advanceToolCatalogRevision();
    this.toolDefinitionsCache = {
      token,
      loadedAt: Date.now(),
      connectionGeneration: this.connectionGeneration,
      catalogRevision,
      tools: safeTools,
    };
    return structuredClone(safeTools);
  }

  private async getDispatchSnapshot(
    token: string,
    toolName: string,
  ): Promise<ClodexMcpDispatchSnapshot> {
    if (!this.isEnabled()) {
      throw new Error('Clodex MCP dispatch is disabled');
    }
    const client = await this.connect(token);
    await this.getRegistrableToolDefinitions(token);
    if (!this.isEnabled()) {
      throw new Error('Clodex MCP dispatch was disabled before authorization');
    }

    const cache = this.toolDefinitionsCache;
    if (
      this.client !== client ||
      this.connectedToken !== token ||
      !cache ||
      cache.token !== token ||
      cache.connectionGeneration !== this.connectionGeneration
    ) {
      throw new Error('Clodex MCP dispatch state is not committed');
    }
    const descriptor = cache.tools.find(
      (candidate) => candidate.name === toolName,
    );
    if (!descriptor || !isRegistrableForMvp(descriptor)) {
      throw new Error(`Clodex MCP tool "${toolName}" is not committed`);
    }

    return {
      client,
      token,
      connectionGeneration: this.connectionGeneration,
      catalogRevision: cache.catalogRevision,
      descriptor: structuredClone(descriptor),
    };
  }

  private assertCurrentDispatch(
    expected: ClodexMcpDispatchSnapshot,
    reviewedDescriptor: TrustedMcpDescriptorCommitment,
    authorization: TrustedMcpDispatchAuthorization,
  ): void {
    authorization.prepareFinalCheck();
    if (!this.isEnabled()) {
      throw new Error('Clodex MCP dispatch was disabled after authorization');
    }
    const cache = this.toolDefinitionsCache;
    if (
      this.client !== expected.client ||
      this.connectedToken !== expected.token ||
      this.connectionGeneration !== expected.connectionGeneration ||
      !cache ||
      cache.token !== expected.token ||
      cache.connectionGeneration !== expected.connectionGeneration ||
      cache.catalogRevision !== expected.catalogRevision
    ) {
      throw new Error('Clodex MCP connection changed after authorization');
    }
    const descriptor = cache.tools.find(
      (candidate) => candidate.name === expected.descriptor.name,
    );
    if (!descriptor || !isRegistrableForMvp(descriptor)) {
      throw new Error(
        `Clodex MCP tool "${expected.descriptor.name}" is no longer committed`,
      );
    }

    const currentDescriptor = createClodexMcpDescriptorCommitment(
      this.gatewayUrl,
      expected.connectionGeneration,
      descriptor,
    );
    assertTrustedMcpDescriptorCommitment(reviewedDescriptor, currentDescriptor);
    authorization.assertCurrent(
      createTrustedMcpDispatchCommitment(
        currentDescriptor,
        toClodexMcpRuntimeBinding(expected),
      ),
    );
  }

  private advanceConnectionGeneration(): number {
    if (this.connectionGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Clodex MCP connection generation space is exhausted');
    }
    this.connectionGeneration += 1;
    return this.connectionGeneration;
  }

  private advanceToolCatalogRevision(): number {
    if (this.toolCatalogRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Clodex MCP catalog revision space is exhausted');
    }
    this.toolCatalogRevision += 1;
    return this.toolCatalogRevision;
  }

  private clearToolDefinitionsCache(): void {
    if (!this.toolDefinitionsCache) return;
    this.advanceToolCatalogRevision();
    this.toolDefinitionsCache = null;
  }

  private toAiTool(
    mcpTool: McpToolDefinition,
    agentInstanceId: string,
    registrationConnectionGeneration: number,
    registrationCatalogRevision: number,
  ): Tool {
    const reviewedDescriptor = createClodexMcpDescriptorCommitment(
      this.gatewayUrl,
      registrationConnectionGeneration,
      mcpTool,
    );
    const reviewedDispatch = createTrustedMcpDispatchCommitment(
      reviewedDescriptor,
      toClodexMcpRuntimeBinding({
        connectionGeneration: registrationConnectionGeneration,
        catalogRevision: registrationCatalogRevision,
      }),
    );
    const aiToolName = toAiToolName(mcpTool.name);
    return tool({
      description: buildToolDescription(mcpTool),
      inputSchema: jsonSchema<Record<string, unknown>>(
        normalizeObjectSchema(mcpTool.inputSchema),
      ),
      strict: false,
      needsApproval: async (args, { toolCallId }) => {
        const approvalRequired = requiresApproval(mcpTool);
        const stageApproval = (): true => {
          if (!this.stageApproval) {
            throw new Error('MCP approval broker is unavailable');
          }
          this.stageApproval({
            agentInstanceId,
            toolCallId,
            aiToolName,
            arguments: args,
            descriptor: reviewedDescriptor,
            approvalContextDigest: reviewedDispatch.digest,
          });
          return true;
        };
        if (this.assessGuardian) {
          let assessment: GuardianAssessment | null;
          try {
            assessment = await this.assessGuardian(
              createMcpGuardianRequest({
                toolName: mcpTool.name,
                readOnly: isReadOnlyTool(mcpTool),
                destructive: mcpTool.annotations?.destructiveHint === true,
                requiresApproval: approvalRequired,
              }),
            );
          } catch {
            this.recordPendingApproval?.(
              agentInstanceId,
              toolCallId,
              'Guardian assessment failed. Approving manually to stay safe.',
            );
            return stageApproval();
          }
          if (assessment) {
            if (assessment.decision === 'deny') {
              throw new Error(
                `Guardian denied action: ${assessment.explanation}`,
              );
            }
            if (
              approvalRequired ||
              assessment.irreversible ||
              assessment.decision === 'escalate'
            ) {
              this.recordPendingApproval?.(
                agentInstanceId,
                toolCallId,
                assessment.explanation,
              );
              return stageApproval();
            }
            return false;
          }
        }

        if (!approvalRequired) return false;

        this.recordPendingApproval?.(
          agentInstanceId,
          toolCallId,
          buildApprovalExplanation(mcpTool),
        );
        return stageApproval();
      },
      execute: async (args, executionOptions) => {
        const toolCallId = (
          executionOptions as { toolCallId?: string } | undefined
        )?.toolCallId;
        const finalAuthority =
          toolCallId && this.claimApprovalAuthority
            ? (this.claimApprovalAuthority({
                agentInstanceId,
                toolCallId,
                aiToolName,
                arguments: args,
                descriptor: reviewedDescriptor,
                approvalContextDigest: reviewedDispatch.digest,
              }) ?? undefined)
            : undefined;
        try {
          const token = await this.requireModelAccessToken();
          const dispatchSnapshot = await this.getDispatchSnapshot(
            token,
            mcpTool.name,
          );
          const currentDescriptor = createClodexMcpDescriptorCommitment(
            this.gatewayUrl,
            dispatchSnapshot.connectionGeneration,
            dispatchSnapshot.descriptor,
          );
          assertTrustedMcpDescriptorCommitment(
            reviewedDescriptor,
            currentDescriptor,
          );
          const dispatchCommitment = createTrustedMcpDispatchCommitment(
            currentDescriptor,
            toClodexMcpRuntimeBinding(dispatchSnapshot),
          );
          assertTrustedMcpDispatchCommitment(
            reviewedDispatch,
            dispatchCommitment,
          );
          const authorization = await authorizeTrustedMcpDispatch({
            commitment: dispatchCommitment,
            assessGuardian: this.assessGuardian,
            finalAuthority,
            effect: finalAuthority
              ? {
                  principalId: agentInstanceId,
                  toolCallId: toolCallId ?? 'unapproved-dispatch',
                  arguments: args,
                }
              : undefined,
          });
          this.assertCurrentDispatch(
            dispatchSnapshot,
            reviewedDescriptor,
            authorization,
          );

          // No await is permitted between the final synchronous fence and the
          // SDK call. The call promise is captured only after authority passes.
          const resultPromise = dispatchSnapshot.client.callTool(
            {
              name: mcpTool.name,
              arguments: args,
            },
            undefined,
            { timeout: CALL_TOOL_TIMEOUT_MS },
          );
          const result = await resultPromise;
          const content = formatMcpContent(result.content);
          const capped = capToolOutput({
            message: `Clodex cloud tool ${mcpTool.name} completed.`,
            tool: mcpTool.name,
            agentInstanceId,
            content,
            raw: result,
          });
          return {
            message: capped.truncated
              ? `Clodex cloud tool ${mcpTool.name} completed. Output was truncated.`
              : `Clodex cloud tool ${mcpTool.name} completed.`,
            result: capped.result,
            truncated: capped.truncated,
          };
        } catch (error) {
          rethrowCappedToolOutputError(error);
        }
      },
    });
  }

  private async requireModelAccessToken(): Promise<string> {
    const token = await this.authService.ensureModelAccessToken();
    if (!token) {
      throw new Error('Sign in to Clodex and select an active key first.');
    }
    return token;
  }
}

function commitRegistrableToolDefinitions(
  definitions: McpToolDefinition[],
): McpToolDefinition[] {
  const committed = structuredClone(definitions.filter(isRegistrableForMvp));
  const names = new Set<string>();
  const aiNames = new Set<string>();
  for (const definition of committed) {
    const aiName = toAiToolName(definition.name);
    if (names.has(definition.name) || aiNames.has(aiName)) {
      throw new Error(
        `Clodex MCP catalog contains an ambiguous tool "${definition.name}"`,
      );
    }
    names.add(definition.name);
    aiNames.add(aiName);
  }
  return committed;
}

function createClodexMcpDescriptorCommitment(
  gatewayUrl: string,
  connectionGeneration: number,
  descriptor: McpToolDefinition,
): TrustedMcpDescriptorCommitment {
  const destructive = descriptor.annotations?.destructiveHint === true;
  // Bind only the canonical network authority. The configured path may be an
  // opaque deployment route and must never become secret material inside a
  // persisted/observable commitment. This service's immutable client and
  // connection generation still bind dispatch to the exact live transport.
  const gatewayOrigin = new URL(gatewayUrl).origin;
  return createTrustedMcpDescriptorCommitment({
    domain: 'clodex-cloud-mcp',
    authorityId: `clodex-cloud:${gatewayOrigin}`,
    toolName: descriptor.name,
    descriptor,
    authorityBinding: {
      gatewayOrigin,
      connectionGeneration,
    },
    classification: {
      readOnly: isReadOnlyTool(descriptor),
      destructive,
      requiresApproval: requiresApproval(descriptor),
    },
  });
}

function toClodexMcpRuntimeBinding(
  snapshot: Pick<
    ClodexMcpDispatchSnapshot,
    'connectionGeneration' | 'catalogRevision'
  >,
) {
  return {
    connectionGeneration: snapshot.connectionGeneration,
    catalogRevision: snapshot.catalogRevision,
  };
}

function isRegistrableForMvp(toolDefinition: McpToolDefinition): boolean {
  const name = toolDefinition.name.trim();
  if (!name || name !== toolDefinition.name) return false;
  // The MCP SDK has no synchronous before-send hook. Until it does, direct
  // cloud dispatch is limited to the host-maintained read-only allowlist;
  // effectful tools fail closed instead of claiming atomic mediation.
  return (
    READ_ONLY_TOOL_ALLOWLIST.has(name) && !requiresApproval(toolDefinition)
  );
}

function requiresApproval(toolDefinition: McpToolDefinition): boolean {
  return (
    APPROVAL_REQUIRED_TOOL_ALLOWLIST.has(toolDefinition.name.trim()) ||
    toolDefinition.annotations?.destructiveHint === true
  );
}

function isReadOnlyTool(toolDefinition: McpToolDefinition): boolean {
  return (
    !requiresApproval(toolDefinition) &&
    READ_ONLY_TOOL_ALLOWLIST.has(toolDefinition.name.trim())
  );
}

function toAiToolName(name: string): `mcp_clodex_${string}` {
  return `mcp_clodex_${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function buildToolDescription(toolDefinition: McpToolDefinition): string {
  const description =
    toolDefinition.description?.trim() || 'Remote Clodex cloud tool.';
  return [
    `[Clodex Cloud Tool: ${toolDefinition.name}] ${description}`,
    'Runs remotely through the Clodex Tools Gateway, not in the local shell.',
    requiresApproval(toolDefinition)
      ? 'Requires explicit user approval before execution.'
      : '',
  ].join('\n');
}

function buildApprovalExplanation(toolDefinition: McpToolDefinition): string {
  if (toolDefinition.name.trim() === 'ssh_exec') {
    return 'Runs a remote SSH command through Clodex Cloud. Review the exact arguments before allowing.';
  }
  return `Runs Clodex Cloud Tool ${toolDefinition.name}. Review the exact arguments before allowing.`;
}

function toCapabilityTool(
  toolDefinition: McpToolDefinition,
): ClodexMcpCapabilityTool {
  const properties = toolDefinition.inputSchema.properties ?? {};
  const requiredFields = new Set(toolDefinition.inputSchema.required ?? []);

  return {
    id: toAiToolName(toolDefinition.name),
    name: toolDefinition.name,
    description:
      toolDefinition.description?.trim() || 'Remote Clodex cloud tool.',
    readOnly: isReadOnlyTool(toolDefinition),
    requiresApproval: requiresApproval(toolDefinition),
    destructive: toolDefinition.annotations?.destructiveHint === true,
    inputFields: Object.entries(properties).map(([name, rawSchema]) => {
      const schema =
        rawSchema && typeof rawSchema === 'object'
          ? (rawSchema as Record<string, unknown>)
          : {};
      return {
        name,
        type: describeJsonSchemaType(schema.type),
        required: requiredFields.has(name),
        description:
          typeof schema.description === 'string'
            ? schema.description
            : undefined,
      };
    }),
  };
}

function describeJsonSchemaType(type: unknown): string {
  if (Array.isArray(type)) {
    const types = type.filter(
      (value): value is string => typeof value === 'string',
    );
    return types.length > 0 ? types.join(' | ') : 'value';
  }
  return typeof type === 'string' && type ? type : 'value';
}

function sanitizeGatewayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'Configured MCP gateway';
  }
}

function requireSafeGatewayUrl(value: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new Error('Clodex MCP gateway URL is not a safe canonical endpoint');
  }
  return url.toString();
}

function normalizeObjectSchema(
  schema: McpToolDefinition['inputSchema'],
): Record<string, unknown> & { type: 'object' } {
  return {
    ...schema,
    type: 'object',
    properties: schema.properties ?? {},
  };
}

function formatMcpContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [JSON.stringify(content)];

  return content.map((item: unknown) => {
    if (!isRecord(item)) return String(item);
    const type = typeof item.type === 'string' ? item.type : 'unknown';
    switch (item.type) {
      case 'text': {
        return typeof item.text === 'string' ? item.text : '[text]';
      }
      case 'resource': {
        const resource = item.resource;
        if (isRecord(resource)) {
          if (typeof resource.text === 'string') return resource.text;
          if (typeof resource.uri === 'string') {
            return `[resource: ${resource.uri}]`;
          }
        }
        return '[resource]';
      }
      case 'image': {
        return `[image: ${typeof item.mimeType === 'string' ? item.mimeType : 'unknown'}]`;
      }
      case 'audio': {
        return `[audio: ${typeof item.mimeType === 'string' ? item.mimeType : 'unknown'}]`;
      }
      case 'resource_link': {
        const name = typeof item.name === 'string' ? item.name : 'resource';
        const uri = typeof item.uri === 'string' ? item.uri : '';
        return `[resource link: ${name}${uri ? ` ${uri}` : ''}]`;
      }
      default:
        return `[${type}: ${JSON.stringify(item)}]`;
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
