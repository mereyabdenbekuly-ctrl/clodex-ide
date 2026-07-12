import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  evaluateMcpToolPolicy,
  mcpServerConfigSchema,
  mcpServerPolicySchema,
  type McpServerConfig,
  type McpPromptDescriptor,
  type McpResourceDescriptor,
  type McpResourceTemplateDescriptor,
  type McpToolDescriptor,
} from '@clodex/mcp-runtime';
import {
  credentialTypeRegistry,
  extractSecretFieldNames,
  type CredentialTypeId,
} from '@shared/credential-types';
import type {
  McpApplyImportInput,
  McpConnectionTestResult,
  McpCredentialOption,
  McpCustomCredentialInput,
  McpImportPreviewSettings,
  McpGetPromptInput,
  McpPromptSettings,
  McpReadResourceInput,
  McpResourceSettings,
  McpResourceTemplateSettings,
  McpServerLogSettings,
  McpServerSettings,
  McpServerSettingsInput,
  McpSettingsPolicy,
  McpSettingsSnapshot,
  McpSettingsTransport,
  McpToolSettings,
} from '@shared/mcp-settings';
import { z } from 'zod';
import type { CredentialsService } from '../credentials';
import { DisposableService } from '../disposable';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import {
  materializeClaudeDesktopMcpImport,
  previewClaudeDesktopMcpConfig,
  type McpImportPreview as CoreMcpImportPreview,
} from './importers/claude-desktop';
import type {
  McpRegistryService,
  McpServerLogEntry,
  McpServerRuntimeState,
} from './index';

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const IMPORT_PREVIEW_TTL_MS = 10 * 60_000;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 16_384;

const settingsInputSchema = mcpServerConfigSchema
  .omit({ source: true })
  .strict();

const applyImportInputSchema = z
  .object({
    previewId: z.string().uuid(),
    serverIds: z.array(z.string().trim().min(1).max(80)).max(100),
    mappings: z.record(
      z.string(),
      z.record(
        z.string(),
        z
          .object({
            kind: z.literal('credential'),
            credentialId: z.string().trim().min(1).max(120),
            field: z.string().trim().min(1).max(120),
          })
          .strict(),
      ),
    ),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.serverIds).size !== input.serverIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['serverIds'],
        message: 'Import server IDs must be unique',
      });
    }
  });

const readResourceInputSchema = z
  .object({
    serverId: z.string().trim().min(1).max(80),
    uri: z.string().trim().min(1).max(8_192),
  })
  .strict();

const getPromptInputSchema = z
  .object({
    serverId: z.string().trim().min(1).max(80),
    promptName: z.string().trim().min(1).max(256),
    arguments: z.record(z.string().min(1).max(256), z.string().max(16_384)),
  })
  .strict();

type CachedImportPreview = {
  sourcePath: string;
  expiresAt: number;
  preview: CoreMcpImportPreview;
};

const PROCEDURE_NAMES = [
  'mcp.list',
  'mcp.upsert',
  'mcp.setEnabled',
  'mcp.setPolicy',
  'mcp.remove',
  'mcp.connect',
  'mcp.disconnect',
  'mcp.restart',
  'mcp.testConnection',
  'mcp.listTools',
  'mcp.listResources',
  'mcp.listResourceTemplates',
  'mcp.readResource',
  'mcp.listPrompts',
  'mcp.getPrompt',
  'mcp.getLogs',
  'mcp.setCustomCredential',
  'mcp.deleteCustomCredential',
  'mcp.previewClaudeDesktopImport',
  'mcp.applyClaudeDesktopImport',
] as const;

export interface McpSettingsServiceOptions {
  logger: Logger;
  karton: KartonService;
  registry: McpRegistryService;
  credentials: CredentialsService;
}

export class McpSettingsService extends DisposableService {
  private readonly previews = new Map<string, CachedImportPreview>();

  private constructor(private readonly options: McpSettingsServiceOptions) {
    super();
  }

  public static async create(
    options: McpSettingsServiceOptions,
  ): Promise<McpSettingsService> {
    const service = new McpSettingsService(options);
    service.registerProcedures();
    return service;
  }

  public snapshot(): McpSettingsSnapshot {
    this.assertNotDisposed();
    const registry = this.options.registry.snapshot();
    const runtimeById = new Map(
      this.options.registry
        .listRuntimeStates()
        .map((state) => [state.serverId, state]),
    );
    return {
      servers: Object.values(registry.servers)
        .map((server) =>
          toServerSettings(
            server,
            runtimeById.get(server.id),
            this.options.registry.getOAuthStatus(server.id),
          ),
        )
        .sort(compareServers),
      credentials: this.listCredentialOptions(),
      updatedAt: Date.now(),
    };
  }

  private registerProcedures(): void {
    const { karton } = this.options;
    karton.registerServerProcedureHandler('mcp.list', async () =>
      this.snapshot(),
    );
    karton.registerServerProcedureHandler(
      'mcp.upsert',
      async (_callerId: string, input: McpServerSettingsInput) => {
        const parsed = settingsInputSchema.parse(input);
        const existing = this.options.registry.snapshot().servers[parsed.id];
        if (
          existing?.source.kind === 'builtin' ||
          existing?.source.kind === 'plugin'
        ) {
          throw new Error(
            'Built-in and plugin MCP transports are managed by the application',
          );
        }
        await this.options.registry.upsertServer({
          ...parsed,
          source: existing?.source ?? { kind: 'user' },
        });
        return this.snapshot();
      },
    );
    karton.registerServerProcedureHandler(
      'mcp.setEnabled',
      async (_callerId: string, serverId: string, enabled: boolean) => {
        await this.options.registry.setEnabled(serverId, enabled);
        return this.snapshot();
      },
    );
    karton.registerServerProcedureHandler(
      'mcp.setPolicy',
      async (
        _callerId: string,
        serverId: string,
        policy: McpSettingsPolicy,
      ) => {
        await this.options.registry.setPolicy(
          serverId,
          mcpServerPolicySchema.parse(policy),
        );
        return this.snapshot();
      },
    );
    karton.registerServerProcedureHandler(
      'mcp.remove',
      async (_callerId: string, serverId: string) => {
        await this.options.registry.removeServer(serverId);
        return this.snapshot();
      },
    );
    karton.registerServerProcedureHandler(
      'mcp.connect',
      async (_callerId: string, serverId: string) => {
        await this.options.registry.connectServer(serverId);
        return this.snapshot();
      },
    );
    karton.registerServerProcedureHandler(
      'mcp.disconnect',
      async (_callerId: string, serverId: string) => {
        await this.options.registry.disconnectServer(serverId);
        return this.snapshot();
      },
    );
    karton.registerServerProcedureHandler(
      'mcp.restart',
      async (_callerId: string, serverId: string) => {
        await this.options.registry.restartServer(serverId);
        return this.snapshot();
      },
    );
    karton.registerServerProcedureHandler(
      'mcp.testConnection',
      async (
        _callerId: string,
        serverId: string,
      ): Promise<McpConnectionTestResult> => {
        try {
          const tools = await this.options.registry.testConnection(serverId);
          return {
            ok: true,
            message: `Connection succeeded. ${tools.length} tool${tools.length === 1 ? '' : 's'} available.`,
            server: this.requireServerSettings(serverId),
            tools: this.toToolSettings(serverId, tools),
          };
        } catch (error) {
          return {
            ok: false,
            message: safeErrorMessage(error),
            server: this.requireServerSettings(serverId),
            tools: [],
          };
        }
      },
    );
    karton.registerServerProcedureHandler(
      'mcp.listTools',
      async (_callerId: string, serverId: string) => {
        const tools = await this.options.registry.listTools(serverId);
        return this.toToolSettings(serverId, tools);
      },
    );
    karton.registerServerProcedureHandler(
      'mcp.listResources',
      async (_callerId: string, serverId: string) =>
        (await this.options.registry.listResources(serverId)).map(
          toResourceSettings,
        ),
    );
    karton.registerServerProcedureHandler(
      'mcp.listResourceTemplates',
      async (_callerId: string, serverId: string) =>
        (await this.options.registry.listResourceTemplates(serverId)).map(
          toResourceTemplateSettings,
        ),
    );
    karton.registerServerProcedureHandler(
      'mcp.readResource',
      async (_callerId: string, input: McpReadResourceInput) => {
        const parsed = readResourceInputSchema.parse(input);
        return await this.options.registry.readResource(
          parsed.serverId,
          parsed.uri,
        );
      },
    );
    karton.registerServerProcedureHandler(
      'mcp.listPrompts',
      async (_callerId: string, serverId: string) =>
        (await this.options.registry.listPrompts(serverId)).map(
          toPromptSettings,
        ),
    );
    karton.registerServerProcedureHandler(
      'mcp.getPrompt',
      async (_callerId: string, input: McpGetPromptInput) => {
        const parsed = getPromptInputSchema.parse(input);
        return await this.options.registry.getPrompt(
          parsed.serverId,
          parsed.promptName,
          parsed.arguments,
        );
      },
    );
    karton.registerServerProcedureHandler(
      'mcp.getLogs',
      async (_callerId: string, serverId: string) =>
        this.options.registry.getLogs(serverId).map(toLogSettings),
    );
    karton.registerServerProcedureHandler(
      'mcp.setCustomCredential',
      async (_callerId: string, input: McpCustomCredentialInput) => {
        await this.options.credentials.setMcpCustomCredential(input);
        return this.snapshot();
      },
    );
    karton.registerServerProcedureHandler(
      'mcp.deleteCustomCredential',
      async (_callerId: string, credentialId: string) => {
        await this.options.credentials.deleteMcpCustomCredential(credentialId);
        return this.snapshot();
      },
    );
    karton.registerServerProcedureHandler(
      'mcp.previewClaudeDesktopImport',
      async (_callerId: string, sourcePath: string) =>
        await this.previewClaudeDesktopImport(sourcePath),
    );
    karton.registerServerProcedureHandler(
      'mcp.applyClaudeDesktopImport',
      async (_callerId: string, input: McpApplyImportInput) =>
        await this.applyClaudeDesktopImport(input),
    );
  }

  private async previewClaudeDesktopImport(
    sourcePath: string,
  ): Promise<McpImportPreviewSettings> {
    this.pruneExpiredPreviews();
    if (!sourcePath.trim()) throw new Error('Select a config file to import');
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile())
      throw new Error('The selected import source is not a file');
    if (stat.size > MAX_IMPORT_BYTES) {
      throw new Error('MCP import config exceeds the 2 MB limit');
    }
    const content = await fs.readFile(sourcePath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    const preview = previewClaudeDesktopMcpConfig(parsed);
    makeImportIdsUnique(
      preview,
      new Set(Object.keys(this.options.registry.snapshot().servers)),
    );
    const previewId = randomUUID();
    const expiresAt = Date.now() + IMPORT_PREVIEW_TTL_MS;
    this.previews.set(previewId, { sourcePath, expiresAt, preview });
    return toImportPreviewSettings(previewId, sourcePath, expiresAt, preview);
  }

  private async applyClaudeDesktopImport(
    input: McpApplyImportInput,
  ): Promise<McpSettingsSnapshot> {
    this.pruneExpiredPreviews();
    const parsed = applyImportInputSchema.parse(input);
    const cached = this.previews.get(parsed.previewId);
    if (!cached) {
      throw new Error('Import preview expired. Preview the file again.');
    }
    const selectedIds = new Set(parsed.serverIds);
    if (selectedIds.size === 0) {
      throw new Error('Select at least one MCP server to import');
    }
    const selectedServers = cached.preview.servers.filter((server) =>
      selectedIds.has(server.proposedId),
    );
    if (selectedServers.length !== selectedIds.size) {
      throw new Error('Import selection does not match the preview');
    }
    const selectedPreview: CoreMcpImportPreview = {
      source: cached.preview.source,
      servers: selectedServers,
    };
    const servers = materializeClaudeDesktopMcpImport(
      selectedPreview,
      parsed.mappings,
    );
    const currentIds = new Set(
      Object.keys(this.options.registry.snapshot().servers),
    );
    for (const server of servers) {
      if (currentIds.has(server.id)) {
        throw new Error(
          `MCP server "${server.id}" was added after preview. Preview the file again.`,
        );
      }
      await this.options.registry.upsertServer(server);
      currentIds.add(server.id);
    }
    this.previews.delete(parsed.previewId);
    return this.snapshot();
  }

  private listCredentialOptions(): McpCredentialOption[] {
    const registered = (
      Object.entries(credentialTypeRegistry) as Array<
        [CredentialTypeId, (typeof credentialTypeRegistry)[CredentialTypeId]]
      >
    )
      .filter(([credentialId]) => credentialId !== 'clodex-auth')
      .map(([credentialId, definition]) => {
        const schema = definition.schema as z.ZodObject<z.ZodRawShape>;
        const metadata = definition.fieldMetadata as Record<
          string,
          { description: string } | undefined
        >;
        const fields = extractSecretFieldNames(schema).map((field) => ({
          name: field,
          label: metadata[field]?.description ?? field,
        }));
        return {
          credentialId,
          displayName: definition.displayName,
          configured: this.options.credentials.has(credentialId),
          custom: false,
          canDelete: false,
          allowedOrigins: [...definition.allowedOrigins],
          fields,
        };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    const custom = this.options.credentials.listMcpCustomCredentials().map(
      (credential): McpCredentialOption => ({
        credentialId: credential.credentialId,
        displayName: credential.displayName,
        configured: true,
        custom: true,
        canDelete: true,
        allowedOrigins: credential.allowedOrigins,
        fields: credential.fields.map((field) => ({
          name: field,
          label: field,
        })),
      }),
    );
    return [...custom, ...registered].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
  }

  private requireServerSettings(serverId: string): McpServerSettings {
    const server = this.snapshot().servers.find((item) => item.id === serverId);
    if (!server) throw new Error(`Unknown MCP server "${serverId}"`);
    return server;
  }

  private toToolSettings(
    serverId: string,
    tools: McpToolDescriptor[],
  ): McpToolSettings[] {
    const server = this.options.registry.snapshot().servers[serverId];
    if (!server) throw new Error(`Unknown MCP server "${serverId}"`);
    return tools.map((tool) => {
      const effective = evaluateMcpToolPolicy(server, {
        name: tool.name,
        readOnlyHint: tool.annotations?.readOnlyHint,
        destructiveHint: tool.annotations?.destructiveHint,
      });
      return {
        name: tool.name,
        title: tool.title?.trim() || null,
        description:
          tool.description?.trim() || 'Tool exposed by this MCP server.',
        readOnly: tool.annotations?.readOnlyHint === true,
        destructive: tool.annotations?.destructiveHint === true,
        effectiveDecision: effective.decision,
        effectiveReason: effective.reason,
      };
    });
  }

  private pruneExpiredPreviews(): void {
    const now = Date.now();
    for (const [previewId, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(previewId);
    }
  }

  protected onTeardown(): void {
    for (const procedureName of PROCEDURE_NAMES) {
      this.options.karton.removeServerProcedureHandler(procedureName);
    }
    this.previews.clear();
  }
}

function toServerSettings(
  server: McpServerConfig,
  runtime?: McpServerRuntimeState,
  oauth?: McpServerSettings['oauth'],
): McpServerSettings {
  const source = toSourceSettings(server);
  const fallbackStatus = server.enabled ? 'disconnected' : 'disabled';
  return {
    id: server.id,
    displayName: server.displayName,
    enabled: server.enabled,
    source,
    group:
      server.source.kind === 'plugin'
        ? 'installed-plugins'
        : server.source.kind === 'builtin'
          ? 'clodex-cloud'
          : 'local-custom',
    trust:
      server.source.kind === 'plugin'
        ? 'signed-plugin'
        : server.source.kind === 'builtin'
          ? 'builtin'
          : server.source.kind === 'imported'
            ? 'reviewed-import'
            : 'user-code',
    transport: toSettingsTransport(server.transport),
    transportPreview: formatTransportPreview(server.transport),
    policy: structuredClone(server.policy),
    runtime: {
      status: runtime?.status ?? fallbackStatus,
      lastError: runtime?.lastError
        ? sanitizeDiagnosticText(runtime.lastError)
        : null,
      connectedAt: runtime?.connectedAt ?? null,
      updatedAt: runtime?.updatedAt ?? Date.now(),
      restartCount: runtime?.restartCount ?? 0,
      catalogRevision: runtime?.catalogRevision ?? 0,
    },
    canEdit: server.source.kind === 'user' || server.source.kind === 'imported',
    canRemove:
      server.source.kind === 'user' || server.source.kind === 'imported',
    oauth: oauth ?? null,
  };
}

function toSourceSettings(
  server: McpServerConfig,
): McpServerSettings['source'] {
  switch (server.source.kind) {
    case 'builtin':
      return {
        kind: 'builtin',
        label: 'Built-in Clodex service',
        builtinId: server.source.builtinId,
      };
    case 'user':
      return { kind: 'user', label: 'User-configured' };
    case 'plugin':
      return {
        kind: 'plugin',
        label: 'Signed marketplace plugin',
        pluginId: server.source.pluginId,
        pluginVersion: server.source.pluginVersion,
      };
    case 'imported':
      return {
        kind: 'imported',
        label: 'Imported after preview',
        importer: server.source.importer,
        importedAt: server.source.importedAt,
      };
  }
}

function formatTransportPreview(
  transport: McpServerConfig['transport'],
): string {
  if (transport.type === 'stdio') {
    const args = redactCommandArgs(transport.args);
    return [transport.command, ...args].map(quoteCommandPart).join(' ');
  }
  const url = new URL(transport.url);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function toSettingsTransport(
  transport: McpServerConfig['transport'],
): McpSettingsTransport {
  if (transport.type === 'stdio') {
    return {
      type: 'stdio',
      command: transport.command,
      args: redactCommandArgs(transport.args),
      cwd: transport.cwd,
      env: structuredClone(transport.env),
    };
  }
  return {
    type: transport.type,
    url: transport.url,
    headers: structuredClone(transport.headers),
    oauth: transport.oauth ? structuredClone(transport.oauth) : undefined,
  };
}

function redactCommandArgs(args: string[]): string[] {
  const result: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      result.push('[redacted]');
      redactNext = false;
      continue;
    }
    if (/^--?(?:api[-_]?key|auth|password|secret|token)$/i.test(arg)) {
      result.push(arg);
      redactNext = true;
      continue;
    }
    result.push(
      arg.replace(
        /^(--?(?:api[-_]?key|auth|password|secret|token)=).+$/i,
        '$1[redacted]',
      ),
    );
  }
  return result;
}

function quoteCommandPart(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function toLogSettings(entry: McpServerLogEntry): McpServerLogSettings {
  return {
    timestamp: entry.timestamp,
    level: entry.level,
    message: sanitizeDiagnosticText(entry.message),
  };
}

function sanitizeDiagnosticText(value: string): string {
  return capText(
    value
      .replace(
        /\bauthorization\b(\s*[:=]\s*)(?:Bearer\s+[^\s,;]+|[^\s,;]+)/gi,
        'authorization$1[redacted]',
      )
      .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
      .replace(
        /\b(api[-_]?key|password|secret|token)\b(\s*[:=]\s*)([^\s,;]+)/gi,
        '$1$2[redacted]',
      ),
    MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  );
}

function safeErrorMessage(error: unknown): string {
  return sanitizeDiagnosticText(
    error instanceof Error ? error.message : String(error),
  );
}

function capText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…[truncated]`;
}

function toResourceSettings(
  resource: McpResourceDescriptor,
): McpResourceSettings {
  return {
    uri: resource.uri,
    name: resource.name,
    title: resource.title?.trim() || null,
    description: resource.description?.trim() || null,
    mimeType: resource.mimeType?.trim() || null,
    size: resource.size ?? null,
  };
}

function toResourceTemplateSettings(
  template: McpResourceTemplateDescriptor,
): McpResourceTemplateSettings {
  return {
    uriTemplate: template.uriTemplate,
    name: template.name,
    title: template.title?.trim() || null,
    description: template.description?.trim() || null,
    mimeType: template.mimeType?.trim() || null,
  };
}

function toPromptSettings(prompt: McpPromptDescriptor): McpPromptSettings {
  return {
    name: prompt.name,
    title: prompt.title?.trim() || null,
    description: prompt.description?.trim() || null,
    arguments:
      prompt.arguments?.map((argument) => ({
        name: argument.name,
        description: argument.description?.trim() || null,
        required: argument.required === true,
      })) ?? [],
  };
}

function compareServers(
  left: McpServerSettings,
  right: McpServerSettings,
): number {
  return (
    left.group.localeCompare(right.group) ||
    left.displayName.localeCompare(right.displayName)
  );
}

function toImportPreviewSettings(
  previewId: string,
  sourcePath: string,
  expiresAt: number,
  preview: CoreMcpImportPreview,
): McpImportPreviewSettings {
  return {
    previewId,
    source: preview.source,
    sourcePath,
    expiresAt,
    servers: preview.servers.map((server) => ({
      sourceName: server.sourceName,
      proposedId: server.proposedId,
      displayName: server.displayName,
      supported: server.supported,
      readyToImport: server.readyToImport,
      warnings: server.warnings.map(sanitizeDiagnosticText),
      requiredSecrets: structuredClone(server.requiredSecrets),
      transport: server.proposedConfig
        ? toSettingsTransport(server.proposedConfig.transport)
        : null,
      transportPreview: server.proposedConfig
        ? formatTransportPreview(server.proposedConfig.transport)
        : null,
    })),
  };
}

function makeImportIdsUnique(
  preview: CoreMcpImportPreview,
  usedIds: Set<string>,
): void {
  for (const server of preview.servers) {
    const base = server.proposedId;
    let candidate = base;
    let suffix = 2;
    while (usedIds.has(candidate)) {
      candidate = `${base.slice(0, 74)}-${suffix++}`;
    }
    usedIds.add(candidate);
    if (candidate === server.proposedId) continue;
    server.proposedId = candidate;
    if (server.proposedConfig) server.proposedConfig.id = candidate;
    server.warnings.push(
      `Server ID changed to "${candidate}" to avoid a registry conflict.`,
    );
  }
}
