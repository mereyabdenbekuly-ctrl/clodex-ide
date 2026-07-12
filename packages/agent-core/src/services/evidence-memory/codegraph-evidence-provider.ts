import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile, realpath } from '../../fs';
import type {
  EvidenceMemoryCodeEvidenceProvider,
  EvidenceMemoryCodeContextSnippet,
  EvidenceMemoryCodeGraphNeighbor,
  EvidenceMemoryEntity,
  EvidenceMemoryResolvedCodeEvidence,
} from './index';

interface CodeGraphNode {
  id: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

interface CodeGraphQueryResult {
  node: CodeGraphNode;
  score: number;
}

interface CodeGraphRelatedNode {
  name: string;
  filePath: string;
  startLine: number;
  endLine?: number;
}

export interface CodeGraphCliEvidenceProviderOptions {
  workspaceRoot: string;
  codegraphBinary?: string;
  syncBeforeResolve?: boolean;
  commandTimeoutMs?: number;
  maxGraphNeighbors?: number;
  getRepositoryRevision?: () => Promise<string | null>;
  runCommand?: (input: {
    executable: string;
    args: readonly string[];
    cwd: string;
    signal?: AbortSignal;
  }) => Promise<string>;
}

/**
 * Resolves file and symbol entities against the local workspace and CodeGraph.
 *
 * CodeGraph is used only for symbol identity and caller/callee expansion. The
 * authoritative fingerprints are always computed from current file bytes, so
 * a stale graph index cannot make changed source appear current.
 */
export class CodeGraphCliEvidenceProvider
  implements EvidenceMemoryCodeEvidenceProvider
{
  private readonly workspaceRoot: string;
  private readonly codegraphBinary: string;
  private readonly syncBeforeResolve: boolean;
  private readonly commandTimeoutMs: number;
  private readonly maxGraphNeighbors: number;
  private readonly getRepositoryRevision: () => Promise<string | null>;
  private readonly runCommand:
    | CodeGraphCliEvidenceProviderOptions['runCommand']
    | undefined;
  private lastSyncAt = 0;

  public constructor(options: CodeGraphCliEvidenceProviderOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.codegraphBinary = options.codegraphBinary ?? 'codegraph';
    this.syncBeforeResolve = options.syncBeforeResolve ?? true;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
    this.maxGraphNeighbors = Math.min(
      Math.max(options.maxGraphNeighbors ?? 40, 1),
      100,
    );
    this.getRepositoryRevision =
      options.getRepositoryRevision ?? (() => this.readGitRevision());
    this.runCommand = options.runCommand;
  }

  public async resolve(input: {
    taskId: string;
    workspaceId: string | null;
    entity: EvidenceMemoryEntity;
    signal?: AbortSignal;
  }): Promise<EvidenceMemoryResolvedCodeEvidence | null> {
    throwIfAborted(input.signal);
    if (input.entity.type === 'file') {
      return this.resolveFile(input.entity, input.signal);
    }
    if (input.entity.type !== 'symbol') return null;
    await this.syncCodeGraph(input.signal);
    return this.resolveSymbol(input.entity, input.signal);
  }

  public async expandContext(input: {
    taskId: string;
    workspaceId: string | null;
    query: string;
    entities: readonly EvidenceMemoryEntity[];
    maxSnippets: number;
    maxCharsPerSnippet: number;
    signal?: AbortSignal;
  }): Promise<readonly EvidenceMemoryCodeContextSnippet[]> {
    throwIfAborted(input.signal);
    const maxSnippets = Math.min(Math.max(input.maxSnippets, 0), 24);
    const maxCharsPerSnippet = Math.min(
      Math.max(input.maxCharsPerSnippet, 256),
      12_000,
    );
    if (maxSnippets === 0) return [];
    const revision = await this.getRepositoryRevision();
    throwIfAborted(input.signal);
    const snippets: EvidenceMemoryCodeContextSnippet[] = [];
    for (const entity of input.entities) {
      if (snippets.length >= maxSnippets) break;
      if (entity.type === 'file') {
        const snippet = await this.expandFileEntity(
          entity,
          input.query,
          maxCharsPerSnippet,
          revision,
          input.signal,
        );
        if (snippet) snippets.push(snippet);
        continue;
      }
      if (entity.type !== 'symbol') continue;
      await this.syncCodeGraph(input.signal);
      snippets.push(
        ...(await this.expandSymbolEntity(
          entity,
          maxSnippets - snippets.length,
          maxCharsPerSnippet,
          revision,
          input.signal,
        )),
      );
    }
    return deduplicateSnippets(snippets).slice(0, maxSnippets);
  }

  private async resolveFile(
    entity: EvidenceMemoryEntity,
    signal?: AbortSignal,
  ): Promise<EvidenceMemoryResolvedCodeEvidence | null> {
    throwIfAborted(signal);
    const filePath = await this.resolveSafeFilePath(entity.value);
    if (!filePath) return null;
    const content = await readFile(filePath);
    throwIfAborted(signal);
    return {
      entity,
      filePath: toWorkspacePath(await this.realWorkspaceRoot(), filePath),
      contentHash: sha256(content),
      repositoryRevision: await this.getRepositoryRevision(),
      graphContext: [],
    };
  }

  private async expandFileEntity(
    entity: EvidenceMemoryEntity,
    query: string,
    maxChars: number,
    repositoryRevision: string | null,
    signal?: AbortSignal,
  ): Promise<EvidenceMemoryCodeContextSnippet | null> {
    throwIfAborted(signal);
    const absolutePath = await this.resolveSafeFilePath(entity.value);
    if (!absolutePath) return null;
    const content = await readFile(absolutePath);
    throwIfAborted(signal);
    const excerpt = selectRelevantExcerpt(
      content.toString('utf-8'),
      query,
      maxChars,
    );
    return {
      source: 'entity',
      entity,
      filePath: toWorkspacePath(await this.realWorkspaceRoot(), absolutePath),
      symbolName: null,
      codeGraphNodeId: null,
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
      content: excerpt.content,
      contentHash: sha256(Buffer.from(excerpt.content, 'utf-8')),
      repositoryRevision,
    };
  }

  private async resolveSymbol(
    entity: EvidenceMemoryEntity,
    signal?: AbortSignal,
  ): Promise<EvidenceMemoryResolvedCodeEvidence | null> {
    const reference = parseSymbolReference(entity.value);
    const results = await this.runJson<CodeGraphQueryResult[]>(
      ['query', '-p', this.workspaceRoot, '-j', '-l', '30', reference.symbol],
      signal,
    );
    const match = selectSymbol(results, reference);
    if (!match) return null;
    const absolutePath = await this.resolveSafeFilePath(match.node.filePath);
    if (!absolutePath) return null;
    const content = await readFile(absolutePath);
    throwIfAborted(signal);
    const lines = content.toString('utf-8').split('\n');
    const startLine = Math.max(1, match.node.startLine);
    const endLine = Math.max(startLine, match.node.endLine);
    const symbolSource = lines
      .slice(startLine - 1, Math.min(endLine, lines.length))
      .join('\n');
    const graphContext = await this.expandGraph(match.node, signal);
    return {
      entity,
      filePath: toWorkspacePath(await this.realWorkspaceRoot(), absolutePath),
      symbolName: match.node.qualifiedName || match.node.name,
      codeGraphNodeId: match.node.id,
      contentHash: sha256(content),
      symbolHash: sha256(Buffer.from(symbolSource, 'utf-8')),
      repositoryRevision: await this.getRepositoryRevision(),
      graphContext,
    };
  }

  private async expandSymbolEntity(
    entity: EvidenceMemoryEntity,
    maxSnippets: number,
    maxChars: number,
    repositoryRevision: string | null,
    signal?: AbortSignal,
  ): Promise<EvidenceMemoryCodeContextSnippet[]> {
    const reference = parseSymbolReference(entity.value);
    const results = await this.runJson<CodeGraphQueryResult[]>(
      ['query', '-p', this.workspaceRoot, '-j', '-l', '30', reference.symbol],
      signal,
    );
    const match = selectSymbol(results, reference);
    if (!match) return [];
    const primary = await this.readNodeSnippet({
      entity,
      source: 'entity',
      node: match.node,
      maxChars,
      repositoryRevision,
      signal,
    });
    if (!primary) return [];
    const snippets = [primary];
    if (maxSnippets <= 1) return snippets;
    const neighbors = await this.expandGraph(match.node, signal);
    for (const neighbor of neighbors) {
      if (snippets.length >= maxSnippets) break;
      const snippet = await this.readNodeSnippet({
        entity,
        source: neighbor.direction,
        node: {
          id: neighbor.nodeId,
          name: neighbor.name,
          qualifiedName: neighbor.name,
          filePath: neighbor.filePath,
          startLine: neighbor.startLine,
          endLine: neighbor.endLine,
        },
        maxChars,
        repositoryRevision,
        useLineWindow: true,
        signal,
      });
      if (snippet) snippets.push(snippet);
    }
    return snippets;
  }

  private async readNodeSnippet(input: {
    entity: EvidenceMemoryEntity;
    source: 'entity' | 'caller' | 'callee';
    node: CodeGraphNode;
    maxChars: number;
    repositoryRevision: string | null;
    useLineWindow?: boolean;
    signal?: AbortSignal;
  }): Promise<EvidenceMemoryCodeContextSnippet | null> {
    throwIfAborted(input.signal);
    const absolutePath = await this.resolveSafeFilePath(input.node.filePath);
    if (!absolutePath) return null;
    const content = await readFile(absolutePath);
    throwIfAborted(input.signal);
    const lines = content.toString('utf-8').split('\n');
    const requestedStart = Math.max(1, input.node.startLine);
    const requestedEnd = Math.max(requestedStart, input.node.endLine);
    const startLine = input.useLineWindow
      ? Math.max(1, requestedStart - 6)
      : requestedStart;
    const endLine = input.useLineWindow
      ? Math.min(lines.length, requestedEnd + 10)
      : Math.min(lines.length, requestedEnd);
    const excerpt = clampLineExcerpt(lines, startLine, endLine, input.maxChars);
    return {
      source: input.source,
      entity: input.entity,
      filePath: toWorkspacePath(await this.realWorkspaceRoot(), absolutePath),
      symbolName: input.node.qualifiedName || input.node.name,
      codeGraphNodeId: input.node.id,
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
      content: excerpt.content,
      contentHash: sha256(Buffer.from(excerpt.content, 'utf-8')),
      repositoryRevision: input.repositoryRevision,
    };
  }

  private async expandGraph(
    node: CodeGraphNode,
    signal?: AbortSignal,
  ): Promise<EvidenceMemoryCodeGraphNeighbor[]> {
    const limit = Math.ceil(this.maxGraphNeighbors / 2);
    const symbol = node.qualifiedName || node.name;
    const [callers, callees] = await Promise.all([
      this.runJson<{ callers?: CodeGraphRelatedNode[] }>(
        [
          'callers',
          '-p',
          this.workspaceRoot,
          '-j',
          '-l',
          String(limit),
          symbol,
        ],
        signal,
      ).catch((error) => {
        if (signal?.aborted) throw error;
        return { callers: [] };
      }),
      this.runJson<{ callees?: CodeGraphRelatedNode[] }>(
        [
          'callees',
          '-p',
          this.workspaceRoot,
          '-j',
          '-l',
          String(limit),
          symbol,
        ],
        signal,
      ).catch((error) => {
        if (signal?.aborted) throw error;
        return { callees: [] };
      }),
    ]);
    return [
      ...toGraphNeighbors('caller', callers.callers ?? []),
      ...toGraphNeighbors('callee', callees.callees ?? []),
    ].slice(0, this.maxGraphNeighbors);
  }

  private async syncCodeGraph(signal?: AbortSignal): Promise<void> {
    if (!this.syncBeforeResolve || Date.now() - this.lastSyncAt < 5_000) return;
    await this.run(['sync', this.workspaceRoot, '-q'], { signal });
    this.lastSyncAt = Date.now();
  }

  private async resolveSafeFilePath(value: string): Promise<string | null> {
    const realRoot = await this.realWorkspaceRoot();
    const candidate = path.isAbsolute(value)
      ? path.resolve(value)
      : path.resolve(this.workspaceRoot, value.replace(/^\.\//, ''));
    try {
      const resolved = await realpath(candidate);
      return isInsideRoot(resolved, realRoot) ? resolved : null;
    } catch {
      return null;
    }
  }

  private async realWorkspaceRoot(): Promise<string> {
    try {
      return await realpath(this.workspaceRoot);
    } catch {
      return this.workspaceRoot;
    }
  }

  private async readGitRevision(): Promise<string | null> {
    try {
      return (
        await this.run(['git', 'rev-parse', 'HEAD'], {
          executable: 'git',
          omitLeadingBinary: true,
        })
      ).trim();
    } catch {
      return null;
    }
  }

  private async runJson<T>(args: string[], signal?: AbortSignal): Promise<T> {
    return JSON.parse(await this.run(args, { signal })) as T;
  }

  private async run(
    args: string[],
    options: {
      executable?: string;
      omitLeadingBinary?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<string> {
    throwIfAborted(options.signal);
    const executable = options.executable ?? this.codegraphBinary;
    const commandArgs = options.omitLeadingBinary ? args.slice(1) : args;
    if (this.runCommand) {
      return this.runCommand({
        executable,
        args: commandArgs,
        cwd: this.workspaceRoot,
        signal: options.signal,
      });
    }
    return new Promise<string>((resolve, reject) => {
      execFile(
        executable,
        commandArgs,
        {
          cwd: this.workspaceRoot,
          encoding: 'utf-8',
          maxBuffer: 4 * 1024 * 1024,
          timeout: this.commandTimeoutMs,
          signal: options.signal,
        },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
  }
}

function parseSymbolReference(value: string): {
  filePath: string | null;
  symbol: string;
} {
  const separator = value.lastIndexOf('#');
  if (separator <= 0 || separator === value.length - 1) {
    return { filePath: null, symbol: value };
  }
  return {
    filePath: value.slice(0, separator),
    symbol: value.slice(separator + 1),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function selectSymbol(
  results: readonly CodeGraphQueryResult[],
  reference: { filePath: string | null; symbol: string },
): CodeGraphQueryResult | null {
  const normalizedFile = reference.filePath?.replaceAll('\\', '/');
  const candidates = results.filter((result) => {
    if (!normalizedFile) return true;
    return result.node.filePath.replaceAll('\\', '/') === normalizedFile;
  });
  return (
    candidates.find(
      (result) =>
        result.node.qualifiedName === reference.symbol ||
        result.node.name === reference.symbol,
    ) ??
    candidates[0] ??
    null
  );
}

function toGraphNeighbors(
  direction: 'caller' | 'callee',
  nodes: readonly CodeGraphRelatedNode[],
): EvidenceMemoryCodeGraphNeighbor[] {
  return nodes.map((node) => ({
    direction,
    nodeId: sha256(
      Buffer.from(
        `codegraph:${direction}:${node.filePath}:${node.startLine}:${node.name}`,
        'utf-8',
      ),
    ),
    name: node.name,
    filePath: node.filePath,
    startLine: Math.max(1, node.startLine),
    endLine: Math.max(node.startLine, node.endLine ?? node.startLine),
  }));
}

function selectRelevantExcerpt(
  content: string,
  query: string,
  maxChars: number,
): { startLine: number; endLine: number; content: string } {
  const lines = content.split('\n');
  const terms = [
    ...new Set(
      query
        .normalize('NFKC')
        .toLowerCase()
        .match(/[\p{L}\p{N}_./:@-]{3,}/gu) ?? [],
    ),
  ].slice(0, 32);
  let bestLine = 1;
  let bestScore = 0;
  for (const [index, line] of lines.entries()) {
    const normalized = line.toLowerCase();
    const score = terms.reduce(
      (sum, term) => sum + (normalized.includes(term) ? 1 : 0),
      0,
    );
    if (score > bestScore) {
      bestScore = score;
      bestLine = index + 1;
    }
  }
  const startLine = Math.max(1, bestLine - 10);
  const endLine = Math.min(lines.length, bestLine + 18);
  return clampLineExcerpt(lines, startLine, endLine, maxChars);
}

function clampLineExcerpt(
  lines: readonly string[],
  requestedStartLine: number,
  requestedEndLine: number,
  maxChars: number,
): { startLine: number; endLine: number; content: string } {
  const startLine = Math.max(1, requestedStartLine);
  const boundedEnd = Math.max(
    startLine,
    Math.min(lines.length, requestedEndLine),
  );
  const selected: string[] = [];
  let chars = 0;
  let endLine = startLine;
  for (let lineNumber = startLine; lineNumber <= boundedEnd; lineNumber += 1) {
    const line = lines[lineNumber - 1] ?? '';
    const nextChars = line.length + (selected.length > 0 ? 1 : 0);
    if (selected.length > 0 && chars + nextChars > maxChars) break;
    const remaining = Math.max(0, maxChars - chars);
    selected.push(line.slice(0, remaining));
    chars += Math.min(nextChars, remaining);
    endLine = lineNumber;
    if (chars >= maxChars) break;
  }
  return {
    startLine,
    endLine,
    content: selected.join('\n'),
  };
}

function deduplicateSnippets(
  snippets: readonly EvidenceMemoryCodeContextSnippet[],
): EvidenceMemoryCodeContextSnippet[] {
  const seen = new Set<string>();
  return snippets.filter((snippet) => {
    const key = `${snippet.filePath}\0${snippet.startLine}\0${snippet.endLine}\0${snippet.contentHash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function toWorkspacePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).replaceAll('\\', '/');
}
