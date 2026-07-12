import {
  isSensitiveMcpConfigKey,
  looksLikeMcpSecretValue,
  mcpCredentialReferenceSchema,
  mcpServerConfigSchema,
  mcpServerIdSchema,
  type McpCredentialReference,
  type McpServerConfig,
} from '@clodex/mcp-runtime';
import { z } from 'zod';

const rawServerSchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    transport: z.enum(['stdio', 'sse', 'streamable-http']).optional(),
    type: z.enum(['stdio', 'sse', 'streamable-http']).optional(),
  })
  .passthrough();

const rawClaudeDesktopConfigSchema = z
  .object({
    mcpServers: z.record(z.string(), rawServerSchema),
  })
  .passthrough();

export interface McpImportRequiredSecret {
  key: string;
  target: 'env' | 'header';
  suggestedCredentialId: string | null;
}

export interface McpImportServerPreview {
  sourceName: string;
  proposedId: string;
  displayName: string;
  supported: boolean;
  readyToImport: boolean;
  warnings: string[];
  requiredSecrets: McpImportRequiredSecret[];
  proposedConfig: McpServerConfig | null;
}

export interface McpImportPreview {
  source: 'claude-desktop';
  servers: McpImportServerPreview[];
}

export type McpImportSecretMappings = Record<
  string,
  Record<string, McpCredentialReference>
>;

export function previewClaudeDesktopMcpConfig(
  input: unknown,
  now = Date.now(),
): McpImportPreview {
  const parsed = rawClaudeDesktopConfigSchema.parse(input);
  const usedIds = new Set<string>();
  return {
    source: 'claude-desktop',
    servers: Object.entries(parsed.mcpServers).map(([sourceName, raw]) =>
      previewServer(sourceName, raw, usedIds, now),
    ),
  };
}

export function materializeClaudeDesktopMcpImport(
  preview: McpImportPreview,
  mappings: McpImportSecretMappings,
): McpServerConfig[] {
  return preview.servers.map((server) => {
    if (!server.supported || !server.proposedConfig) {
      throw new Error(`MCP server "${server.sourceName}" cannot be imported`);
    }
    const mapping = mappings[server.proposedId] ?? {};
    const config = structuredClone(server.proposedConfig);
    for (const required of server.requiredSecrets) {
      const reference = mcpCredentialReferenceSchema.parse(
        mapping[`${required.target}:${required.key}`],
      );
      const target =
        config.transport.type === 'stdio'
          ? config.transport.env
          : config.transport.headers;
      target[required.key] = reference;
    }
    return mcpServerConfigSchema.parse(config);
  });
}

function previewServer(
  sourceName: string,
  raw: z.infer<typeof rawServerSchema>,
  usedIds: Set<string>,
  now: number,
): McpImportServerPreview {
  const warnings: string[] = [];
  const requiredSecrets: McpImportRequiredSecret[] = [];
  const proposedId = createUniqueId(sourceName, usedIds);
  const displayName = sourceName.trim() || proposedId;
  const transportType =
    raw.transport ?? raw.type ?? (raw.command ? 'stdio' : undefined);

  try {
    let transport: McpServerConfig['transport'];
    if (transportType === 'stdio' && raw.command) {
      for (const argument of raw.args ?? []) {
        if (looksLikeMcpSecretValue(argument)) {
          throw new Error(
            'A command argument appears to contain a credential. Move it to an environment credential reference before importing.',
          );
        }
      }
      const env = convertValues(
        raw.env ?? {},
        'env',
        requiredSecrets,
        warnings,
      );
      transport = {
        type: 'stdio',
        command: raw.command,
        args: raw.args ?? [],
        cwd: raw.cwd,
        env,
      };
    } else if (
      (transportType === 'sse' || transportType === 'streamable-http') &&
      raw.url
    ) {
      const headers = convertValues(
        raw.headers ?? {},
        'header',
        requiredSecrets,
        warnings,
      );
      transport = {
        type: transportType,
        url: raw.url,
        headers,
      };
    } else {
      throw new Error('Unsupported or incomplete MCP transport configuration');
    }

    const proposedConfig = mcpServerConfigSchema.parse({
      id: proposedId,
      displayName,
      enabled: false,
      source: {
        kind: 'imported',
        importer: 'claude-desktop',
        importedAt: now,
      },
      transport,
      policy: { default: 'ask', tools: {} },
    });
    return {
      sourceName,
      proposedId,
      displayName,
      supported: true,
      readyToImport: requiredSecrets.length === 0,
      warnings,
      requiredSecrets,
      proposedConfig,
    };
  } catch (error) {
    return {
      sourceName,
      proposedId,
      displayName,
      supported: false,
      readyToImport: false,
      warnings: [
        ...warnings,
        error instanceof Error ? error.message : String(error),
      ],
      requiredSecrets,
      proposedConfig: null,
    };
  }
}

function convertValues(
  values: Record<string, string>,
  target: 'env' | 'header',
  requiredSecrets: McpImportRequiredSecret[],
  warnings: string[],
): Record<string, { kind: 'literal'; value: string } | McpCredentialReference> {
  const converted: Record<
    string,
    { kind: 'literal'; value: string } | McpCredentialReference
  > = {};
  for (const [key, value] of Object.entries(values)) {
    if (isSensitiveMcpConfigKey(key) || looksLikeMcpSecretValue(value)) {
      requiredSecrets.push({
        key,
        target,
        suggestedCredentialId: suggestCredentialId(key),
      });
      warnings.push(
        `${target === 'env' ? 'Environment variable' : 'Header'} "${key}" requires an explicit credential mapping.`,
      );
      continue;
    }
    converted[key] = { kind: 'literal', value };
  }
  return converted;
}

function suggestCredentialId(key: string): string | null {
  const normalized = key.toUpperCase();
  if (normalized.includes('GITHUB')) return 'github-pat';
  if (normalized.includes('FIGMA')) return 'figma-pat';
  if (normalized.includes('VERCEL')) return 'vercel-pat';
  if (normalized.includes('SUPABASE')) return 'supabase-pat';
  if (normalized.includes('POSTHOG')) return 'posthog-pat';
  if (normalized.includes('GOOGLE')) return 'google-ai-key';
  return null;
}

function createUniqueId(sourceName: string, usedIds: Set<string>): string {
  const normalized =
    sourceName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'imported-mcp';
  let candidate = normalized;
  let suffix = 2;
  while (
    usedIds.has(candidate) ||
    !mcpServerIdSchema.safeParse(candidate).success
  ) {
    candidate = `${normalized.slice(0, 55)}-${suffix++}`;
  }
  usedIds.add(candidate);
  return candidate;
}
