import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ExecutableRuntimePolicy } from '@clodex/mcp-runtime';

const execFileAsync = promisify(execFile);
const MEMORY_SAMPLE_INTERVAL_MS = 1_000;

export interface SandboxedRuntimeCommand {
  command: string;
  args: string[];
  cwd: string;
  sandbox: 'bubblewrap' | 'sandbox-exec' | 'permission-boundary';
}

function escapeSandboxString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function prepareSandboxedRuntimeCommand(input: {
  command: string;
  args: string[];
  policy: ExecutableRuntimePolicy;
  platform?: NodeJS.Platform;
  executableExists?: (path: string) => boolean;
}): SandboxedRuntimeCommand {
  const platform = input.platform ?? process.platform;
  const exists =
    input.executableExists ?? ((candidate: string) => existsSync(candidate));
  const { policy } = input;

  if (platform === 'linux') {
    const bubblewrap = ['/usr/bin/bwrap', '/bin/bwrap'].find(exists);
    if (!bubblewrap) {
      if (!policy.allowNetwork || !policy.allowFilesystem) {
        throw new Error(
          `Executable runtime "${policy.runtimeId}" requires bubblewrap to enforce denied capabilities`,
        );
      }
      return {
        command: input.command,
        args: input.args,
        cwd: policy.pluginRoot,
        sandbox: 'permission-boundary',
      };
    }
    const args = [
      '--die-with-parent',
      '--new-session',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--tmpfs',
      '/tmp',
    ];
    if (policy.allowFilesystem) {
      args.push('--bind', policy.pluginRoot, policy.pluginRoot);
    }
    if (!policy.allowNetwork) args.push('--unshare-net');
    args.push('--chdir', policy.pluginRoot);

    const prlimit = ['/usr/bin/prlimit', '/bin/prlimit'].find(exists);
    if (prlimit) {
      args.push(
        prlimit,
        `--as=${policy.maxMemoryMb * 1024 * 1024}`,
        '--',
        input.command,
        ...input.args,
      );
    } else {
      args.push(input.command, ...input.args);
    }
    return {
      command: bubblewrap,
      args,
      cwd: policy.pluginRoot,
      sandbox: 'bubblewrap',
    };
  }

  if (platform === 'darwin') {
    const sandboxExec = '/usr/bin/sandbox-exec';
    if (!exists(sandboxExec)) {
      if (!policy.allowNetwork || !policy.allowFilesystem) {
        throw new Error(
          `Executable runtime "${policy.runtimeId}" requires sandbox-exec to enforce denied capabilities`,
        );
      }
      return {
        command: input.command,
        args: input.args,
        cwd: policy.pluginRoot,
        sandbox: 'permission-boundary',
      };
    }
    const rules = [
      '(version 1)',
      '(deny default)',
      '(allow process*)',
      '(allow sysctl-read)',
      '(allow mach-lookup)',
      '(allow file-read*)',
      '(allow file-write* (subpath "/tmp") (subpath "/private/tmp"))',
    ];
    if (policy.allowFilesystem) {
      rules.push(
        `(allow file-write* (subpath "${escapeSandboxString(policy.pluginRoot)}"))`,
      );
    }
    if (policy.allowNetwork) rules.push('(allow network*)');
    return {
      command: sandboxExec,
      args: ['-p', rules.join(''), input.command, ...input.args],
      cwd: policy.pluginRoot,
      sandbox: 'sandbox-exec',
    };
  }

  if (platform === 'win32') {
    if (!policy.allowNetwork || !policy.allowFilesystem) {
      throw new Error(
        `Executable runtime "${policy.runtimeId}" cannot enforce denied network/filesystem capabilities on this Windows build`,
      );
    }
    return {
      command: input.command,
      args: input.args,
      cwd: policy.pluginRoot,
      sandbox: 'permission-boundary',
    };
  }

  throw new Error(
    `Executable runtime sandbox is unsupported on platform "${platform}"`,
  );
}

export interface RuntimeMemoryMonitor {
  stop(): void;
}

export function startRuntimeMemoryMonitor(input: {
  pid: number;
  maxMemoryMb: number;
  platform?: NodeJS.Platform;
  sample?: (pid: number, platform: NodeJS.Platform) => Promise<number | null>;
  onLimitExceeded: (residentBytes: number) => void;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}): RuntimeMemoryMonitor {
  const platform = input.platform ?? process.platform;
  const sample = input.sample ?? readResidentSetBytes;
  const setIntervalFn = input.setIntervalFn ?? setInterval;
  const clearIntervalFn = input.clearIntervalFn ?? clearInterval;
  const maxBytes = input.maxMemoryMb * 1024 * 1024;
  let stopped = false;
  let sampling = false;

  const timer = setIntervalFn(() => {
    if (stopped || sampling) return;
    sampling = true;
    void sample(input.pid, platform)
      .then((residentBytes) => {
        if (!stopped && residentBytes !== null && residentBytes > maxBytes) {
          stopped = true;
          clearIntervalFn(timer);
          input.onLimitExceeded(residentBytes);
        }
      })
      .finally(() => {
        sampling = false;
      });
  }, MEMORY_SAMPLE_INTERVAL_MS);
  timer.unref?.();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}

async function readResidentSetBytes(
  pid: number,
  platform: NodeJS.Platform,
): Promise<number | null> {
  try {
    if (platform === 'linux') {
      const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      return match ? Number(match[1]) * 1024 : null;
    }
    if (platform === 'darwin') {
      const { stdout } = await execFileAsync(
        '/bin/ps',
        ['-o', 'rss=', '-p', String(pid)],
        { timeout: 2_000 },
      );
      const kilobytes = Number(stdout.trim());
      return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
    }
    if (platform === 'win32') {
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`;
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 3_000, windowsHide: true },
      );
      const bytes = Number(stdout.trim());
      return Number.isFinite(bytes) ? bytes : null;
    }
  } catch {
    return null;
  }
  return null;
}
