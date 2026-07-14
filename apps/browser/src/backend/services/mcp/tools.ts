import { createHash } from 'node:crypto';
import {
  type McpServerConfig,
  type McpToolDescriptor,
} from '@clodex/mcp-runtime';
import { jsonSchema, tool, type Tool } from 'ai';
import type {
  GuardianAssessment,
  GuardianPolicyChecker,
} from '@shared/guardian';
import { createMcpGuardianRequest } from '@/services/guardian/requests';
import type { McpRegistryService } from './index';
import {
  type TrustedMcpDescriptorCommitment,
  type TrustedMcpDispatchCommitment,
  type TrustedMcpFinalAuthority,
} from './trusted-dispatch-gateway';
import type {
  ClaimTrustedMcpApprovalInput,
  StageTrustedMcpApprovalInput,
} from './approval-broker';
import { capToolOutput, rethrowCappedToolOutputError } from '../toolbox/utils';

export interface CreateRegistryMcpToolsOptions {
  registry: McpRegistryService;
  agentInstanceId: string;
  assessGuardian?: GuardianPolicyChecker;
  recordPendingApproval?: (toolCallId: string, explanation: string) => void;
  claimApprovalAuthority?: (
    input: ClaimTrustedMcpApprovalInput,
  ) => TrustedMcpFinalAuthority | null;
  stageApproval?: (input: StageTrustedMcpApprovalInput) => void;
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
        const definitions = await options.registry.listTools(server.id);
        const toolEntries = definitions.flatMap((definition) => {
          const expectedDispatch = options.registry.getToolDispatchCommitment(
            server.id,
            definition.name,
          );
          const policyDecision = expectedDispatch.descriptor.classification
            .requiresApproval
            ? 'ask'
            : 'allow';
          return [
            [
              toRegistryMcpToolName(server.id, definition.name),
              toAiTool(
                server,
                definition,
                policyDecision,
                expectedDispatch,
                options,
              ),
            ] as const,
          ];
        });
        return toolEntries;
      } catch {
        // A broken optional MCP server must not prevent the rest of the agent
        // toolbox from being assembled. Health and diagnostics remain visible
        // through the registry state.
        return [];
      }
    }),
  );
  const flattened = entries.flat();
  const counts = new Map<string, number>();
  for (const [name] of flattened) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Object.fromEntries(
    flattened.filter(([name]) => counts.get(name) === 1),
  );
}

function toAiTool(
  server: McpServerConfig,
  definition: McpToolDescriptor,
  policyDecision: 'allow' | 'ask',
  expectedDispatch: TrustedMcpDispatchCommitment,
  options: CreateRegistryMcpToolsOptions,
): Tool {
  const descriptorCommitment: TrustedMcpDescriptorCommitment =
    expectedDispatch.descriptor;
  const { readOnly, destructive, requiresApproval } =
    descriptorCommitment.classification;
  const aiToolName = toRegistryMcpToolName(server.id, definition.name);
  return tool({
    description: buildDescription(server, definition, policyDecision),
    inputSchema: jsonSchema<Record<string, unknown>>(
      normalizeObjectSchema(definition.inputSchema),
    ),
    strict: false,
    needsApproval: async (args, { toolCallId }) => {
      const stageApproval = (): true => {
        if (!options.stageApproval) {
          throw new Error('MCP approval broker is unavailable');
        }
        options.stageApproval({
          agentInstanceId: options.agentInstanceId,
          toolCallId,
          aiToolName,
          arguments: args,
          descriptor: descriptorCommitment,
          approvalContextDigest: expectedDispatch.digest,
        });
        return true;
      };
      if (options.assessGuardian) {
        let assessment: GuardianAssessment | null;
        try {
          assessment = await options.assessGuardian(
            createMcpGuardianRequest({
              toolName: definition.name,
              readOnly,
              destructive,
              requiresApproval,
            }),
          );
        } catch {
          options.recordPendingApproval?.(
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
            requiresApproval ||
            assessment.irreversible ||
            assessment.decision === 'escalate'
          ) {
            options.recordPendingApproval?.(toolCallId, assessment.explanation);
            return stageApproval();
          }
          return false;
        }
      }

      if (!requiresApproval) return false;
      options.recordPendingApproval?.(
        toolCallId,
        buildApprovalExplanation(server, definition),
      );
      return stageApproval();
    },
    execute: async (args, executionOptions) => {
      const toolCallId = (
        executionOptions as { toolCallId?: string } | undefined
      )?.toolCallId;
      const finalAuthority =
        toolCallId && options.claimApprovalAuthority
          ? (options.claimApprovalAuthority({
              agentInstanceId: options.agentInstanceId,
              toolCallId,
              aiToolName,
              arguments: args,
              descriptor: descriptorCommitment,
              approvalContextDigest: expectedDispatch.digest,
            }) ?? undefined)
          : undefined;
      try {
        const result = await options.registry.callTool(
          server.id,
          definition.name,
          args,
          {
            agentInstanceId: options.agentInstanceId,
            expectedDescriptorCommitment: descriptorCommitment,
            expectedDispatchCommitment: expectedDispatch,
            ...(toolCallId ? { toolCallId } : {}),
            ...(finalAuthority ? { finalAuthority } : {}),
          },
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
