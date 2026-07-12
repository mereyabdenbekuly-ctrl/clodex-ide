import type { AgentHost } from '@clodex/agent-core/host';
import {
  asSchema,
  jsonSchema,
  streamText,
  tool as defineTool,
  type ModelMessage,
  type Tool,
  type ToolSet,
} from 'ai';
import type {
  AgentTurnHostHandlers,
  AgentTurnJsonObject,
  AgentTurnJsonValue,
  IsolatedAgentConversationMessage,
  IsolatedAgentToolDefinition,
  IsolatedAgentUsage,
} from './isolated-agent-turn';
import { isAgentTurnJsonValue } from './isolated-agent-turn';

export const ISOLATED_READ_ONLY_TOOL_NAMES = [
  'read',
  'getFileSkeleton',
  'getSymbolBody',
  'searchProjectSymbols',
  'glob',
  'grepSearch',
  'listMemories',
  'readMemory',
  'searchMemories',
] as const;

type IsolatedReadOnlyToolName = (typeof ISOLATED_READ_ONLY_TOOL_NAMES)[number];

interface IsolatedTurnToolbox {
  getTool(toolName: string, agentInstanceId: string): Promise<Tool | null>;
}

export interface BrowserIsolatedAgentTurnAdapterOptions {
  host: Pick<AgentHost, 'models'>;
  toolbox: IsolatedTurnToolbox;
  allowedToolNames?: readonly IsolatedReadOnlyToolName[];
  streamTextFn?: typeof streamText;
}

export function createBrowserIsolatedAgentTurnHandlers({
  host,
  toolbox,
  allowedToolNames = ISOLATED_READ_ONLY_TOOL_NAMES,
  streamTextFn = streamText,
}: BrowserIsolatedAgentTurnAdapterOptions): AgentTurnHostHandlers {
  const allowedTools = new Set<string>(allowedToolNames);

  return {
    async callModel(request, { signal, onEvent }) {
      const modelWithOptions = await host.models.getWithOptions(
        request.modelId,
        request.traceId,
        request.metadata,
      );
      const modelTools = Object.fromEntries(
        request.tools.map((definition) => [
          definition.name,
          defineTool({
            description: definition.description,
            inputSchema: jsonSchema(definition.inputSchema),
            strict: definition.strict,
          }),
        ]),
      ) as ToolSet;
      const result = streamTextFn({
        model: modelWithOptions.model,
        providerOptions: modelWithOptions.providerOptions,
        headers: modelWithOptions.headers,
        system: request.systemPrompt || undefined,
        messages: toModelMessages(request.messages),
        tools: modelTools,
        abortSignal: signal,
        maxOutputTokens: request.settings?.maxOutputTokens,
        temperature: request.settings?.temperature,
        stopWhen: () => true,
      });

      let text = '';
      let reasoning = '';
      let finishReason = 'unknown';
      let rawFinishReason: string | undefined;
      let usage: IsolatedAgentUsage = {};
      let providerMetadata: AgentTurnJsonObject | undefined;
      const toolCalls: Array<{
        toolCallId: string;
        toolName: string;
        input: AgentTurnJsonValue;
      }> = [];

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            text += part.text;
            onEvent({ type: 'text-delta', text: part.text });
            break;
          case 'reasoning-delta':
            reasoning += part.text;
            onEvent({ type: 'reasoning-delta', text: part.text });
            break;
          case 'tool-call':
            toolCalls.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: toAgentTurnJsonValue(part.input),
            });
            break;
          case 'finish-step':
            finishReason = String(part.finishReason);
            rawFinishReason = part.rawFinishReason;
            usage = normalizeUsage(part.usage);
            providerMetadata = toOptionalAgentTurnJsonObject(
              part.providerMetadata,
            );
            break;
          case 'finish':
            finishReason = String(part.finishReason);
            rawFinishReason = part.rawFinishReason;
            usage = normalizeUsage(part.totalUsage);
            break;
          case 'abort':
            throw createAbortError();
          case 'error':
            throw normalizeError(part.error);
        }
      }

      return {
        text,
        reasoning,
        toolCalls,
        finishReason,
        rawFinishReason,
        usage,
        providerMetadata,
      };
    },

    async callTool(request, { signal }) {
      if (!allowedTools.has(request.call.toolName)) {
        throw new Error(
          `Tool "${request.call.toolName}" is not allowed in an isolated read-only turn`,
        );
      }

      const resolvedTool = await toolbox.getTool(
        request.call.toolName,
        request.agentInstanceId,
      );
      if (!resolvedTool?.execute) {
        throw new Error(
          `Tool "${request.call.toolName}" is unavailable or has no executor`,
        );
      }

      const messages = toModelMessages(
        request.messages.at(-1)?.role === 'assistant'
          ? request.messages.slice(0, -1)
          : request.messages,
      );
      const needsApproval =
        typeof resolvedTool.needsApproval === 'function'
          ? await resolvedTool.needsApproval(request.call.input, {
              toolCallId: request.call.toolCallId,
              messages,
            })
          : resolvedTool.needsApproval === true;
      if (needsApproval) {
        throw new Error(
          `Tool "${request.call.toolName}" requires approval and cannot run in the read-only isolated lane`,
        );
      }

      const output = await collectToolOutput(
        resolvedTool.execute(request.call.input, {
          toolCallId: request.call.toolCallId,
          messages,
          abortSignal: signal,
        }),
      );
      return {
        output: toAgentTurnJsonValue(output),
      };
    },
  };
}

export async function getBrowserIsolatedReadOnlyToolDefinitions(
  toolbox: IsolatedTurnToolbox,
  agentInstanceId: string,
  toolNames: readonly IsolatedReadOnlyToolName[] = ISOLATED_READ_ONLY_TOOL_NAMES,
): Promise<IsolatedAgentToolDefinition[]> {
  const definitions: IsolatedAgentToolDefinition[] = [];
  for (const toolName of toolNames) {
    const resolvedTool = await toolbox.getTool(toolName, agentInstanceId);
    if (!resolvedTool) continue;
    const schema = await asSchema(resolvedTool.inputSchema).jsonSchema;
    const inputSchema = toAgentTurnJsonValue(schema);
    if (
      inputSchema === null ||
      Array.isArray(inputSchema) ||
      typeof inputSchema !== 'object'
    ) {
      throw new Error(`Tool "${toolName}" produced a non-object JSON schema`);
    }
    definitions.push({
      name: toolName,
      description: resolvedTool.description,
      inputSchema: inputSchema as AgentTurnJsonObject,
      strict: resolvedTool.strict,
    });
  }
  return definitions;
}

function toModelMessages(
  messages: readonly IsolatedAgentConversationMessage[],
): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    switch (message.role) {
      case 'user':
        return {
          role: 'user',
          content: message.content,
        };
      case 'assistant': {
        const content: Array<Record<string, unknown>> = [];
        if (message.text) {
          content.push({
            type: 'text',
            text: message.text,
          });
        }
        for (const call of message.toolCalls) {
          content.push({
            type: 'tool-call',
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
          });
        }
        return {
          role: 'assistant',
          content: content as ModelMessage['content'],
        } as ModelMessage;
      }
      case 'tool':
        return {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              output: {
                type: 'json',
                value: message.output,
              },
            },
          ],
        } as ModelMessage;
    }
  });
}

async function collectToolOutput(value: unknown): Promise<unknown> {
  const resolved = await value;
  if (!isAsyncIterable(resolved)) return resolved;

  let latest: unknown = null;
  for await (const item of resolved) {
    latest = item;
  }
  return latest;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' && value !== null && Symbol.asyncIterator in value
  );
}

function toAgentTurnJsonValue(value: unknown): AgentTurnJsonValue {
  if (isAgentTurnJsonValue(value)) return value;

  try {
    const serialized = JSON.stringify(value, (_key, entry) => {
      if (typeof entry === 'bigint') return entry.toString();
      if (entry instanceof Error) {
        return {
          name: entry.name,
          message: entry.message,
          stack: entry.stack,
        };
      }
      return entry;
    });
    if (serialized !== undefined) {
      const parsed: unknown = JSON.parse(serialized);
      if (isAgentTurnJsonValue(parsed)) return parsed;
    }
  } catch {
    // Fall through to a string representation for non-JSON host values.
  }

  return String(value);
}

function normalizeUsage(value: {
  inputTokens?: number | undefined;
  inputTokenDetails?: {
    noCacheTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
  };
  outputTokens?: number | undefined;
  outputTokenDetails?: {
    textTokens?: number | undefined;
    reasoningTokens?: number | undefined;
  };
  totalTokens?: number | undefined;
}): IsolatedAgentUsage {
  return {
    inputTokens: finiteNonNegative(value.inputTokens),
    outputTokens: finiteNonNegative(value.outputTokens),
    totalTokens: finiteNonNegative(value.totalTokens),
    noCacheInputTokens: finiteNonNegative(
      value.inputTokenDetails?.noCacheTokens,
    ),
    cacheReadInputTokens: finiteNonNegative(
      value.inputTokenDetails?.cacheReadTokens,
    ),
    cacheWriteInputTokens: finiteNonNegative(
      value.inputTokenDetails?.cacheWriteTokens,
    ),
    textOutputTokens: finiteNonNegative(value.outputTokenDetails?.textTokens),
    reasoningOutputTokens: finiteNonNegative(
      value.outputTokenDetails?.reasoningTokens,
    ),
  };
}

function toOptionalAgentTurnJsonObject(
  value: unknown,
): AgentTurnJsonObject | undefined {
  const converted = toAgentTurnJsonValue(value);
  return converted !== null &&
    !Array.isArray(converted) &&
    typeof converted === 'object'
    ? (converted as AgentTurnJsonObject)
    : undefined;
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createAbortError(): Error {
  return new DOMException('Isolated model call was aborted', 'AbortError');
}
