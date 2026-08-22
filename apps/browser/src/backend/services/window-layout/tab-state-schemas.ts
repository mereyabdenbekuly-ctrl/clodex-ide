import { z } from 'zod';

export const windowStateSchema = z.object({
  width: z.number(),
  height: z.number(),
  x: z.number().optional(),
  y: z.number().optional(),
  isMaximized: z.boolean(),
  isFullScreen: z.boolean(),
});

export type WindowState = z.infer<typeof windowStateSchema>;

export const fileTabMetadataSchema = z.object({
  workspaceKey: z.string(),
  relativePath: z.string(),
  absolutePath: z.string(),
  kind: z.enum(['text', 'image', 'svg', 'binary']),
  mimeType: z.string(),
  size: z.number(),
  displayName: z.string().optional(),
  readOnly: z.boolean().optional(),
  showDiff: z.boolean().optional(),
  diffStaged: z.boolean().optional(),
  diffOldPath: z.string().optional(),
});

export const tabEntrySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('browser'),
    url: z.string(),
    agentInstanceId: z.string().nullable(),
  }),
  z.object({
    type: z.literal('terminal'),
    id: z.string(),
    cwd: z.string(),
    title: z.string(),
    agentInstanceId: z.string().nullable(),
  }),
  z.object({
    type: z.literal('file'),
    id: z.string(),
    title: z.string(),
    file: fileTabMetadataSchema,
    agentInstanceId: z.string().nullable(),
  }),
]);

export type TabEntry = z.infer<typeof tabEntrySchema>;

export const tabStateSchema = z.object({
  /** Ordered list of tabs that were open */
  tabs: z.array(
    z.preprocess((val) => {
      // Normalize legacy entries (no `type` field) to `type: 'browser'`.
      if (typeof val === 'object' && val !== null && !('type' in val)) {
        return { type: 'browser', ...(val as Record<string, unknown>) };
      }
      return val;
    }, tabEntrySchema),
  ),
  /** Index into `tabs` of the active tab, or -1 if none */
  activeTabIndex: z.number().int().min(-1),
  /** Last active tab per agent instance */
  lastActiveTabPerAgent: z.record(z.string(), z.string()),
  /** ID of the agent instance that was last open, for restoration on restart */
  lastOpenAgentId: z.string().nullable(),
});

export type PersistedTabState = z.infer<typeof tabStateSchema>;
