import unhandled from 'electron-unhandled';
unhandled();

import { app, dialog, protocol } from 'electron';
import started from 'electron-squirrel-startup';
import path from 'node:path';
import {
  installStartupOpenFileListener,
  installStartupOpenUrlListener,
} from './startup-url-events';

// CRITICAL: `main` is imported dynamically (below in the 'ready' handler)
// instead of statically. On Windows machines without the VC++ redistributable
// installed system-wide, static imports eagerly load native .node addons
// (@libsql, sharp, etc.) whose transitive vcruntime140.dll dependency cannot be
// resolved when the process is launched by Squirrel's Update.exe (different
// working directory). Keeping the import dynamic ensures Squirrel install/
// uninstall/update events are handled cleanly without touching native code.

const isSmokeTest = process.argv.includes('--smoke-test');
const isMcpPackagedAcceptanceRequested = process.argv.includes(
  '--mcp-packaged-acceptance-local',
);

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const appBaseName = (() => {
  switch (__APP_RELEASE_CHANNEL__) {
    case 'release':
      return 'clodex';
    case 'nightly':
      return 'clodex-nightly';
    case 'prerelease':
      return 'clodex-prerelease';
    case 'dev':
    default:
      return 'clodex-dev';
  }
})();

const appName = (() => {
  switch (__APP_RELEASE_CHANNEL__) {
    case 'release':
      return 'Clodex Agentic IDE';
    case 'nightly':
      return 'Clodex Agentic IDE Nightly';
    case 'prerelease':
      return 'Clodex Agentic IDE (Pre-Release)';
    case 'dev':
    default:
      return 'Clodex Agentic IDE (Dev-Build)';
  }
})();

// Set the app name for macOS menu bar
app.setName(appName);
if (process.platform === 'win32') {
  app.setAppUserModelId(`com.squirrel.${appBaseName}.${appBaseName}`);
}
app.applicationMenu = null;
installStartupOpenUrlListener();
installStartupOpenFileListener();

// Keep the channel-specific userData path by default, while honoring Electron's
// standard override for isolated smoke profiles and managed deployments.
const userDataOverride = app.commandLine.getSwitchValue('user-data-dir').trim();
const isMcpPackagedAcceptance =
  isMcpPackagedAcceptanceRequested &&
  app.isPackaged &&
  userDataOverride.length > 0 &&
  isPathInside(app.getPath('temp'), path.resolve(userDataOverride));
app.setPath(
  'userData',
  userDataOverride
    ? path.resolve(userDataOverride)
    : path.join(app.getPath('appData'), appBaseName),
);
app.setPath('sessionData', path.join(app.getPath('userData'), 'session'));

// Register custom protocols as privileged (must happen before app.ready)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'clodex',
    privileges: {
      standard: true,
      secure: true,
      allowServiceWorkers: true,
      codeCache: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'attachment',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'workspace',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'plans',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const singleInstanceLock =
  isMcpPackagedAcceptanceRequested || app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
// `ready` can fire while the ESM entry bundle is still being evaluated.
// `whenReady()` also resolves for late subscribers, so packaged builds cannot
// miss startup entirely before this handler is registered.
void app
  .whenReady()
  .then(async () => {
    // Don't load native modules during Squirrel install/uninstall events.
    // The process is about to quit — loading them would crash on Windows
    // machines without system-wide VC++ redistributable.
    if (started) return;

    if (isMcpPackagedAcceptanceRequested && !isMcpPackagedAcceptance) {
      console.error(
        'MCP_PACKAGED_ACCEPTANCE status=failed reason=local-mode-denied',
      );
      app.exit(1);
      return;
    }

    if (isSmokeTest) {
      // Validate the full import tree is intact, then exit.
      await import('./main');
      console.log('[smoke-test] App ready — all modules loaded successfully.');
      app.exit(0);
      return;
    }

    if (isMcpPackagedAcceptance) {
      const [{ runPackagedMcpAcceptance }, { MCP_PACKAGED_ACCEPTANCE_MARKER }] =
        await Promise.all([
          import('./mcp-acceptance/run'),
          import('../shared/mcp-packaged-acceptance'),
        ]);
      const report = await runPackagedMcpAcceptance({
        nodeExecutable: app.commandLine
          .getSwitchValue('mcp-acceptance-node')
          .trim(),
        fixturePath: app.commandLine
          .getSwitchValue('mcp-acceptance-fixture')
          .trim(),
      });
      console.log(`${MCP_PACKAGED_ACCEPTANCE_MARKER}${JSON.stringify(report)}`);
      app.exit(report.status === 'passed' ? 0 : 1);
      return;
    }

    const { main } = await import('./main');
    await main({ launchOptions: { verbose: true } });
  })
  .catch((error: unknown) => {
    if (isMcpPackagedAcceptanceRequested) {
      console.error(
        'MCP_PACKAGED_ACCEPTANCE status=failed reason=startup-failed',
      );
      app.exit(1);
      return;
    }
    const message =
      error instanceof Error ? error.message : 'Unknown startup failure';
    console.error('[Clodex] Startup failed', error);
    dialog.showErrorBox(
      'Clodex could not start',
      `${message}\n\nIf this persists, verify that macOS Keychain is unlocked and restart Clodex.`,
    );
    app.exit(1);
  });

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  // macOS apps typically keep the app running when all windows are closed but I (glenn) think that is bs so we'll quit the app when all windows are closed - no matter which platform.
  app.quit();
});

app.on('activate', () => {});

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), candidatePath);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
