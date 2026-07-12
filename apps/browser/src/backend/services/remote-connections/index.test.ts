import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}));

import type { KartonService } from '@/services/karton';
import type { Logger } from '@/services/logger';
import type {
  RemoteSshAdapter,
  RemoteSshSession,
} from '@/services/remote-connections';
import { RemoteConnectionsService } from '@/services/remote-connections';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

function createKarton() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  return {
    handlers,
    service: {
      registerServerProcedureHandler: vi.fn(
        (name: string, handler: (...args: any[]) => unknown) => {
          handlers.set(name, handler);
        },
      ),
      removeServerProcedureHandler: vi.fn((name: string) => {
        handlers.delete(name);
      }),
    } as unknown as KartonService,
  };
}

function createSshAdapter() {
  const session: RemoteSshSession = {
    execute: vi.fn(async () => ({
      ok: true as const,
      exitCode: 0,
      stdout: 'remote output\n',
      stderr: '',
      durationMs: 12,
    })),
    disconnect: vi.fn(async () => undefined),
    terminalCommand: vi.fn(() => "ssh -S '/tmp/control' 'deploy@example.com'"),
  };
  const adapter: RemoteSshAdapter = {
    getCapabilities: vi.fn(async () => ({
      sshExecutable: true,
      persistentSessions: true,
      passwordAuthentication: true,
      terminalHandoff: true,
    })),
    test: vi.fn(async () => ({ ok: true as const, latencyMs: 42 })),
    connect: vi.fn(async () => ({
      ok: true as const,
      session,
      latencyMs: 55,
    })),
    execute: vi.fn(async () => ({
      ok: true as const,
      exitCode: 0,
      stdout: 'one-shot output\n',
      stderr: '',
      durationMs: 18,
    })),
  };
  return { adapter, session };
}

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
} as unknown as Logger;

describe('RemoteConnectionsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores credentials without exposing them through the public contract', async () => {
    const karton = createKarton();
    const ssh = createSshAdapter();
    let savedStore: any = null;
    let now = 1_000;
    const service = await RemoteConnectionsService.create({
      logger,
      karton: karton.service,
      sshAdapter: ssh.adapter,
      now: () => ++now,
      idGenerator: () => CONNECTION_ID,
      loadStore: async () => ({ version: 1, connections: [] }),
      saveStore: async (store) => {
        savedStore = structuredClone(store);
      },
    });

    const created = await service.save({
      name: 'Production',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      remotePath: '/srv/app',
      hostKeyPolicy: 'strict',
      authentication: { type: 'password', secret: 'super-secret' },
    });

    expect(created).toMatchObject({
      ok: true,
      connection: {
        id: CONNECTION_ID,
        authentication: {
          type: 'password',
          credentialConfigured: true,
        },
      },
    });
    expect(JSON.stringify(created)).not.toContain('super-secret');
    expect(savedStore.connections[0].authentication.secret).toBe(
      'super-secret',
    );

    const edited = await service.save({
      id: CONNECTION_ID,
      name: 'Production API',
      host: 'example.com',
      port: 2222,
      username: 'deploy',
      remotePath: '/srv/api',
      hostKeyPolicy: 'accept-new',
      authentication: { type: 'password' },
    });
    expect(edited.ok).toBe(true);
    expect(savedStore.connections[0].authentication.secret).toBe(
      'super-secret',
    );

    const listed = await service.list();
    expect(listed.connections).toHaveLength(1);
    expect(listed.connections[0]).toMatchObject({
      name: 'Production API',
      port: 2222,
      remotePath: '/srv/api',
    });
    expect(JSON.stringify(listed)).not.toContain('super-secret');

    await service.teardown();
    expect(karton.handlers.size).toBe(0);
  });

  it('persists honest test status and sanitized failure state', async () => {
    const karton = createKarton();
    const ssh = createSshAdapter();
    const service = await RemoteConnectionsService.create({
      logger,
      karton: karton.service,
      sshAdapter: ssh.adapter,
      now: () => 5_000,
      idGenerator: () => CONNECTION_ID,
      loadStore: async () => ({ version: 1, connections: [] }),
      saveStore: async () => undefined,
    });
    await service.save({
      name: 'Staging',
      host: 'staging.example.com',
      port: 22,
      username: 'ubuntu',
      remotePath: '',
      hostKeyPolicy: 'strict',
      authentication: { type: 'ssh-agent' },
    });

    const succeeded = await service.test(CONNECTION_ID);
    expect(succeeded).toMatchObject({
      ok: true,
      connection: {
        lastCheckSucceeded: true,
        lastLatencyMs: 42,
        status: 'disconnected',
      },
    });

    vi.mocked(ssh.adapter.test).mockResolvedValueOnce({
      ok: false,
      code: 'authentication-failed',
      message: 'Permission denied (publickey).',
    });
    const failed = await service.test(CONNECTION_ID);
    expect(failed).toMatchObject({
      ok: false,
      code: 'authentication-failed',
      connection: {
        lastCheckSucceeded: false,
        lastError: 'Permission denied (publickey).',
        status: 'error',
      },
    });

    await service.teardown();
  });

  it('persists a user-selected SSH runner and detaches it before deletion', async () => {
    const karton = createKarton();
    const ssh = createSshAdapter();
    let savedStore: any = null;
    const onRunnerConnectionChanged = vi.fn(async () => undefined);
    const service = await RemoteConnectionsService.create({
      logger,
      karton: karton.service,
      sshAdapter: ssh.adapter,
      idGenerator: () => CONNECTION_ID,
      loadStore: async () => ({ version: 1, connections: [] }),
      saveStore: async (store) => {
        savedStore = structuredClone(store);
      },
      onRunnerConnectionChanged,
    });
    await service.save({
      name: 'Remote builder',
      host: 'builder.example.com',
      port: 22,
      username: 'builder',
      remotePath: '/srv/build',
      hostKeyPolicy: 'strict',
      authentication: { type: 'ssh-agent' },
    });

    await expect(service.setRunnerConnection(CONNECTION_ID)).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        runnerConnectionId: CONNECTION_ID,
      }),
    );
    expect(service.getRunnerConnectionId()).toBe(CONNECTION_ID);
    expect((await service.list()).runnerConnectionId).toBe(CONNECTION_ID);
    expect(savedStore.runnerConnectionId).toBe(CONNECTION_ID);
    expect(onRunnerConnectionChanged).toHaveBeenCalledWith(CONNECTION_ID);

    await service.delete(CONNECTION_ID);
    expect(onRunnerConnectionChanged).toHaveBeenLastCalledWith(null);
    expect(savedStore.runnerConnectionId).toBeNull();
    await service.teardown();
  });

  it('does not persist an SSH runner selection when host configuration fails', async () => {
    const karton = createKarton();
    const ssh = createSshAdapter();
    let savedStore: any = null;
    const service = await RemoteConnectionsService.create({
      logger,
      karton: karton.service,
      sshAdapter: ssh.adapter,
      idGenerator: () => CONNECTION_ID,
      loadStore: async () => ({ version: 1, connections: [] }),
      saveStore: async (store) => {
        savedStore = structuredClone(store);
      },
      onRunnerConnectionChanged: async () => {
        throw new Error('runner security unavailable');
      },
    });
    await service.save({
      name: 'Remote builder',
      host: 'builder.example.com',
      port: 22,
      username: 'builder',
      remotePath: '/srv/build',
      hostKeyPolicy: 'strict',
      authentication: { type: 'ssh-agent' },
    });

    await expect(service.setRunnerConnection(CONNECTION_ID)).resolves.toEqual({
      ok: false,
      code: 'operation-failed',
      message: 'runner security unavailable',
      connection: expect.objectContaining({ id: CONNECTION_ID }),
    });
    expect(service.getRunnerConnectionId()).toBeNull();
    expect(savedStore.runnerConnectionId).toBeNull();
    await service.teardown();
  });

  it('connects, opens a terminal, executes approved commands, and disconnects', async () => {
    const karton = createKarton();
    const ssh = createSshAdapter();
    const createTerminal = vi.fn(async () => 'term-remote');
    const writeTerminalInput = vi.fn();
    const service = await RemoteConnectionsService.create({
      logger,
      karton: karton.service,
      sshAdapter: ssh.adapter,
      idGenerator: () => CONNECTION_ID,
      loadStore: async () => ({ version: 1, connections: [] }),
      saveStore: async () => undefined,
      createTerminal,
      writeTerminalInput,
    });
    await service.save({
      name: 'Build host',
      host: 'build.example.com',
      port: 22,
      username: 'builder',
      remotePath: '/opt/build',
      hostKeyPolicy: 'strict',
      authentication: { type: 'ssh-agent' },
    });

    const connected = await service.connect(CONNECTION_ID);
    expect(connected).toMatchObject({
      ok: true,
      connection: { status: 'connected' },
    });

    const reconnected = await service.reconnect(CONNECTION_ID);
    expect(reconnected).toMatchObject({
      ok: true,
      connection: { status: 'connected' },
    });
    expect(ssh.adapter.connect).toHaveBeenCalledTimes(2);
    expect(ssh.session.disconnect).toHaveBeenCalledOnce();

    const terminal = await service.openTerminal(CONNECTION_ID);
    expect(terminal).toMatchObject({
      ok: true,
      terminalId: 'term-remote',
    });
    expect(createTerminal).toHaveBeenCalledOnce();
    expect(writeTerminalInput).toHaveBeenCalledWith(
      'term-remote',
      expect.stringContaining("ssh -S '/tmp/control'"),
    );

    const execution = await service.execute({
      connectionId: CONNECTION_ID,
      command: 'git status --short',
      timeoutSeconds: 30,
    });
    expect(execution).toMatchObject({
      ok: true,
      stdout: 'remote output\n',
      exitCode: 0,
    });
    expect(ssh.session.execute).toHaveBeenCalledWith(
      "cd -- '/opt/build' && (git status --short)",
      30_000,
    );

    const archive = Buffer.from([0, 1, 2, 255]);
    const runnerExecution = await service.executeRunnerCommand({
      connectionId: CONNECTION_ID,
      command: 'tar -xzf -',
      timeoutMs: 30_000,
      stdin: archive,
    });
    expect(runnerExecution.ok).toBe(true);
    expect(ssh.session.execute).toHaveBeenLastCalledWith(
      "cd -- '/opt/build' && (tar -xzf -)",
      30_000,
      archive,
    );

    const tools = service.getAgentTools();
    expect(Object.keys(tools)).toEqual([
      'mcp_clodex_remote_connections',
      'mcp_clodex_remote_exec',
    ]);

    const disconnected = await service.disconnect(CONNECTION_ID);
    expect(disconnected).toMatchObject({
      ok: true,
      connection: { status: 'disconnected' },
    });
    expect(ssh.session.disconnect).toHaveBeenCalledTimes(2);

    await service.teardown();
  });

  it('coalesces runner ControlMaster setup and never falls back to one-shot SSH', async () => {
    const karton = createKarton();
    const ssh = createSshAdapter();
    const service = await RemoteConnectionsService.create({
      logger,
      karton: karton.service,
      sshAdapter: ssh.adapter,
      idGenerator: () => CONNECTION_ID,
      loadStore: async () => ({ version: 1, connections: [] }),
      saveStore: async () => undefined,
    });
    await service.save({
      name: 'Runner host',
      host: 'runner.example.com',
      port: 22,
      username: 'builder',
      remotePath: '/srv/repository',
      hostKeyPolicy: 'strict',
      authentication: { type: 'ssh-agent' },
    });

    await Promise.all([
      service.ensureRunnerControlSession(CONNECTION_ID),
      service.ensureRunnerControlSession(CONNECTION_ID),
    ]);
    expect(ssh.adapter.connect).toHaveBeenCalledOnce();

    const result = await service.executeRunnerCommand({
      connectionId: CONNECTION_ID,
      command: 'git status --short',
      timeoutMs: 30_000,
      requirePersistentSession: true,
    });
    expect(result.ok).toBe(true);
    expect(ssh.session.execute).toHaveBeenCalledWith(
      "cd -- '/srv/repository' && (git status --short)",
      30_000,
      undefined,
    );
    expect(ssh.adapter.execute).not.toHaveBeenCalled();

    await service.teardown();
  });
});
