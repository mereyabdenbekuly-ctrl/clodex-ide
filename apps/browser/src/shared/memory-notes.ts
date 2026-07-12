import { z } from 'zod';

export const memoryNotesRetentionValues = [
  'forever',
  '30-days',
  '90-days',
  '1-year',
] as const;
export const memoryNotesRetentionSchema = z.enum(memoryNotesRetentionValues);
export type MemoryNotesRetention = z.infer<typeof memoryNotesRetentionSchema>;

export const memoryNotesManagementScopes = [
  'all',
  'global',
  'workspace',
  'agent',
] as const;
export const memoryNotesManagementScopeSchema = z.enum(
  memoryNotesManagementScopes,
);
export type MemoryNotesManagementScope = z.infer<
  typeof memoryNotesManagementScopeSchema
>;

export interface MemoryNotesStats {
  total: number;
  byScope: {
    global: number;
    workspace: number;
    agent: number;
  };
  oldestCreatedAt: number | null;
  newestUpdatedAt: number | null;
}

export interface MemoryNotesExportResult {
  canceled: boolean;
  count: number;
  filePath?: string;
}

export interface MemoryNotesRetentionResult {
  retention: MemoryNotesRetention;
  deleted: number;
}

export interface MemoryNotesResetResult {
  scope: MemoryNotesManagementScope;
  deleted: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

export function getMemoryNotesRetentionDurationMs(
  retention: MemoryNotesRetention,
): number | null {
  switch (retention) {
    case 'forever':
      return null;
    case '30-days':
      return 30 * DAY_MS;
    case '90-days':
      return 90 * DAY_MS;
    case '1-year':
      return 365 * DAY_MS;
  }
}
