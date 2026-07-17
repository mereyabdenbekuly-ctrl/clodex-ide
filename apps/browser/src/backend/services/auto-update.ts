/**
 * AutoUpdateService - Handles automatic app updates using Electron's autoUpdater.
 *
 * This service is responsible for:
 * - Checking for updates from the configured update server
 * - Downloading updates automatically when available
 * - Notifying the user when an update is ready to install
 * - Triggering app restart to install updates
 *
 * Platform support: macOS and Windows only (Linux is not supported by Electron's autoUpdater)
 */

import { autoUpdater } from 'electron';
import { DisposableService } from './disposable';
import type { Logger } from './logger';
import type { NotificationService } from './notification';
import type { TelemetryService } from './telemetry';
import type { PreferencesService } from './preferences';
import type { KartonService } from './karton';
import type { UpdateChannel } from '@shared/karton-contracts/ui/shared-types';
import {
  buildUpdateFeedURL,
  inferPrereleaseUpdateChannel,
  resolveUpdateArchitecture,
  resolveUpdateChannel,
  resolveUpdatePlatform,
} from './auto-update-config';

declare const __APP_RELEASE_CHANNEL__:
  | 'dev'
  | 'prerelease'
  | 'nightly'
  | 'release';
declare const __APP_VERSION__: string;
declare const __APP_PLATFORM__: string;
declare const __APP_ARCH__: string;
declare const __APP_DISTRIBUTION_MODE__:
  | 'official'
  | 'community-unsigned'
  | 'community-observed';
declare const __APP_AUTO_UPDATE_ENABLED__: boolean;

export class AutoUpdateService extends DisposableService {
  private readonly logger: Logger;
  private readonly notificationService: NotificationService;
  private readonly telemetryService: TelemetryService;
  private readonly preferencesService: PreferencesService;
  private readonly uiKarton: KartonService;
  private updateDownloaded = false;
  private updateNotificationId: string | null = null;
  private updateInfo: {
    releaseName?: string;
    releaseNotes?: string;
    releaseDate?: Date;
    updateURL?: string;
  } | null = null;

  // Check for updates every 30 minutes
  private readonly UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
  private updateCheckIntervalId: ReturnType<typeof setInterval> | null = null;

  private constructor(
    logger: Logger,
    notificationService: NotificationService,
    telemetryService: TelemetryService,
    preferencesService: PreferencesService,
    uiKarton: KartonService,
  ) {
    super();
    this.logger = logger;
    this.notificationService = notificationService;
    this.telemetryService = telemetryService;
    this.preferencesService = preferencesService;
    this.uiKarton = uiKarton;
  }

  private report(
    error: Error,
    operation: string,
    extra?: Record<string, unknown>,
  ) {
    this.telemetryService.captureException(error, {
      service: 'auto-update',
      operation,
      ...extra,
    });
  }

  public static async create(
    logger: Logger,
    notificationService: NotificationService,
    telemetryService: TelemetryService,
    preferencesService: PreferencesService,
    uiKarton: KartonService,
  ): Promise<AutoUpdateService> {
    const instance = new AutoUpdateService(
      logger,
      notificationService,
      telemetryService,
      preferencesService,
      uiKarton,
    );
    await instance.initialize();
    return instance;
  }

  private async initialize(): Promise<void> {
    if (!__APP_AUTO_UPDATE_ENABLED__) {
      this.logger.debug(
        `[AutoUpdateService] Auto-updates disabled for ${__APP_DISTRIBUTION_MODE__} distribution`,
      );
      this.setAutoUpdateState('unsupported');
      return;
    }

    // Only run on macOS and Windows
    const platform = this.getPlatform();
    if (platform !== 'macos' && platform !== 'win') {
      this.logger.debug(
        '[AutoUpdateService] Auto-updates not supported on this platform, skipping initialization',
      );
      this.setAutoUpdateState('unsupported');
      return;
    }

    // Don't run in dev builds - they shouldn't auto-update
    if (__APP_RELEASE_CHANNEL__ === 'dev') {
      this.logger.debug(
        '[AutoUpdateService] Auto-updates disabled for dev builds, skipping initialization',
      );
      this.setAutoUpdateState('unsupported');
      return;
    }

    const feedURL = this.buildFeedURL();
    if (!feedURL) {
      this.logger.warn(
        '[AutoUpdateService] Could not build feed URL, auto-updates disabled',
      );
      return;
    }

    this.logger.debug(
      `[AutoUpdateService] Initializing with feed URL: ${feedURL}`,
    );

    try {
      // Set up event handlers before setting feed URL
      this.setupEventHandlers();

      // Configure the auto updater
      autoUpdater.setFeedURL({ url: feedURL });

      this.logger.debug('[AutoUpdateService] Feed URL configured successfully');

      // Don't check immediately on first launch (Squirrel.Windows lock issue)
      // Wait 10 seconds before first check
      setTimeout(() => {
        if (!this.disposed) {
          this.checkForUpdates();
        }
      }, 10000);

      // Set up periodic update checks
      this.updateCheckIntervalId = setInterval(() => {
        if (!this.disposed) {
          this.checkForUpdates();
        }
      }, this.UPDATE_CHECK_INTERVAL_MS);

      // Listen for preference changes to update the feed URL when channel changes
      this.preferencesService.addListener((newPrefs, oldPrefs) => {
        if (newPrefs.updateChannel !== oldPrefs.updateChannel) {
          this.onUpdateChannelChanged();
        }
      });

      // Register Karton procedure handlers
      this.uiKarton.registerServerProcedureHandler(
        'autoUpdate.checkForUpdates',
        async (_callingClientId: string) => {
          this.checkForUpdates();
        },
      );
      this.uiKarton.registerServerProcedureHandler(
        'autoUpdate.quitAndInstall',
        async (_callingClientId: string) => {
          this.quitAndInstall();
        },
      );
    } catch (error) {
      this.logger.error(
        '[AutoUpdateService] Failed to initialize auto-updater',
        error,
      );
      this.report(error as Error, 'initialize');
    }
  }

  /**
   * Called when the user changes the update channel preference.
   * Re-configures the feed URL and triggers an immediate update check.
   */
  private onUpdateChannelChanged(): void {
    const feedURL = this.buildFeedURL();
    if (!feedURL) {
      this.logger.warn(
        '[AutoUpdateService] Could not build feed URL after channel change',
      );
      return;
    }

    this.logger.debug(
      `[AutoUpdateService] Update channel changed, new feed URL: ${feedURL}`,
    );

    try {
      autoUpdater.setFeedURL({ url: feedURL });

      // Reset downloaded state so the guard in checkForUpdates() allows
      // re-checking against the new channel's update feed.
      this.updateDownloaded = false;
      this.updateInfo = null;
      this.setAutoUpdateState('idle');

      // Re-start periodic checks if they were stopped after a previous download
      if (!this.updateCheckIntervalId) {
        this.updateCheckIntervalId = setInterval(() => {
          if (!this.disposed) this.checkForUpdates();
        }, this.UPDATE_CHECK_INTERVAL_MS);
      }

      // Trigger an immediate check with the new channel
      this.checkForUpdates();
    } catch (error) {
      this.logger.error(
        '[AutoUpdateService] Failed to reconfigure feed URL after channel change',
        error,
      );
      this.report(error as Error, 'onUpdateChannelChanged');
    }
  }

  private getPlatform(): 'macos' | 'win' | 'linux' {
    return resolveUpdatePlatform(__APP_PLATFORM__);
  }

  private getArch(): 'arm64' | 'x64' {
    return resolveUpdateArchitecture(__APP_ARCH__);
  }

  /**
   * Infer the default update channel from the installed version string.
   * e.g. "1.0.0-alpha003" → 'alpha', "1.0.0-beta001" → 'beta'
   */
  private inferChannelFromVersion(): UpdateChannel | null {
    return inferPrereleaseUpdateChannel(__APP_VERSION__);
  }

  /**
   * Get the effective update channel for the update server.
   * For release builds, always use 'release'.
   * For prerelease builds, use the user's configured channel or infer from version.
   */
  private getReleaseChannel(): string | null {
    const prefs = this.preferencesService.get();
    return resolveUpdateChannel({
      distributionMode: __APP_DISTRIBUTION_MODE__,
      releaseChannel: __APP_RELEASE_CHANNEL__,
      version: __APP_VERSION__,
      preference:
        __APP_RELEASE_CHANNEL__ === 'prerelease'
          ? (prefs.updateChannel ?? this.inferChannelFromVersion() ?? undefined)
          : undefined,
    });
  }

  private buildFeedURL(): string | null {
    const feedURL = buildUpdateFeedURL({
      distributionMode: __APP_DISTRIBUTION_MODE__,
      origin: process.env.UPDATE_SERVER_ORIGIN,
      releaseChannel: __APP_RELEASE_CHANNEL__,
      version: __APP_VERSION__,
      platform: __APP_PLATFORM__,
      architecture: __APP_ARCH__,
      preference:
        __APP_RELEASE_CHANNEL__ === 'prerelease'
          ? this.preferencesService.get().updateChannel
          : undefined,
    });
    if (!feedURL) {
      this.logger.warn(
        '[AutoUpdateService] Auto-update feed is unavailable for this build or UPDATE_SERVER_ORIGIN is missing or invalid',
      );
      return null;
    }

    const platform = this.getPlatform();
    const arch = this.getArch();
    const channel = this.getReleaseChannel();

    this.logger.debug(
      `[AutoUpdateService] Built feed URL: ${feedURL} (platform: ${platform}, arch: ${arch}, channel: ${channel}, version: ${__APP_VERSION__})`,
    );

    return feedURL;
  }

  private setupEventHandlers(): void {
    autoUpdater.on('error', (error: Error) => {
      this.logger.error('[AutoUpdateService] Update error:', error);
      this.logger.debug(`[AutoUpdateService] Error message: ${error.message}`);
      this.logger.debug(`[AutoUpdateService] Error stack: ${error.stack}`);
      this.report(error, 'autoUpdaterError');
      this.setAutoUpdateState('error', null, error.message);
    });

    autoUpdater.on('checking-for-update', () => {
      this.logger.debug('[AutoUpdateService] Checking for updates...');
      this.setAutoUpdateState('checking');
    });

    autoUpdater.on('update-available', () => {
      this.logger.debug(
        '[AutoUpdateService] Update available, download starting automatically',
      );
      this.setAutoUpdateState('downloading');
    });

    autoUpdater.on('update-not-available', () => {
      this.logger.debug(
        '[AutoUpdateService] No update available, app is up to date',
      );
      this.setAutoUpdateState('not-available');
    });

    autoUpdater.on(
      'update-downloaded',
      (_event, releaseNotes, releaseName, releaseDate, updateURL) => {
        this.updateDownloaded = true;
        this.updateInfo = {
          releaseName,
          releaseNotes,
          releaseDate,
          updateURL,
        };

        this.logger.debug('[AutoUpdateService] Update downloaded successfully');
        this.logger.debug(`[AutoUpdateService] Release name: ${releaseName}`);
        this.logger.debug(`[AutoUpdateService] Release notes: ${releaseNotes}`);
        this.logger.debug(`[AutoUpdateService] Release date: ${releaseDate}`);
        this.logger.debug(`[AutoUpdateService] Update URL: ${updateURL}`);

        // Stop periodic checks — no need to re-check once an update is ready
        if (this.updateCheckIntervalId) {
          clearInterval(this.updateCheckIntervalId);
          this.updateCheckIntervalId = null;
        }

        // Show notification to user
        this.showUpdateReadyNotification(releaseName);

        // Sync state to UI
        this.setAutoUpdateState('ready', {
          releaseName,
          releaseNotes,
        });
      },
    );

    autoUpdater.on('before-quit-for-update', () => {
      this.logger.debug(
        '[AutoUpdateService] App is about to quit to install update',
      );
    });
  }

  private showUpdateReadyNotification(releaseName: string): void {
    const versionDisplay = releaseName || 'a new version';

    // Dismiss any previous update notification before showing a new one
    if (this.updateNotificationId)
      this.notificationService.dismissNotification(this.updateNotificationId);

    this.updateNotificationId = this.notificationService.showNotification({
      title: 'Update Ready',
      message: `${versionDisplay} has been downloaded and is ready to install.`,
      type: 'info',
      actions: [
        {
          label: 'Restart & Install Now',
          type: 'primary',
          onClick: () => {
            this.quitAndInstall();
          },
        },
        {
          label: 'Later',
          type: 'secondary',
          onClick: () => {
            this.logger.debug(
              '[AutoUpdateService] User chose to install update later',
            );
          },
        },
      ],
    });
  }

  /**
   * Manually trigger an update check
   */
  public checkForUpdates(): void {
    this.assertNotDisposed();

    if (!__APP_AUTO_UPDATE_ENABLED__) {
      this.logger.debug(
        `[AutoUpdateService] Ignoring update check for ${__APP_DISTRIBUTION_MODE__} distribution`,
      );
      return;
    }

    if (this.updateDownloaded) {
      this.logger.debug(
        '[AutoUpdateService] Skipping update check - update already downloaded and ready to install',
      );
      return;
    }

    const platform = this.getPlatform();
    if (platform !== 'macos' && platform !== 'win') {
      this.logger.debug(
        '[AutoUpdateService] Cannot check for updates on unsupported platform',
      );
      return;
    }

    this.logger.debug('[AutoUpdateService] Manually triggering update check');
    try {
      autoUpdater.checkForUpdates();
    } catch (error) {
      this.logger.error(
        '[AutoUpdateService] Error checking for updates:',
        error,
      );
      this.report(error as Error, 'checkForUpdates');
    }
  }

  /**
   * Quit the app and install the downloaded update
   */
  public quitAndInstall(): void {
    this.assertNotDisposed();

    if (!this.updateDownloaded) {
      this.logger.warn(
        '[AutoUpdateService] Cannot quit and install - no update has been downloaded',
      );
      return;
    }

    this.logger.debug(
      '[AutoUpdateService] Quitting app and installing update...',
    );
    autoUpdater.quitAndInstall();
  }

  /**
   * Check if an update has been downloaded and is ready to install
   */
  public isUpdateReady(): boolean {
    return this.updateDownloaded;
  }

  /**
   * Get information about the downloaded update
   */
  public getUpdateInfo(): typeof this.updateInfo {
    return this.updateInfo;
  }

  /**
   * Push auto-update status to the UI via Karton state.
   */
  private setAutoUpdateState(
    status:
      | 'idle'
      | 'checking'
      | 'downloading'
      | 'ready'
      | 'not-available'
      | 'error'
      | 'unsupported',
    updateInfo?: { releaseName?: string; releaseNotes?: string } | null,
    errorMessage?: string | null,
  ): void {
    this.uiKarton.setState((draft) => {
      draft.autoUpdate.status = status;
      if (updateInfo !== undefined) {
        draft.autoUpdate.updateInfo = updateInfo;
      }
      draft.autoUpdate.errorMessage = errorMessage ?? null;
    });
  }

  protected onTeardown(): void {
    if (this.updateCheckIntervalId) {
      clearInterval(this.updateCheckIntervalId);
      this.updateCheckIntervalId = null;
    }
    this.uiKarton.removeServerProcedureHandler('autoUpdate.checkForUpdates');
    this.uiKarton.removeServerProcedureHandler('autoUpdate.quitAndInstall');
    this.logger.debug('[AutoUpdateService] Teardown complete');
  }
}
