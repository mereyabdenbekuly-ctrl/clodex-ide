import { z } from 'zod';
import { credentialTypeRegistry } from './credential-types';
import type { PluginMarketplacePermission } from './plugin-marketplace';

export const pluginMetadataSchema = z.object({
  displayName: z.string(),
  description: z.string(),
  requiredCredentials: z.array(
    z
      .string()
      .refine((id) => Object.keys(credentialTypeRegistry).includes(id), {
        message: 'Invalid credential type ID',
      }),
  ),
});

export type PluginMetadata = z.infer<typeof pluginMetadataSchema>;

export type PluginDefinition = {
  id: string;
  displayName: string;
  description: string;
  requiredCredentials: string[];
  logoSvg: string | null;
  skills: Array<{ name: string; description: string }>;
  source: 'bundled' | 'marketplace';
  version: string | null;
  permissions: PluginMarketplacePermission[];
};
