import type { AuthInfo, ProxyConfig, WebContents } from 'electron';
import { session } from 'electron';
import type {
  NetworkPolicy,
  NetworkPolicyDestinationGrant,
} from '@shared/network-policy';
import { DisposableService } from '../disposable';
import type { EgressProxyCapability } from './transparent-proxy';

export const CONTROLLED_BROWSER_PARTITION = 'persist:browser-content';
export const CONTROLLED_BROWSER_PRINCIPAL_ID = 'browser:shared-session';

const FAIL_CLOSED_PROXY_URL = 'http://127.0.0.1:9';
const NO_IMPLICIT_LOOPBACK_BYPASS = '<-loopback>';

export type ProxyAuthenticationHandler = (
  authInfo: AuthInfo,
  callback: (username?: string, password?: string) => void,
) => boolean;

export interface ControlledBrowserTabEgressOptions {
  proxyAuthenticationHandler?: ProxyAuthenticationHandler;
}

interface BrowserSessionProxyTarget {
  setProxy(config: ProxyConfig): Promise<void>;
  clearHostResolverCache(): Promise<void>;
  closeAllConnections(): Promise<void>;
}

export interface ControlledBrowserEgressOptions {
  capability: EgressProxyCapability | null;
  browserSession?: BrowserSessionProxyTarget;
}

export class ControlledBrowserEgressSession extends DisposableService {
  private constructor(
    private readonly browserSession: BrowserSessionProxyTarget,
    private proxyEndpoint: URL | null = null,
    private credentials: { username: string; password: string } | null = null,
  ) {
    super();
  }

  public static async create(
    options: ControlledBrowserEgressOptions,
  ): Promise<ControlledBrowserEgressSession> {
    const browserSession =
      options.browserSession ??
      (session.fromPartition(
        CONTROLLED_BROWSER_PARTITION,
      ) as BrowserSessionProxyTarget);
    const instance = new ControlledBrowserEgressSession(browserSession);

    // Install a dead loopback proxy first. If the managed proxy configuration
    // fails, Chromium remains unable to fall back to direct networking.
    await instance.applyProxy(FAIL_CLOSED_PROXY_URL);
    if (options.capability) {
      const parsed = parseBrowserProxyCapability(options.capability);
      instance.proxyEndpoint = parsed.endpoint;
      instance.credentials = parsed.credentials;
      await instance.applyProxy(options.capability.url);
    }
    return instance;
  }

  public readonly handleProxyAuthentication: ProxyAuthenticationHandler = (
    authInfo,
    callback,
  ) => {
    if (
      !authInfo.isProxy ||
      !this.proxyEndpoint ||
      !this.credentials ||
      normalizeProxyHostname(authInfo.host) !==
        normalizeProxyHostname(this.proxyEndpoint.hostname) ||
      authInfo.port !== Number(this.proxyEndpoint.port || 80)
    ) {
      return false;
    }
    callback(this.credentials.username, this.credentials.password);
    return true;
  };

  public get managedProxyActive(): boolean {
    return this.proxyEndpoint !== null && this.credentials !== null;
  }

  protected async onTeardown(): Promise<void> {
    await this.engageFailClosed();
  }

  /**
   * Drops Chromium resolver state and live sockets after an in-memory policy
   * change so a revoked grant cannot keep using an already-open tunnel.
   */
  public async refreshNetworkBoundary(): Promise<void> {
    await this.clearNetworkState();
  }

  public async engageFailClosed(): Promise<void> {
    this.proxyEndpoint = null;
    this.credentials = null;
    await this.applyProxy(FAIL_CLOSED_PROXY_URL);
  }

  private async applyProxy(proxyUrl: string): Promise<void> {
    await this.browserSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: proxyUrl,
      proxyBypassRules: NO_IMPLICIT_LOOPBACK_BYPASS,
    });
    await this.clearNetworkState();
  }

  private async clearNetworkState(): Promise<void> {
    await Promise.all([
      this.browserSession.clearHostResolverCache(),
      this.browserSession.closeAllConnections(),
    ]);
  }
}

export function createControlledBrowserNetworkPolicy(
  allowedHosts: readonly string[] = [],
  allowedDestinations: readonly NetworkPolicyDestinationGrant[] = [],
  version = 1,
): NetworkPolicy {
  const hosts = [...new Set(allowedHosts.map((host) => host.trim()))].filter(
    Boolean,
  );
  return {
    id: 'controlled-browser',
    version,
    mode: hosts.length > 0 ? 'allowlist' : 'unrestricted',
    allowedHosts: hosts,
    allowedPorts: [80, 443],
    allowedDestinations: [...allowedDestinations],
    allowPrivateNetworks: false,
    allowLoopback: false,
    allowIpLiterals: false,
  };
}

export function parseControlledBrowserAllowedHosts(
  value: string | undefined,
): string[] {
  if (!value) return [];
  return [...new Set(value.split(',').map((host) => host.trim()))].filter(
    Boolean,
  );
}

export function enforceControlledBrowserWebRtcPolicy(
  webContents: Pick<WebContents, 'setWebRTCIPHandlingPolicy'>,
): void {
  webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
}

function parseBrowserProxyCapability(capability: EgressProxyCapability): {
  endpoint: URL;
  credentials: { username: string; password: string };
} {
  const endpoint = new URL(capability.url);
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash ||
    !isLoopbackProxyHostname(endpoint.hostname)
  ) {
    throw new Error('Controlled browser proxy must be an HTTP loopback URL');
  }
  const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(capability.authorization);
  if (!match) {
    throw new Error('Controlled browser proxy requires Basic authentication');
  }
  const decoded = Buffer.from(match[1] ?? '', 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 1 || separator === decoded.length - 1) {
    throw new Error('Controlled browser proxy credentials are malformed');
  }
  return {
    endpoint,
    credentials: {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    },
  };
}

function normalizeProxyHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function isLoopbackProxyHostname(hostname: string): boolean {
  const normalized = normalizeProxyHostname(hostname);
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}
