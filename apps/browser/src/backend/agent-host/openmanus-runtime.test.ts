import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { OpenManusExecutionRequest } from './protocol';
import { executeOpenManusRequest } from './openmanus-runtime';

const request: OpenManusExecutionRequest = {
  prompt: 'Inspect the workspace',
  mountPrefix: 'w1234',
  workspacePath: '/workspace/project',
  openManusHome: '/opt/openmanus',
  pythonExecutable: 'python3',
  timeoutMs: 60_000,
  modelId: 'gpt-5.5',
  baseUrl: 'https://example.test/v1',
  apiKey: 'secret-route-token',
  maxTokens: 8_192,
  environment: {
    PATH: '/usr/bin',
  },
};

describe('executeOpenManusRequest', () => {
  it('runs the Python agent with an ephemeral config and redacts output', async () => {
    let configPath = '';
    let configContents = '';
    const child = createFakeChild();
    const spawnProcess = vi.fn(
      (
        _command: string,
        _args: readonly string[],
        options: { env?: NodeJS.ProcessEnv },
      ) => {
        configPath = options.env?.OPENMANUS_CONFIG_PATH ?? '';
        configContents = fs.readFileSync(configPath, 'utf8');
        queueMicrotask(() => {
          child.stdout.write(`result ${request.apiKey}`);
          child.stderr.write(`warning ${request.apiKey}`);
          child.emit('close', 0, null);
        });
        return child;
      },
    ) as unknown as typeof spawn;

    const result = await executeOpenManusRequest(request, { spawnProcess });

    expect(spawnProcess).toHaveBeenCalledWith(
      'python3',
      ['main.py', '--prompt', expect.stringContaining('Inspect the workspace')],
      expect.objectContaining({
        cwd: '/opt/openmanus',
        shell: false,
        env: expect.objectContaining({
          PATH: '/usr/bin',
          WORKSPACE_ROOT: '/workspace/project',
          OPENMANUS_WORKSPACE_ROOT: '/workspace/project',
          OPENMANUS_CONFIG_PATH: expect.any(String),
        }),
      }),
    );
    expect(configContents).toContain('model = "gpt-5.5"');
    expect(configContents).toContain('api_key = "secret-route-token"');
    expect(result).toMatchObject({
      message: 'OpenManus completed.',
      exitCode: 0,
      timedOut: false,
      stdout: 'result [REDACTED]',
      stderr: 'warning [REDACTED]',
    });
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('terminates the child when the caller aborts', async () => {
    const child = createFakeChild();
    let notifySpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      notifySpawned = resolve;
    });
    child.kill.mockImplementation((signal?: NodeJS.Signals | number) => {
      queueMicrotask(() => child.emit('close', null, signal ?? 'SIGTERM'));
      return true;
    });
    const spawnProcess = vi.fn(() => {
      notifySpawned?.();
      return child;
    }) as unknown as typeof spawn;
    const abortController = new AbortController();

    const execution = executeOpenManusRequest(request, {
      signal: abortController.signal,
      spawnProcess,
    });
    await spawned;
    abortController.abort();

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('removes the ephemeral directory when config creation fails', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'clodex-openmanus-test-'),
    );
    const mkdtemp = vi.spyOn(fsPromises, 'mkdtemp').mockResolvedValue(tmpDir);
    const writeFile = vi
      .spyOn(fsPromises, 'writeFile')
      .mockRejectedValueOnce(new Error('disk full'));

    try {
      await expect(executeOpenManusRequest(request)).rejects.toThrow(
        'disk full',
      );
      expect(fs.existsSync(tmpDir)).toBe(false);
    } finally {
      mkdtemp.mockRestore();
      writeFile.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}
