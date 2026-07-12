import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AutomationWakeSchedulerStatus } from '@shared/automations';
import type { Logger } from '../logger';

const execFileAsync = promisify(execFile);
const TASK_ID = 'xyz.clodex.automation-wake';
const COMMAND_TIMEOUT_MS = 15_000;

export interface NativeWakeCommandRunner {
  run(command: string, args: string[]): Promise<void>;
}

export interface NativeWakeSchedulerOptions {
  logger: Logger;
  userDataPath: string;
  executablePath: string;
  platform?: NodeJS.Platform;
  homePath?: string;
  uid?: number;
  now?: () => number;
  runner?: NativeWakeCommandRunner;
}

export interface NativeWakeRegistrationPlan {
  platform: NodeJS.Platform;
  canWakeSystem: boolean;
  files: Array<{ path: string; contents: string }>;
  unregister: Array<{ command: string; args: string[] }>;
  register: Array<{ command: string; args: string[] }>;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plistEscape(value: string): string {
  return xmlEscape(value);
}

function systemdEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function formatLocalDateTime(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(
    value.getDate(),
  )}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(
    value.getSeconds(),
  )}`;
}

export function buildNativeWakeRegistrationPlan(input: {
  platform: NodeJS.Platform;
  scheduledFor: Date;
  executablePath: string;
  userDataPath: string;
  homePath: string;
  uid: number;
}): NativeWakeRegistrationPlan {
  const {
    platform,
    scheduledFor,
    executablePath,
    userDataPath,
    homePath,
    uid,
  } = input;
  const iso = scheduledFor.toISOString();

  if (platform === 'darwin') {
    const plistPath = path.join(
      userDataPath,
      'wake-scheduler',
      `${TASK_ID}.plist`,
    );
    const local = {
      minute: scheduledFor.getMinutes(),
      hour: scheduledFor.getHours(),
      day: scheduledFor.getDate(),
      month: scheduledFor.getMonth() + 1,
    };
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${TASK_ID}</string>
  <key>ProgramArguments</key><array>
    <string>${plistEscape(executablePath)}</string>
    <string>--clodex-automation-wake</string>
    <string>${plistEscape(iso)}</string>
  </array>
  <key>StartCalendarInterval</key><dict>
    <key>Minute</key><integer>${local.minute}</integer>
    <key>Hour</key><integer>${local.hour}</integer>
    <key>Day</key><integer>${local.day}</integer>
    <key>Month</key><integer>${local.month}</integer>
  </dict>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`;
    return {
      platform,
      canWakeSystem: false,
      files: [{ path: plistPath, contents: plist }],
      unregister: [
        {
          command: '/bin/launchctl',
          args: ['bootout', `gui/${uid}/${TASK_ID}`],
        },
      ],
      register: [
        {
          command: '/bin/launchctl',
          args: ['bootstrap', `gui/${uid}`, plistPath],
        },
      ],
    };
  }

  if (platform === 'win32') {
    const xmlPath = path.join(userDataPath, 'wake-scheduler', `${TASK_ID}.xml`);
    const localStartBoundary = formatLocalDateTime(scheduledFor);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><TimeTrigger><StartBoundary>${xmlEscape(localStartBoundary)}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author"><Exec>
    <Command>${xmlEscape(executablePath)}</Command>
    <Arguments>--clodex-automation-wake ${xmlEscape(iso)}</Arguments>
  </Exec></Actions>
</Task>
`;
    return {
      platform,
      canWakeSystem: true,
      files: [{ path: xmlPath, contents: xml }],
      unregister: [
        {
          command: 'schtasks.exe',
          args: ['/Delete', '/TN', TASK_ID, '/F'],
        },
      ],
      register: [
        {
          command: 'schtasks.exe',
          args: ['/Create', '/TN', TASK_ID, '/XML', xmlPath, '/F'],
        },
      ],
    };
  }

  if (platform === 'linux') {
    const systemdDir = path.join(homePath, '.config', 'systemd', 'user');
    const servicePath = path.join(systemdDir, `${TASK_ID}.service`);
    const timerPath = path.join(systemdDir, `${TASK_ID}.timer`);
    const service = `[Unit]
Description=Launch Clodex for a scheduled automation

[Service]
Type=oneshot
ExecStart="${systemdEscape(executablePath)}" --clodex-automation-wake ${iso}
`;
    const systemdCalendar = `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
    const timer = `[Unit]
Description=Wake Clodex for its next scheduled automation

[Timer]
OnCalendar=${systemdCalendar}
Persistent=true
AccuracySec=1s
Unit=${TASK_ID}.service

[Install]
WantedBy=timers.target
`;
    return {
      platform,
      canWakeSystem: false,
      files: [
        { path: servicePath, contents: service },
        { path: timerPath, contents: timer },
      ],
      unregister: [
        {
          command: 'systemctl',
          args: ['--user', 'disable', '--now', `${TASK_ID}.timer`],
        },
      ],
      register: [
        { command: 'systemctl', args: ['--user', 'daemon-reload'] },
        {
          command: 'systemctl',
          args: ['--user', 'enable', '--now', `${TASK_ID}.timer`],
        },
      ],
    };
  }

  return {
    platform,
    canWakeSystem: false,
    files: [],
    unregister: [],
    register: [],
  };
}

class DefaultWakeCommandRunner implements NativeWakeCommandRunner {
  async run(command: string, args: string[]): Promise<void> {
    await execFileAsync(command, args, {
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        USERPROFILE: process.env.USERPROFILE,
      },
    });
  }
}

export class NativeWakeScheduler {
  private readonly platform: NodeJS.Platform;
  private readonly homePath: string;
  private readonly uid: number;
  private readonly now: () => number;
  private readonly runner: NativeWakeCommandRunner;
  private status: AutomationWakeSchedulerStatus;
  private lastSyncedWakeAt: string | null | undefined;

  public constructor(private readonly options: NativeWakeSchedulerOptions) {
    this.platform = options.platform ?? process.platform;
    this.homePath = options.homePath ?? os.homedir();
    this.uid = options.uid ?? process.getuid?.() ?? 0;
    this.now = options.now ?? Date.now;
    this.runner = options.runner ?? new DefaultWakeCommandRunner();
    this.status = this.unavailableStatus(null, 'No native wake is registered.');
  }

  public getStatus(): AutomationWakeSchedulerStatus {
    return structuredClone(this.status);
  }

  public async sync(nextWakeAt: string | null): Promise<void> {
    if (
      this.lastSyncedWakeAt === nextWakeAt &&
      (this.status.mode === 'native' || nextWakeAt === null)
    ) {
      return;
    }
    if (!['darwin', 'linux', 'win32'].includes(this.platform)) {
      this.status = this.unavailableStatus(
        nextWakeAt,
        `Native wake is unsupported on ${this.platform}.`,
      );
      return;
    }

    const scheduledFor = nextWakeAt ? new Date(nextWakeAt) : null;
    if (
      scheduledFor &&
      (!Number.isFinite(scheduledFor.getTime()) ||
        scheduledFor.getTime() <= this.now())
    ) {
      this.status = this.unavailableStatus(
        nextWakeAt,
        'Native wake refused an invalid or past timestamp.',
      );
      return;
    }

    const plan = buildNativeWakeRegistrationPlan({
      platform: this.platform,
      scheduledFor: scheduledFor ?? new Date(this.now() + 60_000),
      executablePath: this.options.executablePath,
      userDataPath: this.options.userDataPath,
      homePath: this.homePath,
      uid: this.uid,
    });

    try {
      for (const command of plan.unregister) {
        await this.runner
          .run(command.command, command.args)
          .catch(() => undefined);
      }
      if (!scheduledFor) {
        for (const file of plan.files) {
          await fs.rm(file.path, { force: true });
        }
        this.status = this.unavailableStatus(
          null,
          'No enabled automation requires a native wake.',
        );
        this.lastSyncedWakeAt = null;
        return;
      }
      for (const file of plan.files) {
        await fs.mkdir(path.dirname(file.path), {
          recursive: true,
          mode: 0o700,
        });
        await fs.writeFile(file.path, file.contents, { mode: 0o600 });
      }
      for (const command of plan.register) {
        await this.runner.run(command.command, command.args);
      }
      this.status = {
        platform: this.platform,
        mode: 'native',
        canWakeSystem: plan.canWakeSystem,
        scheduledFor: scheduledFor.toISOString(),
        registeredAt: new Date(this.now()).toISOString(),
        message: plan.canWakeSystem
          ? 'The operating system will wake and launch Clodex for this run.'
          : 'The operating system will launch Clodex at the due time or immediately after resume.',
      };
      this.lastSyncedWakeAt = nextWakeAt;
    } catch (error) {
      this.options.logger.warn(
        '[NativeWakeScheduler] Native registration failed; resume reconciliation remains active',
        error,
      );
      this.status = {
        platform: this.platform,
        mode: 'resume-only',
        canWakeSystem: false,
        scheduledFor: scheduledFor?.toISOString() ?? null,
        registeredAt: null,
        message:
          error instanceof Error
            ? `Native wake unavailable: ${error.message}`
            : 'Native wake unavailable; resume reconciliation remains active.',
      };
      this.lastSyncedWakeAt = undefined;
    }
  }

  private unavailableStatus(
    scheduledFor: string | null,
    message: string,
  ): AutomationWakeSchedulerStatus {
    return {
      platform: this.platform,
      mode: 'unavailable',
      canWakeSystem: false,
      scheduledFor,
      registeredAt: null,
      message,
    };
  }
}
