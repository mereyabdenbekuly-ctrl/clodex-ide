import { app } from 'electron';
import type { Logger } from './logger';
import path from 'node:path';
import { DisposableService } from './disposable';
import { AUTH_CALLBACK_SCHEME } from './auth/callback-scheme';

const STABLE_APP_SCHEME = 'clodex';
const CLODEX_APP_SCHEME = 'clodex-ide';

export function resolveDefaultProtocolSchemes(options: {
  authCallbackScheme: string;
  registerDefaultProtocols: boolean;
}): string[] {
  if (!options.registerDefaultProtocols) return [];
  return Array.from(
    new Set([CLODEX_APP_SCHEME, STABLE_APP_SCHEME, options.authCallbackScheme]),
  );
}

/**
 * Service responsible for registering the app as the default protocol client for auth callback URLs.
 * This enables the OS to route configured callback scheme URLs to this app.
 *
 * Note: URL handling is done in startup/url-routing.ts.
 * This service only sets up the protocol registration.
 */
export class URIHandlerService extends DisposableService {
  private readonly logger: Logger;

  private constructor(logger: Logger) {
    super();
    this.logger = logger;
  }

  public static async create(logger: Logger): Promise<URIHandlerService> {
    const instance = new URIHandlerService(logger);
    await instance.initialize();
    logger.debug('[URIHandlerService] Created service');
    return instance;
  }

  private async initialize(): Promise<void> {
    const schemes = resolveDefaultProtocolSchemes({
      authCallbackScheme: AUTH_CALLBACK_SCHEME,
      registerDefaultProtocols: __APP_REGISTER_DEFAULT_PROTOCOLS__,
    });
    if (schemes.length === 0) {
      this.logger.debug(
        `[URIHandlerService] Default protocol registration disabled for ${__APP_DISTRIBUTION_MODE__} distribution`,
      );
      return;
    }

    for (const scheme of schemes) {
      const registered = app.setAsDefaultProtocolClient(scheme);
      if (!registered) {
        this.logger.error(
          `[URIHandlerService] Failed to register protocol client for ${scheme} (defaultApp: ${process.defaultApp ? 'yes' : 'no'})`,
        );
      }
    }

    // In development mode, we need to pass the script path for the protocol to work.
    if (process.defaultApp && process.argv.length >= 2) {
      const scriptPath = path.resolve(process.argv[1]);
      for (const scheme of schemes) {
        const registered = app.setAsDefaultProtocolClient(
          scheme,
          process.execPath,
          [scriptPath],
        );
        if (!registered) {
          this.logger.error(
            `[URIHandlerService] Failed to register development protocol client for ${scheme} (defaultApp: ${process.defaultApp ? 'yes' : 'no'}, execPath: ${process.execPath}, scriptPath: ${scriptPath})`,
          );
        }
      }
    }

    const unconfirmedSchemes = schemes.filter(
      (scheme) => !app.isDefaultProtocolClient(scheme),
    );
    if (unconfirmedSchemes.length === 0) {
      this.logger.debug(
        `[URIHandlerService] Set as default protocol client for ${schemes.join(', ')}`,
      );
    } else {
      this.logger.warn(
        `[URIHandlerService] Protocol client registration not confirmed for ${unconfirmedSchemes.join(', ')} after attempting ${schemes.join(', ')}`,
      );
    }
    for (const scheme of schemes) {
      this.logger.debug(
        `[URIHandlerService] Is default protocol client for ${scheme}: ${app.isDefaultProtocolClient(scheme) ? 'yes' : 'no'}`,
      );
    }
  }

  protected onTeardown(): void {
    this.logger.debug('[URIHandlerService] Teardown complete');
  }
}
