import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodeGraphCliEvidenceProvider } from './codegraph-evidence-provider';

describe('CodeGraphCliEvidenceProvider', () => {
  it('fingerprints a workspace-confined file without persisting its content', async () => {
    const workspace = path.join(os.tmpdir(), `code-evidence-${randomUUID()}`);
    await fs.mkdir(path.join(workspace, '.codegraph'), { recursive: true });
    await fs.writeFile(
      path.join(workspace, 'config.ts'),
      'export const x = 1;\n',
    );
    const provider = new CodeGraphCliEvidenceProvider({
      workspaceRoot: workspace,
      syncBeforeResolve: false,
    });

    const result = await provider.resolve({
      taskId: 'task-a',
      workspaceId: workspace,
      entity: { type: 'file', value: 'config.ts' },
    });

    expect(result).toMatchObject({
      filePath: 'config.ts',
      repositoryRevision: null,
      graphContext: [],
      contentHash: createHash('sha256')
        .update('export const x = 1;\n')
        .digest('hex'),
    });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('rejects file entities that escape the workspace', async () => {
    const workspace = path.join(os.tmpdir(), `code-evidence-${randomUUID()}`);
    await fs.mkdir(path.join(workspace, '.codegraph'), { recursive: true });
    const provider = new CodeGraphCliEvidenceProvider({
      workspaceRoot: workspace,
      syncBeforeResolve: false,
    });

    await expect(
      provider.resolve({
        taskId: 'task-a',
        workspaceId: workspace,
        entity: { type: 'file', value: '../outside.ts' },
      }),
    ).resolves.toBeNull();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('aborts an in-flight CodeGraph command at the caller deadline', async () => {
    const workspace = path.join(os.tmpdir(), `code-evidence-${randomUUID()}`);
    await fs.mkdir(path.join(workspace, '.codegraph'), { recursive: true });
    const provider = new CodeGraphCliEvidenceProvider({
      workspaceRoot: workspace,
      syncBeforeResolve: false,
      runCommand: ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    });

    await expect(
      provider.resolve({
        taskId: 'task-a',
        workspaceId: workspace,
        entity: { type: 'symbol', value: 'neverReturns' },
        signal: AbortSignal.timeout(10),
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('fingerprints an exact symbol and expands CodeGraph callers and callees', async () => {
    const workspace = path.join(os.tmpdir(), `code-evidence-${randomUUID()}`);
    await fs.mkdir(path.join(workspace, '.codegraph'), { recursive: true });
    const source = [
      'const dependency = 1;',
      'export function run() {',
      '  return dependency;',
      '}',
      '',
    ].join('\n');
    await fs.writeFile(path.join(workspace, 'service.ts'), source);
    await fs.writeFile(
      path.join(workspace, 'main.ts'),
      [
        'import { run } from "./service";',
        '',
        'export function main() {',
        '  return run();',
        '}',
        '',
      ].join('\n'),
    );
    const provider = new CodeGraphCliEvidenceProvider({
      workspaceRoot: workspace,
      syncBeforeResolve: false,
      getRepositoryRevision: async () => 'revision-a',
      runCommand: async ({ args }) => {
        if (args[0] === 'query') {
          return JSON.stringify([
            {
              node: {
                id: 'function:run',
                name: 'run',
                qualifiedName: 'run',
                filePath: 'service.ts',
                startLine: 2,
                endLine: 4,
              },
              score: 100,
            },
          ]);
        }
        if (args[0] === 'callers') {
          return JSON.stringify({
            callers: [
              {
                name: 'main',
                filePath: 'main.ts',
                startLine: 5,
              },
            ],
          });
        }
        if (args[0] === 'callees') {
          return JSON.stringify({
            callees: [
              {
                name: 'dependency',
                filePath: 'service.ts',
                startLine: 1,
              },
            ],
          });
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
    });

    const result = await provider.resolve({
      taskId: 'task-a',
      workspaceId: workspace,
      entity: { type: 'symbol', value: 'service.ts#run' },
    });

    expect(result).toEqual(
      expect.objectContaining({
        filePath: 'service.ts',
        symbolName: 'run',
        codeGraphNodeId: 'function:run',
        repositoryRevision: 'revision-a',
        contentHash: createHash('sha256').update(source).digest('hex'),
        symbolHash: createHash('sha256')
          .update(
            ['export function run() {', '  return dependency;', '}'].join('\n'),
          )
          .digest('hex'),
        graphContext: [
          expect.objectContaining({
            direction: 'caller',
            name: 'main',
            filePath: 'main.ts',
          }),
          expect.objectContaining({
            direction: 'callee',
            name: 'dependency',
            filePath: 'service.ts',
          }),
        ],
      }),
    );
    const snippets = await provider.expandContext({
      taskId: 'task-a',
      workspaceId: workspace,
      query: 'run dependency',
      entities: [{ type: 'symbol', value: 'service.ts#run' }],
      maxSnippets: 3,
      maxCharsPerSnippet: 1_000,
    });
    expect(snippets).toEqual([
      expect.objectContaining({
        source: 'entity',
        filePath: 'service.ts',
        symbolName: 'run',
        startLine: 2,
        endLine: 4,
      }),
      expect.objectContaining({
        source: 'caller',
        filePath: 'main.ts',
        symbolName: 'main',
      }),
      expect.objectContaining({
        source: 'callee',
        filePath: 'service.ts',
        symbolName: 'dependency',
      }),
    ]);
    expect(snippets.every((snippet) => snippet.content.length <= 1_000)).toBe(
      true,
    );
    await fs.rm(workspace, { recursive: true, force: true });
  });
});
