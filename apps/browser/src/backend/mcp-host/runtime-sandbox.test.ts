import { describe, expect, it, vi } from 'vitest';
import type { ExecutableRuntimePolicy } from '@clodex/mcp-runtime';
import {
  prepareSandboxedRuntimeCommand,
  startRuntimeMemoryMonitor,
} from './runtime-sandbox';

function policy(
  overrides: Partial<ExecutableRuntimePolicy> = {},
): ExecutableRuntimePolicy {
  return {
    kind: 'plugin-executable',
    pluginId: 'local-tools',
    runtimeId: 'server',
    pluginRoot: '/plugins/local-tools',
    allowNetwork: false,
    allowFilesystem: false,
    maxMemoryMb: 128,
    requestTimeoutMs: 30_000,
    ...overrides,
  };
}

describe('plugin executable runtime sandbox', () => {
  it('wraps Linux runtimes with bubblewrap, network isolation and prlimit', () => {
    const result = prepareSandboxedRuntimeCommand({
      command: '/plugins/local-tools/runtime/server',
      args: ['--stdio'],
      policy: policy(),
      platform: 'linux',
      executableExists: (candidate) =>
        candidate === '/usr/bin/bwrap' || candidate === '/usr/bin/prlimit',
    });

    expect(result.command).toBe('/usr/bin/bwrap');
    expect(result.args).toContain('--unshare-net');
    expect(result.args).toContain('--as=134217728');
    expect(result.args).toContain('/plugins/local-tools/runtime/server');
    expect(result.sandbox).toBe('bubblewrap');
  });

  it('creates a deny-default macOS sandbox profile', () => {
    const result = prepareSandboxedRuntimeCommand({
      command: '/plugins/local-tools/runtime/server',
      args: [],
      policy: policy({ allowNetwork: true }),
      platform: 'darwin',
      executableExists: (candidate) => candidate === '/usr/bin/sandbox-exec',
    });

    expect(result.command).toBe('/usr/bin/sandbox-exec');
    expect(result.args[1]).toContain('(deny default)');
    expect(result.args[1]).toContain('(allow network*)');
    expect(result.args[1]).not.toContain(
      '(allow file-write* (subpath "/plugins/local-tools"))',
    );
  });

  it('fails closed when denied capabilities cannot be enforced', () => {
    expect(() =>
      prepareSandboxedRuntimeCommand({
        command: 'C:\\plugins\\server.exe',
        args: [],
        policy: policy({
          pluginRoot: 'C:\\plugins\\local-tools',
          allowNetwork: false,
          allowFilesystem: true,
        }),
        platform: 'win32',
      }),
    ).toThrow('cannot enforce denied network/filesystem capabilities');
  });

  it('terminates a runtime after a sampled memory limit violation', async () => {
    vi.useFakeTimers();
    const onLimitExceeded = vi.fn();
    const monitor = startRuntimeMemoryMonitor({
      pid: 123,
      maxMemoryMb: 64,
      sample: async () => 65 * 1024 * 1024,
      onLimitExceeded,
    });

    await vi.advanceTimersByTimeAsync(1_100);

    expect(onLimitExceeded).toHaveBeenCalledWith(65 * 1024 * 1024);
    monitor.stop();
    vi.useRealTimers();
  });
});
