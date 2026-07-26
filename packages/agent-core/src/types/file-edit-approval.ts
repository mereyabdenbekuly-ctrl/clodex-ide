import { z } from 'zod';

/** Controls whether eligible workspace file edits require manual review. */
export const fileEditApprovalModeSchema = z.enum(['manual', 'autoWorkspace']);
export type FileEditApprovalMode = z.infer<typeof fileEditApprovalModeSchema>;

/**
 * Fail-closed default for new agents and corrupted or missing persistence
 * rows. Automatic approval must always be an explicit per-agent choice.
 *
 * Migration SQL intentionally inlines `manual` for replay stability.
 */
export const DEFAULT_FILE_EDIT_APPROVAL_MODE: FileEditApprovalMode = 'manual';
