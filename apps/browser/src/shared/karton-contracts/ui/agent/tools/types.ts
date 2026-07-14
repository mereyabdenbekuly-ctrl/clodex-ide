import type { InferUITools, Tool } from 'ai';
import { universalToolSchemas } from '@clodex/agent-core/types/tools';
import type { ToolOutputDiff, WithDiff } from '@clodex/agent-core/types/tools';
import { z } from 'zod';
import {
  desktopAutomationAppSchema,
  desktopAutomationElementSchema,
  desktopAutomationInspectionSchema,
} from '@shared/desktop-automation';

export {
  copyToolInputSchema,
  copyToolOutputSchema,
  copyToolSchema,
  deleteToolInputSchema,
  deleteToolSchema,
  globToolInputSchema,
  globToolOutputSchema,
  globToolSchema,
  grepSearchToolInputSchema,
  grepSearchToolOutputSchema,
  grepSearchToolSchema,
  lsToolInputSchema,
  lsToolSchema,
  mkdirToolInputSchema,
  mkdirToolOutputSchema,
  mkdirToolSchema,
  multiEditToolInputSchema,
  multiEditToolOutputSchema,
  multiEditToolSchema,
  readToolInputSchema,
  readToolOutputSchema,
  readToolSchema,
  searchProjectSymbolsToolInputSchema,
  searchProjectSymbolsToolOutputSchema,
  searchProjectSymbolsToolSchema,
  universalToolSchemas,
  writeToolInputSchema,
  writeToolOutputSchema,
  writeToolSchema,
} from '@clodex/agent-core/types/tools';

export type {
  CopyToolInput,
  CopyToolOutput,
  DeleteToolInput,
  GlobToolInput,
  GlobToolOutput,
  GrepSearchToolInput,
  GrepSearchToolOutput,
  LsToolInput,
  MkdirToolInput,
  MkdirToolOutput,
  MultiEditToolInput,
  MultiEditToolOutput,
  readToolInput,
  ReadToolOutput,
  SearchProjectSymbolsToolInput,
  SearchProjectSymbolsToolOutput,
  UniversalToolSchemas,
  UniversalTools,
  WriteToolInput,
  WriteToolOutput,
} from '@clodex/agent-core/types/tools';

export const getLintingDiagnosticsToolInputSchema = z.object({
  paths: z
    .array(z.string())
    .describe(
      'File paths to check for diagnostics. Each must include a valid mount prefix, e.g. "w1a2b/src/file.ts".',
    ),
});

export const lintingDiagnosticSchema = z.object({
  line: z.number(),
  column: z.number(),
  severity: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    .default(1),
  source: z.string(),
  message: z.string(),
  code: z.string().optional(),
});

export const fileDiagnosticsSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to the file to get linting diagnostics for. Must include a valid mount prefix. e.g. "/ws1/path/to/file.ts"',
    ),
  diagnostics: z.array(lintingDiagnosticSchema),
});

export const diagnosticsSummarySchema = z.object({
  totalFiles: z.number(),
  totalIssues: z.number(),
  errors: z.number(),
  warnings: z.number(),
  infos: z.number(),
  hints: z.number(),
});

export const getLintingDiagnosticsToolOutputSchema = z.object({
  message: z.string(),
  files: z.array(fileDiagnosticsSchema),
  summary: diagnosticsSummarySchema,
});

export type LintingDiagnostic = z.infer<typeof lintingDiagnosticSchema>;
export type FileDiagnostics = z.infer<typeof fileDiagnosticsSchema>;
export type DiagnosticsSummary = z.infer<typeof diagnosticsSummarySchema>;
export type GetLintingDiagnosticsToolInput = z.infer<
  typeof getLintingDiagnosticsToolInputSchema
>;
export type GetLintingDiagnosticsToolOutput = z.infer<
  typeof getLintingDiagnosticsToolOutputSchema
>;

export const getLintingDiagnosticsToolSchema = {
  inputSchema: getLintingDiagnosticsToolInputSchema,
  outputSchema: getLintingDiagnosticsToolOutputSchema,
} as const;

export const runOpenManusToolInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .describe('The autonomous task to delegate to OpenManus.'),
  mountPrefix: z
    .string()
    .min(1)
    .describe(
      'Mounted workspace prefix to run OpenManus against, e.g. "w48b2".',
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(30 * 60 * 1000)
    .optional()
    .describe('Optional timeout in milliseconds. Defaults to 10 minutes.'),
});

export const runOpenManusToolOutputSchema = z.object({
  message: z.string(),
  exitCode: z.number().nullable(),
  signal: z.string().optional(),
  timedOut: z.boolean(),
  mountPrefix: z.string(),
  runtimeId: z.string(),
  stdout: z.string(),
  stderr: z.string(),
});

export type RunOpenManusToolInput = z.infer<typeof runOpenManusToolInputSchema>;
export type RunOpenManusToolOutput = z.infer<
  typeof runOpenManusToolOutputSchema
>;

export const runOpenManusToolSchema = {
  inputSchema: runOpenManusToolInputSchema,
  outputSchema: runOpenManusToolOutputSchema,
} as const;

// IMPORTANT: This definition is tied to a child agent - so the types are not strictly coupled. Change this type when you change the input schema of the @project-md.ts agent.
export const updateWorkspaceMdToolInputSchema = z.object({
  updateReason: z
    .string()
    .min(5)
    .describe('Brief reason for triggering the .clodex/WORKSPACE.md update.'),
  mountPrefix: z.string().describe('Mount prefix of the workspace to update.'),
});

export const updateWorkspaceMdToolOutputSchema = z.object({
  message: z.string(),
});

export type UpdateWorkspaceMdToolInput = z.infer<
  typeof updateWorkspaceMdToolInputSchema
>;
export type UpdateWorkspaceMdToolOutput = z.infer<
  typeof updateWorkspaceMdToolOutputSchema
>;

export const updateWorkspaceMdToolSchema = {
  inputSchema: updateWorkspaceMdToolInputSchema,
  outputSchema: updateWorkspaceMdToolOutputSchema,
} as const;

export const executeSandboxJsToolInputSchema = z.object({
  explanation: z
    .string()
    .describe(
      'Concise (max 5 words) human-readable description of what this script does. Examples: "Take a screenshot", "Read workspace files", "Query DOM elements", "Process API response", "Generate image thumbnail"',
    ),
  script: z.string().describe('JavaScript code to execute'),
});

export const executeSandboxJsToolOutputSchema = z.object({
  message: z.string(),
  result: z.any(),
});

export type ExecuteSandboxJsToolInput = z.infer<
  typeof executeSandboxJsToolInputSchema
>;
export type ExecuteSandboxJsToolOutput = z.infer<
  typeof executeSandboxJsToolOutputSchema
>;

export const executeSandboxJsToolSchema = {
  inputSchema: executeSandboxJsToolInputSchema,
  outputSchema: executeSandboxJsToolOutputSchema,
} as const;

export const consoleLogLevelSchema = z.enum([
  'log',
  'debug',
  'info',
  'error',
  'warning',
  'dir',
  'dirxml',
  'table',
  'trace',
  'clear',
  'startGroup',
  'startGroupCollapsed',
  'endGroup',
  'assert',
  'profile',
  'profileEnd',
  'count',
  'timeEnd',
]);

export type ConsoleLogLevel = z.infer<typeof consoleLogLevelSchema>;

export const readConsoleLogsToolInputSchema = z.object({
  id: z.string().describe('The tab ID to read console logs from'),
  filter: z
    .string()
    .optional()
    .describe('Case-insensitive substring to filter logs by'),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('Maximum number of logs to return (most recent first)'),
  levels: z
    .array(consoleLogLevelSchema)
    .optional()
    .describe('Filter by specific log levels'),
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .optional()
    .describe(
      'Milliseconds to wait BEFORE reading logs. Use after injecting monitoring code to capture async/animation logs.',
    ),
});

export const readConsoleLogsToolOutputSchema = z.object({
  message: z.string(),
  result: z.any(),
});

export type ReadConsoleLogsToolInput = z.infer<
  typeof readConsoleLogsToolInputSchema
>;
export type ReadConsoleLogsToolOutput = z.infer<
  typeof readConsoleLogsToolOutputSchema
>;

export const readConsoleLogsToolSchema = {
  inputSchema: readConsoleLogsToolInputSchema,
  outputSchema: readConsoleLogsToolOutputSchema,
} as const;

export const searchInLibraryDocsToolInputSchema = z.object({
  libraryId: z.string().describe('ID for which docs should be searched'),
  topic: z.string().describe('Topic to search for in the docs'),
});

export const searchInLibraryDocsToolOutputSchema = z.object({
  message: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});

export type SearchInLibraryDocsToolInput = z.infer<
  typeof searchInLibraryDocsToolInputSchema
>;
export type SearchInLibraryDocsToolOutput = z.infer<
  typeof searchInLibraryDocsToolOutputSchema
>;

export const searchInLibraryDocsToolSchema = {
  inputSchema: searchInLibraryDocsToolInputSchema,
  outputSchema: searchInLibraryDocsToolOutputSchema,
} as const;

export const listLibraryDocsToolInputSchema = z.object({
  name: z.string().describe('Library name for which to search for matches.'),
});

export const listLibraryDocsToolOutputSchema = z.object({
  message: z.string(),
  library: z.string(),
  results: z.array(
    z.object({
      libraryId: z.string(),
      title: z.string(),
      description: z.string().optional(),
      trustScore: z.number().optional(),
      versions: z.array(z.string()).optional(),
    }),
  ),
  truncated: z.boolean(),
  itemsRemoved: z.number().optional(),
});

export type ListLibraryDocsToolInput = z.infer<
  typeof listLibraryDocsToolInputSchema
>;
export type ListLibraryDocsToolOutput = z.infer<
  typeof listLibraryDocsToolOutputSchema
>;

export const listLibraryDocsToolSchema = {
  inputSchema: listLibraryDocsToolInputSchema,
  outputSchema: listLibraryDocsToolOutputSchema,
} as const;

const questionFieldOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
});

const inputFieldSchema = z.object({
  type: z.literal('input'),
  questionId: z.string(),
  inputType: z.enum(['text', 'email', 'number', 'password']).optional(),
  validationFormat: z.enum(['date', 'date-time', 'uri']).optional(),
  integer: z.boolean().optional(),
  label: z.string(),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  defaultValue: z.union([z.string(), z.number()]).optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  required: z.boolean().optional(),
});

const radioGroupFieldSchema = z.object({
  type: z.literal('radio-group'),
  questionId: z.string(),
  label: z.string(),
  description: z.string().optional(),
  options: z.array(questionFieldOptionSchema).min(1),
  defaultValue: z.string().optional(),
  required: z.boolean().optional(),
  allowOther: z.boolean().optional(),
});

const checkboxFieldSchema = z.object({
  type: z.literal('checkbox'),
  questionId: z.string(),
  label: z.string(),
  description: z.string().optional(),
  defaultValue: z.boolean().optional(),
});

const checkboxGroupFieldSchema = z.object({
  type: z.literal('checkbox-group'),
  questionId: z.string(),
  label: z.string(),
  description: z.string().optional(),
  options: z.array(questionFieldOptionSchema).min(1),
  defaultValues: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  minItems: z.number().int().nonnegative().optional(),
  maxItems: z.number().int().nonnegative().optional(),
});

export const questionFieldSchema = z.discriminatedUnion('type', [
  inputFieldSchema,
  radioGroupFieldSchema,
  checkboxFieldSchema,
  checkboxGroupFieldSchema,
]);

export type QuestionField = z.infer<typeof questionFieldSchema>;

const questionFieldFlatSchema = z.object({
  type: z.enum(['input', 'radio-group', 'checkbox', 'checkbox-group']),
  questionId: z.string(),
  label: z.string(),
  description: z.string().optional(),
  inputType: z.enum(['text', 'email', 'number', 'password']).optional(),
  validationFormat: z.enum(['date', 'date-time', 'uri']).optional(),
  integer: z.boolean().optional(),
  placeholder: z.string().optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  required: z.boolean().optional(),
  options: z.array(questionFieldOptionSchema).min(1).optional(),
  allowOther: z.boolean().optional(),
  defaultValues: z.array(z.string()).optional(),
  minItems: z.number().int().nonnegative().optional(),
  maxItems: z.number().int().nonnegative().optional(),
});

export const askUserQuestionsToolInputSchemaFlat = z.object({
  title: z.string().describe('Form title shown in the collapsible header.'),
  description: z
    .string()
    .optional()
    .describe('Optional top-level description.'),
  steps: z
    .array(
      z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        fields: z.array(questionFieldFlatSchema).min(1).max(10),
      }),
    )
    .min(1)
    .max(5)
    .describe('Array of form steps. Single-step forms have one entry.'),
});

export const askUserQuestionsToolInputSchema = z.object({
  title: z.string().describe('Form title shown in the collapsible header.'),
  description: z
    .string()
    .optional()
    .describe('Optional top-level description.'),
  steps: z
    .array(
      z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        fields: z.array(questionFieldSchema).min(1).max(10),
      }),
    )
    .min(1)
    .max(5)
    .describe('Array of form steps. Single-step forms have one entry.'),
});

const questionAnswerValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

export type QuestionAnswerValue = z.infer<typeof questionAnswerValueSchema>;

export const askUserQuestionsToolOutputSchema = z.object({
  completed: z.boolean(),
  cancelled: z.boolean(),
  cancelReason: z
    .enum(['user_cancelled', 'user_sent_message', 'agent_stopped'])
    .optional(),
  answers: z.record(z.string(), questionAnswerValueSchema),
  completedSteps: z.number(),
  notice: z.string().optional(),
});

export type AskUserQuestionsToolInput = z.infer<
  typeof askUserQuestionsToolInputSchema
>;
export type AskUserQuestionsToolOutput = z.infer<
  typeof askUserQuestionsToolOutputSchema
>;

export const askUserQuestionsToolSchema = {
  inputSchema: askUserQuestionsToolInputSchema,
  outputSchema: askUserQuestionsToolOutputSchema,
} as const;

// ============================================================================
// Create Shell Session Tool
// ============================================================================

// Shell tool schemas live in `@clodex/agent-shell/schemas` (single source
// of truth shared with the Node shell runtime). Re-exported here so existing
// browser UI / contract imports continue to resolve unchanged.
export {
  createShellSessionToolInputSchema,
  createShellSessionToolOutputSchema,
  createShellSessionToolSchema,
  executeShellCommandToolInputSchema,
  executeShellCommandToolOutputSchema,
  executeShellCommandToolSchema,
} from '@clodex/agent-shell/schemas';
export type {
  CreateShellSessionToolInput,
  CreateShellSessionToolOutput,
  ExecuteShellCommandToolInput,
  ExecuteShellCommandToolOutput,
} from '@clodex/agent-shell/schemas';
// Also imported (not just re-exported) so `allToolSchemas` below can
// reference them in local module scope.
import {
  createShellSessionToolSchema,
  executeShellCommandToolSchema,
} from '@clodex/agent-shell/schemas';

// ============================================================================
// Memory Notes Tools
// ============================================================================

export const memoryNoteScopeSchema = z.enum(['global', 'workspace', 'agent']);
export const memoryNoteSensitivitySchema = z.enum(['normal', 'sensitive']);
export const memorySearchMatchModeSchema = z.enum([
  'any',
  'all-on-line',
  'all-within-entry',
]);

const memoryScopeInputFields = {
  scope: memoryNoteScopeSchema
    .optional()
    .describe('Memory scope. Defaults to agent when adding a note.'),
  mountPrefix: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Required only for workspace scope. Must be a mount prefix currently available to this agent.',
    ),
};

export const addMemoryToolInputSchema = z.object({
  ...memoryScopeInputFields,
  title: z.string().min(1).max(160).describe('Short note title.'),
  content: z
    .string()
    .min(1)
    .max(20_000)
    .describe('Long-term note content to store.'),
  tags: z
    .array(z.string().min(1).max(48))
    .max(16)
    .default([])
    .describe('Optional retrieval tags.'),
  sensitivity: memoryNoteSensitivitySchema
    .default('normal')
    .describe(
      'Use sensitive for secrets, credentials, personal data, or other private information.',
    ),
});

export const listMemoriesToolInputSchema = z.object({
  ...memoryScopeInputFields,
  limit: z.number().int().min(1).max(50).default(20),
});

export const readMemoryToolInputSchema = z.object({
  id: z.string().uuid(),
});

export const searchMemoriesToolInputSchema = z.object({
  ...memoryScopeInputFields,
  query: z.string().trim().min(1).max(500),
  mode: memorySearchMatchModeSchema.default('any'),
  limit: z.number().int().min(1).max(50).default(20),
});

export const deleteMemoryToolInputSchema = z.object({
  id: z.string().uuid(),
});

const memoryResultScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }),
  z.object({ type: z.literal('agent') }),
  z.object({
    type: z.literal('workspace'),
    mountPrefix: z.string(),
  }),
]);

const memorySummarySchema = z.object({
  id: z.string().uuid(),
  scope: memoryResultScopeSchema,
  title: z.string(),
  tags: z.array(z.string()),
  sensitivity: memoryNoteSensitivitySchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const addMemoryToolOutputSchema = z.object({
  message: z.string(),
  memory: memorySummarySchema,
});

export const listMemoriesToolOutputSchema = z.object({
  notice: z.string(),
  memories: z.array(memorySummarySchema),
});

export const readMemoryToolOutputSchema = z.object({
  notice: z.string(),
  memory: memorySummarySchema.extend({ content: z.string() }).nullable(),
});

export const searchMemoriesToolOutputSchema = z.object({
  notice: z.string(),
  matches: z.array(memorySummarySchema.extend({ excerpt: z.string() })),
});

export const deleteMemoryToolOutputSchema = z.object({
  message: z.string(),
  id: z.string().uuid(),
  deleted: z.boolean(),
});

export const addMemoryToolSchema = {
  inputSchema: addMemoryToolInputSchema,
  outputSchema: addMemoryToolOutputSchema,
} as const;
export const listMemoriesToolSchema = {
  inputSchema: listMemoriesToolInputSchema,
  outputSchema: listMemoriesToolOutputSchema,
} as const;
export const readMemoryToolSchema = {
  inputSchema: readMemoryToolInputSchema,
  outputSchema: readMemoryToolOutputSchema,
} as const;
export const searchMemoriesToolSchema = {
  inputSchema: searchMemoriesToolInputSchema,
  outputSchema: searchMemoriesToolOutputSchema,
} as const;
export const deleteMemoryToolSchema = {
  inputSchema: deleteMemoryToolInputSchema,
  outputSchema: deleteMemoryToolOutputSchema,
} as const;

export type AddMemoryToolInput = z.infer<typeof addMemoryToolInputSchema>;
export type AddMemoryToolOutput = z.infer<typeof addMemoryToolOutputSchema>;
export type ListMemoriesToolInput = z.infer<typeof listMemoriesToolInputSchema>;
export type ListMemoriesToolOutput = z.infer<
  typeof listMemoriesToolOutputSchema
>;
export type ReadMemoryToolInput = z.infer<typeof readMemoryToolInputSchema>;
export type ReadMemoryToolOutput = z.infer<typeof readMemoryToolOutputSchema>;
export type SearchMemoriesToolInput = z.infer<
  typeof searchMemoriesToolInputSchema
>;
export type SearchMemoriesToolOutput = z.infer<
  typeof searchMemoriesToolOutputSchema
>;
export type DeleteMemoryToolInput = z.infer<typeof deleteMemoryToolInputSchema>;
export type DeleteMemoryToolOutput = z.infer<
  typeof deleteMemoryToolOutputSchema
>;

export const inspectDesktopToolInputSchema = z.object({
  maxElements: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe('Maximum number of safe pressable accessibility elements.'),
});

export const inspectDesktopToolOutputSchema =
  desktopAutomationInspectionSchema.extend({
    notice: z.string(),
  });

export const captureDesktopToolInputSchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9._-]+$/)
    .optional()
    .describe('Optional safe PNG attachment filename.'),
});

export const captureDesktopToolOutputSchema = z.object({
  message: z.string(),
  app: desktopAutomationAppSchema,
  attachmentPath: z.string(),
});

export const pressDesktopElementToolInputSchema = z.object({
  targetId: z
    .string()
    .uuid()
    .describe('Opaque target id from the latest inspectDesktop result.'),
});

export const pressDesktopElementToolOutputSchema = z.object({
  message: z.string(),
  app: desktopAutomationAppSchema,
  element: desktopAutomationElementSchema,
});

export const inspectDesktopToolSchema = {
  inputSchema: inspectDesktopToolInputSchema,
  outputSchema: inspectDesktopToolOutputSchema,
} as const;
export const captureDesktopToolSchema = {
  inputSchema: captureDesktopToolInputSchema,
  outputSchema: captureDesktopToolOutputSchema,
} as const;
export const pressDesktopElementToolSchema = {
  inputSchema: pressDesktopElementToolInputSchema,
  outputSchema: pressDesktopElementToolOutputSchema,
} as const;

export type InspectDesktopToolInput = z.infer<
  typeof inspectDesktopToolInputSchema
>;
export type InspectDesktopToolOutput = z.infer<
  typeof inspectDesktopToolOutputSchema
>;
export type CaptureDesktopToolInput = z.infer<
  typeof captureDesktopToolInputSchema
>;
export type CaptureDesktopToolOutput = z.infer<
  typeof captureDesktopToolOutputSchema
>;
export type PressDesktopElementToolInput = z.infer<
  typeof pressDesktopElementToolInputSchema
>;
export type PressDesktopElementToolOutput = z.infer<
  typeof pressDesktopElementToolOutputSchema
>;

export const allToolSchemas = {
  ...universalToolSchemas,
  getLintingDiagnostics: getLintingDiagnosticsToolSchema,
  updateWorkspaceMd: updateWorkspaceMdToolSchema,
  executeSandboxJs: executeSandboxJsToolSchema,
  readConsoleLogs: readConsoleLogsToolSchema,
  listLibraryDocs: listLibraryDocsToolSchema,
  searchInLibraryDocs: searchInLibraryDocsToolSchema,
  askUserQuestions: askUserQuestionsToolSchema,
  runOpenManus: runOpenManusToolSchema,
  createShellSession: createShellSessionToolSchema,
  executeShellCommand: executeShellCommandToolSchema,
  addMemory: addMemoryToolSchema,
  listMemories: listMemoriesToolSchema,
  readMemory: readMemoryToolSchema,
  searchMemories: searchMemoriesToolSchema,
  deleteMemory: deleteMemoryToolSchema,
  inspectDesktop: inspectDesktopToolSchema,
  captureDesktop: captureDesktopToolSchema,
  pressDesktopElement: pressDesktopElementToolSchema,
} as const;

export type AllTools = typeof allToolSchemas;

export type UIAgentTools = InferUITools<AllTools>;

export type ClodexToolSet = {
  [K in keyof AllTools]: Tool<
    AllTools[K]['inputSchema'],
    AllTools[K]['outputSchema']
  >;
};

export type ToolName = keyof ClodexToolSet;

export type { ToolOutputDiff, WithDiff };
