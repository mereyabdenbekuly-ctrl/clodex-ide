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
  private client: Client | null = null;
  private transport: SSEClientTransport | null = null;
  private connectedToken: string | null = null;
  private toolDefinitionsCache: {
    token: string;
    loadedAt: number;
    tools: McpToolDefinition[];
  } | null = null;

  constructor(deps: ClodexMcpServiceDeps) {
    this.authService = deps.authService;
    this.logger = deps.logger;
    this.gatewayUrl =
      deps.gatewayUrl?.trim() ||
      process.env.CLODEX_MCP_GATEWAY_URL ||
      DEFAULT_CLODEX_MCP_GATEWAY_URL;
    this.isEnabled = deps.isEnabled ?? (() => true);
    this.recordPendingApproval = deps.recordPendingApproval;
    this.assessGuardian = deps.assessGuardian;
  }

  public async getTools(
    agentInstanceId: string,
  ): Promise<Record<string, Tool>> {
    if (!this.isEnabled()) {
      await this.resetConnection();
      return {};
    }
    const token = await this.authService.ensureModelAccessToken();
    if (!token) return {};

    try {
      const toolDefinitions = await this.getRegistrableToolDefinitions(token);
      const entries = toolDefinitions.map(
        (mcpTool) =>
          [
            toAiToolName(mcpTool.name),
            this.toAiTool(mcpTool, agentInstanceId),
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
    await this.resetConnection();
  }

  public async getCapabilityStatus(
    refresh = false,
  ): Promise<ClodexMcpCapabilityStatus> {
    const checkedAt = new Date();
    if (!this.isEnabled()) {
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
      this.toolDefinitionsCache = null;
      await this.resetConnection();
    }

    const token = await this.authService.ensureModelAccessToken();
    if (!token) {
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
    this.client = client;
    this.transport = transport;
    this.connectedToken = token;
    this.logger.debug('[ClodexMcpService] Connected to Clodex MCP Gateway');
    return client;
  }

  private async resetConnection(): Promise<void> {
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.connectedToken = null;
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
      Date.now() - this.toolDefinitionsCache.loadedAt < TOOL_LIST_CACHE_TTL_MS
    ) {
      return this.toolDefinitionsCache.tools;
    }

    const client = await this.connect(token);
    const { tools } = await client.listTools(undefined, {
      timeout: LIST_TOOLS_TIMEOUT_MS,
    });
    const safeTools = tools.filter(isRegistrableForMvp);
    this.toolDefinitionsCache = {
      token,
      loadedAt: Date.now(),
      tools: safeTools,
    };
    return safeTools;
  }

  private toAiTool(mcpTool: McpToolDefinition, agentInstanceId: string): Tool {
    return tool({
      description: buildToolDescription(mcpTool),
      inputSchema: jsonSchema<Record<string, unknown>>(
        normalizeObjectSchema(mcpTool.inputSchema),
      ),
      strict: false,
      needsApproval: async (_args, { toolCallId }) => {
        const approvalRequired = requiresApproval(mcpTool);
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
            return true;
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
              return true;
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
        return true;
      },
      execute: async (args) => {
        try {
          const client = await this.connect(
            await this.requireModelAccessToken(),
          );
          const result = await client.callTool(
            {
              name: mcpTool.name,
              arguments: args,
            },
            undefined,
            { timeout: CALL_TOOL_TIMEOUT_MS },
          );
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

function isRegistrableForMvp(toolDefinition: McpToolDefinition): boolean {
  const name = toolDefinition.name.trim();
  if (requiresApproval(toolDefinition)) return true;
  if (toolDefinition.annotations?.destructiveHint === true) return false;
  return (
    toolDefinition.annotations?.readOnlyHint === true ||
    READ_ONLY_TOOL_ALLOWLIST.has(name)
  );
}

function requiresApproval(toolDefinition: McpToolDefinition): boolean {
  return APPROVAL_REQUIRED_TOOL_ALLOWLIST.has(toolDefinition.name.trim());
}

function isReadOnlyTool(toolDefinition: McpToolDefinition): boolean {
  return (
    !requiresApproval(toolDefinition) &&
    (toolDefinition.annotations?.readOnlyHint === true ||
      READ_ONLY_TOOL_ALLOWLIST.has(toolDefinition.name.trim()))
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
