import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  copyToolExecute,
  deleteToolExecute,
  getFileSkeletonToolExecute,
  getSymbolBodyToolExecute,
  globToolExecute,
  grepSearchToolExecute,
  mkdirToolExecute,
  multiEditToolExecute,
  readToolExecute,
  searchProjectSymbolsToolExecute,
  writeToolExecute,
} from './universal-tools';
import type { UniversalToolboxDeps } from './types';
import {
  AeadDataProtection,
  ProtectedAppendFileStorage,
  ProtectedFileStorage,
  protectedFileContext,
  type HostPaths,
} from '../../host';
import { ProjectIndexService } from '../project-index';
import { AgentStore } from '../../store';
import {
  POST_EDIT_VERIFICATION_NUDGE,
  PendingEditService,
} from '../pending-edits';

function makeHostPaths(root: string): HostPaths {
  return {
    dataDir: () => path.join(root, 'data'),
    tempDir: () => path.join(root, 'tmp'),
    agentsDir: () => path.join(root, 'agents'),
    agentDir: (agentId) => path.join(root, 'agents', agentId),
    agentAttachmentsDir: (agentId) =>
      path.join(root, 'agents', agentId, 'attachments'),
    agentAttachmentPath: (agentId, attachmentId) =>
      path.join(root, 'agents', agentId, 'attachments', attachmentId),
    agentAppsDir: (agentId) => path.join(root, 'agents', agentId, 'apps'),
    agentShellLogsDir: (agentId) =>
      path.join(root, 'agents', agentId, 'shells'),
    diffHistoryDir: () => path.join(root, 'diff-history'),
    diffHistoryDbPath: () => path.join(root, 'diff-history', 'db.sqlite'),
    diffHistoryBlobsDir: () => path.join(root, 'diff-history', 'blobs'),
    agentDbPath: () => path.join(root, 'agent.sqlite'),
    fileReadCacheDbPath: () => path.join(root, 'file-read-cache.sqlite'),
    processedImageCacheDbPath: () =>
      path.join(root, 'processed-image-cache.sqlite'),
    userDataDir: () => path.join(root, 'user-data'),
    plansDir: () => path.join(root, 'plans'),
    logsDir: () => path.join(root, 'logs'),
    memoryDir: () => path.join(root, 'memory'),
    pluginsDir: () => path.join(root, 'plugins'),
    builtinSkillsDir: () => path.join(root, 'plugins'),
    ripgrepBaseDir: () => path.join(root, 'rg'),
  };
}

function makeDeps(root: string, workspace: string): UniversalToolboxDeps {
  return {
    agentInstanceId: 'agent-1',
    hostPaths: makeHostPaths(root),
    staticMounts: [
      {
        prefix: 'wtest',
        absolutePath: workspace,
        permissions: ['read', 'write', 'create', 'delete'],
      },
      {
        prefix: 'readonly',
        absolutePath: path.join(root, 'readonly'),
        permissions: ['read'],
      },
    ],
    diffHistoryService: {
      ignoreFileForWatcher: vi.fn(),
      unignoreFileForWatcher: vi.fn(),
      registerAgentEdit: vi.fn(async () => {}),
      registerAgentEditBatch: vi.fn(async () => {}),
      acceptPendingEditsForAgentFile: vi.fn(async () => {}),
    } as never,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe('universal toolbox', () => {
  let root: string;
  let workspace: string;
  let deps: UniversalToolboxDeps;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'agent-core-toolbox-'));
    workspace = path.join(root, 'workspace');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(path.join(root, 'readonly'), { recursive: true });
    deps = makeDeps(root, workspace);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('validates read paths', async () => {
    writeFileSync(path.join(workspace, 'file.txt'), 'hello');
    await expect(
      readToolExecute({ path: 'wtest/file.txt' }, deps),
    ).resolves.toEqual({
      message: 'File opened and loaded into context.',
    });
  });

  it('reads from the memory mount', async () => {
    mkdirSync(path.join(root, 'memory'), { recursive: true });
    writeFileSync(path.join(root, 'memory', 'index.md'), '# Memory\n');
    await expect(
      readToolExecute({ path: 'memory/index.md' }, deps),
    ).resolves.toEqual({
      message: 'File opened and loaded into context.',
    });
  });

  it('rejects writes, edits, and deletes in the memory mount', async () => {
    mkdirSync(path.join(root, 'memory'), { recursive: true });
    writeFileSync(path.join(root, 'memory', 'index.md'), '# Memory\n');

    await expect(
      writeToolExecute({ path: 'memory/new.md', content: 'nope' }, deps),
    ).rejects.toThrow(/read-only/);
    await expect(
      multiEditToolExecute(
        {
          path: 'memory/index.md',
          edits: [{ old_string: 'Memory', new_string: 'Edited' }],
        },
        deps,
      ),
    ).rejects.toThrow(/read-only/);
    await expect(
      deleteToolExecute({ path: 'memory/index.md' }, deps),
    ).rejects.toThrow(/read-only/);
  });

  it('reads, globs, and greps protected mounts without exposing ciphertext', async () => {
    const storage = new ProtectedFileStorage(
      new AeadDataProtection(randomBytes(32)),
      { chunkSize: 4096 },
    );
    deps.protectedFiles = storage;

    const attachmentPath = deps.hostPaths.agentAttachmentPath(
      'agent-1',
      'secret.txt',
    );
    const memoryPath = path.join(deps.hostPaths.memoryDir(), 'index.md');
    const shellPath = path.join(
      deps.hostPaths.agentShellLogsDir('agent-1'),
      'session.shell.log',
    );
    await storage.writeFile(
      attachmentPath,
      'attachment private needle\n',
      protectedFileContext.attachment('agent-1', 'secret.txt'),
    );
    await storage.writeFile(
      memoryPath,
      'memory private needle\n',
      protectedFileContext.memory('index.md'),
    );
    const shellLog = new ProtectedAppendFileStorage(
      storage,
      shellPath,
      protectedFileContext.shellLog('agent-1', 'session.shell.log'),
    );
    await shellLog.append('shell private needle\n');
    await shellLog.drain();

    for (const [mountedPath, diskPath] of [
      ['att/secret.txt', attachmentPath],
      ['memory/index.md', memoryPath],
      ['shells/session.shell.log', shellPath],
    ] as const) {
      await expect(
        readToolExecute({ path: mountedPath }, deps),
      ).resolves.toEqual({
        message: 'File opened and loaded into context.',
      });
      expect(readFileSync(diskPath, 'utf-8')).not.toContain('private needle');
    }

    await expect(
      globToolExecute({ mount_prefix: 'att', pattern: '*.txt' }, deps),
    ).resolves.toMatchObject({
      result: { relativePaths: ['secret.txt'] },
    });
    await expect(
      globToolExecute({ mount_prefix: 'shells', pattern: '*.shell.log' }, deps),
    ).resolves.toMatchObject({
      result: { relativePaths: ['session.shell.log'] },
    });

    for (const prefix of ['att', 'memory', 'shells']) {
      const grep = await grepSearchToolExecute(
        {
          mount_prefix: prefix,
          query: 'private needle',
        },
        deps,
      );
      expect(grep.result.totalMatches).toBe(1);
      expect(grep.result.matches[0]?.preview).toContain('private needle');
    }
  });

  it('creates directories and rejects read-only mounts', async () => {
    const result = await mkdirToolExecute({ path: 'wtest/a/b' }, deps);
    expect(result.message).toContain('Created directory');
    await expect(
      mkdirToolExecute({ path: 'readonly/x' }, deps),
    ).rejects.toThrow(/read-only/);
  });

  it('writes and multi-edits with diff history', async () => {
    const writeResult = await writeToolExecute(
      { path: 'wtest/file.txt', content: 'hello world' },
      deps,
      { toolCallId: 'tc-write' },
    );
    expect(writeResult.message).toContain('created');
    expect(readFileSync(path.join(workspace, 'file.txt'), 'utf-8')).toBe(
      'hello world',
    );

    const editResult = await multiEditToolExecute(
      {
        path: 'wtest/file.txt',
        edits: [{ old_string: 'world', new_string: 'clodex' }],
      },
      deps,
      { toolCallId: 'tc-edit' },
    );
    expect(editResult.result.editsApplied).toBe(1);
    expect(readFileSync(path.join(workspace, 'file.txt'), 'utf-8')).toBe(
      'hello clodex',
    );
    expect(deps.diffHistoryService?.registerAgentEdit).toHaveBeenCalled();
  });

  it('waits for approval before writing a proposed file edit', async () => {
    writeFileSync(path.join(workspace, 'file.txt'), 'before');
    let capturedApply: (() => Promise<void>) | undefined;
    deps.pendingEditService = {
      requestApproval: vi.fn(async (request) => {
        capturedApply = request.apply;
        expect(readFileSync(path.join(workspace, 'file.txt'), 'utf-8')).toBe(
          'before',
        );
        await request.apply();
        return {
          status: 'accepted',
          message: 'accepted by test',
        };
      }),
    } as never;

    const result = await writeToolExecute(
      { path: 'wtest/file.txt', content: 'after' },
      deps,
      { toolCallId: 'tc-pre-apply-write' },
    );

    expect(capturedApply).toBeDefined();
    expect(result.message).toBe('accepted by test');
    expect(readFileSync(path.join(workspace, 'file.txt'), 'utf-8')).toBe(
      'after',
    );
    expect(deps.diffHistoryService?.registerAgentEdit).toHaveBeenCalled();
  });

  it('keeps write tool changes pending until the user accepts', async () => {
    writeFileSync(path.join(workspace, 'file.txt'), 'before');
    const store = new AgentStore({
      agents: { instances: {} },
      toolbox: {},
    });
    const pendingEditService = new PendingEditService({ store });
    deps.pendingEditService = pendingEditService;

    const writePromise = writeToolExecute(
      { path: 'wtest/file.txt', content: 'after' },
      deps,
      { toolCallId: 'tc-real-pending-write' },
    );

    await vi.waitFor(() => {
      expect(
        store.get().toolbox['agent-1']?.pendingProposedEdits.at(0)?.id,
      ).toBe('tc-real-pending-write');
    });
    expect(readFileSync(path.join(workspace, 'file.txt'), 'utf-8')).toBe(
      'before',
    );
    expect(deps.diffHistoryService?.registerAgentEdit).not.toHaveBeenCalled();

    await pendingEditService.acceptEdit('tc-real-pending-write');

    const result = await writePromise;
    expect(result.message).toContain('Success: applied changes');
    expect(readFileSync(path.join(workspace, 'file.txt'), 'utf-8')).toBe(
      'after',
    );
    expect(deps.diffHistoryService?.registerAgentEdit).toHaveBeenCalled();
  });

  it('returns a deterministic verification nudge after accepting a pending edit', async () => {
    const store = new AgentStore({
      agents: { instances: {} },
      toolbox: {},
    });
    const pendingEditService = new PendingEditService({ store });

    const decisionPromise = pendingEditService.requestApproval({
      toolCallId: 'tc-pre-apply-accept',
      agentInstanceId: 'agent-1',
      absolutePath: path.join(workspace, 'file.txt'),
      relativePath: 'wtest/file.txt',
      oldContent: 'before',
      newContent: 'after',
      apply: vi.fn(async () => {}),
    });

    expect(store.get().toolbox['agent-1']?.pendingProposedEdits.at(0)?.id).toBe(
      'tc-pre-apply-accept',
    );
    await pendingEditService.acceptEdit('tc-pre-apply-accept');

    const decision = await decisionPromise;
    expect(decision.status).toBe('accepted');
    expect(decision.message).toContain('Success: applied changes');
    expect(decision.message).toContain(POST_EDIT_VERIFICATION_NUDGE);
  });

  it('locks pending edits by file until the approval is resolved', async () => {
    const store = new AgentStore({
      agents: { instances: {} },
      toolbox: {},
    });
    const pendingEditService = new PendingEditService({ store });
    const absolutePath = path.join(workspace, 'locked.txt');

    const firstDecisionPromise = pendingEditService.requestApproval({
      toolCallId: 'tc-lock-1',
      lockOwnerId: 'swarm-run:coder-a',
      agentInstanceId: 'agent-1',
      absolutePath,
      relativePath: 'wtest/locked.txt',
      oldContent: 'before',
      newContent: 'after-a',
      apply: vi.fn(async () => {}),
    });

    const secondDecision = await pendingEditService.requestApproval({
      toolCallId: 'tc-lock-2',
      lockOwnerId: 'swarm-run:coder-b',
      agentInstanceId: 'agent-1',
      absolutePath,
      relativePath: 'wtest/locked.txt',
      oldContent: 'before',
      newContent: 'after-b',
      apply: vi.fn(async () => {}),
    });

    expect(secondDecision.status).toBe('rejected');
    expect(secondDecision.message).toContain('currently locked');

    await pendingEditService.acceptEdit('tc-lock-1');
    await expect(firstDecisionPromise).resolves.toMatchObject({
      status: 'accepted',
    });

    const thirdDecisionPromise = pendingEditService.requestApproval({
      toolCallId: 'tc-lock-3',
      lockOwnerId: 'swarm-run:coder-b',
      agentInstanceId: 'agent-1',
      absolutePath,
      relativePath: 'wtest/locked.txt',
      oldContent: 'after-a',
      newContent: 'after-b',
      apply: vi.fn(async () => {}),
    });
    pendingEditService.rejectEdit('tc-lock-3');

    await expect(thirdDecisionPromise).resolves.toMatchObject({
      status: 'rejected',
    });
  });

  it('does not write a proposed multi-edit when rejected', async () => {
    writeFileSync(path.join(workspace, 'file.txt'), 'hello world');
    deps.pendingEditService = {
      requestApproval: vi.fn(async () => ({
        status: 'rejected',
        message: 'rejected by test',
      })),
    } as never;

    const result = await multiEditToolExecute(
      {
        path: 'wtest/file.txt',
        edits: [{ old_string: 'world', new_string: 'clodex' }],
      },
      deps,
      { toolCallId: 'tc-pre-apply-reject' },
    );

    expect(result.message).toBe('rejected by test');
    expect(result.result.editsApplied).toBe(1);
    expect(readFileSync(path.join(workspace, 'file.txt'), 'utf-8')).toBe(
      'hello world',
    );
    expect(deps.diffHistoryService?.registerAgentEdit).not.toHaveBeenCalled();
  });

  it('finds files with glob and grep', async () => {
    mkdirSync(path.join(workspace, 'src'), { recursive: true });
    writeFileSync(path.join(workspace, 'src', 'a.ts'), 'const value = 1;\n');
    writeFileSync(path.join(workspace, 'src', 'b.txt'), 'nope\n');

    // `**/` prefix is required for the runtime-node JS fallback to descend
    // into subdirectories (ripgrep handles `src/*.ts` directly, but we
    // can't assume rg is available in unit tests).
    const globResult = await globToolExecute(
      { mount_prefix: 'wtest', pattern: '**/src/*.ts' },
      deps,
    );
    expect(globResult.result.relativePaths).toEqual(['src/a.ts']);

    const grepResult = await grepSearchToolExecute(
      {
        mount_prefix: 'wtest',
        query: 'value',
        include_file_pattern: '**/*.ts',
      },
      deps,
    );
    expect(grepResult.result.matches).toHaveLength(1);
    expect(grepResult.result.matches[0]?.path).toBe('src/a.ts');
  });

  it('reads AST skeletons and symbol bodies without full file reads', async () => {
    mkdirSync(path.join(workspace, 'src'), { recursive: true });
    writeFileSync(
      path.join(workspace, 'src', 'service.ts'),
      [
        'export class AccountService {',
        '  getBalance(userId: string) {',
        '    const balance = 42;',
        '    return { userId, balance };',
        '  }',
        '',
        '  formatBalance(value: number) {',
        '    return `$${value}`;',
        '  }',
        '}',
        '',
        'export function helper() {',
        "  return 'ok';",
        '}',
      ].join('\n'),
    );

    const skeleton = await getFileSkeletonToolExecute(
      { path: 'wtest/src/service.ts' },
      deps,
    );
    expect(skeleton.result.language).toBe('TypeScript');
    expect(skeleton.result.outline).toContain('AccountService');
    expect(skeleton.result.outline).toContain('getBalance');
    expect(skeleton.result.outline).toContain('helper');

    const method = await getSymbolBodyToolExecute(
      {
        path: 'wtest/src/service.ts',
        symbolName: 'AccountService.getBalance',
      },
      deps,
    );
    expect(method.result.fullName).toBe('AccountService.getBalance');
    expect(method.result.startLine).toBe(2);
    expect(method.result.endLine).toBe(5);
    expect(method.result.body).toContain('const balance = 42');
    expect(method.result.body).not.toContain('formatBalance');

    const helper = await getSymbolBodyToolExecute(
      { path: 'wtest/src/service.ts', symbolName: 'helper' },
      deps,
    );
    expect(helper.result.fullName).toBe('helper');
    expect(helper.result.body).toContain("return 'ok'");
  });

  it('searches project symbols across mounted source files', async () => {
    mkdirSync(path.join(workspace, 'src'), { recursive: true });
    writeFileSync(
      path.join(workspace, 'src', 'billing.ts'),
      [
        'export class BillingService {',
        '  calculateBalance(userId: string) {',
        '    return userId.length;',
        '  }',
        '}',
      ].join('\n'),
    );
    writeFileSync(
      path.join(workspace, 'src', 'auth.ts'),
      [
        'export function createSession(userId: string) {',
        '  return { userId };',
        '}',
      ].join('\n'),
    );
    mkdirSync(path.join(workspace, 'node_modules', 'noisy'), {
      recursive: true,
    });
    writeFileSync(
      path.join(workspace, 'node_modules', 'noisy', 'billing.ts'),
      'export class BillingNoise {}',
    );

    deps.projectIndexService = new ProjectIndexService();

    const result = await searchProjectSymbolsToolExecute(
      { query: 'Billing', mount_prefix: 'wtest' },
      deps,
    );

    expect(result.result.totalMatches).toBeGreaterThanOrEqual(1);
    expect(result.result.matches[0]?.path).toBe('wtest/src/billing.ts');
    expect(result.result.matches[0]?.symbol.fullName).toBe('BillingService');
    expect(result.message).toContain('BillingService');
    expect(result.message).not.toContain('BillingNoise');
  });

  it('skips noisy gitignored directories by default and matches root-level **/X', async () => {
    // Root-level file that `**/README.md` must match.
    writeFileSync(path.join(workspace, 'README.md'), '# top\n');
    // A nested README to confirm `**` still matches deeper paths.
    mkdirSync(path.join(workspace, 'pkg'), { recursive: true });
    writeFileSync(path.join(workspace, 'pkg', 'README.md'), '# pkg\n');

    // Noisy directory that must be excluded by default — and is the
    // shape that triggered the stack overflow on real monorepos.
    mkdirSync(path.join(workspace, 'node_modules', 'foo'), {
      recursive: true,
    });
    writeFileSync(
      path.join(workspace, 'node_modules', 'foo', 'README.md'),
      'should be ignored\n',
    );

    const defaultRun = await globToolExecute(
      { mount_prefix: 'wtest', pattern: '**/README.md' },
      deps,
    );
    expect(defaultRun.result.relativePaths.sort()).toEqual([
      'README.md',
      'pkg/README.md',
    ]);

    // Opt-in: include_gitignored picks the node_modules tree back up.
    const openedUp = await globToolExecute(
      {
        mount_prefix: 'wtest',
        pattern: '**/README.md',
        include_gitignored: true,
      },
      deps,
    );
    expect(openedUp.result.relativePaths).toContain(
      'node_modules/foo/README.md',
    );
  });

  it('does not stack-overflow on directories with many entries', async () => {
    // The bug we're guarding against was `result.push(...inner)` with
    // an inner array large enough to cross V8's spread limit. Recursive
    // walks of pnpm monorepos pushed well past 100k. 2k flat entries
    // here is plenty to exercise the iterative path without slowing
    // CI.
    const big = path.join(workspace, 'big');
    mkdirSync(big, { recursive: true });
    for (let i = 0; i < 2000; i++) {
      writeFileSync(path.join(big, `f${i}.txt`), 'x');
    }
    const result = await globToolExecute(
      { mount_prefix: 'wtest', pattern: '**/big/*.txt' },
      deps,
    );
    // Capped at 50 by the universal-tools layer; we only care that the
    // walk completed without throwing and returned a non-zero match.
    expect(result.result.totalMatches).toBeGreaterThanOrEqual(50);
  }, 30_000);

  it('plumbs include_gitignored through to runtime-node', async () => {
    // A user-authored .gitignore that hides `secrets/`. Default glob
    // calls must honor it; `include_gitignored: true` must override it.
    writeFileSync(path.join(workspace, '.gitignore'), 'secrets/\n');
    mkdirSync(path.join(workspace, 'secrets'), { recursive: true });
    writeFileSync(path.join(workspace, 'secrets', 'leak.md'), 'shh\n');

    const respected = await globToolExecute(
      { mount_prefix: 'wtest', pattern: '**/leak.md' },
      deps,
    );
    expect(respected.result.relativePaths).not.toContain('secrets/leak.md');

    const overridden = await globToolExecute(
      {
        mount_prefix: 'wtest',
        pattern: '**/leak.md',
        include_gitignored: true,
      },
      deps,
    );
    expect(overridden.result.relativePaths).toContain('secrets/leak.md');
  });

  // ---------------------------------------------------------------------------
  // Move / delete diff-history tracking — guards against the regression
  // introduced when copy/delete were ported from the browser toolbox to the
  // shared universal-tools helper. Origin/main captured every removed file
  // individually so the watcher would not surface them as "external"
  // changes; without these tests the regression silently re-lands.
  // ---------------------------------------------------------------------------

  function getRegisteredEditPaths(): string[] {
    const single = deps.diffHistoryService?.registerAgentEdit as ReturnType<
      typeof vi.fn
    >;
    const batch = deps.diffHistoryService?.registerAgentEditBatch as ReturnType<
      typeof vi.fn
    >;
    // Multi-file ops (directory move/copy/remove) flow through
    // `registerAgentEditBatch` so the per-toolCall fan-out cap of
    // `registerAgentEdit` does not silently drop the tail entries.
    // Aggregate both so callers can assert on the registered set
    // without knowing which code path was taken.
    const singlePaths = single.mock.calls.map(
      (call) => (call[0] as { path: string }).path,
    );
    const batchPaths = batch.mock.calls.flatMap((call) =>
      (call[0] as Array<{ path: string }>).map((edit) => edit.path),
    );
    return [...singlePaths, ...batchPaths];
  }

  it('move (single file): registers an edit for src deletion AND dest creation', async () => {
    writeFileSync(path.join(workspace, 'a.txt'), 'hello');

    const result = await copyToolExecute(
      {
        input_path: 'wtest/a.txt',
        output_path: 'wtest/b.txt',
        move: true,
      },
      deps,
      { toolCallId: 'tc-move-single' },
    );

    expect(result?.message).toContain('Moved');
    const paths = getRegisteredEditPaths();
    expect(paths).toContain(path.join(workspace, 'a.txt'));
    expect(paths).toContain(path.join(workspace, 'b.txt'));
    // Watcher ignore should fire for BOTH paths, not just dest.
    const ignoreMock = deps.diffHistoryService
      ?.ignoreFileForWatcher as ReturnType<typeof vi.fn>;
    const ignored = ignoreMock.mock.calls.map((c) => c[0]);
    expect(ignored).toContain(path.join(workspace, 'a.txt'));
    expect(ignored).toContain(path.join(workspace, 'b.txt'));
  });

  it('move (directory): registers an edit for every src AND dest file under the moved tree', async () => {
    mkdirSync(path.join(workspace, 'src', 'nested'), { recursive: true });
    writeFileSync(path.join(workspace, 'src', 'a.txt'), 'a');
    writeFileSync(path.join(workspace, 'src', 'b.txt'), 'b');
    writeFileSync(path.join(workspace, 'src', 'nested', 'c.txt'), 'c');

    await copyToolExecute(
      {
        input_path: 'wtest/src',
        output_path: 'wtest/dst',
        move: true,
      },
      deps,
      { toolCallId: 'tc-move-dir' },
    );

    const paths = getRegisteredEditPaths();
    // Source-side deletions
    expect(paths).toContain(path.join(workspace, 'src', 'a.txt'));
    expect(paths).toContain(path.join(workspace, 'src', 'b.txt'));
    expect(paths).toContain(path.join(workspace, 'src', 'nested', 'c.txt'));
    // Destination-side creations (without these, undo restores src but
    // leaves dst in place — duplicating the tree)
    expect(paths).toContain(path.join(workspace, 'dst', 'a.txt'));
    expect(paths).toContain(path.join(workspace, 'dst', 'b.txt'));
    expect(paths).toContain(path.join(workspace, 'dst', 'nested', 'c.txt'));
  });

  it('copy (directory, no move): registers an edit for every dest file but NOT any src file', async () => {
    mkdirSync(path.join(workspace, 'src', 'nested'), { recursive: true });
    writeFileSync(path.join(workspace, 'src', 'a.txt'), 'a');
    writeFileSync(path.join(workspace, 'src', 'nested', 'c.txt'), 'c');

    await copyToolExecute(
      {
        input_path: 'wtest/src',
        output_path: 'wtest/dst',
        move: false,
      },
      deps,
      { toolCallId: 'tc-copy-dir' },
    );

    const paths = getRegisteredEditPaths();
    expect(paths).toContain(path.join(workspace, 'dst', 'a.txt'));
    expect(paths).toContain(path.join(workspace, 'dst', 'nested', 'c.txt'));
    // Source files must remain intact and not appear as deletions.
    expect(paths).not.toContain(path.join(workspace, 'src', 'a.txt'));
    expect(paths).not.toContain(path.join(workspace, 'src', 'nested', 'c.txt'));
  });

  it('copy (no move): does NOT register an edit for the source path', async () => {
    writeFileSync(path.join(workspace, 'a.txt'), 'hello');

    await copyToolExecute(
      {
        input_path: 'wtest/a.txt',
        output_path: 'wtest/b.txt',
        move: false,
      },
      deps,
      { toolCallId: 'tc-copy-single' },
    );

    const paths = getRegisteredEditPaths();
    expect(paths).not.toContain(path.join(workspace, 'a.txt'));
    expect(paths).toContain(path.join(workspace, 'b.txt'));
  });

  it('move rejects read-only sources', async () => {
    writeFileSync(path.join(root, 'readonly', 'a.txt'), 'hello');

    await expect(
      copyToolExecute(
        {
          input_path: 'readonly/a.txt',
          output_path: 'wtest/a.txt',
          move: true,
        },
        deps,
        { toolCallId: 'tc-move-readonly' },
      ),
    ).rejects.toThrow('Mount readonly is read-only or does not allow delete');

    expect(readFileSync(path.join(root, 'readonly', 'a.txt'), 'utf-8')).toBe(
      'hello',
    );
  });

  it('delete (directory): registers an edit for every child file', async () => {
    mkdirSync(path.join(workspace, 'tree', 'inner'), { recursive: true });
    writeFileSync(path.join(workspace, 'tree', 'a.txt'), 'a');
    writeFileSync(path.join(workspace, 'tree', 'b.txt'), 'b');
    writeFileSync(path.join(workspace, 'tree', 'inner', 'c.txt'), 'c');

    await deleteToolExecute({ path: 'wtest/tree' }, deps, {
      toolCallId: 'tc-delete-dir',
    });

    const paths = getRegisteredEditPaths();
    expect(paths).toContain(path.join(workspace, 'tree', 'a.txt'));
    expect(paths).toContain(path.join(workspace, 'tree', 'b.txt'));
    expect(paths).toContain(path.join(workspace, 'tree', 'inner', 'c.txt'));
  });

  it('delete (single file): registers exactly one edit and leaves the existing behavior intact', async () => {
    writeFileSync(path.join(workspace, 'lone.txt'), 'bye');

    await deleteToolExecute({ path: 'wtest/lone.txt' }, deps, {
      toolCallId: 'tc-delete-file',
    });

    const paths = getRegisteredEditPaths();
    expect(paths).toEqual([path.join(workspace, 'lone.txt')]);
  });

  // ---------------------------------------------------------------------------
  // Diff-history fan-out cap regression. `DiffHistoryService.registerAgentEdit`
  // silently drops edits past `MAX_EDITS_PER_TOOL_CALL` (50) for any one tool
  // call — a guard against runaway iterative tools. Directory move/copy/remove
  // however emit one edit per child file under a single tool call, and a tree
  // with >25 files used to lose the tail of those records, leaving undo
  // unable to restore the dropped paths. The universal-tools port routes
  // directory ops through `registerAgentEditBatch`, which bypasses the cap
  // for coherent multi-file payloads. These tests lock that contract in so a
  // future refactor cannot re-introduce the partial-undo regression.
  // ---------------------------------------------------------------------------

  it('move (directory, >50 files): records every src AND dest edit via the batch API (regression guard for fan-out cap)', async () => {
    const TREE_SIZE = 60;
    mkdirSync(path.join(workspace, 'big-src'), { recursive: true });
    for (let i = 0; i < TREE_SIZE; i++) {
      writeFileSync(path.join(workspace, 'big-src', `file-${i}.txt`), `${i}`);
    }

    await copyToolExecute(
      {
        input_path: 'wtest/big-src',
        output_path: 'wtest/big-dst',
        move: true,
      },
      deps,
      { toolCallId: 'tc-move-big-dir' },
    );

    const paths = getRegisteredEditPaths();
    // Every source file must be recorded as a deletion, every destination
    // file as a creation. Without the batch routing, the per-toolCall cap
    // would truncate this list at 50 and leave 70 entries unrestorable.
    for (let i = 0; i < TREE_SIZE; i++) {
      expect(paths).toContain(path.join(workspace, 'big-src', `file-${i}.txt`));
      expect(paths).toContain(path.join(workspace, 'big-dst', `file-${i}.txt`));
    }

    // Directory ops must flow through the batch API in a single call;
    // looping the iterative API would re-introduce the cap bug.
    const batchMock = deps.diffHistoryService
      ?.registerAgentEditBatch as ReturnType<typeof vi.fn>;
    expect(batchMock).toHaveBeenCalledTimes(1);
    const batchPayload = batchMock.mock.calls[0]?.[0] as Array<unknown>;
    expect(batchPayload.length).toBe(TREE_SIZE * 2);
  });

  it('delete (directory, >50 files): records every child edit via the batch API (regression guard for fan-out cap)', async () => {
    const TREE_SIZE = 60;
    mkdirSync(path.join(workspace, 'big-tree'), { recursive: true });
    for (let i = 0; i < TREE_SIZE; i++) {
      writeFileSync(path.join(workspace, 'big-tree', `file-${i}.txt`), `${i}`);
    }

    await deleteToolExecute({ path: 'wtest/big-tree' }, deps, {
      toolCallId: 'tc-delete-big-tree',
    });

    const paths = getRegisteredEditPaths();
    for (let i = 0; i < TREE_SIZE; i++) {
      expect(paths).toContain(
        path.join(workspace, 'big-tree', `file-${i}.txt`),
      );
    }

    const batchMock = deps.diffHistoryService
      ?.registerAgentEditBatch as ReturnType<typeof vi.fn>;
    expect(batchMock).toHaveBeenCalledTimes(1);
    const batchPayload = batchMock.mock.calls[0]?.[0] as Array<unknown>;
    expect(batchPayload.length).toBe(TREE_SIZE);
  });
});
