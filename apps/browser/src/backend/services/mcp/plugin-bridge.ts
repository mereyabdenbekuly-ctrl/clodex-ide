import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  collectCredentialReferences,
  mcpServerIdSchema,
  mcpServerPolicySchema,
  mcpTransportSchema,
  type McpServerConfig,
} from '@clodex/mcp-runtime';
import type {
  PluginMarketplaceLockEntry,
  PluginMarketplaceMcpServerSummary,
} from '@shared/plugin-marketplace';
import { z } from 'zod';

const PLUGIN_MCP_FILE_SCHEMA_VERSION = 1;

const pluginMcpServerDeclarationSchema = z
  .object({
    id: mcpServerIdSchema,
    displayName: z.string().trim().min(1).max(120),
    enabledByDefault: z.boolean().default(false),
    runtimeId: z.string().trim().min(1).max(80).optional(),
    transport: mcpTransportSchema,
    policy: mcpServerPolicySchema.default({
      default: 'ask',
      tools: {},
    }),
  })
  .strict()
  .superRefine((declaration, context) => {
    if (declaration.transport.type === 'stdio' && !declaration.runtimeId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runtimeId'],
        message: 'stdio plugin MCP servers require runtimeId',
      });
    }
    if (declaration.transport.type !== 'stdio' && declaration.runtimeId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runtimeId'],
        message: 'runtimeId is valid only for stdio plugin MCP servers',
      });
    }
  });
export type PluginMcpServerDeclaration = z.infer<
  typeof pluginMcpServerDeclarationSchema
>;

const pluginMcpServersFileSchema = z
  .object({
    schemaVersion: z.literal(PLUGIN_MCP_FILE_SCHEMA_VERSION),
    servers: z.array(pluginMcpServerDeclarationSchema).max(50),
  })
  .strict()
  .superRefine((file, context) => {
    const ids = new Set<string>();
    for (const [index, server] of file.servers.entries()) {
      if (ids.has(server.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['servers', index, 'id'],
          message: `Duplicate plugin MCP server ID: ${server.id}`,
        });
      }
      ids.add(server.id);
    }
  });

export interface DiscoverPluginMcpServersOptions {
  installedDir: string;
  installed: PluginMarketplaceLockEntry[];
  isExecutableRuntimeEnabled?: () => boolean;
}

const pluginRuntimeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimes: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(80),
            kind: z.literal('executable'),
            entrypoint: z
              .string()
              .trim()
              .min(1)
              .max(512)
              .refine(
                (value) =>
                  !path.isAbsolute(value) &&
                  !value.includes('\\') &&
                  !value.split('/').includes('..'),
                'Runtime entrypoint must stay inside the plugin directory',
              ),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            args: z.array(z.string().max(4_096)).max(64).default([]),
            platforms: z
              .array(z.enum(['darwin', 'linux', 'win32']))
              .min(1)
              .max(3),
            architectures: z
              .array(z.enum(['arm64', 'x64']))
              .min(1)
              .max(2),
            limits: z
              .object({
                maxMemoryMb: z.number().int().min(32).max(4_096),
                requestTimeoutMs: z
                  .number()
                  .int()
                  .min(1_000)
                  .max(5 * 60_000),
              })
              .strict(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const [index, runtime] of manifest.runtimes.entries()) {
      if (ids.has(runtime.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['runtimes', index, 'id'],
          message: `Duplicate plugin runtime ID: ${runtime.id}`,
        });
      }
      ids.add(runtime.id);
    }
  });
export type PluginRuntimeManifest = z.infer<typeof pluginRuntimeManifestSchema>;

export async function readPluginMcpServerDeclarations(
  pluginRoot: string,
): Promise<PluginMcpServerDeclaration[] | null> {
  const declarationPath = resolveInside(pluginRoot, 'mcp', 'servers.json');
  let content: string;
  try {
    content = await fs.readFile(declarationPath, 'utf-8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  return pluginMcpServersFileSchema.parse(JSON.parse(content)).servers;
}

export function summarizePluginMcpServers(
  declarations: PluginMcpServerDeclaration[],
): PluginMarketplaceMcpServerSummary[] {
  return declarations.map((declaration) => {
    if (declaration.transport.type === 'stdio') {
      return {
        id: declaration.id,
        displayName: declaration.displayName,
        transport: 'stdio' as const,
        runtimeId: declaration.runtimeId!,
        endpoint: `runtime:${declaration.runtimeId}`,
        authentication:
          collectCredentialReferences(declaration.transport).length > 0
            ? ('credential' as const)
            : ('none' as const),
      };
    }
    const hasCredentials =
      collectCredentialReferences(declaration.transport).length > 0;
    const hasOAuth = declaration.transport.oauth !== undefined;
    return {
      id: declaration.id,
      displayName: declaration.displayName,
      transport: declaration.transport.type,
      endpoint: declaration.transport.url,
      authentication:
        hasOAuth && hasCredentials
          ? 'oauth+credential'
          : hasOAuth
            ? 'oauth'
            : hasCredentials
              ? 'credential'
              : 'none',
    };
  });
}

export async function discoverPluginMcpServers(
  options: DiscoverPluginMcpServersOptions,
): Promise<McpServerConfig[]> {
  const servers: McpServerConfig[] = [];
  for (const plugin of options.installed) {
    if (!plugin.manifest.permissions.includes('mcp')) continue;
    const permissions = new Set(plugin.manifest.permissions);
    const pluginRoot = resolveInside(options.installedDir, plugin.id);
    const declarations = await readPluginMcpServerDeclarations(pluginRoot);
    if (!declarations) continue;
    const runtimeManifest = declarations.some(
      (declaration) => declaration.transport.type === 'stdio',
    )
      ? await readPluginRuntimeManifest(pluginRoot)
      : null;
    const declaredCredentials = new Set(plugin.manifest.requiredCredentials);
    for (const declaration of declarations) {
      let transport = declaration.transport;
      let executableRuntimePolicy: Extract<
        McpServerConfig['source'],
        { kind: 'plugin' }
      >['executableRuntimePolicy'];
      if (declaration.transport.type === 'stdio') {
        if (!options.isExecutableRuntimeEnabled?.()) {
          throw new Error(
            `Plugin ${plugin.id} declares stdio MCP "${declaration.id}", but executable extensions are disabled`,
          );
        }
        if (!permissions.has('process')) {
          throw new Error(
            `Plugin ${plugin.id} declares stdio MCP "${declaration.id}" without process permission`,
          );
        }
        const runtime = runtimeManifest?.runtimes.find(
          (candidate) => candidate.id === declaration.runtimeId,
        );
        if (!runtime) {
          throw new Error(
            `Plugin ${plugin.id} MCP "${declaration.id}" references missing runtime "${declaration.runtimeId}"`,
          );
        }
        const command = await validatePluginRuntime(pluginRoot, runtime);
        executableRuntimePolicy = {
          kind: 'plugin-executable',
          pluginId: plugin.id,
          runtimeId: runtime.id,
          pluginRoot,
          allowNetwork: permissions.has('network'),
          allowFilesystem: permissions.has('filesystem'),
          maxMemoryMb: runtime.limits.maxMemoryMb,
          requestTimeoutMs: runtime.limits.requestTimeoutMs,
        };
        transport = {
          ...declaration.transport,
          command,
          cwd: pluginRoot,
          args: [...runtime.args, ...declaration.transport.args],
        };
      } else if (!permissions.has('network')) {
        throw new Error(
          `Plugin ${plugin.id} declares remote MCP "${declaration.id}" without network permission`,
        );
      }
      const credentialReferences = collectCredentialReferences(transport);
      if (credentialReferences.length > 0 && !permissions.has('credentials')) {
        throw new Error(
          `Plugin ${plugin.id} declares credential-backed MCP "${declaration.id}" without credentials permission`,
        );
      }
      for (const reference of credentialReferences) {
        if (!declaredCredentials.has(reference.credentialId)) {
          throw new Error(
            `Plugin ${plugin.id} MCP "${declaration.id}" references undeclared credential "${reference.credentialId}"`,
          );
        }
      }
      servers.push({
        id: `plugin.${plugin.id}.${declaration.id}`,
        displayName: `${plugin.manifest.displayName}: ${declaration.displayName}`,
        // Installation and publisher defaults never opt the user into a new
        // network capability. Existing user enablement is preserved later by
        // McpRegistryService.syncPluginServers().
        enabled: false,
        source: {
          kind: 'plugin',
          pluginId: plugin.id,
          pluginVersion: plugin.version,
          ...(executableRuntimePolicy ? { executableRuntimePolicy } : {}),
        },
        transport,
        policy: {
          ...declaration.policy,
          // A signed publisher may suggest deny/ask defaults, but installation
          // alone must never grant automatic execution.
          default:
            declaration.policy.default === 'deny' ? 'deny' : ('ask' as const),
        },
      });
    }
  }
  return servers;
}

export async function readPluginRuntimeManifest(
  pluginRoot: string,
): Promise<PluginRuntimeManifest | null> {
  const manifestPath = resolveInside(pluginRoot, 'runtime', 'manifest.json');
  try {
    return pluginRuntimeManifestSchema.parse(
      JSON.parse(await fs.readFile(manifestPath, 'utf8')),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function validatePluginRuntime(
  pluginRoot: string,
  runtime: PluginRuntimeManifest['runtimes'][number],
): Promise<string> {
  if (
    !runtime.platforms.includes(
      process.platform as 'darwin' | 'linux' | 'win32',
    )
  ) {
    throw new Error(
      `Plugin runtime "${runtime.id}" does not support this platform`,
    );
  }
  if (!runtime.architectures.includes(process.arch as 'arm64' | 'x64')) {
    throw new Error(
      `Plugin runtime "${runtime.id}" does not support this architecture`,
    );
  }

  const entrypoint = resolveInside(pluginRoot, runtime.entrypoint);
  const [realRoot, realEntrypoint, stat, content] = await Promise.all([
    fs.realpath(pluginRoot),
    fs.realpath(entrypoint),
    fs.stat(entrypoint),
    fs.readFile(entrypoint),
  ]);
  if (
    realEntrypoint !== realRoot &&
    !realEntrypoint.startsWith(`${realRoot}${path.sep}`)
  ) {
    throw new Error(`Plugin runtime "${runtime.id}" escapes the plugin root`);
  }
  if (!stat.isFile()) {
    throw new Error(`Plugin runtime "${runtime.id}" is not a regular file`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) {
    throw new Error(`Plugin runtime "${runtime.id}" is not executable`);
  }
  const digest = createHash('sha256').update(content).digest('hex');
  if (digest !== runtime.sha256) {
    throw new Error(
      `Plugin runtime "${runtime.id}" failed integrity validation`,
    );
  }
  return realEntrypoint;
}

function resolveInside(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  if (
    resolved !== resolvedRoot &&
    !resolved.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error('Plugin MCP path escapes the installed plugin directory');
  }
  return resolved;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
