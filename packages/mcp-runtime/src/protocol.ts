import { z } from 'zod';
import { mcpServerIdSchema, resolvedMcpTransportSchema } from './config';

export const MCP_HOST_PROTOCOL_VERSION = 6;
export const MCP_HOST_HEARTBEAT_INTERVAL_MS = 5_000;

const requestIdSchema = z.string().trim().min(1).max(120);
const launchIdSchema = z.string().trim().min(1).max(120);
export const mcpConnectionIdSchema = z.string().uuid();
export type McpConnectionId = z.infer<typeof mcpConnectionIdSchema>;

export const mcpToolDescriptorSchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    title: z.string().max(500).optional(),
    description: z.string().max(16_384).optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    annotations: z
      .object({
        readOnlyHint: z.boolean().optional(),
        destructiveHint: z.boolean().optional(),
        idempotentHint: z.boolean().optional(),
        openWorldHint: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type McpToolDescriptor = z.infer<typeof mcpToolDescriptorSchema>;

const mcpAnnotationsSchema = z
  .object({
    audience: z
      .array(z.enum(['user', 'assistant']))
      .max(2)
      .optional(),
    priority: z.number().min(0).max(1).optional(),
    lastModified: z.string().max(256).optional(),
  })
  .passthrough();

export const mcpResourceDescriptorSchema = z
  .object({
    uri: z.string().trim().min(1).max(8_192),
    name: z.string().trim().min(1).max(512),
    title: z.string().max(512).optional(),
    description: z.string().max(16_384).optional(),
    mimeType: z.string().max(512).optional(),
    size: z.number().int().nonnegative().optional(),
    annotations: mcpAnnotationsSchema.optional(),
  })
  .passthrough();

export type McpResourceDescriptor = z.infer<typeof mcpResourceDescriptorSchema>;

export const mcpResourceTemplateDescriptorSchema = z
  .object({
    uriTemplate: z.string().trim().min(1).max(8_192),
    name: z.string().trim().min(1).max(512),
    title: z.string().max(512).optional(),
    description: z.string().max(16_384).optional(),
    mimeType: z.string().max(512).optional(),
    annotations: mcpAnnotationsSchema.optional(),
  })
  .passthrough();

export type McpResourceTemplateDescriptor = z.infer<
  typeof mcpResourceTemplateDescriptorSchema
>;

export const mcpPromptDescriptorSchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    title: z.string().max(512).optional(),
    description: z.string().max(16_384).optional(),
    arguments: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(256),
            description: z.string().max(16_384).optional(),
            required: z.boolean().optional(),
          })
          .passthrough(),
      )
      .max(256)
      .optional(),
  })
  .passthrough();

export type McpPromptDescriptor = z.infer<typeof mcpPromptDescriptorSchema>;

const mcpElicitationFieldBaseSchema = z.object({
  id: z.string().trim().min(1).max(256),
  label: z.string().trim().min(1).max(512),
  description: z.string().max(4_096).optional(),
  required: z.boolean().default(false),
});

const mcpElicitationOptionSchema = z
  .object({
    value: z.string().max(1_024),
    label: z.string().trim().min(1).max(1_024),
  })
  .strict();

export const mcpElicitationFieldSchema = z
  .discriminatedUnion('kind', [
    mcpElicitationFieldBaseSchema
      .extend({
        kind: z.literal('text'),
        inputType: z
          .enum(['text', 'email', 'date', 'date-time', 'uri'])
          .default('text'),
        minLength: z.number().int().nonnegative().max(16_384).optional(),
        maxLength: z.number().int().nonnegative().max(16_384).optional(),
        defaultValue: z.string().max(16_384).optional(),
      })
      .strict(),
    mcpElicitationFieldBaseSchema
      .extend({
        kind: z.literal('number'),
        integer: z.boolean().default(false),
        minimum: z.number().finite().optional(),
        maximum: z.number().finite().optional(),
        defaultValue: z.number().finite().optional(),
      })
      .strict(),
    mcpElicitationFieldBaseSchema
      .extend({
        kind: z.literal('boolean'),
        defaultValue: z.boolean().optional(),
      })
      .strict(),
    mcpElicitationFieldBaseSchema
      .extend({
        kind: z.literal('select'),
        options: z.array(mcpElicitationOptionSchema).min(1).max(50),
        defaultValue: z.string().max(1_024).optional(),
      })
      .strict(),
    mcpElicitationFieldBaseSchema
      .extend({
        kind: z.literal('multi-select'),
        options: z.array(mcpElicitationOptionSchema).min(1).max(50),
        minItems: z.number().int().nonnegative().max(50).optional(),
        maxItems: z.number().int().nonnegative().max(50).optional(),
        defaultValues: z.array(z.string().max(1_024)).max(50).optional(),
      })
      .strict(),
  ])
  .superRefine((field, context) => {
    if (field.kind === 'text') {
      if (
        field.minLength !== undefined &&
        field.maxLength !== undefined &&
        field.minLength > field.maxLength
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['maxLength'],
          message: 'Text maxLength must be greater than or equal to minLength',
        });
      }
      if (
        field.defaultValue !== undefined &&
        field.minLength !== undefined &&
        field.defaultValue.length < field.minLength
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defaultValue'],
          message: 'Text defaultValue is shorter than minLength',
        });
      }
      if (
        field.defaultValue !== undefined &&
        field.maxLength !== undefined &&
        field.defaultValue.length > field.maxLength
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defaultValue'],
          message: 'Text defaultValue is longer than maxLength',
        });
      }
      return;
    }

    if (field.kind === 'number') {
      if (
        field.minimum !== undefined &&
        field.maximum !== undefined &&
        field.minimum > field.maximum
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['maximum'],
          message: 'Number maximum must be greater than or equal to minimum',
        });
      }
      if (
        field.defaultValue !== undefined &&
        field.minimum !== undefined &&
        field.defaultValue < field.minimum
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defaultValue'],
          message: 'Number defaultValue is less than minimum',
        });
      }
      if (
        field.defaultValue !== undefined &&
        field.maximum !== undefined &&
        field.defaultValue > field.maximum
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defaultValue'],
          message: 'Number defaultValue is greater than maximum',
        });
      }
      if (
        field.integer &&
        field.defaultValue !== undefined &&
        !Number.isInteger(field.defaultValue)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defaultValue'],
          message: 'Integer defaultValue must be an integer',
        });
      }
      return;
    }

    if (field.kind !== 'select' && field.kind !== 'multi-select') return;

    const optionValues = new Set<string>();
    for (const [index, option] of field.options.entries()) {
      if (optionValues.has(option.value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options', index, 'value'],
          message: 'Elicitation option values must be unique',
        });
      }
      optionValues.add(option.value);
    }

    if (field.kind === 'select') {
      if (
        field.defaultValue !== undefined &&
        !optionValues.has(field.defaultValue)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defaultValue'],
          message: 'Select defaultValue must match an option',
        });
      }
      return;
    }

    if (
      field.minItems !== undefined &&
      field.maxItems !== undefined &&
      field.minItems > field.maxItems
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxItems'],
        message:
          'Multi-select maxItems must be greater than or equal to minItems',
      });
    }
    if (field.minItems !== undefined && field.minItems > field.options.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['minItems'],
        message: 'Multi-select minItems cannot exceed the option count',
      });
    }
    if (field.maxItems !== undefined && field.maxItems > field.options.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxItems'],
        message: 'Multi-select maxItems cannot exceed the option count',
      });
    }
    if (field.defaultValues !== undefined) {
      const defaults = new Set<string>();
      for (const [index, value] of field.defaultValues.entries()) {
        if (!optionValues.has(value)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['defaultValues', index],
            message: 'Multi-select defaultValues must match available options',
          });
        }
        if (defaults.has(value)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['defaultValues', index],
            message: 'Multi-select defaultValues must be unique',
          });
        }
        defaults.add(value);
      }
      if (
        field.minItems !== undefined &&
        field.defaultValues.length < field.minItems
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defaultValues'],
          message: 'Multi-select defaultValues contain fewer than minItems',
        });
      }
      if (
        field.maxItems !== undefined &&
        field.defaultValues.length > field.maxItems
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defaultValues'],
          message: 'Multi-select defaultValues contain more than maxItems',
        });
      }
    }
  });

export type McpElicitationField = z.infer<typeof mcpElicitationFieldSchema>;

export const mcpElicitationRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(16_384),
    fields: z.array(mcpElicitationFieldSchema).min(1).max(10),
  })
  .strict()
  .superRefine((request, context) => {
    const ids = new Set<string>();
    for (const [index, field] of request.fields.entries()) {
      if (ids.has(field.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', index, 'id'],
          message: 'Elicitation field IDs must be unique',
        });
      }
      ids.add(field.id);
    }
  });

export type McpElicitationRequest = z.infer<typeof mcpElicitationRequestSchema>;

const mcpElicitationAnswerSchema = z.union([
  z.string().max(16_384),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(1_024)).max(50),
]);

const mcpElicitationContentSchema = z
  .record(z.string().trim().min(1).max(256), mcpElicitationAnswerSchema)
  .superRefine((content, context) => {
    if (Object.keys(content).length > 10) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Elicitation content may contain at most 10 answers',
      });
    }
  });

export const mcpElicitationResultSchema = z
  .object({
    action: z.enum(['accept', 'decline', 'cancel']),
    content: mcpElicitationContentSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.action === 'accept' && !result.content) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: 'Accepted elicitation requires content',
      });
    }
    if (result.action !== 'accept' && result.content) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: 'Only accepted elicitation may contain content',
      });
    }
  });

export type McpElicitationResult = z.infer<typeof mcpElicitationResultSchema>;

export const mcpConnectionStateSchema = z.enum([
  'disconnected',
  'connecting',
  'connected',
  'authorization-required',
  'failed',
]);
export type McpConnectionState = z.infer<typeof mcpConnectionStateSchema>;

const oauthPayloadSchema = z.unknown();

export const mcpOAuthHostRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('load-client-information') }).strict(),
  z
    .object({
      operation: z.literal('save-client-information'),
      value: oauthPayloadSchema,
    })
    .strict(),
  z.object({ operation: z.literal('load-tokens') }).strict(),
  z
    .object({ operation: z.literal('save-tokens'), value: oauthPayloadSchema })
    .strict(),
  z.object({ operation: z.literal('prepare-state') }).strict(),
  z
    .object({
      operation: z.literal('open-authorization'),
      authorizationUrl: z.string().url().max(8_192),
    })
    .strict(),
  z
    .object({
      operation: z.literal('save-code-verifier'),
      codeVerifier: z.string().min(43).max(128),
    })
    .strict(),
  z.object({ operation: z.literal('load-code-verifier') }).strict(),
  z
    .object({
      operation: z.literal('save-discovery-state'),
      value: oauthPayloadSchema,
    })
    .strict(),
  z.object({ operation: z.literal('load-discovery-state') }).strict(),
  z
    .object({
      operation: z.literal('invalidate-credentials'),
      scope: z.enum(['all', 'client', 'tokens', 'verifier', 'discovery']),
    })
    .strict(),
]);

export type McpOAuthHostRequest = z.infer<typeof mcpOAuthHostRequestSchema>;

export const mcpNetworkProxyConfigSchema = z
  .object({
    url: z.string().url().max(2_048),
    authorization: z.string().min(1).max(2_048),
  })
  .strict();
export type McpNetworkProxyConfig = z.infer<typeof mcpNetworkProxyConfigSchema>;

export const mainToMcpHostMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('initialize'),
      protocolVersion: z.literal(MCP_HOST_PROTOCOL_VERSION),
      launchId: launchIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('connect-server'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      connectionId: mcpConnectionIdSchema,
      transport: resolvedMcpTransportSchema,
      secretValues: z.array(z.string().min(1).max(16_384)).max(128).default([]),
      networkProxy: mcpNetworkProxyConfigSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('disconnect-server'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      connectionId: mcpConnectionIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('list-tools'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('list-resources'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      cursor: z.string().max(8_192).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('list-resource-templates'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      cursor: z.string().max(8_192).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('read-resource'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      uri: z.string().trim().min(1).max(8_192),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(10 * 60_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('list-prompts'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      cursor: z.string().max(8_192).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('get-prompt'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      promptName: z.string().trim().min(1).max(256),
      arguments: z.record(z.string().min(1).max(256), z.string()).default({}),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(10 * 60_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('call-tool'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      toolName: z.string().trim().min(1).max(256),
      arguments: z.record(z.string(), z.unknown()).default({}),
      agentInstanceId: z.string().trim().min(1).max(256).optional(),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(10 * 60_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('elicitation-rpc-result'),
      launchId: launchIdSchema,
      elicitationRequestId: requestIdSchema,
      ok: z.boolean(),
      result: mcpElicitationResultSchema.optional(),
      error: z.string().max(16_384).optional(),
    })
    .strict()
    .superRefine((message, context) => {
      if (message.ok && !message.result) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Successful elicitation RPC requires a result',
        });
      }
      if (!message.ok && !message.error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Failed elicitation RPC requires an error',
        });
      }
    }),
  z
    .object({
      type: z.literal('finish-oauth'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      authorizationCode: z.string().trim().min(1).max(8_192),
    })
    .strict(),
  z
    .object({
      type: z.literal('oauth-rpc-result'),
      launchId: launchIdSchema,
      authRequestId: requestIdSchema,
      ok: z.boolean(),
      value: z.unknown().optional(),
      error: z.string().max(16_384).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('cancel-request'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('ping'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      sentAt: z.number().finite(),
    })
    .strict(),
  z
    .object({
      type: z.literal('shutdown'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      reason: z.string().max(1_000),
    })
    .strict(),
]);

export type MainToMcpHostMessage = z.infer<typeof mainToMcpHostMessageSchema>;

const serializedErrorSchema = z
  .object({
    message: z.string().max(16_384),
    stack: z.string().max(32_768).optional(),
    code: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

export type McpHostSerializedError = z.infer<typeof serializedErrorSchema>;

export const mcpHostToMainMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('ready'),
      protocolVersion: z.literal(MCP_HOST_PROTOCOL_VERSION),
      launchId: launchIdSchema,
      pid: z.number().int().nonnegative(),
      startedAt: z.number().finite(),
    })
    .strict(),
  z
    .object({
      type: z.literal('heartbeat'),
      launchId: launchIdSchema,
      sequence: z.number().int().nonnegative(),
      sentAt: z.number().finite(),
      connectedServerCount: z.number().int().nonnegative(),
      activeRequestCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('pong'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      sentAt: z.number().finite(),
      receivedAt: z.number().finite(),
    })
    .strict(),
  z
    .object({
      type: z.literal('connection-state'),
      launchId: launchIdSchema,
      requestId: requestIdSchema.optional(),
      serverId: mcpServerIdSchema,
      connectionId: mcpConnectionIdSchema,
      state: mcpConnectionStateSchema,
      error: serializedErrorSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tools-result'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      tools: z.array(mcpToolDescriptorSchema).max(5_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('resources-result'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      resources: z.array(mcpResourceDescriptorSchema).max(5_000),
      nextCursor: z.string().max(8_192).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('resource-templates-result'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      resourceTemplates: z
        .array(mcpResourceTemplateDescriptorSchema)
        .max(5_000),
      nextCursor: z.string().max(8_192).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('resource-read-result'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      uri: z.string().max(8_192),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('prompts-result'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      prompts: z.array(mcpPromptDescriptorSchema).max(5_000),
      nextCursor: z.string().max(8_192).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('prompt-result'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      promptName: z.string().max(256),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('list-changed'),
      launchId: launchIdSchema,
      serverId: mcpServerIdSchema,
      connectionId: mcpConnectionIdSchema,
      kind: z.enum(['tools', 'resources', 'prompts']),
      tools: z.array(mcpToolDescriptorSchema).max(5_000).optional(),
      resources: z.array(mcpResourceDescriptorSchema).max(5_000).optional(),
      prompts: z.array(mcpPromptDescriptorSchema).max(5_000).optional(),
    })
    .strict()
    .superRefine((message, context) => {
      const payloadCount = [
        message.tools,
        message.resources,
        message.prompts,
      ].filter((payload) => payload !== undefined).length;
      const matchingPayload =
        message.kind === 'tools'
          ? message.tools
          : message.kind === 'resources'
            ? message.resources
            : message.prompts;
      if (!matchingPayload || payloadCount !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'List-changed must contain exactly one payload matching its kind',
        });
      }
    }),
  z
    .object({
      type: z.literal('tool-call-result'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      toolName: z.string().trim().min(1).max(256),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('oauth-finish-result'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('oauth-rpc-request'),
      launchId: launchIdSchema,
      authRequestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      request: mcpOAuthHostRequestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('elicitation-rpc-request'),
      launchId: launchIdSchema,
      elicitationRequestId: requestIdSchema,
      serverId: mcpServerIdSchema,
      agentInstanceId: z.string().trim().min(1).max(256),
      request: mcpElicitationRequestSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('elicitation-rpc-cancel'),
      launchId: launchIdSchema,
      elicitationRequestId: requestIdSchema,
      serverId: mcpServerIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('request-error'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
      serverId: mcpServerIdSchema.optional(),
      error: serializedErrorSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('server-log'),
      launchId: launchIdSchema,
      serverId: mcpServerIdSchema,
      level: z.enum(['debug', 'info', 'warn', 'error']),
      message: z.string().max(16_384),
    })
    .strict(),
  z
    .object({
      type: z.literal('shutdown-complete'),
      launchId: launchIdSchema,
      requestId: requestIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('fatal'),
      launchId: launchIdSchema.nullable(),
      error: serializedErrorSchema,
    })
    .strict(),
]);

export type McpHostToMainMessage = z.infer<typeof mcpHostToMainMessageSchema>;

export function isMainToMcpHostMessage(
  value: unknown,
): value is MainToMcpHostMessage {
  return mainToMcpHostMessageSchema.safeParse(value).success;
}

export function isMcpHostToMainMessage(
  value: unknown,
): value is McpHostToMainMessage {
  return mcpHostToMainMessageSchema.safeParse(value).success;
}
