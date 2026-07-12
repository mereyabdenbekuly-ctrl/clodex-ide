import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../logger';
import {
  buildNativeWakeRegistrationPlan,
  NativeWakeScheduler,
} from './native-wake';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('native automation wake registration', () => {
  it('builds a Windows task with WakeToRun and no shell interpolation', () => {
    const plan = buildNativeWakeRegistrationPlan({
      platform: 'win32',
      scheduledFor: new Date('2026-07-12T04:30:00.000Z'),
      executablePath: 'C:\\Program Files\\Clodex\\Clodex.exe',
      userDataPath: 'C:\\Users\\test\\AppData\\Roaming\\Clodex',
      homePath: 'C:\\Users\\test',
      uid: 0,
    });

    expect(plan.canWakeSystem).toBe(true);
    expect(plan.files[0]?.contents).toContain('<WakeToRun>true</WakeToRun>');
    expect(plan.register[0]).toMatchObject({
      command: 'schtasks.exe',
      args: expect.arrayContaining(['/Create', '/XML']),
    });
  });

  it('uses a launchd calendar job without privileged pmset commands', () => {
    const plan = buildNativeWakeRegistrationPlan({
      platform: 'darwin',
      scheduledFor: new Date('2026-07-12T04:30:00.000Z'),
      executablePath: '/Applications/Clodex.app/Contents/MacOS/Clodex',
      userDataPath: '/Users/test/Library/Application Support/Clodex',
      homePath: '/Users/test',
      uid: 501,
    });

    expect(plan.canWakeSystem).toBe(false);
    expect(plan.register[0]?.command).toBe('/bin/launchctl');
    expect(
      [...plan.register, ...plan.unregister].some(({ command }) =>
        command.includes('pmset'),
      ),
    ).toBe(false);
  });

  it('uses an explicit UTC systemd calendar expression', () => {
    const plan = buildNativeWakeRegistrationPlan({
      platform: 'linux',
      scheduledFor: new Date('2026-07-12T04:30:00.000Z'),
      executablePath: '/opt/clodex/clodex',
      userDataPath: '/home/test/.config/Clodex',
      homePath: '/home/test',
      uid: 1_000,
    });

    expect(
      plan.files.find((file) => file.path.endsWith('.timer'))?.contents,
    ).toContain('OnCalendar=2026-07-12 04:30:00 UTC');
  });

  it('persists a protected registration and reports native status', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clodex-wake-test-'));
    temporaryDirectories.push(root);
    const calls: Array<{ command: string; args: string[] }> = [];
    const scheduler = new NativeWakeScheduler({
      logger: { warn: vi.fn() } as unknown as Logger,
      platform: 'linux',
      userDataPath: root,
      homePath: root,
      executablePath: '/opt/clodex/clodex',
      now: () => Date.parse('2026-07-11T10:00:00.000Z'),
      runner: {
        run: async (command, args) => {
          calls.push({ command, args });
        },
      },
    });

    await scheduler.sync('2026-07-11T11:00:00.000Z');

    expect(scheduler.getStatus()).toMatchObject({
      mode: 'native',
      canWakeSystem: false,
      scheduledFor: '2026-07-11T11:00:00.000Z',
    });
    expect(calls).toContainEqual({
      command: 'systemctl',
      args: ['--user', 'enable', '--now', 'xyz.clodex.automation-wake.timer'],
    });
    await expect(
      fs.stat(
        path.join(
          root,
          '.config',
          'systemd',
          'user',
          'xyz.clodex.automation-wake.timer',
        ),
      ),
    ).resolves.toBeDefined();
  });
});
