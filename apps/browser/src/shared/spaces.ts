import { z } from 'zod';

export const spaceLinkSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  url: z.string().url().max(8_192),
});
export type SpaceLink = z.infer<typeof spaceLinkSchema>;

const spaceFieldsSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).default(''),
  workspacePaths: z
    .array(z.string().trim().min(1).max(4_096))
    .max(64)
    .default([]),
  links: z.array(spaceLinkSchema).max(200).default([]),
  instructions: z.string().max(100_000).default(''),
  archived: z.boolean().default(false),
});

export const createSpaceInputSchema = spaceFieldsSchema;
export type CreateSpaceInput = z.infer<typeof createSpaceInputSchema>;

export const updateSpaceInputSchema = spaceFieldsSchema.partial().extend({
  id: z.string().uuid(),
});
export type UpdateSpaceInput = z.infer<typeof updateSpaceInputSchema>;

export const spaceDefinitionSchema = spaceFieldsSchema.extend({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SpaceDefinition = z.infer<typeof spaceDefinitionSchema>;

export interface SpaceProjectImport {
  name: string;
  rootPath: string | null;
}

export interface SpacesSnapshot {
  spaces: SpaceDefinition[];
  projectsImportedAt: string | null;
}
