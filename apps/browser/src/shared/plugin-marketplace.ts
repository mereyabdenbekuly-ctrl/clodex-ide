import { z } from 'zod';
import { credentialTypeRegistry } from './credential-types';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_MCP_SERVER_ID_PATTERN = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const PRIVATE_MARKETPLACE_SOURCES_SCHEMA_VERSION = 1;

export const pluginMarketplacePermissionSchema = z.enum([
  'skills',
  'apps',
  'mcp',
  'network',
  'filesystem',
  'credentials',
  'process',
]);
export type PluginMarketplacePermission = z.infer<
  typeof pluginMarketplacePermissionSchema
>;

export const pluginMarketplaceMcpServerSummarySchema = z.discriminatedUnion(
  'transport',
  [
    z
      .object({
        id: z.string().trim().min(1).max(80).regex(SAFE_MCP_SERVER_ID_PATTERN),
        displayName: z.string().trim().min(1).max(120),
        transport: z.enum(['streamable-http', 'sse']),
        endpoint: z.string().url().max(8_192),
        authentication: z.enum([
          'none',
          'oauth',
          'credential',
          'oauth+credential',
        ]),
      })
      .strict(),
    z
      .object({
        id: z.string().trim().min(1).max(80).regex(SAFE_MCP_SERVER_ID_PATTERN),
        displayName: z.string().trim().min(1).max(120),
        transport: z.literal('stdio'),
        runtimeId: z.string().trim().min(1).max(80),
        endpoint: z.string().trim().min(1).max(256),
        authentication: z.enum(['none', 'credential']),
      })
      .strict(),
  ],
);
export type PluginMarketplaceMcpServerSummary = z.infer<
  typeof pluginMarketplaceMcpServerSummarySchema
>;

export const pluginMarketplaceExecutableRuntimeSummarySchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    sha256: z.string().regex(SHA256_PATTERN),
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
  .strict();
export type PluginMarketplaceExecutableRuntimeSummary = z.infer<
  typeof pluginMarketplaceExecutableRuntimeSummarySchema
>;

export const pluginMarketplaceManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(SAFE_PLUGIN_ID_PATTERN),
    version: z.string().regex(SEMVER_PATTERN),
    displayName: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    publisher: z.string().trim().min(1).max(120),
    publisherId: z.string().regex(SAFE_PLUGIN_ID_PATTERN).optional(),
    compatibility: z
      .object({
        minAppVersion: z.string().regex(SEMVER_PATTERN),
        maxAppVersion: z.string().regex(SEMVER_PATTERN).optional(),
      })
      .strict(),
    permissions: z.array(pluginMarketplacePermissionSchema).max(12),
    requiredCredentials: z
      .array(
        z
          .string()
          .refine((id) => Object.keys(credentialTypeRegistry).includes(id), {
            message: 'Invalid credential type ID',
          }),
      )
      .max(12),
    mcpServers: z
      .array(pluginMarketplaceMcpServerSummarySchema)
      .max(50)
      .optional(),
    executableRuntimes: z
      .array(pluginMarketplaceExecutableRuntimeSummarySchema)
      .max(20)
      .optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (new Set(manifest.permissions).size !== manifest.permissions.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissions'],
        message: 'Plugin permissions must be unique',
      });
    }
    if (
      new Set(manifest.requiredCredentials).size !==
      manifest.requiredCredentials.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredCredentials'],
        message: 'Required credential IDs must be unique',
      });
    }
    const mcpServers = manifest.mcpServers ?? [];
    if (
      new Set(mcpServers.map((server) => server.id)).size !== mcpServers.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mcpServers'],
        message: 'MCP server summary IDs must be unique',
      });
    }
    if (manifest.permissions.includes('mcp') && mcpServers.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mcpServers'],
        message:
          'Plugins with mcp permission must declare MCP server summaries',
      });
    }
    if (!manifest.permissions.includes('mcp') && mcpServers.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mcpServers'],
        message: 'MCP server summaries require the mcp permission',
      });
    }
    const executableRuntimes = manifest.executableRuntimes ?? [];
    if (
      new Set(executableRuntimes.map((runtime) => runtime.id)).size !==
      executableRuntimes.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executableRuntimes'],
        message: 'Executable runtime IDs must be unique',
      });
    }
    if (
      executableRuntimes.length > 0 &&
      !manifest.permissions.includes('process')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['executableRuntimes'],
        message: 'Executable runtime summaries require process permission',
      });
    }
  });
export type PluginMarketplaceManifest = z.infer<
  typeof pluginMarketplaceManifestSchema
>;

export const pluginMarketplacePackageSourceSchema = z.discriminatedUnion(
  'type',
  [
    z
      .object({
        type: z.literal('bundled-directory'),
        relativePath: z
          .string()
          .min(1)
          .max(512)
          .refine(
            (value) =>
              !value.includes('\\') &&
              !value.startsWith('/') &&
              !value.split('/').includes('..'),
            'Bundled package path must stay inside the marketplace directory',
          ),
      })
      .strict(),
    z
      .object({
        type: z.literal('https'),
        url: z
          .string()
          .url()
          .refine((value) => value.startsWith('https://'), {
            message: 'Marketplace package URL must use HTTPS',
          }),
      })
      .strict(),
  ],
);
export type PluginMarketplacePackageSource = z.infer<
  typeof pluginMarketplacePackageSourceSchema
>;

export const pluginMarketplaceIndexEntrySchema = z
  .object({
    manifest: pluginMarketplaceManifestSchema,
    source: pluginMarketplacePackageSourceSchema,
    sha256: z.string().regex(SHA256_PATTERN),
    publisherSignature: z
      .object({
        keyId: z.string().trim().min(1).max(120),
        signature: z.string().trim().min(1).max(1_024),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.manifest.publisherId && !entry.publisherSignature) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publisherSignature'],
        message: 'Publisher-identified plugins require a publisher signature',
      });
    }
    if (!entry.manifest.publisherId && entry.publisherSignature) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publisherSignature'],
        message: 'Publisher signatures require manifest.publisherId',
      });
    }
  });
export type PluginMarketplaceIndexEntry = z.infer<
  typeof pluginMarketplaceIndexEntrySchema
>;

export const pluginMarketplacePublisherKeySchema = z
  .object({
    publisherId: z.string().regex(SAFE_PLUGIN_ID_PATTERN),
    publisherName: z.string().trim().min(1).max(120),
    keyId: z.string().trim().min(1).max(120),
    publicKey: z.string().trim().min(1).max(8_192),
    status: z.enum(['active', 'revoked']),
  })
  .strict();
export type PluginMarketplacePublisherKey = z.infer<
  typeof pluginMarketplacePublisherKeySchema
>;

export const pluginMarketplaceIndexPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    publisherKeys: z
      .array(pluginMarketplacePublisherKeySchema)
      .max(1_000)
      .optional(),
    plugins: z.array(pluginMarketplaceIndexEntrySchema).max(500),
  })
  .strict()
  .superRefine((payload, context) => {
    const keyIds = new Set<string>();
    const publisherKeys = payload.publisherKeys ?? [];
    for (let index = 0; index < publisherKeys.length; index += 1) {
      const key = publisherKeys[index]!;
      if (keyIds.has(key.keyId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['publisherKeys', index, 'keyId'],
          message: 'Publisher key IDs must be unique',
        });
      }
      keyIds.add(key.keyId);
    }
  });
export type PluginMarketplaceIndexPayload = z.infer<
  typeof pluginMarketplaceIndexPayloadSchema
>;

export const signedPluginMarketplaceIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    keyId: z.string().min(1).max(80),
    payload: z.string().min(1),
    signature: z.string().min(1),
  })
  .strict();
export type SignedPluginMarketplaceIndex = z.infer<
  typeof signedPluginMarketplaceIndexSchema
>;

export const pluginMarketplaceInstallSourceSchema = z.union([
  z.literal('official'),
  z
    .object({
      kind: z.literal('private-marketplace'),
      sourceId: z.string().regex(SAFE_PLUGIN_ID_PATTERN),
      signingKeyId: z.string().trim().min(1).max(120),
      signingKeyFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
    .strict(),
]);
export type PluginMarketplaceInstallSource = z.infer<
  typeof pluginMarketplaceInstallSourceSchema
>;

export const pluginMarketplaceLockEntrySchema = z
  .object({
    id: z.string().regex(SAFE_PLUGIN_ID_PATTERN),
    version: z.string().regex(SEMVER_PATTERN),
    sha256: z.string().regex(SHA256_PATTERN),
    source: pluginMarketplaceInstallSourceSchema,
    installedAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    manifest: pluginMarketplaceManifestSchema,
    publisherKeyId: z.string().trim().min(1).max(120).optional(),
    publisherSignature: z.string().trim().min(1).max(1_024).optional(),
  })
  .strict();
export type PluginMarketplaceLockEntry = z.infer<
  typeof pluginMarketplaceLockEntrySchema
>;

export const pluginMarketplaceLockfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    plugins: z.record(z.string(), pluginMarketplaceLockEntrySchema),
  })
  .strict()
  .superRefine((lockfile, context) => {
    for (const [pluginId, entry] of Object.entries(lockfile.plugins)) {
      if (pluginId !== entry.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['plugins', pluginId, 'id'],
          message: 'Lockfile key must match the plugin ID',
        });
      }
    }
  });
export type PluginMarketplaceLockfile = z.infer<
  typeof pluginMarketplaceLockfileSchema
>;

export const pluginMarketplaceCatalogItemSchema = z.object({
  manifest: pluginMarketplaceManifestSchema,
  sha256: z.string().regex(SHA256_PATTERN),
  publisherVerified: z.boolean().optional(),
  publisherKeyId: z.string().nullable().optional(),
  compatible: z.boolean(),
  compatibilityError: z.string().nullable(),
  installedVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
});
export type PluginMarketplaceCatalogItem = z.infer<
  typeof pluginMarketplaceCatalogItemSchema
>;

export const pluginMarketplaceStateSchema = z.object({
  enabled: z.boolean(),
  status: z.enum(['ready', 'unavailable', 'error']),
  keyId: z.string().nullable(),
  generatedAt: z.number().int().nonnegative().nullable(),
  expiresAt: z.number().int().nonnegative().nullable(),
  refreshedAt: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  warnings: z.array(z.string()),
  catalog: z.array(pluginMarketplaceCatalogItemSchema),
  installed: z.array(pluginMarketplaceLockEntrySchema),
});
export type PluginMarketplaceState = z.infer<
  typeof pluginMarketplaceStateSchema
>;

export type PluginMarketplaceOperationResult =
  | {
      ok: true;
      operation: 'install' | 'update' | 'uninstall';
      pluginId: string;
      state: PluginMarketplaceState;
    }
  | {
      ok: false;
      operation: 'install' | 'update' | 'uninstall';
      pluginId: string;
      error: string;
      rolledBack: boolean;
      state: PluginMarketplaceState;
    };

export const privateMarketplaceSourceSchema = z
  .object({
    schemaVersion: z.literal(PRIVATE_MARKETPLACE_SOURCES_SCHEMA_VERSION),
    id: z.string().regex(SAFE_PLUGIN_ID_PATTERN),
    displayName: z.string().trim().min(1).max(120),
    indexUrl: z
      .string()
      .url()
      .max(8_192)
      .superRefine((value, context) => {
        const url = new URL(value);
        if (url.protocol !== 'https:') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Private marketplace index must use HTTPS',
          });
        }
        if (url.username || url.password || url.search || url.hash) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'Private marketplace index URL may not contain credentials, query, or fragment',
          });
        }
      }),
    signingKeyId: z.string().trim().min(1).max(120),
    signingPublicKey: z
      .string()
      .trim()
      .min(1)
      .max(8_192)
      .refine(
        (value) =>
          value.startsWith('-----BEGIN PUBLIC KEY-----') &&
          value.endsWith('-----END PUBLIC KEY-----'),
        'Private marketplace signing key must be a PEM public key',
      ),
    enabled: z.boolean().default(true),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((source, context) => {
    if (source.updatedAt < source.createdAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updatedAt'],
        message: 'Private marketplace updatedAt cannot precede createdAt',
      });
    }
  });
export type PrivateMarketplaceSource = z.infer<
  typeof privateMarketplaceSourceSchema
>;

export const privateMarketplaceSourcesConfigSchema = z
  .object({
    schemaVersion: z.literal(PRIVATE_MARKETPLACE_SOURCES_SCHEMA_VERSION),
    sources: z.array(privateMarketplaceSourceSchema).max(20),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = new Set<string>();
    const urls = new Set<string>();
    for (let index = 0; index < config.sources.length; index += 1) {
      const source = config.sources[index]!;
      if (ids.has(source.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources', index, 'id'],
          message: 'Private marketplace source IDs must be unique',
        });
      }
      const normalizedUrl = new URL(source.indexUrl).toString();
      if (urls.has(normalizedUrl)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources', index, 'indexUrl'],
          message: 'Private marketplace index URLs must be unique',
        });
      }
      ids.add(source.id);
      urls.add(normalizedUrl);
    }
  });
export type PrivateMarketplaceSourcesConfig = z.infer<
  typeof privateMarketplaceSourcesConfigSchema
>;

export const privateMarketplaceSourceInputSchema = z
  .object({
    id: z.string().regex(SAFE_PLUGIN_ID_PATTERN),
    displayName: z.string().trim().min(1).max(120),
    indexUrl: z
      .string()
      .url()
      .max(8_192)
      .superRefine((value, context) => {
        const url = new URL(value);
        if (url.protocol !== 'https:') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Private marketplace index must use HTTPS',
          });
        }
        if (url.username || url.password || url.search || url.hash) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'Private marketplace index URL may not contain credentials, query, or fragment',
          });
        }
      }),
    signingKeyId: z.string().trim().min(1).max(120),
    signingPublicKey: z
      .string()
      .trim()
      .min(1)
      .max(8_192)
      .refine(
        (value) =>
          value.startsWith('-----BEGIN PUBLIC KEY-----') &&
          value.endsWith('-----END PUBLIC KEY-----'),
        'Private marketplace signing key must be a PEM public key',
      ),
    enabled: z.boolean().default(true),
  })
  .strict();
export type PrivateMarketplaceSourceInput = z.infer<
  typeof privateMarketplaceSourceInputSchema
>;

export type PrivateMarketplaceSourceStatus = 'idle' | 'ready' | 'error';

export type PrivateMarketplaceSourcePublic = {
  id: string;
  displayName: string;
  indexUrl: string;
  signingKeyId: string;
  signingKeyFingerprint: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  status: PrivateMarketplaceSourceStatus;
  generatedAt: number | null;
  expiresAt: number | null;
  refreshedAt: number | null;
  pluginCount: number;
  error: string | null;
  catalog: PrivateMarketplaceCatalogItem[];
};

export type PrivateMarketplaceSourcesState = {
  enabled: boolean;
  sources: PrivateMarketplaceSourcePublic[];
};

export type PrivateMarketplaceCatalogItem = PluginMarketplaceCatalogItem & {
  sourceId: string;
  installedFromSource: boolean;
  sourceConflict: string | null;
};

export type PrivateMarketplaceOperationResult =
  | {
      ok: true;
      operation: 'install' | 'update' | 'uninstall';
      pluginId: string;
      sourceId: string;
      state: PrivateMarketplaceSourcesState;
    }
  | {
      ok: false;
      operation: 'install' | 'update' | 'uninstall';
      pluginId: string;
      sourceId: string;
      error: string;
      rolledBack: boolean;
      state: PrivateMarketplaceSourcesState;
    };

export function canonicalizePluginPublisherAttestation(
  entry: Pick<PluginMarketplaceIndexEntry, 'manifest' | 'source' | 'sha256'>,
): string {
  return canonicalizeJson({
    schemaVersion: 1,
    manifest: entry.manifest,
    source: entry.source,
    sha256: entry.sha256,
  });
}

function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error('Publisher attestation cannot contain undefined values');
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
    .join(',')}}`;
}
