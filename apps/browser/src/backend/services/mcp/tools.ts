import { createHash } from 'node:crypto';
import {
  evaluateMcpToolPolicy,
  type McpServerConfig,
  type McpPromptDescriptor,
  type McpResourceDescriptor,
  type McpResourceTemplateDescriptor,
  type McpToolDescriptor,
} from '@clodex/mcp-runtime';
import { jsonSchema, tool, type Tool } from 'ai';
import type {
  GuardianAssessment,
  GuardianPolicyChecker,
} from '@shared/guardian';
import { createMcpGuardianRequest } from '@/services/guardian/requests';
import type { McpRegistryService } from './index';
import { capToolOutput, rethrowCappedToolOutputError } from '../toolbox/utils';

export interface CreateRegistryMcpToolsOptions {
  registry: McpRegistryService;
  agentInstanceId: string;
  assessGuardian?: GuardianPolicyChecker;
  recordPendingApproval?: (toolCallId: string, explanation: string) => void;
}

export async function createRegistryMcpTools(
  options: CreateRegistryMcpToolsOptions,
): Promise<Record<string, Tool>> {
  const registry = options.registry.snapshot();
  const enabledServers = Object.values(registry.servers).filter(
    (server) => server.enabled,
  );
  const entries = await Promise.all(
    enabledServers.map(async (server) => {
      try {
        const [definitions, resources, resourceTemplates, prompts] =
          await Promise.all([
            options.registry.listTools(server.id),
            options.registry.listResources(server.id).catch(() => []),
            options.registry.listResourceTemplates(server.id).catch(() => []),
            options.registry.listPrompts(server.id).catch(() => []),
          ]);
        const toolEntries = definitions.flatMap((definition) => {
          const effectivePolicy = evaluateMcpToolPolicy(server, {
            name: definition.name,
            readOnlyHint: definition.annotations?.readOnlyHint,
            destructiveHint: definition.annotations?.destructiveHint,
          });
          if (effectivePolicy.decision === 'deny') return [];
          return [
            [
              toRegistryMcpToolName(server.id, definition.name),
              toAiTool(server, definition, effectivePolicy.decision, options),
            ] as const,
          ];
        });
        if (resources.length > 0 || resourceTemplates.length > 0) {
          toolEntries.push([
            toRegistryMcpToolName(server.id, 'read_resource'),
            toResourceTool(server, resources, resourceTemplates, options),
          ]);
        }
        if (prompts.length > 0) {
          toolEntries.push([
            toRegistryMcpToolName(server.id, 'get_prompt'),
            toPromptTool(server, prompts, options),
          ]);
        }
        return toolEntries;
      } catch {
        // A broken optional MCP server must not prevent the rest of the agent
        // toolbox from being assembled. Health and diagnostics remain visible
        // through the registry state.
        return [];
      }
    }),
  );
  return Object.fromEntries(entries.flat());
}

function toResourceTool(
  server: McpServerConfig,
  resources: McpResourceDescriptor[],
  templates: McpResourceTemplateDescriptor[],
  options: CreateRegistryMcpToolsOptions,
): Tool {
  const catalog = [
    ...resources.slice(0, 20).map((resource) => resource.uri),
    ...templates.slice(0, 20).map((template) => template.uriTemplate),
  ];
  return tool({
    description: [
      `[MCP: ${server.displayName}] Read a resource exposed by this server.`,
      catalog.length > 0
        ? `Known resources/templates:\n${catalog.map((item) => `- ${item}`).join('\n')}`
        : '',
      requiresContextApproval(server)
        ? 'Requires user approval because this is a custom or imported MCP server.'
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    inputSchema: jsonSchema<{ uri: string }>({
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: 'Exact MCP resource URI to read.',
        },
      },
      required: ['uri'],
      additionalProperties: false,
    }),
    strict: true,
    needsApproval: requiresContextApproval(server),
    execute: async ({ uri }) => {
      const result = await options.registry.readResource(server.id, uri);
      const capped = capToolOutput({
        message: `MCP resource ${server.displayName}/${uri} was read.`,
        serverId: server.id,
        tool: 'read_resource',
        agentInstanceId: options.agentInstanceId,
        result,
      });
      return {
        message: capped.truncated
          ? 'MCP resource was read. Output was truncated.'
          : 'MCP resource was read.',
        result: capped.result,
        truncated: capped.truncated,
      };
    },
  });
}

function toPromptTool(
  server: McpServerConfig,
  prompts: McpPromptDescriptor[],
  options: CreateRegistryMcpToolsOptions,
): Tool {
  const catalog = prompts.slice(0, 50).map((prompt) => {
    const args =
      prompt.arguments
        ?.map((argument) => `${argument.name}${argument.required ? '*' : ''}`)
        .join(', ') ?? '';
    return `- ${prompt.name}${args ? ` (${args})` : ''}: ${
      prompt.description?.trim() || 'No description'
    }`;
  });
  return tool({
    description: [
      `[MCP: ${server.displayName}] Resolve a reusable prompt exposed by this server.`,
      catalog.join('\n'),
      requiresContextApproval(server)
        ? 'Requires user approval because prompt arguments are sent to a custom or imported MCP server.'
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    inputSchema: jsonSchema<{
      name: string;
      arguments?: Record<string, string>;
    }>({
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: prompts.map((prompt) => prompt.name),
        },
        arguments: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['name'],
      additionalProperties: false,
    }),
    strict: true,
    needsApproval: requiresContextApproval(server),
    execute: async ({ name, arguments: args = {} }) => {
      const result = await options.registry.getPrompt(server.id, name, args);
      const capped = capToolOutput({
        message: `MCP prompt ${server.displayName}/${name} was resolved.`,
        serverId: server.id,
        tool: 'get_prompt',
        agentInstanceId: options.agentInstanceId,
        result,
      });
      return {
        message: capped.truncated
          ? 'MCP prompt was resolved. Output was truncated.'
          : 'MCP prompt was resolved.',
        result: capped.result,
        truncated: capped.truncated,
      };
    },
  });
}

function requiresContextApproval(server: McpServerConfig): boolean {
  return server.source.kind === 'user' || server.source.kind === 'imported';
}

function toAiTool(
  server: McpServerConfig,
  definition: McpToolDescriptor,
  policyDecision: 'allow' | 'ask',
  options: CreateRegistryMcpToolsOptions,
): Tool {
  const readOnly = definition.annotations?.readOnlyHint === true;
  const destructive = definition.annotations?.destructiveHint === true;
  return tool({
    description: buildDescription(server, definition, policyDecision),
    inputSchema: jsonSchema<Record<string, unknown>>(
      normalizeObjectSchema(definition.inputSchema),
    ),
    strict: false,
    needsApproval: async (_args, { toolCallId }) => {
      const policyRequiresApproval = policyDecision === 'ask' || destructive;
      if (options.assessGuardian) {
        let assessment: GuardianAssessment | null;
        try {
          assessment = await options.assessGuardian(
            createMcpGuardianRequest({
              toolName: definition.name,
              readOnly,
              destructive,
              requiresApproval: policyRequiresApproval,
            }),
          );
        } catch {
          options.recordPendingApproval?.(
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
            policyRequiresApproval ||
            assessment.irreversible ||
            assessment.decision === 'escalate'
          ) {
            options.recordPendingApproval?.(toolCallId, assessment.explanation);
            return true;
          }
          return false;
        }
      }

      if (!policyRequiresApproval) return false;
      options.recordPendingApproval?.(
        toolCallId,
        buildApprovalExplanation(server, definition),
      );
      return true;
    },
    execute: async (args) => {
      try {
        const result = await options.registry.callTool(
          server.id,
          definition.name,
          args,
          { agentInstanceId: options.agentInstanceId },
        );
        const capped = capToolOutput({
          message: `MCP tool ${server.displayName}/${definition.name} completed.`,
          serverId: server.id,
          tool: definition.name,
          agentInstanceId: options.agentInstanceId,
          result,
        });
        return {
          message: capped.truncated
            ? `MCP tool ${server.displayName}/${definition.name} completed. Output was truncated.`
            : `MCP tool ${server.displayName}/${definition.name} completed.`,
          result: capped.result,
          truncated: capped.truncated,
        };
      } catch (error) {
        rethrowCappedToolOutputError(error);
      }
    },
  });
}

function buildDescription(
  server: McpServerConfig,
  definition: McpToolDescriptor,
  policyDecision: 'allow' | 'ask',
): string {
  const description =
    definition.description?.trim() || 'Tool exposed by an MCP server.';
  const executionBoundary =
    server.transport.type === 'stdio'
      ? 'Runs through a local MCP process with the current OS user privileges.'
      : 'Runs through a remote MCP server over the network.';
  return [
    `[MCP: ${server.displayName} / ${definition.name}] ${description}`,
    executionBoundary,
    policyDecision === 'ask'
      ? 'Requires explicit user approval before execution.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildApprovalExplanation(
  server: McpServerConfig,
  definition: McpToolDescriptor,
): string {
  const location =
    server.transport.type === 'stdio' ? 'a local process' : 'a remote server';
  return `Runs MCP tool ${server.displayName}/${definition.name} through ${location}. Review the exact arguments before allowing.`;
}

function normalizeObjectSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> & { type: 'object' } {
  return {
    ...schema,
    type: 'object',
    properties:
      schema.properties &&
      typeof schema.properties === 'object' &&
      !Array.isArray(schema.properties)
        ? schema.properties
        : {},
  };
}

function toRegistryMcpToolName(serverId: string, toolName: string): string {
  const digest = createHash('sha256')
    .update(serverId)
    .update('\0')
    .update(toolName)
    .digest('hex')
    .slice(0, 8);
  return `mcp_${slug(serverId, 20)}_${slug(toolName, 26)}_${digest}`;
}

function slug(value: string, maxLength: number): string {
  const normalized =
    value
      .trim()
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, maxLength) || 'tool';
  return normalized;
}
