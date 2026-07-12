import { z } from 'zod';

export const GENERATED_APP_MANIFEST_FILE = 'clodex-app.json' as const;
export const GENERATED_APP_MANIFEST_SCHEMA_VERSION = 1 as const;

const capabilityReasonSchema = z.string().trim().min(1).max(1_000);
const identifierSchema = z.string().trim().min(1).max(256);
const generatedAppIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'Generated app ID must be a path-safe slug',
  );

export const generatedAppManifestCapabilitySchema = z.discriminatedUnion(
  'type',
  [
    z.object({
      type: z.literal('agent:ask'),
      reason: capabilityReasonSchema,
    }),
    z.object({
      type: z.literal('automation:run'),
      reason: capabilityReasonSchema,
      automationIds: z.array(z.string().uuid()).min(1).max(100),
    }),
    z.object({
      type: z.literal('mcp:call'),
      reason: capabilityReasonSchema,
      tools: z
        .array(
          z.object({
            serverId: identifierSchema,
            toolName: identifierSchema,
          }),
        )
        .min(1)
        .max(100),
    }),
    z.object({
      type: z.literal('mcp:write'),
      reason: capabilityReasonSchema,
      tools: z
        .array(
          z.object({
            serverId: identifierSchema,
            toolName: identifierSchema,
          }),
        )
        .min(1)
        .max(100),
    }),
  ],
);
export type GeneratedAppManifestCapability = z.infer<
  typeof generatedAppManifestCapabilitySchema
>;

export const generatedAppManifestSchema = z
  .object({
    schemaVersion: z.literal(GENERATED_APP_MANIFEST_SCHEMA_VERSION),
    id: generatedAppIdSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2_048).optional(),
    version: z
      .string()
      .trim()
      .regex(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
        'Generated app version must use semantic versioning',
      ),
    entrypoint: z.literal('index.html').default('index.html'),
    capabilities: z
      .array(generatedAppManifestCapabilitySchema)
      .max(32)
      .default([]),
  })
  .strict()
  .superRefine((manifest, context) => {
    const capabilityTypes = new Set<string>();
    const mcpTools = new Set<string>();
    const automationIds = new Set<string>();

    for (const capability of manifest.capabilities) {
      if (capabilityTypes.has(capability.type)) {
        context.addIssue({
          code: 'custom',
          message: `Capability "${capability.type}" may appear only once`,
          path: ['capabilities'],
        });
      }
      capabilityTypes.add(capability.type);

      if (capability.type === 'mcp:call' || capability.type === 'mcp:write') {
        for (const tool of capability.tools) {
          const key = `${tool.serverId}\0${tool.toolName}`;
          if (mcpTools.has(key)) {
            context.addIssue({
              code: 'custom',
              message: `MCP tool "${tool.serverId}/${tool.toolName}" is duplicated`,
              path: ['capabilities'],
            });
          }
          mcpTools.add(key);
        }
      }

      if (capability.type === 'automation:run') {
        for (const automationId of capability.automationIds) {
          if (automationIds.has(automationId)) {
            context.addIssue({
              code: 'custom',
              message: `Automation "${automationId}" is duplicated`,
              path: ['capabilities'],
            });
          }
          automationIds.add(automationId);
        }
      }
    }
  });
export type GeneratedAppManifest = z.infer<typeof generatedAppManifestSchema>;

export const generatedAppIdentitySchema = z.object({
  manifestSchemaVersion: z.literal(GENERATED_APP_MANIFEST_SCHEMA_VERSION),
  appVersion: z.string().min(1).max(128),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  executableHash: z.string().regex(/^[a-f0-9]{64}$/),
  assetHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type GeneratedAppIdentity = z.infer<typeof generatedAppIdentitySchema>;

export function canonicalizeGeneratedAppManifest(
  manifest: GeneratedAppManifest,
): string {
  return JSON.stringify(sortJsonValue(manifest));
}

export function getManifestCapabilityTypes(
  manifest: GeneratedAppManifest,
): Array<'agent:ask' | 'automation:run' | 'mcp:call' | 'mcp:write'> {
  return manifest.capabilities.map((capability) => capability.type);
}

export function getManifestMcpTools(
  manifest: GeneratedAppManifest,
): Array<{ serverId: string; toolName: string }> {
  return manifest.capabilities.flatMap((capability) =>
    capability.type === 'mcp:call' ? capability.tools : [],
  );
}

export function getManifestMcpWriteTools(
  manifest: GeneratedAppManifest,
): Array<{ serverId: string; toolName: string }> {
  return manifest.capabilities.flatMap((capability) =>
    capability.type === 'mcp:write' ? capability.tools : [],
  );
}

export function getManifestAutomationIds(
  manifest: GeneratedAppManifest,
): string[] {
  return manifest.capabilities.flatMap((capability) =>
    capability.type === 'automation:run' ? capability.automationIds : [],
  );
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJsonValue(nested)]),
  );
}
