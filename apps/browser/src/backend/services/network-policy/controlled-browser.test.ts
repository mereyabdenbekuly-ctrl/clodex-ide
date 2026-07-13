import type { AuthInfo, ProxyConfig } from 'electron';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  session: { fromPartition: vi.fn() },
}));

import {
  ControlledBrowserEgressSession,
  createControlledBrowserNetworkPolicy,
  createControlledBrowserTabEgressOptions,
  enforceControlledBrowserWebRtcPolicy,
  parseControlledBrowserAllowedHosts,
} from './controlled-browser';
import { evaluateNetworkPolicy } from '.';

describe('ControlledBrowserEgressSession', () => {
  it('installs fail-closed routing before the authenticated managed proxy', async () => {
    const proxyConfigs: ProxyConfig[] = [];
    const target = {
      setProxy: vi.fn(async (config: ProxyConfig) => {
        proxyConfigs.push(config);
      }),
      clearHostResolverCache: vi.fn(async () => undefined),
      closeAllConnections: vi.fn(async () => undefined),
    };

    const controlled = await ControlledBrowserEgressSession.create({
      capability: {
        url: 'http://127.0.0.1:4319',
        authorization: `Basic ${Buffer.from('clodex:secret-token').toString(
          'base64',
        )}`,
      },
      browserSession: target,
    });

    expect(proxyConfigs).toEqual([
      {
        mode: 'fixed_servers',
        proxyRules: 'http://127.0.0.1:9',
        proxyBypassRules: '<-loopback>',
      },
      {
        mode: 'fixed_servers',
        proxyRules: 'http://127.0.0.1:4319',
        proxyBypassRules: '<-loopback>',
      },
    ]);
    expect(target.clearHostResolverCache).toHaveBeenCalledTimes(2);
    expect(target.closeAllConnections).toHaveBeenCalledTimes(2);
    expect(controlled.managedProxyActive).toBe(true);

    await controlled.refreshNetworkBoundary();
    expect(target.clearHostResolverCache).toHaveBeenCalledTimes(3);
    expect(target.closeAllConnections).toHaveBeenCalledTimes(3);

    await controlled.teardown();
    expect(proxyConfigs.at(-1)?.proxyRules).toBe('http://127.0.0.1:9');
    expect(controlled.managedProxyActive).toBe(false);
  });

  it('answers only the exact managed proxy authentication challenge', async () => {
    const controlled = await ControlledBrowserEgressSession.create({
      capability: {
        url: 'http://127.0.0.1:4319',
        authorization: `Basic ${Buffer.from('clodex:secret-token').toString(
          'base64',
        )}`,
      },
      browserSession: {
        setProxy: async () => undefined,
        clearHostResolverCache: async () => undefined,
        closeAllConnections: async () => undefined,
      },
    });
    const callback = vi.fn();

    expect(
      controlled.handleProxyAuthentication(
        proxyAuth({ host: '127.0.0.1', port: 4319 }),
        callback,
      ),
    ).toBe(true);
    expect(callback).toHaveBeenCalledWith('clodex', 'secret-token');

    callback.mockClear();
    expect(
      controlled.handleProxyAuthentication(
        proxyAuth({ host: '127.0.0.1', port: 4320 }),
        callback,
      ),
    ).toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });

  it('keeps the dead proxy installed when managed capability validation fails', async () => {
    const proxyConfigs: ProxyConfig[] = [];
    await expect(
      ControlledBrowserEgressSession.create({
        capability: {
          url: 'http://127.0.0.1:4319',
          authorization: 'Bearer invalid',
        },
        browserSession: {
          setProxy: async (config) => {
            proxyConfigs.push(config);
          },
          clearHostResolverCache: async () => undefined,
          closeAllConnections: async () => undefined,
        },
      }),
    ).rejects.toThrow('requires Basic authentication');
    expect(proxyConfigs).toEqual([
      {
        mode: 'fixed_servers',
        proxyRules: 'http://127.0.0.1:9',
        proxyBypassRules: '<-loopback>',
      },
    ]);
  });
});

describe('controlled browser policy', () => {
  it('disables default-session favicon fetches for controlled tabs', () => {
    const proxyAuthenticationHandler = vi.fn(() => false);

    expect(
      createControlledBrowserTabEgressOptions(proxyAuthenticationHandler),
    ).toEqual({
      proxyAuthenticationHandler,
      allowFaviconNetworkFetch: false,
    });
  });

  it('disables WebRTC UDP paths that cannot traverse the managed proxy', () => {
    const setWebRTCIPHandlingPolicy = vi.fn();
    enforceControlledBrowserWebRtcPolicy({ setWebRTCIPHandlingPolicy });
    expect(setWebRTCIPHandlingPolicy).toHaveBeenCalledWith(
      'disable_non_proxied_udp',
    );
  });

  it('allows public web egress while denying local network classes by default', () => {
    const policy = createControlledBrowserNetworkPolicy();
    expect(policy).toMatchObject({
      mode: 'unrestricted',
      allowedPorts: [80, 443],
      allowPrivateNetworks: false,
      allowLoopback: false,
      allowIpLiterals: false,
    });
    expect(
      evaluateNetworkPolicy(policy, 'https://docs.example.com').decision,
    ).toBe('allow');
    expect(evaluateNetworkPolicy(policy, 'http://127.0.0.1')).toMatchObject({
      decision: 'deny',
      reason: 'loopback-denied',
    });
    expect(
      evaluateNetworkPolicy(policy, 'https://docs.example.com:8443'),
    ).toMatchObject({
      decision: 'deny',
      reason: 'port-not-allowed',
    });
  });

  it('supports an enterprise host allowlist from the environment', () => {
    expect(
      createControlledBrowserNetworkPolicy(
        parseControlledBrowserAllowedHosts(
          'docs.example.com, *.example.org,docs.example.com',
        ),
      ),
    ).toMatchObject({
      mode: 'allowlist',
      allowedHosts: ['docs.example.com', '*.example.org'],
    });
  });
});

function proxyAuth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    isProxy: true,
    scheme: 'basic',
    host: '127.0.0.1',
    port: 4319,
    realm: 'clodex-egress',
    ...overrides,
  };
}
