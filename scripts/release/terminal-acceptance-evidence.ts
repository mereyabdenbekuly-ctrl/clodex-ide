export type TerminalAcceptanceCheckStatus = 'fail' | 'pass' | 'pending';

export interface TerminalAcceptanceCheck {
  durationMs?: number;
  status: TerminalAcceptanceCheckStatus;
}

export interface TerminalAcceptanceManifest {
  schemaVersion: 1;
  status: 'failed' | 'passed';
  reasonCode?: string;
  contentFree: true;
  checks: {
    packagedLaunch: TerminalAcceptanceCheck & {
      cdpConnected: boolean;
      isolatedProfile: boolean;
    };
    terminalUi: TerminalAcceptanceCheck & {
      inputFocused: boolean;
      openedViaUi: boolean;
    };
    command: TerminalAcceptanceCheck & {
      enteredViaUi: boolean;
      outputObserved: boolean;
    };
    ptyExit: TerminalAcceptanceCheck & {
      exitCode: number | null;
      terminalRemoved: boolean;
    };
    appShutdown: TerminalAcceptanceCheck & {
      exitCode: number | null;
      servicesShutDown: boolean;
    };
  };
}

export function createInitialTerminalAcceptanceManifest(): TerminalAcceptanceManifest {
  return {
    schemaVersion: 1,
    status: 'failed',
    contentFree: true,
    checks: {
      packagedLaunch: {
        cdpConnected: false,
        isolatedProfile: false,
        status: 'pending',
      },
      terminalUi: {
        inputFocused: false,
        openedViaUi: false,
        status: 'pending',
      },
      command: {
        enteredViaUi: false,
        outputObserved: false,
        status: 'pending',
      },
      ptyExit: {
        exitCode: null,
        status: 'pending',
        terminalRemoved: false,
      },
      appShutdown: {
        exitCode: null,
        servicesShutDown: false,
        status: 'pending',
      },
    },
  };
}

export function serializeTerminalAcceptanceManifest(
  manifest: TerminalAcceptanceManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
