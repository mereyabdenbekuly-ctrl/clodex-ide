import path from 'node:path';
import { z } from 'zod';

export const MCP_REGISTRY_SCHEMA_VERSION = 1;
export const MCP_MAX_SERVERS = 100;
export const MCP_MAX_CONFIG_ENTRIES = 128;
export const MCP_MAX_OAUTH_SCOPES = 64;

const SAFE_ID_PATTERN = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const SAFE_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SENSITIVE_KEY_PARTS = [
  'AUTH',
  'COOKIE',
  'CREDENTIAL',
  'KEY',
  'PASSWORD',
  'PRIVATE',
  'SECRET',
  'SESSION',
  'TOKEN',
] as const;

export const mcpServerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(SAFE_ID_PATTERN);

export const mcpCredentialReferenceSchema = z
  .object({
    kind: z.literal('credential'),
    credentialId: z.string().trim().min(1).max(120).regex(SAFE_ID_PATTERN),
    field: z.string().trim().min(1).max(120).regex(SAFE_FIELD_PATTERN),
  })
  .strict();

export const mcpLiteralValueSchema = z
  .object({
    kind: z.literal('literal'),
    value: z
      .string()
      .max(16_384)
      .refine((value) => !value.includes('\0'), 'Value may not contain NUL'),
  })
  .strict();

export const mcpConfigValueSchema = z.discriminatedUnion('kind', [
  mcpLiteralValueSchema,
  mcpCredentialReferenceSchema,
]);

export type McpCredentialReference = z.infer<
  typeof mcpCredentialReferenceSchema
>;
export type McpConfigValue = z.infer<typeof mcpConfigValueSchema>;

const stdioArgsSchema = z
  .array(
    z
      .string()
      .max(16_384)
      .refine((value) => !value.includes('\0'), 'Argument may not contain NUL'),
  )
  .max(128)
  .default([])
  .superRefine((args, context) => {
    for (const [index, argument] of args.entries()) {
      if (
        /^--?(?:api[-_]?key|auth|authorization|cookie|password|secret|token)=/i.test(
          argument,
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message:
            'Secrets may not be embedded in MCP command arguments; use an environment credential reference',
        });
      }
      if (
        /^--?(?:api[-_]?key|auth|authorization|cookie|password|secret|token)$/i.test(
          argument,
        ) &&
        index + 1 < args.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index + 1],
          message:
            'Secrets may not be embedded in MCP command arguments; use an environment credential reference',
        });
      }
      if (/\bBearer\s+\S+/i.test(argument)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message:
            'Bearer credentials may not be embedded in MCP command arguments',
        });
      }
    }
  });

const configValuesSchema = z
  .record(z.string().min(1).max(256), mcpConfigValueSchema)
  .superRefine((values, context) => {
    if (Object.keys(values).length > MCP_MAX_CONFIG_ENTRIES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Configuration may contain at most ${MCP_MAX_CONFIG_ENTRIES} entries`,
      });
    }
    for (const [key, value] of Object.entries(values)) {
      if (
        value.kind === 'literal' &&
        (isSensitiveMcpConfigKey(key) || looksLikeMcpSecretValue(value.value))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message:
            'Sensitive configuration values must use a credential reference',
        });
      }
    }
  });

export const mcpStdioTransportSchema = z
  .object({
    type: z.literal('stdio'),
    command: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .refine(
        (value) => !value.includes('\0') && !/[\r\n]/.test(value),
        'Command may not contain NUL or newlines',
      ),
    args: stdioArgsSchema,
    cwd: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .refine((value) => path.isAbsolute(value), 'cwd must be absolute')
      .optional(),
    env: configValuesSchema.default({}),
  })
  .strict();

const remoteUrlSchema = z
  .string()
  .url()
  .max(4_096)
  .superRefine((value, context) => {
    const url = new URL(value);
    const isLoopback =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]' ||
      url.hostname === '::1';
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && isLoopback)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Remote MCP URLs must use HTTPS unless they target loopback',
      });
    }
    if (url.username || url.password) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Credentials may not be embedded in an MCP URL',
      });
    }
    if (url.hash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MCP URLs may not contain fragments',
      });
    }
    for (const key of url.searchParams.keys()) {
      if (isSensitiveMcpConfigKey(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Sensitive URL parameter "${key}" must not be persisted`,
        });
      }
    }
  });

const remoteHeadersSchema = configValuesSchema.superRefine(
  (headers, context) => {
    for (const key of Object.keys(headers)) {
      if (!HEADER_NAME_PATTERN.test(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'Invalid HTTP header name',
        });
      }
    }
  },
);

export const mcpOAuthConfigSchema = z
  .object({
    clientRegistrationId: mcpServerIdSchema,
    scopes: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(256)
          .refine(
            (value) => !/\s/.test(value),
            'OAuth scopes may not contain whitespace',
          ),
      )
      .max(MCP_MAX_OAUTH_SCOPES)
      .default([]),
    redirectMode: z.literal('custom-scheme').default('custom-scheme'),
  })
  .strict();

export type McpOAuthConfig = z.infer<typeof mcpOAuthConfigSchema>;

export const mcpStreamableHttpTransportSchema = z
  .object({
    type: z.literal('streamable-http'),
    url: remoteUrlSchema,
    headers: remoteHeadersSchema.default({}),
    oauth: mcpOAuthConfigSchema.optional(),
  })
  .strict()
  .superRefine(assertOAuthHeaderBoundary);

export const mcpSseTransportSchema = z
  .object({
    type: z.literal('sse'),
    url: remoteUrlSchema,
    headers: remoteHeadersSchema.default({}),
    oauth: mcpOAuthConfigSchema.optional(),
  })
  .strict()
  .superRefine(assertOAuthHeaderBoundary);

export const mcpTransportSchema = z.discriminatedUnion('type', [
  mcpStdioTransportSchema,
  mcpStreamableHttpTransportSchema,
  mcpSseTransportSchema,
]);

export type McpStdioTransport = z.infer<typeof mcpStdioTransportSchema>;
export type McpStreamableHttpTransport = z.infer<
  typeof mcpStreamableHttpTransportSchema
>;
export type McpSseTransport = z.infer<typeof mcpSseTransportSchema>;
export type McpTransport = z.infer<typeof mcpTransportSchema>;

export const executableRuntimePolicySchema = z
  .object({
    kind: z.literal('plugin-executable'),
    pluginId: mcpServerIdSchema,
    runtimeId: z.string().trim().min(1).max(80),
    pluginRoot: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .refine((value) => path.isAbsolute(value), 'pluginRoot must be absolute'),
    allowNetwork: z.boolean(),
    allowFilesystem: z.boolean(),
    maxMemoryMb: z.number().int().min(32).max(4_096),
    requestTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(5 * 60_000),
  })
  .strict();
export type ExecutableRuntimePolicy = z.infer<
  typeof executableRuntimePolicySchema
>;

export const resolvedMcpStdioTransportSchema = mcpStdioTransportSchema.extend({
  env: z.record(z.string().min(1).max(256), z.string()),
  runtimePolicy: executableRuntimePolicySchema.optional(),
});

export const resolvedMcpOAuthConfigSchema = z
  .object({
    clientRegistrationId: mcpServerIdSchema,
    redirectUrl: z.string().url().max(4_096),
    scopes: z.array(z.string().min(1).max(256)).max(MCP_MAX_OAUTH_SCOPES),
    clientMetadata: z.record(z.string().min(1).max(256), z.unknown()),
    allowedAuthorizationOrigins: z
      .array(z.string().url().max(4_096))
      .min(1)
      .max(16),
  })
  .strict();

export type ResolvedMcpOAuthConfig = z.infer<
  typeof resolvedMcpOAuthConfigSchema
>;

const resolvedRemoteHeadersSchema = z.record(
  z.string().min(1).max(256),
  z.string(),
);

export const resolvedMcpStreamableHttpTransportSchema = z
  .object({
    type: z.literal('streamable-http'),
    url: remoteUrlSchema,
    headers: resolvedRemoteHeadersSchema,
    oauth: resolvedMcpOAuthConfigSchema.optional(),
  })
  .strict()
  .superRefine(assertResolvedOAuthHeaderBoundary);

export const resolvedMcpSseTransportSchema = z
  .object({
    type: z.literal('sse'),
    url: remoteUrlSchema,
    headers: resolvedRemoteHeadersSchema,
    oauth: resolvedMcpOAuthConfigSchema.optional(),
  })
  .strict()
  .superRefine(assertResolvedOAuthHeaderBoundary);

export const resolvedMcpTransportSchema = z.discriminatedUnion('type', [
  resolvedMcpStdioTransportSchema,
  resolvedMcpStreamableHttpTransportSchema,
  resolvedMcpSseTransportSchema,
]);

export type ResolvedMcpTransport = z.infer<typeof resolvedMcpTransportSchema>;

export const mcpServerSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('builtin'),
      builtinId: mcpServerIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('user'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('plugin'),
      pluginId: mcpServerIdSchema,
      pluginVersion: z.string().trim().min(1).max(80),
      executableRuntimePolicy: executableRuntimePolicySchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('imported'),
      importer: z.enum(['claude-desktop']),
      importedAt: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type McpServerSource = z.infer<typeof mcpServerSourceSchema>;

export const mcpToolPolicyDecisionSchema = z.enum(['allow', 'ask', 'deny']);
export type McpToolPolicyDecision = z.infer<typeof mcpToolPolicyDecisionSchema>;

export const mcpServerPolicySchema = z
  .object({
    default: z.enum(['ask', 'deny', 'allow-read-only']).default('ask'),
    tools: z
      .record(z.string().trim().min(1).max(256), mcpToolPolicyDecisionSchema)
      .default({}),
  })
  .strict();

export type McpServerPolicy = z.infer<typeof mcpServerPolicySchema>;

export const mcpServerConfigSchema = z
  .object({
    id: mcpServerIdSchema,
    displayName: z.string().trim().min(1).max(120),
    enabled: z.boolean().default(true),
    source: mcpServerSourceSchema,
    transport: mcpTransportSchema,
    policy: mcpServerPolicySchema.default({
      default: 'ask',
      tools: {},
    }),
  })
  .strict();

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const mcpRegistryConfigSchema = z
  .object({
    schemaVersion: z.literal(MCP_REGISTRY_SCHEMA_VERSION),
    servers: z.record(mcpServerIdSchema, mcpServerConfigSchema),
  })
  .strict()
  .superRefine((registry, context) => {
    if (Object.keys(registry.servers).length > MCP_MAX_SERVERS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['servers'],
        message: `Registry may contain at most ${MCP_MAX_SERVERS} servers`,
      });
    }
    for (const [serverId, server] of Object.entries(registry.servers)) {
      if (serverId !== server.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['servers', serverId, 'id'],
          message: 'Registry key must match server.id',
        });
      }
    }
  });

export type McpRegistryConfig = z.infer<typeof mcpRegistryConfigSchema>;

export const EMPTY_MCP_REGISTRY_CONFIG: McpRegistryConfig = {
  schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
  servers: {},
};

export function isSensitiveMcpConfigKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

export function looksLikeMcpSecretValue(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^Bearer\s+\S+/i.test(trimmed) ||
    /^(?:ghp_|github_pat_|glpat-|npm_|xox[baprs]-|sk-[A-Za-z0-9_-]{12,})/.test(
      trimmed,
    ) ||
    /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(trimmed)
  );
}

export function collectCredentialReferences(
  transport: McpTransport,
): McpCredentialReference[] {
  const values = transport.type === 'stdio' ? transport.env : transport.headers;
  const unique = new Map<string, McpCredentialReference>();
  for (const value of Object.values(values)) {
    if (value.kind !== 'credential') continue;
    unique.set(`${value.credentialId}\0${value.field}`, value);
  }
  return [...unique.values()];
}

function assertOAuthHeaderBoundary(
  transport: {
    oauth?: McpOAuthConfig;
    headers: Record<string, McpConfigValue>;
  },
  context: z.RefinementCtx,
): void {
  if (!transport.oauth) return;
  for (const key of Object.keys(transport.headers)) {
    if (key.toLowerCase() === 'authorization') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['headers', key],
        message:
          'OAuth-managed MCP transports may not also configure an Authorization header',
      });
    }
  }
}

function assertResolvedOAuthHeaderBoundary(
  transport: {
    oauth?: ResolvedMcpOAuthConfig;
    headers: Record<string, string>;
  },
  context: z.RefinementCtx,
): void {
  if (
    transport.oauth &&
    Object.keys(transport.headers).some(
      (key) => key.toLowerCase() === 'authorization',
    )
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['headers'],
      message:
        'OAuth-managed MCP transports may not also configure an Authorization header',
    });
  }
}
