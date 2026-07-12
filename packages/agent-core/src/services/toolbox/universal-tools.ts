import path from 'node:path';
import { tool } from 'ai';
import { ClientRuntimeNode } from '@clodex/agent-runtime-node';
import {
  copyFile,
  mkdir as fsMkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from '../../fs';
import { writePendingEditToDisk } from '../pending-edits';
import type {
  CopyToolInput,
  DeleteToolInput,
  GetFileSkeletonToolInput,
  GetSymbolBodyToolInput,
  GlobToolInput,
  GrepSearchToolInput,
  LsToolInput,
  MkdirToolInput,
  MultiEditToolInput,
  SearchProjectSymbolsToolInput,
  ClodexToolSet,
  UniversalToolSchemas,
  WithDiff,
  WriteToolInput,
  readToolInput,
} from '../../types/tools';
import {
  copyToolInputSchema,
  copyToolOutputSchema,
  deleteToolInputSchema,
  deleteToolOutputSchema,
  getFileSkeletonToolInputSchema,
  getFileSkeletonToolOutputSchema,
  getSymbolBodyToolInputSchema,
  getSymbolBodyToolOutputSchema,
  globToolInputSchema,
  globToolOutputSchema,
  grepSearchToolInputSchema,
  grepSearchToolOutputSchema,
  lsToolInputSchema,
  lsToolSchema,
  mkdirToolInputSchema,
  mkdirToolOutputSchema,
  multiEditToolInputSchema,
  multiEditToolOutputSchema,
  readToolInputSchema,
  readToolOutputSchema,
  searchProjectSymbolsToolInputSchema,
  searchProjectSymbolsToolOutputSchema,
  writeToolInputSchema,
  writeToolOutputSchema,
} from '../../types/tools';
import {
  getFileSymbols,
  getFileSymbolRanges,
  type SymbolInfo,
} from '../../file-read-transformer/ast';
import { isProtectedMountPrefix, readProtectedMountedFile } from '../../host';
import type { AgentFileEdit } from '../diff-history';
import {
  defaultProjectIndexService,
  type ProjectIndexMount,
} from '../project-index';
import type { UniversalToolboxDeps } from './types';
import {
  findWorkspaceRootForPath,
  listAvailableMountPrefixes,
  resolveToolPath,
} from './path-resolution';
import {
  buildAgentFileEditContent,
  capToolOutput,
  captureFileState,
  cleanupTempFile,
  formatTruncationMessage,
  rethrowCappedToolOutputError,
  truncatePreview,
} from './utils';

const READ_DESCRIPTION = `Read metadata and contents of a file. Equals \`cat\` / \`echo\` in bash. For directories, use \`ls\` instead.
If the file is not in context after the tool call, this **ALWAYS** implies that the file has **NOT** changed since the last read that is already in your context!
Large files are truncated to a dynamic token budget. To read a large file efficiently, issue multiple parallel read calls with non-overlapping \`start_line\`/\`end_line\` ranges.

The \`preview\` parameter controls the output format:
- **\`preview: true\`** — Returns a structural outline instead of raw content.
- **\`preview: false\` (default)** — Returns the full file content, line-numbered and truncated to budget.`;

const LS_DESCRIPTION = `List files and directories in a directory path. Equals \`ls\` / \`tree\` in bash. For reading file contents, use \`read\` instead.`;
const MKDIR_DESCRIPTION = `Create a directory (and any missing parent directories).

Parameters:
- path (string, REQUIRED): Directory path to create. Must include a valid mount prefix. Parent directories are created automatically.

Behavior: No-op if the directory already exists. Throws if path points to an existing file or if the mount is read-only.`;
const WRITE_DESCRIPTION = `Write content to a file. Overrides existing file contents. Creates parent directories if needed.`;
const MULTI_EDIT_DESCRIPTION = `Make multiple find-and-replace edits to a single file in one operation. CRITICAL: Edits are applied SEQUENTIALLY - each edit sees the results of previous edits.`;
const DELETE_DESCRIPTION = `Delete a file or directory from the file system with undo capability.`;
const COPY_DESCRIPTION = `Copy or move a file or directory. Use this to rename files or directories by moving them. Throws error if source doesn't exist or if trying to copy a directory into an existing file.`;
const GLOB_DESCRIPTION = `Find files and directories BY THEIR PATH/NAME using glob patterns (like 'find' command). Use when searching for files by name or extension. NOT for searching inside file contents (use grepSearch for that).`;
const GREP_DESCRIPTION = `Fast regex search INSIDE file contents using ripgrep. Use to find code patterns, function definitions, or specific text within files. NOT for finding files by name (use glob for that).`;
const GET_FILE_SKELETON_DESCRIPTION = `Return an AST symbol outline for a source file without loading full file contents. Use this before full \`read\` on large or unfamiliar code files to save Clodex tokens.`;
const GET_SYMBOL_BODY_DESCRIPTION = `Return the exact body/range for one function, class, method, variable, or similar source symbol. Use after \`getFileSkeleton\` when you only need one implementation instead of the whole file.`;
const SEARCH_PROJECT_SYMBOLS_DESCRIPTION = `Search the local project index for classes, functions, methods, interfaces, variables, and exported symbols across mounted workspaces. Use this BEFORE attempting to modify existing code when you need to locate a function, component, class, route, variable, or API. Pass the likely symbol name or query to get precise file paths and line numbers; this avoids blind directory exploration and saves tokens. If no symbol matches, fall back to grepSearch for raw text search.`;

const MAX_SKELETON_SYMBOLS = 120;
const MAX_SYMBOL_BODY_CHARS = 24_000;

function getToolCallId(options: unknown): string {
  return (
    (options as { toolCallId?: string } | undefined)?.toolCallId ??
    `tool-call-${Date.now()}`
  );
}

function getToolLockOwnerId(options: unknown): string | undefined {
  const context = (options as { experimental_context?: unknown } | undefined)
    ?.experimental_context;
  if (!context || typeof context !== 'object') return undefined;
  const lockOwnerId = (context as { lockOwnerId?: unknown }).lockOwnerId;
  return typeof lockOwnerId === 'string' && lockOwnerId.trim()
    ? lockOwnerId
    : undefined;
}

function tempDir(deps: UniversalToolboxDeps): string {
  return path.join(deps.hostPaths.tempDir(), 'agent-temp-files');
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(absolutePath: string): Promise<boolean> {
  try {
    return (await stat(absolutePath)).isDirectory();
  } catch {
    return false;
  }
}

function stripCodeFence(content: string): string {
  let cleanContent = content;
  if (cleanContent.startsWith('```')) {
    const lines = cleanContent.split('\n');
    if (lines[0]?.trim().startsWith('```')) lines.shift();
    cleanContent = lines.join('\n');
  }
  if (cleanContent.endsWith('```')) {
    const lines = cleanContent.split('\n');
    if (lines[lines.length - 1]?.trim() === '```') lines.pop();
    cleanContent = lines.join('\n');
  }
  return cleanContent;
}

function extForPath(filePath: string): string {
  return path.extname(filePath).toLowerCase().replace(/^\./, '');
}

async function readResolvedFile(
  deps: UniversalToolboxDeps,
  resolved: ReturnType<typeof resolveToolPath>,
): Promise<Buffer> {
  if (isProtectedMountPrefix(resolved.mountPrefix)) {
    const content = await readProtectedMountedFile(
      deps.protectedFiles,
      deps.hostPaths,
      deps.agentInstanceId,
      `${resolved.mountPrefix}/${resolved.relativePath}`,
    );
    if (content) return content;
  }
  return readFile(resolved.absolutePath);
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function lineCount(content: string): number {
  return content.length === 0 ? 0 : content.split('\n').length;
}

function lineRange(
  content: string,
  startLine: number,
  endLine: number,
): string {
  return content
    .split('\n')
    .slice(startLine - 1, endLine)
    .join('\n');
}

function flattenSymbols(
  symbols: readonly SymbolInfo[],
  parent: readonly string[] = [],
): Array<{
  name: string;
  fullName: string;
  kind: string;
  line: number;
  signature?: string;
}> {
  const out: Array<{
    name: string;
    fullName: string;
    kind: string;
    line: number;
    signature?: string;
  }> = [];

  for (const symbol of symbols) {
    const pathParts = [...parent, symbol.name];
    const flattened = {
      name: symbol.name,
      fullName: pathParts.join('.'),
      kind: symbol.kind,
      line: symbol.line + 1,
    };
    out.push(
      symbol.signature
        ? { ...flattened, signature: symbol.signature }
        : flattened,
    );
    if (symbol.children) {
      out.push(...flattenSymbols(symbol.children, pathParts));
    }
  }

  return out;
}

function formatSkeletonOutline(
  symbols: ReadonlyArray<ReturnType<typeof flattenSymbols>[number]>,
): string {
  return symbols
    .map((symbol) => {
      const prefix = `${symbol.fullName} (${symbol.kind}, line ${symbol.line})`;
      return symbol.signature ? `${prefix}: ${symbol.signature}` : prefix;
    })
    .join('\n');
}

function truncateSymbolBody(body: string): string {
  if (body.length <= MAX_SYMBOL_BODY_CHARS) return body;
  return `${body.slice(0, MAX_SYMBOL_BODY_CHARS)}\n... (${body.length - MAX_SYMBOL_BODY_CHARS} more chars truncated; use read with start_line/end_line for the remaining range)`;
}

async function registerSingleEdit(
  deps: UniversalToolboxDeps,
  absolutePath: string,
  toolCallId: string,
  beforeState: Awaited<ReturnType<typeof captureFileState>>,
  afterState: Awaited<ReturnType<typeof captureFileState>>,
): Promise<WithDiff<object>['_diff']> {
  if (!deps.diffHistoryService) return null;

  try {
    const { editContent, tempFilesToCleanup } = await buildAgentFileEditContent(
      beforeState,
      afterState,
      tempDir(deps),
    );

    if (!editContent.isExternal && editContent.contentAfter !== null) {
      void deps.mutations?.onTextFileWritten?.(
        deps.agentInstanceId,
        absolutePath,
        editContent.contentAfter,
      );
    } else if (!editContent.isExternal && editContent.contentBefore !== null) {
      void deps.mutations?.onTextFileClosed?.(
        deps.agentInstanceId,
        absolutePath,
      );
    }

    await deps.diffHistoryService.registerAgentEdit({
      agentInstanceId: deps.agentInstanceId,
      path: absolutePath,
      toolCallId,
      workspaceRoot: findWorkspaceRootForPath(deps, absolutePath),
      ...editContent,
    });

    for (const tempFile of tempFilesToCleanup) void cleanupTempFile(tempFile);
  } catch (error) {
    deps.logger?.error('[UniversalToolbox] Failed to register agent edit', {
      error,
      path: absolutePath,
      toolCallId,
    });
  }

  return !beforeState.isExternal && !afterState.isExternal
    ? { before: beforeState.content, after: afterState.content }
    : null;
}

interface BatchEditItem {
  absolutePath: string;
  beforeState: Awaited<ReturnType<typeof captureFileState>>;
  afterState: Awaited<ReturnType<typeof captureFileState>>;
}

/**
 * Registers a multi-file edit batch (every entry shares `toolCallId`)
 * via `DiffHistoryService.registerAgentEditBatch`, bypassing the
 * per-toolCall fan-out cap that would otherwise truncate the tail of
 * a directory move/copy/remove and leave `undoToolCalls` unable to
 * restore the dropped files. Per-item errors (e.g. failure to build
 * edit content) are isolated so one bad path never aborts the batch.
 */
async function registerEditBatch(
  deps: UniversalToolboxDeps,
  toolCallId: string,
  items: ReadonlyArray<BatchEditItem>,
): Promise<void> {
  if (!deps.diffHistoryService || items.length === 0) return;

  const edits: AgentFileEdit[] = [];
  const tempFilesToCleanup: string[] = [];
  for (const item of items) {
    try {
      const built = await buildAgentFileEditContent(
        item.beforeState,
        item.afterState,
        tempDir(deps),
      );
      const { editContent } = built;
      tempFilesToCleanup.push(...built.tempFilesToCleanup);

      if (!editContent.isExternal && editContent.contentAfter !== null) {
        void deps.mutations?.onTextFileWritten?.(
          deps.agentInstanceId,
          item.absolutePath,
          editContent.contentAfter,
        );
      } else if (
        !editContent.isExternal &&
        editContent.contentBefore !== null
      ) {
        void deps.mutations?.onTextFileClosed?.(
          deps.agentInstanceId,
          item.absolutePath,
        );
      }

      edits.push({
        agentInstanceId: deps.agentInstanceId,
        path: item.absolutePath,
        toolCallId,
        workspaceRoot: findWorkspaceRootForPath(deps, item.absolutePath),
        ...editContent,
      });
    } catch (error) {
      deps.logger?.error(
        '[UniversalToolbox] Failed to build agent edit for batch',
        {
          error,
          path: item.absolutePath,
          toolCallId,
        },
      );
    }
  }

  try {
    await deps.diffHistoryService.registerAgentEditBatch(edits);
  } catch (error) {
    deps.logger?.error(
      '[UniversalToolbox] Failed to register agent edit batch',
      {
        error,
        toolCallId,
        batchSize: edits.length,
      },
    );
  }

  for (const tempFile of tempFilesToCleanup) void cleanupTempFile(tempFile);
}

async function mutateSinglePath<T extends object>(
  deps: UniversalToolboxDeps,
  absolutePath: string,
  toolCallId: string,
  mutate: () => Promise<T>,
): Promise<WithDiff<T>> {
  const beforeState = await captureFileState(absolutePath, tempDir(deps));
  deps.diffHistoryService?.ignoreFileForWatcher(absolutePath);
  try {
    const result = await mutate();
    const afterState = await captureFileState(absolutePath, tempDir(deps));
    const _diff = await registerSingleEdit(
      deps,
      absolutePath,
      toolCallId,
      beforeState,
      afterState,
    );
    return { ...result, _diff };
  } finally {
    setTimeout(
      () => deps.diffHistoryService?.unignoreFileForWatcher(absolutePath),
      500,
    );
  }
}

function invalidateProjectIndexPath(
  deps: UniversalToolboxDeps,
  absolutePath: string,
): void {
  (deps.projectIndexService ?? defaultProjectIndexService).invalidateFile(
    absolutePath,
    findWorkspaceRootForPath(deps, absolutePath) ?? undefined,
  );
}

async function proposeSinglePathEdit<T extends object>(
  deps: UniversalToolboxDeps,
  absolutePath: string,
  relativePath: string,
  toolCallId: string,
  lockOwnerId: string | undefined,
  beforeState: Awaited<ReturnType<typeof captureFileState>>,
  newContent: string,
  result: T,
): Promise<WithDiff<T>> {
  const _diff = !beforeState.isExternal
    ? { before: beforeState.content ?? '', after: newContent }
    : null;

  if (!deps.pendingEditService) {
    return mutateSinglePath(deps, absolutePath, toolCallId, async () => {
      await writePendingEditToDisk(absolutePath, newContent);
      invalidateProjectIndexPath(deps, absolutePath);
      return result;
    });
  }

  const decision = await deps.pendingEditService.requestApproval({
    toolCallId,
    agentInstanceId: deps.agentInstanceId,
    lockOwnerId,
    absolutePath,
    relativePath,
    oldContent: beforeState.isExternal ? null : beforeState.content,
    newContent,
    apply: async () => {
      deps.diffHistoryService?.ignoreFileForWatcher(absolutePath);
      try {
        await writePendingEditToDisk(absolutePath, newContent);
        const afterState = await captureFileState(absolutePath, tempDir(deps));
        await registerSingleEdit(
          deps,
          absolutePath,
          toolCallId,
          beforeState,
          afterState,
        );
        await deps.diffHistoryService?.acceptPendingEditsForAgentFile?.(
          deps.agentInstanceId,
          absolutePath,
        );
        invalidateProjectIndexPath(deps, absolutePath);
      } finally {
        setTimeout(
          () => deps.diffHistoryService?.unignoreFileForWatcher(absolutePath),
          500,
        );
      }
    },
  });

  return {
    ...result,
    message: decision.message,
    _diff: decision.status === 'accepted' ? _diff : null,
  };
}

async function copyDirectoryRecursive(
  src: string,
  dest: string,
): Promise<void> {
  await fsMkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDirectoryRecursive(srcPath, destPath);
    else await copyFile(srcPath, destPath);
  }
}

/**
 * Enumerate every regular file under `absolutePath`. Used by `delete` and
 * `move` to register per-file diff-history entries for structural fs
 * operations (matches origin/main behavior — without this, watcher
 * notifications surface as "external" changes and the agent's edit
 * summary loses every child of a directory delete / the source side of
 * a move).
 *
 * Returns `[absolutePath]` for single files and `[]` when the path is
 * missing entirely (the caller still proceeds; downstream ops handle the
 * missing case).
 */
async function collectAllFiles(absolutePath: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  if (await isDirectory(absolutePath)) await walk(absolutePath);
  else if (await exists(absolutePath)) out.push(absolutePath);
  return out;
}

export async function readToolExecute(
  params: readToolInput,
  deps: UniversalToolboxDeps,
) {
  if (
    params.start_line !== undefined &&
    params.end_line !== undefined &&
    params.start_line > params.end_line
  ) {
    throw new Error('end_line must be equal or larger than start_line');
  }
  if (
    params.start_page !== undefined &&
    params.end_page !== undefined &&
    params.start_page > params.end_page
  ) {
    throw new Error('end_page must be equal or larger than start_page');
  }

  try {
    const resolved = resolveToolPath(deps, params.path, 'read');
    if (!(await exists(resolved.absolutePath))) {
      throw new Error('File or directory does not exist or is not accessible');
    }
    return { message: 'File opened and loaded into context.' };
  } catch (error) {
    rethrowCappedToolOutputError(error);
  }
}

export async function getFileSkeletonToolExecute(
  params: GetFileSkeletonToolInput,
  deps: UniversalToolboxDeps,
) {
  try {
    const resolved = resolveToolPath(deps, params.path, 'read');
    if (!(await exists(resolved.absolutePath))) {
      throw new Error('File does not exist or is not accessible');
    }
    if (await isDirectory(resolved.absolutePath)) {
      throw new Error('Path is a directory. Use ls for directories.');
    }

    const ext = extForPath(resolved.absolutePath);
    if (!ext) {
      throw new Error('File has no supported source-code extension');
    }

    const content = (await readResolvedFile(deps, resolved)).toString('utf-8');
    const parsed = await getFileSymbols(content, ext);
    if (!parsed) {
      throw new Error(
        `No Tree-sitter grammar is available for ".${ext}" files`,
      );
    }

    const flattened = flattenSymbols(parsed.symbols);
    const capped = capToolOutput(flattened, { maxItems: MAX_SKELETON_SYMBOLS });
    const outline = formatSkeletonOutline(capped.result);
    const totalLines = lineCount(content);

    let message = `Read AST skeleton for ${params.path}: ${flattened.length} symbols across ${totalLines} lines`;
    if (capped.truncated) {
      message += formatTruncationMessage(
        capped.itemsRemoved,
        flattened.length,
        [
          'Use getSymbolBody for the exact symbol you need',
          'Use grepSearch to narrow by function or class name',
        ],
      );
    }

    return {
      message,
      result: {
        path: params.path,
        language: parsed.language,
        totalSymbols: flattened.length,
        symbols: capped.result,
        outline,
        truncated: capped.truncated,
        itemsRemoved: capped.itemsRemoved,
      },
    };
  } catch (error) {
    rethrowCappedToolOutputError(error);
  }
}

export async function getSymbolBodyToolExecute(
  params: GetSymbolBodyToolInput,
  deps: UniversalToolboxDeps,
) {
  try {
    const resolved = resolveToolPath(deps, params.path, 'read');
    if (!(await exists(resolved.absolutePath))) {
      throw new Error('File does not exist or is not accessible');
    }
    if (await isDirectory(resolved.absolutePath)) {
      throw new Error('Path is a directory. Use ls for directories.');
    }

    const ext = extForPath(resolved.absolutePath);
    if (!ext) {
      throw new Error('File has no supported source-code extension');
    }

    const content = (await readResolvedFile(deps, resolved)).toString('utf-8');
    const ranges = await getFileSymbolRanges(content, ext, params.symbolName);
    if (!ranges) {
      throw new Error(
        `No Tree-sitter grammar is available for ".${ext}" files`,
      );
    }
    if (ranges.length === 0) {
      throw new Error(
        `Symbol "${params.symbolName}" was not found in ${params.path}. Use getFileSkeleton first to see available symbols.`,
      );
    }

    const exact =
      ranges.find((range) => range.fullName === params.symbolName) ??
      ranges.find((range) => range.name === params.symbolName) ??
      ranges[0];
    if (!exact) {
      throw new Error(`Symbol "${params.symbolName}" was not found`);
    }

    const body = truncateSymbolBody(
      lineRange(content, exact.startLine, exact.endLine),
    );
    const additionalMatches = ranges
      .filter((range) => range !== exact)
      .slice(0, 10);

    return {
      message: `Read ${exact.kind} ${exact.fullName} from ${params.path} (lines ${exact.startLine}-${exact.endLine})`,
      result: {
        path: params.path,
        symbolName: params.symbolName,
        matchedName: exact.name,
        fullName: exact.fullName,
        kind: exact.kind,
        startLine: exact.startLine,
        endLine: exact.endLine,
        body,
        additionalMatches:
          additionalMatches.length > 0 ? additionalMatches : undefined,
      },
    };
  } catch (error) {
    rethrowCappedToolOutputError(error);
  }
}

function getSearchableProjectMounts(
  deps: UniversalToolboxDeps,
  mountPrefix?: string,
): ProjectIndexMount[] {
  const requestedPrefix = mountPrefix?.trim();
  const prefixes = requestedPrefix
    ? [requestedPrefix]
    : (deps.mountManager?.getMountPrefixes(deps.agentInstanceId) ??
      listAvailableMountPrefixes(deps));
  const mounts: ProjectIndexMount[] = [];
  const seen = new Set<string>();

  for (const prefix of prefixes) {
    if (isProtectedMountPrefix(prefix)) continue;
    let resolved: ReturnType<typeof resolveToolPath>;
    try {
      resolved = resolveToolPath(deps, `${prefix}/`, 'read');
    } catch {
      continue;
    }
    const key = `${resolved.mountPrefix}\0${resolved.mountRoot}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mounts.push({
      prefix: resolved.mountPrefix,
      absolutePath: resolved.mountRoot,
    });
  }

  return mounts;
}

export async function searchProjectSymbolsToolExecute(
  params: SearchProjectSymbolsToolInput,
  deps: UniversalToolboxDeps,
) {
  try {
    const mounts = getSearchableProjectMounts(deps, params.mount_prefix);
    if (mounts.length === 0) {
      throw new Error(
        params.mount_prefix
          ? `Mount ${params.mount_prefix} not found or not readable`
          : 'No readable workspace mounts are available',
      );
    }

    const projectIndex = deps.projectIndexService ?? defaultProjectIndexService;
    const result = await projectIndex.searchSymbols({
      query: params.query,
      mounts,
      maxResults: params.max_results,
    });

    const lines = result.matches.map((match) => {
      const exported = match.symbol.exported ? 'exported ' : '';
      const signature = match.symbol.signature
        ? `: ${match.symbol.signature}`
        : '';
      return `- [${exported}${match.symbol.kind}] ${match.symbol.fullName} in ${toPosixPath(match.path)}:${match.symbol.line}${signature}`;
    });

    let message =
      result.totalMatches === 0
        ? `No project symbols found for "${result.query}". Try grepSearch for raw text search.`
        : `Found ${result.totalMatches} project symbol matches for "${result.query}".`;
    if (lines.length > 0) message += `\n${lines.join('\n')}`;
    if (result.truncated) {
      message += formatTruncationMessage(
        result.itemsRemoved,
        result.totalMatches,
        [
          'Use a more specific symbol name or mount_prefix',
          'Use getSymbolBody with the matching path and fullName',
        ],
      );
    }

    return { message, result };
  } catch (error) {
    rethrowCappedToolOutputError(error);
  }
}

export async function lsToolExecute(
  params: LsToolInput,
  deps: UniversalToolboxDeps,
) {
  try {
    const resolved = resolveToolPath(deps, params.path, 'read');
    if (!(await exists(resolved.absolutePath))) {
      throw new Error('Directory does not exist or is not accessible');
    }
    return;
  } catch (error) {
    rethrowCappedToolOutputError(error);
  }
}

export async function mkdirToolExecute(
  params: MkdirToolInput,
  deps: UniversalToolboxDeps,
) {
  try {
    const resolved = resolveToolPath(deps, params.path, 'create');
    if (await isDirectory(resolved.absolutePath)) {
      return { message: `Directory already exists: ${params.path}` };
    }
    if (await exists(resolved.absolutePath)) {
      throw new Error(
        `A file already exists at ${params.path}. Cannot create directory.`,
      );
    }
    await fsMkdir(resolved.absolutePath, { recursive: true });
    return { message: `Created directory: ${params.path}` };
  } catch (error) {
    rethrowCappedToolOutputError(error);
  }
}

export async function writeToolExecute(
  params: WriteToolInput,
  deps: UniversalToolboxDeps,
  options?: unknown,
) {
  const resolved = resolveToolPath(deps, params.path, 'write');
  const fileExists = await exists(resolved.absolutePath);
  const cleanContent = stripCodeFence(params.content);
  const beforeState = await captureFileState(
    resolved.absolutePath,
    tempDir(deps),
  );
  if (!beforeState.isExternal && beforeState.content === cleanContent) {
    return {
      message: `No changes detected. File is identical: ${resolved.relativePath}`,
      _diff: null,
    };
  }
  const messagePrefix = deps.pendingEditService
    ? `Pending approval to ${fileExists ? 'update' : 'create'}`
    : `Successfully ${fileExists ? 'updated' : 'created'}`;
  let message = `${messagePrefix} file: ${resolved.relativePath}`;
  if (cleanContent.length > 4000) {
    message +=
      `\n\nLarge file write (${cleanContent.length} chars). ` +
      'Prefer incremental edits rather than making large changes like this again.';
  }
  return proposeSinglePathEdit(
    deps,
    resolved.absolutePath,
    resolved.relativePath,
    getToolCallId(options),
    getToolLockOwnerId(options),
    beforeState,
    cleanContent,
    { message },
  );
}

export async function multiEditToolExecute(
  params: MultiEditToolInput,
  deps: UniversalToolboxDeps,
  options?: unknown,
) {
  if (params.edits.length === 0) {
    throw new Error(
      'Missing required parameter: edits (must contain at least one edit)',
    );
  }
  const resolved = resolveToolPath(deps, params.path, 'write');
  if (!(await exists(resolved.absolutePath))) {
    throw new Error(`File does not exist: ${resolved.relativePath}`);
  }
  const beforeState = await captureFileState(
    resolved.absolutePath,
    tempDir(deps),
  );
  let content = await readFile(resolved.absolutePath, 'utf-8');
  let totalEditsApplied = 0;
  for (const edit of params.edits) {
    const { old_string, new_string, replace_all = false } = edit;
    const occurrences = content.split(old_string).length - 1;
    if (occurrences === 0) continue;
    if (replace_all) {
      content = content.split(old_string).join(new_string);
      totalEditsApplied += occurrences;
    } else {
      const index = content.indexOf(old_string);
      if (index !== -1) {
        content =
          content.substring(0, index) +
          new_string +
          content.substring(index + old_string.length);
        totalEditsApplied += 1;
      }
    }
  }
  if (totalEditsApplied === 0) {
    return {
      message: `Applied 0 edits to ${resolved.relativePath}.`,
      result: { editsApplied: totalEditsApplied },
      _diff: null,
    };
  }
  return proposeSinglePathEdit(
    deps,
    resolved.absolutePath,
    resolved.relativePath,
    getToolCallId(options),
    getToolLockOwnerId(options),
    beforeState,
    content,
    {
      message: deps.pendingEditService
        ? `Pending approval to apply ${totalEditsApplied} edits`
        : `Successfully applied ${totalEditsApplied} edits`,
      result: { editsApplied: totalEditsApplied },
    },
  );
}

export async function deleteToolExecute(
  params: DeleteToolInput,
  deps: UniversalToolboxDeps,
  options?: unknown,
) {
  const resolved = resolveToolPath(deps, params.path, 'delete');
  if (!(await exists(resolved.absolutePath)))
    throw new Error('File or directory not found');

  // Single-file delete keeps the simple `mutateSinglePath` flow (capture →
  // rm → register one edit). Directory delete needs per-child tracking
  // so each removed file shows up in the agent's edit history and the
  // watcher does not surface them as "external" deletions. Matches
  // origin/main's split between single-file and directory delete.
  const targetIsDir = await isDirectory(resolved.absolutePath);
  if (!targetIsDir) {
    return mutateSinglePath(
      deps,
      resolved.absolutePath,
      getToolCallId(options),
      async () => {
        await rm(resolved.absolutePath, { recursive: true, force: true });
        return {};
      },
    );
  }

  const childFiles = await collectAllFiles(resolved.absolutePath);
  const beforeStates = new Map<
    string,
    Awaited<ReturnType<typeof captureFileState>>
  >();
  for (const childFile of childFiles) {
    beforeStates.set(
      childFile,
      await captureFileState(childFile, tempDir(deps)),
    );
    deps.diffHistoryService?.ignoreFileForWatcher(childFile);
  }

  try {
    await rm(resolved.absolutePath, { recursive: true, force: true });
    const items: BatchEditItem[] = [];
    for (const childFile of childFiles) {
      const before = beforeStates.get(childFile);
      if (!before) continue;
      const after = await captureFileState(childFile, tempDir(deps));
      items.push({
        absolutePath: childFile,
        beforeState: before,
        afterState: after,
      });
    }
    // Directory remove can exceed the per-toolCall fan-out cap (50)
    // for any non-trivial tree; route through the batch API so undo
    // can restore every child file. Single-file deletions go through
    // `mutateSinglePath` higher up, not this path.
    await registerEditBatch(deps, getToolCallId(options), items);
    return { _diff: null };
  } finally {
    for (const childFile of childFiles) {
      setTimeout(
        () => deps.diffHistoryService?.unignoreFileForWatcher(childFile),
        500,
      );
    }
  }
}

export async function copyToolExecute(
  params: CopyToolInput,
  deps: UniversalToolboxDeps,
  options?: unknown,
) {
  const src = resolveToolPath(
    deps,
    params.input_path,
    params.move ? 'delete' : 'read',
  );
  const dest = resolveToolPath(deps, params.output_path, 'create');
  const srcExists = await exists(src.absolutePath);
  const srcIsDir = await isDirectory(src.absolutePath);
  if (!srcExists && !srcIsDir)
    throw new Error(`Source not found: ${params.input_path}`);

  const destIsDir = await isDirectory(dest.absolutePath);
  let finalDest = dest.absolutePath;
  if (!srcIsDir && destIsDir)
    finalDest = path.join(dest.absolutePath, path.basename(src.absolutePath));

  // Diff-history needs per-file tracking on BOTH sides of a copy/move so
  // every created file shows up in the agent's edit summary and so undo
  // can replay the full delta. Origin/main enumerated children for
  // directory ops; the universal-tools port collapsed everything to a
  // single path which (a) crashed with EISDIR on directory dest paths
  // and (b) made dir-move undo asymmetric (src restored, dest left in
  // place — duplicating the tree). Mirror main: collect src children
  // up-front, derive dest equivalents by re-rooting under
  // `dest.absolutePath`, then track each pair through the existing
  // `registerSingleEdit` helper.
  const toolCallId = getToolCallId(options);
  const srcFiles = srcIsDir
    ? await collectAllFiles(src.absolutePath)
    : [src.absolutePath];
  const destFiles = srcIsDir
    ? srcFiles.map((srcFile) => {
        const rel = path.relative(src.absolutePath, srcFile);
        return path.join(dest.absolutePath, rel);
      })
    : [finalDest];

  const destBeforeStates = new Map<
    string,
    Awaited<ReturnType<typeof captureFileState>>
  >();
  for (const destFile of destFiles) {
    destBeforeStates.set(
      destFile,
      await captureFileState(destFile, tempDir(deps)),
    );
    deps.diffHistoryService?.ignoreFileForWatcher(destFile);
  }

  // Source-side tracking is only meaningful for moves — copies leave
  // the source intact, so registering it as a deletion would be wrong.
  const srcBeforeStates = new Map<
    string,
    Awaited<ReturnType<typeof captureFileState>>
  >();
  if (params.move) {
    for (const srcFile of srcFiles) {
      srcBeforeStates.set(
        srcFile,
        await captureFileState(srcFile, tempDir(deps)),
      );
      deps.diffHistoryService?.ignoreFileForWatcher(srcFile);
    }
  }

  try {
    if (srcIsDir) {
      if ((await exists(dest.absolutePath)) && !destIsDir) {
        throw new Error(
          `Cannot copy directory into existing file: ${params.output_path}`,
        );
      }
      await copyDirectoryRecursive(src.absolutePath, dest.absolutePath);
      if (params.move)
        await rm(src.absolutePath, { recursive: true, force: true });
    } else {
      await fsMkdir(path.dirname(finalDest), { recursive: true });
      if (params.move) {
        try {
          await rename(src.absolutePath, finalDest);
        } catch {
          await copyFile(src.absolutePath, finalDest);
          await unlink(src.absolutePath);
        }
      } else {
        await copyFile(src.absolutePath, finalDest);
      }
    }

    let firstDestDiff: WithDiff<object>['_diff'] = null;
    if (srcIsDir) {
      // Directory ops can fan out beyond the per-toolCall cap of
      // `registerAgentEdit` (50 entries); a 30-file move with the
      // iterative path silently drops the last 10 source deletions
      // and leaves undo unable to restore them. Route through the
      // batch API so the full dest + src delta is tracked atomically.
      // For directory ops there are multiple deltas; surfacing only
      // the first would be misleading, so leave `_diff` null and
      // rely on the registered diff-history entries.
      const batchItems: BatchEditItem[] = [];
      for (const destFile of destFiles) {
        const before = destBeforeStates.get(destFile);
        if (!before) continue;
        const after = await captureFileState(destFile, tempDir(deps));
        batchItems.push({
          absolutePath: destFile,
          beforeState: before,
          afterState: after,
        });
      }
      if (params.move) {
        for (const srcFile of srcFiles) {
          const srcBefore = srcBeforeStates.get(srcFile);
          if (!srcBefore) continue;
          const srcAfter = await captureFileState(srcFile, tempDir(deps));
          batchItems.push({
            absolutePath: srcFile,
            beforeState: srcBefore,
            afterState: srcAfter,
          });
        }
      }
      await registerEditBatch(deps, toolCallId, batchItems);
    } else {
      // Single-file copy/move: keep the iterative path so the returned
      // `_diff` reflects the only delta the caller cares about.
      for (const destFile of destFiles) {
        const before = destBeforeStates.get(destFile);
        if (!before) continue;
        const after = await captureFileState(destFile, tempDir(deps));
        firstDestDiff = await registerSingleEdit(
          deps,
          destFile,
          toolCallId,
          before,
          after,
        );
      }
      if (params.move) {
        for (const srcFile of srcFiles) {
          const srcBefore = srcBeforeStates.get(srcFile);
          if (!srcBefore) continue;
          const srcAfter = await captureFileState(srcFile, tempDir(deps));
          await registerSingleEdit(
            deps,
            srcFile,
            toolCallId,
            srcBefore,
            srcAfter,
          );
        }
      }
    }

    const action = params.move ? 'Moved' : 'Copied';
    return {
      message: `${action} ${srcIsDir ? 'directory' : 'file'}: ${params.input_path} → ${params.output_path}`,
      _diff: firstDestDiff,
    };
  } catch (error) {
    rethrowCappedToolOutputError(error);
  } finally {
    for (const destFile of destFiles) {
      setTimeout(
        () => deps.diffHistoryService?.unignoreFileForWatcher(destFile),
        500,
      );
    }
    if (params.move) {
      for (const srcFile of srcFiles) {
        setTimeout(
          () => deps.diffHistoryService?.unignoreFileForWatcher(srcFile),
          500,
        );
      }
    }
  }
}

/**
 * glob/grep delegate the actual FS walk to `@clodex/agent-runtime-node`'s
 * `ClientRuntimeNode`, which dispatches ripgrep-first and falls back to a
 * minimatch + `ignore` + iterative walk implementation when the rg binary is
 * absent. Host-supplied `rgBinaryBasePath` controls the rg location; an empty
 * value cleanly opts into the JS fallback.
 *
 * Cache keyed by absolute mount root so multiple agents sharing a workspace
 * reuse the same runtime (and its memoized gitignore tree). Created lazily
 * the first time a tool call touches a given mount.
 */
function makeRuntimeCache(rgBinaryBasePath: string | undefined): {
  get: (mountRoot: string) => ClientRuntimeNode;
} {
  const cache = new Map<string, ClientRuntimeNode>();
  return {
    get(mountRoot: string) {
      const cached = cache.get(mountRoot);
      if (cached) return cached;
      const runtime = new ClientRuntimeNode({
        workingDirectory: mountRoot,
        rgBinaryBasePath: rgBinaryBasePath ?? '',
      });
      cache.set(mountRoot, runtime);
      return runtime;
    },
  };
}

export async function globToolExecute(
  params: GlobToolInput,
  deps: UniversalToolboxDeps,
  runtimeCache?: { get: (mountRoot: string) => ClientRuntimeNode },
) {
  const resolved = resolveToolPath(deps, `${params.mount_prefix}/`, 'read');
  if (isProtectedMountPrefix(resolved.mountPrefix)) {
    const relativePaths = (await walkProtectedMount(resolved.mountRoot)).filter(
      (entry) => globMatches(params.pattern, entry),
    );
    const totalMatches = relativePaths.length;
    const cappedPaths = capToolOutput(relativePaths, { maxItems: 50 });
    return {
      message: `Found ${totalMatches} matches for pattern "${params.pattern}" in protected mount "${resolved.mountPrefix}"`,
      result: {
        totalMatches,
        relativePaths: cappedPaths.result,
        truncated: cappedPaths.truncated,
        itemsRemoved: cappedPaths.itemsRemoved,
      },
    };
  }
  const cache = runtimeCache ?? makeRuntimeCache(deps.rgBinaryBasePath);
  const runtime = cache.get(resolved.mountRoot);
  const r = await runtime.fileSystem.glob(params.pattern, {
    respectGitignore: !params.include_gitignored,
    maxResults: 50,
  });
  if (!r.success) {
    throw new Error(r.error ?? r.message);
  }

  const relativePaths = r.relativePaths ?? [];
  const totalMatches = r.totalMatches ?? relativePaths.length;
  const cappedPaths = capToolOutput(relativePaths, { maxItems: 50 });
  let message = `Found ${totalMatches} matches for pattern "${params.pattern}" in "${resolved.mountRoot}"`;
  if (cappedPaths.truncated) {
    message += formatTruncationMessage(cappedPaths.itemsRemoved, totalMatches, [
      'Use a more specific glob pattern (e.g., "src/**/*.ts" instead of "**/*.ts")',
      'Break down your search into multiple smaller queries',
    ]);
  }
  return {
    message,
    result: {
      totalMatches,
      relativePaths: cappedPaths.result,
      truncated: cappedPaths.truncated,
      itemsRemoved: cappedPaths.itemsRemoved,
    },
  };
}

export async function grepSearchToolExecute(
  params: GrepSearchToolInput,
  deps: UniversalToolboxDeps,
  runtimeCache?: { get: (mountRoot: string) => ClientRuntimeNode },
) {
  const resolved = resolveToolPath(deps, `${params.mount_prefix}/`, 'read');
  if (isProtectedMountPrefix(resolved.mountPrefix)) {
    return grepProtectedMount(params, deps, resolved);
  }
  const cache = runtimeCache ?? makeRuntimeCache(deps.rgBinaryBasePath);
  const runtime = cache.get(resolved.mountRoot);
  const maxMatches = Math.min(params.max_matches ?? 15, 50);

  const r = await runtime.fileSystem.grep(params.query, {
    recursive: true,
    caseSensitive: params.case_sensitive,
    filePattern: params.include_file_pattern,
    excludePatterns: params.exclude_file_pattern
      ? [params.exclude_file_pattern]
      : undefined,
    respectGitignore: !params.include_gitignored,
    maxMatches,
  });
  if (!r.success) {
    throw new Error(r.error ?? r.message);
  }

  const rawMatches = r.matches ?? [];
  const matches = rawMatches.map((m) => ({
    // Normalize to POSIX separators so results are stable across OSes
    // (the runtime returns native separators on Windows, e.g. `src\a.ts`)
    // and consistent with glob's already-normalized `relativePaths`.
    path: m.relativePath.replace(/\\/g, '/'),
    line: m.line,
    preview: truncatePreview(m.preview ?? m.match ?? '', 500),
  }));
  const filesSearched = r.filesSearched ?? 0;
  const totalMatches = r.totalMatches ?? matches.length;

  const cappedMatches = capToolOutput(matches, { maxItems: maxMatches });
  const matchCountTruncated = totalMatches >= maxMatches;
  const wasTruncated = matchCountTruncated || cappedMatches.truncated;
  let message = matchCountTruncated
    ? `Found ${maxMatches}+ matches (showing first ${maxMatches})`
    : `Found ${totalMatches} matches`;
  message += ` in ${filesSearched} files`;
  if (params.include_file_pattern)
    message += ` (included: ${params.include_file_pattern})`;
  if (params.exclude_file_pattern)
    message += ` (excluded: ${params.exclude_file_pattern})`;
  if (wasTruncated && cappedMatches.itemsRemoved) {
    message += formatTruncationMessage(
      cappedMatches.itemsRemoved,
      totalMatches,
      [
        'Use include_file_pattern to search specific file types (e.g., "*.ts")',
        'Use exclude_file_pattern to skip irrelevant directories (e.g., "metadata/**")',
        'Use a more specific regex pattern',
      ],
    );
  }
  return {
    message,
    result: {
      totalMatches,
      filesSearched,
      matches: cappedMatches.result,
      truncated: wasTruncated,
      itemsRemoved: cappedMatches.itemsRemoved,
    },
  };
}

async function walkProtectedMount(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string, relativeDir: string): Promise<void> => {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.endsWith('.segments')) continue;
      const relative = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  await walk(root, '');
  return files.sort();
}

function globMatches(pattern: string, candidate: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]')
    .replaceAll('\0', '.*');
  return new RegExp(`^${escaped}$`).test(candidate);
}

async function grepProtectedMount(
  params: GrepSearchToolInput,
  deps: UniversalToolboxDeps,
  resolved: ReturnType<typeof resolveToolPath>,
) {
  const maxMatches = Math.min(params.max_matches ?? 15, 50);
  const candidates = (await walkProtectedMount(resolved.mountRoot)).filter(
    (candidate) =>
      (!params.include_file_pattern ||
        globMatches(params.include_file_pattern, candidate)) &&
      (!params.exclude_file_pattern ||
        !globMatches(params.exclude_file_pattern, candidate)),
  );
  let expression: RegExp;
  try {
    expression = new RegExp(params.query, params.case_sensitive ? 'g' : 'gi');
  } catch {
    expression = new RegExp(
      params.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      params.case_sensitive ? 'g' : 'gi',
    );
  }

  const matches: Array<{ path: string; line: number; preview: string }> = [];
  let totalMatches = 0;
  let filesSearched = 0;
  for (const candidate of candidates) {
    const content = await readProtectedMountedFile(
      deps.protectedFiles,
      deps.hostPaths,
      deps.agentInstanceId,
      `${resolved.mountPrefix}/${candidate}`,
    );
    if (!content) continue;
    filesSearched++;
    const lines = content.toString('utf-8').split('\n');
    for (let index = 0; index < lines.length; index++) {
      expression.lastIndex = 0;
      if (!expression.test(lines[index] ?? '')) continue;
      totalMatches++;
      if (matches.length < maxMatches) {
        matches.push({
          path: candidate,
          line: index + 1,
          preview: truncatePreview(lines[index] ?? '', 500),
        });
      }
    }
  }
  const truncated = totalMatches > matches.length;
  return {
    message: truncated
      ? `Found ${totalMatches} matches in ${filesSearched} protected files (showing first ${matches.length})`
      : `Found ${totalMatches} matches in ${filesSearched} protected files`,
    result: {
      totalMatches,
      filesSearched,
      matches,
      truncated,
      itemsRemoved: totalMatches - matches.length,
    },
  };
}

export function makeUniversalTools(
  deps: UniversalToolboxDeps,
): Partial<ClodexToolSet<UniversalToolSchemas>> {
  const runtimeCache = makeRuntimeCache(deps.rgBinaryBasePath);
  return {
    read: tool({
      description: READ_DESCRIPTION,
      inputSchema: readToolInputSchema,
      outputSchema: readToolOutputSchema,
      strict: false,
      execute: (args) => readToolExecute(args, deps),
    }),
    getFileSkeleton: tool({
      description: GET_FILE_SKELETON_DESCRIPTION,
      inputSchema: getFileSkeletonToolInputSchema,
      outputSchema: getFileSkeletonToolOutputSchema,
      strict: false,
      execute: (args) => getFileSkeletonToolExecute(args, deps),
    }),
    getSymbolBody: tool({
      description: GET_SYMBOL_BODY_DESCRIPTION,
      inputSchema: getSymbolBodyToolInputSchema,
      outputSchema: getSymbolBodyToolOutputSchema,
      strict: false,
      execute: (args) => getSymbolBodyToolExecute(args, deps),
    }),
    searchProjectSymbols: tool({
      description: SEARCH_PROJECT_SYMBOLS_DESCRIPTION,
      inputSchema: searchProjectSymbolsToolInputSchema,
      outputSchema: searchProjectSymbolsToolOutputSchema,
      strict: false,
      execute: (args) => searchProjectSymbolsToolExecute(args, deps),
    }),
    ls: tool({
      description: LS_DESCRIPTION,
      inputSchema: lsToolInputSchema,
      outputSchema: lsToolSchema.outputSchema,
      strict: false,
      execute: (args) => lsToolExecute(args, deps),
    }),
    mkdir: tool({
      description: MKDIR_DESCRIPTION,
      inputSchema: mkdirToolInputSchema,
      outputSchema: mkdirToolOutputSchema,
      strict: false,
      execute: (args) => mkdirToolExecute(args, deps),
    }),
    write: tool({
      description: WRITE_DESCRIPTION,
      inputSchema: writeToolInputSchema,
      outputSchema: writeToolOutputSchema,
      strict: false,
      execute: (args, options) => writeToolExecute(args, deps, options),
    }),
    multiEdit: tool({
      description: MULTI_EDIT_DESCRIPTION,
      inputSchema: multiEditToolInputSchema,
      outputSchema: multiEditToolOutputSchema,
      strict: false,
      execute: (args, options) => multiEditToolExecute(args, deps, options),
    }),
    delete: tool({
      description: DELETE_DESCRIPTION,
      inputSchema: deleteToolInputSchema,
      outputSchema: deleteToolOutputSchema,
      strict: false,
      execute: (args, options) => deleteToolExecute(args, deps, options),
    }),
    copy: tool({
      description: COPY_DESCRIPTION,
      inputSchema: copyToolInputSchema,
      outputSchema: copyToolOutputSchema,
      strict: false,
      execute: (args, options) => copyToolExecute(args, deps, options),
    }),
    glob: tool({
      description: GLOB_DESCRIPTION,
      inputSchema: globToolInputSchema,
      outputSchema: globToolOutputSchema,
      strict: false,
      execute: (args) => globToolExecute(args, deps, runtimeCache),
    }),
    grepSearch: tool({
      description: GREP_DESCRIPTION,
      inputSchema: grepSearchToolInputSchema,
      outputSchema: grepSearchToolOutputSchema,
      strict: false,
      execute: (args) => grepSearchToolExecute(args, deps, runtimeCache),
    }),
  };
}
