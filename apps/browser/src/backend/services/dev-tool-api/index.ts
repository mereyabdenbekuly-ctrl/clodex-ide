import type { Logger } from '../logger';
import type { KartonService } from '../karton';
import type { WindowLayoutService } from '../window-layout';
import { DisposableService } from '../disposable';

/**
 * Options for the getScreenshot method
 */
export interface GetScreenshotOptions {
  /** The tab ID to capture. If not provided, uses the active tab. */
  tabId?: string;
  /** Image format (default: 'png') */
  format?: 'png' | 'jpeg' | 'webp';
  /** Image quality (0-100) for jpeg/webp formats (default: 80) */
  quality?: number;
  /** Capture the full page (scrollable area) instead of just the viewport */
  fullPage?: boolean;
  /** Clip area to capture (in CSS pixels) */
  clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Result of a screenshot capture operation
 */
export interface GetScreenshotResult {
  success: boolean;
  /** Base64-encoded image data (without data URL prefix) */
  data?: string;
  error?: string;
}

/**
 * DevToolAPI Service
 *
 * Responsible for:
 * - Managing the devTools sub-state within the UI state contract
 * - Handling all server procedures related to dev tools (clodex toolbar and Chrome DevTools)
 * - Providing access to tab webcontents and debugger for future devtools functionality
 *
 * This service centralizes all devtools-related functionality and will be extended
 * to offer additional capabilities that devtools need (console, network, etc.)
 */
export class DevToolAPIService extends DisposableService {
  private readonly logger: Logger;
  private readonly uiKarton: KartonService;
  private readonly windowLayoutService: WindowLayoutService;

  private constructor(
    logger: Logger,
    uiKarton: KartonService,
    windowLayoutService: WindowLayoutService,
  ) {
    super();
    this.logger = logger;
    this.uiKarton = uiKarton;
    this.windowLayoutService = windowLayoutService;
  }

  public static async create(
    logger: Logger,
    uiKarton: KartonService,
    windowLayoutService: WindowLayoutService,
  ): Promise<DevToolAPIService> {
    const service = new DevToolAPIService(
      logger,
      uiKarton,
      windowLayoutService,
    );
    await service.initialize();
    return service;
  }

  private async initialize(): Promise<void> {
    this.registerProcedureHandlers();
    this.logger.debug('[DevToolAPIService] Initialized');
  }

  private registerProcedureHandlers(): void {
    // Clodex DevTools (toolbar) procedures
    this.uiKarton.registerServerProcedureHandler(
      'browser.devTools.toggle',
      async (_callingClientId: string, tabId?: string) => {
        await this.toggleDevTools(tabId);
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'browser.devTools.open',
      async (_callingClientId: string, tabId?: string) => {
        await this.openDevTools(tabId);
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'browser.devTools.close',
      async (_callingClientId: string, tabId?: string) => {
        await this.closeDevTools(tabId);
      },
    );

    // Chrome DevTools (CDP) procedures
    this.uiKarton.registerServerProcedureHandler(
      'browser.devTools.chrome.toggle',
      async (_callingClientId: string, tabId?: string) => {
        await this.toggleChromeDevTools(tabId);
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'browser.devTools.chrome.open',
      async (_callingClientId: string, tabId?: string) => {
        await this.openChromeDevTools(tabId);
      },
    );

    this.uiKarton.registerServerProcedureHandler(
      'browser.devTools.chrome.close',
      async (_callingClientId: string, tabId?: string) => {
        await this.closeChromeDevTools(tabId);
      },
    );

    // Screenshot procedure
    this.uiKarton.registerServerProcedureHandler(
      'browser.devTools.getScreenshot',
      async (_callingClientId: string, options?: GetScreenshotOptions) => {
        return await this.getScreenshot(options);
      },
    );
  }

  /**
   * Toggle the clodex dev toolbar visibility for a tab
   */
  private async toggleDevTools(tabId?: string): Promise<void> {
    this.logger.debug(
      `[DevToolAPIService] toggleDevTools called with tabId: ${tabId}`,
    );
    const tab = this.windowLayoutService.getTab(tabId);
    tab?.toggleDevTools();
  }

  /**
   * Open the clodex dev toolbar for a tab
   */
  private async openDevTools(tabId?: string): Promise<void> {
    this.logger.debug(
      `[DevToolAPIService] openDevTools called with tabId: ${tabId}`,
    );
    const tab = this.windowLayoutService.getTab(tabId);
    tab?.openDevTools();
  }

  /**
   * Close the clodex dev toolbar for a tab
   */
  private async closeDevTools(tabId?: string): Promise<void> {
    this.logger.debug(
      `[DevToolAPIService] closeDevTools called with tabId: ${tabId}`,
    );
    const tab = this.windowLayoutService.getTab(tabId);
    tab?.closeDevTools();
  }

  /**
   * Toggle Chrome DevTools for a tab
   */
  private async toggleChromeDevTools(tabId?: string): Promise<void> {
    this.logger.debug(
      `[DevToolAPIService] toggleChromeDevTools called with tabId: ${tabId}`,
    );
    const tab = this.windowLayoutService.getTab(tabId);
    tab?.toggleChromeDevTools();
  }

  /**
   * Open Chrome DevTools for a tab
   */
  private async openChromeDevTools(tabId?: string): Promise<void> {
    this.logger.debug(
      `[DevToolAPIService] openChromeDevTools called with tabId: ${tabId}`,
    );
    const tab = this.windowLayoutService.getTab(tabId);
    tab?.openChromeDevTools();
  }

  /**
   * Close Chrome DevTools for a tab
   */
  private async closeChromeDevTools(tabId?: string): Promise<void> {
    this.logger.debug(
      `[DevToolAPIService] closeChromeDevTools called with tabId: ${tabId}`,
    );
    const tab = this.windowLayoutService.getTab(tabId);
    tab?.closeChromeDevTools();
  }

  // ============================================================================
  // WebContents and Debugger Access
  // ============================================================================

  /**
   * Get the webcontents for a tab.
   * This provides access to the tab's web content for devtools functionality.
   *
   * @param tabId - Optional tab ID. If not provided, uses the active tab.
   * @returns The WebContents instance or undefined if tab not found
   */
  public getTabWebContents(tabId?: string) {
    const tab = this.windowLayoutService.getTab(tabId);
    return tab?.getViewContainer().webContents;
  }

  /**
   * Get the debugger instance for a tab's webcontents.
   * This provides access to the Chrome DevTools Protocol for devtools functionality.
   *
   * @param tabId - Optional tab ID. If not provided, uses the active tab.
   * @returns The Debugger instance or undefined if tab not found
   */
  public getTabDebugger(tabId?: string) {
    const webContents = this.getTabWebContents(tabId);
    return webContents?.debugger;
  }

  /**
   * Check if the debugger is attached to a tab's webcontents.
   *
   * @param tabId - Optional tab ID. If not provided, uses the active tab.
   * @returns True if debugger is attached, false otherwise
   */
  public isDebuggerAttached(tabId?: string): boolean {
    const debugger_ = this.getTabDebugger(tabId);
    return debugger_?.isAttached() ?? false;
  }

  // ============================================================================
  // Screenshot API
  // ============================================================================

  /**
   * Capture a screenshot of a tab using the Chrome DevTools Protocol.
   *
   * @param options - Screenshot options
   * @returns Promise resolving to an object with success status and base64 data or error
   */
  public async getScreenshot(
    options?: GetScreenshotOptions,
  ): Promise<GetScreenshotResult> {
    const tabId = options?.tabId;
    const format = options?.format ?? 'png';
    const quality = options?.quality ?? 100;
    const fullPage = options?.fullPage ?? false;
    const clip = options?.clip;

    this.logger.debug(
      `[DevToolAPIService] getScreenshot called with tabId: ${tabId}, format: ${format}`,
    );

    const webContents = this.getTabWebContents(tabId);

    if (!webContents) {
      return { success: false, error: 'Tab not found' };
    }

    if (webContents.isDestroyed()) {
      return { success: false, error: 'Tab is destroyed' };
    }

    const debugger_ = webContents.debugger;

    if (!debugger_.isAttached()) {
      return { success: false, error: 'Debugger not attached' };
    }

    try {
      // Build the CDP command parameters
      const captureParams: {
        format: 'png' | 'jpeg' | 'webp';
        quality?: number;
        captureBeyondViewport?: boolean;
        clip?: {
          x: number;
          y: number;
          width: number;
          height: number;
          scale: number;
        };
      } = {
        format,
      };

      // Quality only applies to jpeg and webp
      if (format === 'jpeg' || format === 'webp') {
        captureParams.quality = quality;
      }

      // For full page capture, we need to capture beyond viewport
      if (fullPage) {
        captureParams.captureBeyondViewport = true;
      }

      // If a clip region is specified, add it with scale 1
      if (clip) {
        captureParams.clip = {
          x: clip.x,
          y: clip.y,
          width: clip.width,
          height: clip.height,
          scale: 1,
        };
      }

      // Execute the CDP command
      const result = await debugger_.sendCommand(
        'Page.captureScreenshot',
        captureParams,
      );

      if (!result.data) {
        return { success: false, error: 'No screenshot data returned' };
      }

      this.logger.debug(
        `[DevToolAPIService] Screenshot captured successfully, size: ${Math.round(result.data.length / 1024)}KB`,
      );

      return { success: true, data: result.data };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[DevToolAPIService] Failed to capture screenshot: ${errorMessage}`,
      );
      return { success: false, error: errorMessage };
    }
  }

  // ============================================================================
  // Teardown
  // ============================================================================

  protected onTeardown(): void {
    // Unregister all procedure handlers
    this.uiKarton.removeServerProcedureHandler('browser.devTools.toggle');
    this.uiKarton.removeServerProcedureHandler('browser.devTools.open');
    this.uiKarton.removeServerProcedureHandler('browser.devTools.close');
    this.uiKarton.removeServerProcedureHandler(
      'browser.devTools.chrome.toggle',
    );
    this.uiKarton.removeServerProcedureHandler('browser.devTools.chrome.open');
    this.uiKarton.removeServerProcedureHandler('browser.devTools.chrome.close');
    this.uiKarton.removeServerProcedureHandler(
      'browser.devTools.getScreenshot',
    );

    this.logger.debug('[DevToolAPIService] Torn down');
  }
}
