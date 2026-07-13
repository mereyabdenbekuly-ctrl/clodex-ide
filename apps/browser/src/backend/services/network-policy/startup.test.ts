import { vi } from 'vitest';

vi.mock('electron', () => ({
  session: { fromPartition: vi.fn() },
}));

import type { ResolvedMcpTransport } from '@clodex/mcp-runtime';
import type { FeatureGateId } from '@shared/feature-gates';
import type { PersistentNetworkEgressGrant } from '@shared/network-egress-control';
import {
  DEFAULT_DENY_NETWORK_POLICY,
  type NetworkPolicyDestinationGrant,
} from '@shared/network-policy';
import { describe, expect, it } from 'vitest';
import type { NetworkPolicyEngine } from '.';
import {
  CONTROLLED_BROWSER_PRINCIPAL_ID,
  type ControlledBrowserEgressSession,
} from './controlled-browser';
import {
  initializeGuardianEgressStartup,
  type GuardianEgressStartupDependencies,
} from './startup';
import type {
  EgressProxyCapability,
  TransparentEgressProxy,
} from './transparent-proxy';

const EGRESS_FEATURES = [
  'egress-policy-engine',
  'egress-transparent-proxy',
  'egress-controlled-browser',
  'egress-control-center',
] as const satisfies readonly FeatureGateId[];

function createLogger() {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function expectEnabled<T extends { readonly enabled: boolean }>(
  value: T,
): asserts value is Extract<T, { readonly enabled: true }> {
  expect(value.enabled).toBe(true);
  if (!value.enabled) throw new Error('Expected startup binding to be enabled');
}

function createHarness({
  managedProxyActive = true,
  refreshError,
  now = 10_000,
}: {
  managedProxyActive?: boolean;
  refreshError?: Error;
  now?: number;
} = {}) {
  const browserCapability: EgressProxyCapability = {
    url: 'http://127.0.0.1:4319',
    authorization: 'Basic browser-capability',
  };
  const mcpCapability: EgressProxyCapability = {
    url: 'http://127.0.0.1:4319',
    authorization: 'Basic mcp-capability',
  };
  const engine = {
    evaluate: vi.fn(),
  } as unknown as NetworkPolicyEngine;
  const issueCapability = vi.fn((scope: { principalKind: string }) =>
    scope.principalKind === 'browser' ? browserCapability : mcpCapability,
  );
  const revokeCapability = vi.fn();
  const proxy = {
    issueCapability,
    revokeCapability,
    teardown: vi.fn(async () => undefined),
  } as unknown as TransparentEgressProxy;
  const handleProxyAuthentication = vi.fn(() => false);
  const refreshNetworkBoundary = refreshError
    ? vi.fn(async () => {
        throw refreshError;
      })
    : vi.fn(async () => undefined);
  const engageFailClosed = vi.fn(async () => undefined);
  const session = {
    handleProxyAuthentication,
    managedProxyActive,
    refreshNetworkBoundary,
    engageFailClosed,
    teardown: vi.fn(async () => undefined),
  } as unknown as ControlledBrowserEgressSession;
  const dependencies: GuardianEgressStartupDependencies = {
    createNetworkPolicyEngine: vi.fn(async () => engine),
    createTransparentEgressProxy: vi.fn(async () => proxy),
    createControlledBrowserEgressSession: vi.fn(async () => session),
    now: vi.fn(() => now),
  };

  return {
    browserCapability,
    mcpCapability,
    engine,
    proxy,
    session,
    issueCapability,
    revokeCapability,
    handleProxyAuthentication,
    refreshNetworkBoundary,
    engageFailClosed,
    dependencies,
  };
}

async function start({
  enabledFeatures = EGRESS_FEATURES,
  grants = [],
  allowedHosts,
  harness = createHarness(),
}: {
  enabledFeatures?: readonly FeatureGateId[];
  grants?: readonly PersistentNetworkEgressGrant[];
  allowedHosts?: string;
  harness?: ReturnType<typeof createHarness>;
} = {}) {
  const logger = createLogger();
  const enabled = new Set(enabledFeatures);
  const isFeatureEnabled = vi.fn((feature: FeatureGateId) =>
    enabled.has(feature),
  );
  const getBrowserGrants = vi.fn(() => grants);
  const getAuditPath = vi.fn(() => '/tmp/network-policy-audit.jsonl');
  const result = await initializeGuardianEgressStartup({
    logger,
    isFeatureEnabled,
    getBrowserGrants,
    getAuditPath,
    controlledBrowserAllowedHosts: allowedHosts,
    dependencies: harness.dependencies,
  });
  return {
    result,
    logger,
    isFeatureEnabled,
    getBrowserGrants,
    getAuditPath,
    harness,
  };
}

describe('initializeGuardianEgressStartup', () => {
  it('does not initialize managed egress when every feature is disabled', async () => {
    const started = await start({ enabledFeatures: [] });

    expect(
      started.isFeatureEnabled.mock.calls.map(([feature]) => feature),
    ).toEqual(EGRESS_FEATURES);
    expect(started.getBrowserGrants).not.toHaveBeenCalled();
    expect(started.getAuditPath).not.toHaveBeenCalled();
    expect(
      started.harness.dependencies.createNetworkPolicyEngine,
    ).not.toHaveBeenCalled();
    expect(
      started.harness.dependencies.createTransparentEgressProxy,
    ).not.toHaveBeenCalled();
    expect(
      started.harness.dependencies.createControlledBrowserEgressSession,
    ).not.toHaveBeenCalled();
    expect(started.result.networkPolicyEvaluator).toBeNull();
    expect(started.result.transparentEgressProxy).toBeNull();
    expect(started.result.controlledBrowserEgressSession).toBeNull();
    expect(started.result.controlledBrowserTabEgressOptions).toBeUndefined();
    expect(started.result.controlCenter).toEqual({ enabled: false });
    expect(started.result.remoteMcp).toEqual({ enabled: false });
  });

  it('does not expose remote MCP or control-center bindings for browser-only egress', async () => {
    const harness = createHarness();
    const started = await start({
      harness,
      enabledFeatures: ['egress-policy-engine', 'egress-controlled-browser'],
      grants: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          scope: 'persistent',
          protocol: 'http',
          hostname: 'localhost',
          port: 3000,
          createdAt: 1,
          expiresAt: null,
        },
      ],
    });
    const engineOptions = vi.mocked(
      harness.dependencies.createNetworkPolicyEngine,
    ).mock.calls[0]?.[0];

    expect(started.getBrowserGrants).not.toHaveBeenCalled();
    expect(
      harness.dependencies.createTransparentEgressProxy,
    ).toHaveBeenCalledWith({ engine: harness.engine });
    expect(started.result.remoteMcp).toEqual({ enabled: false });
    expect(started.result.controlCenter).toEqual({ enabled: false });
    await expect(
      Promise.resolve(
        engineOptions?.resolvePolicy?.({
          principalKind: 'browser',
          principalId: CONTROLLED_BROWSER_PRINCIPAL_ID,
        }),
      ),
    ).resolves.toMatchObject({ allowedDestinations: [] });
  });

  it('keeps controlled browser startup fail closed when the engine is unavailable', async () => {
    const harness = createHarness({ managedProxyActive: false });
    const initializationError = new Error('audit unavailable');
    harness.dependencies.createNetworkPolicyEngine = vi.fn(async () => {
      throw initializationError;
    });

    const started = await start({ harness });
    const controlCenter = started.result.controlCenter;
    const remoteMcp = started.result.remoteMcp;
    expectEnabled(controlCenter);
    expectEnabled(remoteMcp);

    expect(started.getAuditPath).toHaveBeenCalledOnce();
    expect(
      harness.dependencies.createTransparentEgressProxy,
    ).not.toHaveBeenCalled();
    expect(
      harness.dependencies.createControlledBrowserEgressSession,
    ).toHaveBeenCalledWith({ capability: null });
    expect(started.result.transparentEgressProxy).toBeNull();
    expect(started.result.controlledBrowserEgressSession).toBe(harness.session);
    await expect(
      started.result.networkPolicyEvaluator?.evaluate({} as never),
    ).rejects.toThrow(
      'Network policy engine is unavailable; managed network egress blocked',
    );
    expect(controlCenter.getBrowserPolicy()).toBeNull();
    expect(started.result.controlledBrowserTabEgressOptions).toEqual({
      proxyAuthenticationHandler: harness.handleProxyAuthentication,
      allowFaviconNetworkFetch: false,
    });
    expect(controlCenter.getRuntimeStatus()).toEqual({
      policyEngineEnabled: true,
      policyEngineAvailable: false,
      proxyRequired: true,
      proxyAvailable: false,
      controlledBrowserEnabled: true,
      controlledBrowserActive: false,
    });
    expect(
      remoteMcp.resolveNetworkProxy('stdio', {
        type: 'stdio',
        command: 'node',
        args: [],
        env: {},
      }),
    ).toBeUndefined();
    expect(() =>
      remoteMcp.resolveNetworkProxy('remote-test', {
        type: 'streamable-http',
        url: 'https://mcp.example.com/v1',
        headers: {},
      }),
    ).toThrow(
      'Transparent egress proxy is unavailable; remote MCP connection blocked',
    );
    expect(started.logger.error).toHaveBeenNthCalledWith(
      1,
      '[NetworkPolicyEngine] Initialization failed; managed network egress will fail closed',
      initializationError,
    );
    expect(started.logger.error).toHaveBeenNthCalledWith(
      2,
      '[TransparentEgressProxy] Policy engine is unavailable; controlled runtimes will fail closed',
    );
    expect(started.logger.warn).toHaveBeenCalledWith(
      '[ControlledBrowserEgress] Managed proxy unavailable; browser networking is fail closed',
    );
  });

  it('initializes policies, browser routing, grants, and MCP capabilities on success', async () => {
    const harness = createHarness();
    const grants: PersistentNetworkEgressGrant[] = [
      {
        id: '00000000-0000-4000-8000-000000000001',
        scope: 'persistent',
        protocol: 'http',
        hostname: 'localhost',
        port: 3000,
        createdAt: 1,
        expiresAt: null,
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        scope: 'persistent',
        protocol: 'https',
        hostname: 'future.example.com',
        port: 443,
        createdAt: 2,
        expiresAt: 20_000,
      },
      {
        id: '00000000-0000-4000-8000-000000000003',
        scope: 'persistent',
        protocol: 'https',
        hostname: 'expired.example.com',
        port: 443,
        createdAt: 3,
        expiresAt: 10_000,
      },
    ];
    const started = await start({
      harness,
      grants,
      allowedHosts: ' docs.example.com,*.example.org,docs.example.com ',
    });
    const controlCenter = started.result.controlCenter;
    const remoteMcp = started.result.remoteMcp;
    expectEnabled(controlCenter);
    expectEnabled(remoteMcp);
    const engineOptions = vi.mocked(
      harness.dependencies.createNetworkPolicyEngine,
    ).mock.calls[0]?.[0];

    expect(engineOptions?.auditPath).toBe('/tmp/network-policy-audit.jsonl');
    expect(harness.dependencies.now).toHaveBeenCalledTimes(2);
    expect(
      harness.dependencies.createTransparentEgressProxy,
    ).toHaveBeenCalledWith({ engine: harness.engine });
    expect(harness.issueCapability).toHaveBeenNthCalledWith(1, {
      principalKind: 'browser',
      principalId: CONTROLLED_BROWSER_PRINCIPAL_ID,
    });
    expect(
      harness.dependencies.createControlledBrowserEgressSession,
    ).toHaveBeenCalledWith({ capability: harness.browserCapability });
    expect(started.result.networkPolicyEvaluator).toBe(harness.engine);
    expect(started.result.transparentEgressProxy).toBe(harness.proxy);
    expect(started.result.controlledBrowserEgressSession).toBe(harness.session);
    expect(started.result.controlledBrowserTabEgressOptions).toEqual({
      proxyAuthenticationHandler: harness.handleProxyAuthentication,
      allowFaviconNetworkFetch: false,
    });
    expect(controlCenter.getRuntimeStatus()).toEqual({
      policyEngineEnabled: true,
      policyEngineAvailable: true,
      proxyRequired: true,
      proxyAvailable: true,
      controlledBrowserEnabled: true,
      controlledBrowserActive: true,
    });
    expect(controlCenter.getBrowserPolicy()).toEqual({
      id: 'controlled-browser',
      version: 1,
      mode: 'allowlist',
      allowedHosts: ['docs.example.com', '*.example.org'],
      allowedPorts: [80, 443],
      allowedDestinations: [
        { protocol: 'http', hostname: 'localhost', port: 3000 },
        {
          protocol: 'https',
          hostname: 'future.example.com',
          port: 443,
          expiresAt: 20_000,
        },
      ],
      allowPrivateNetworks: false,
      allowLoopback: false,
      allowIpLiterals: false,
    });
    expect(started.logger.debug).toHaveBeenCalledWith(
      '[ControlledBrowserEgress] Browser session routed through managed proxy (2 allowed host pattern(s))',
    );

    const replacementGrants: NetworkPolicyDestinationGrant[] = [
      { protocol: 'http', hostname: '127.0.0.1', port: 4318 },
    ];
    await controlCenter.applyBrowserGrants(replacementGrants);
    expect(harness.refreshNetworkBoundary).toHaveBeenCalledOnce();
    expect(controlCenter.getBrowserPolicy()).toMatchObject({
      version: 2,
      allowedDestinations: replacementGrants,
    });

    expect(
      remoteMcp.resolveNetworkProxy('stdio', {
        type: 'stdio',
        command: 'node',
        args: [],
        env: {},
      }),
    ).toBeUndefined();
    const remoteTransport = {
      type: 'streamable-http',
      url: 'https://mcp.example.com/v1',
      headers: {},
    } satisfies ResolvedMcpTransport;
    expect(remoteMcp.resolveNetworkProxy('remote-test', remoteTransport)).toBe(
      harness.mcpCapability,
    );
    expect(harness.issueCapability).toHaveBeenNthCalledWith(2, {
      principalKind: 'mcp',
      principalId: 'mcp:remote-test',
    });
    await expect(
      Promise.resolve(
        engineOptions?.resolvePolicy?.({
          principalKind: 'mcp',
          principalId: 'mcp:remote-test',
        }),
      ),
    ).resolves.toMatchObject({
      id: 'mcp-remote:remote-test',
      allowedHosts: ['mcp.example.com'],
      allowedPorts: [443],
    });

    remoteMcp.revokeNetworkProxy('remote-test', harness.mcpCapability);
    expect(harness.revokeCapability).toHaveBeenCalledWith(
      harness.mcpCapability,
    );
    await expect(
      Promise.resolve(
        engineOptions?.resolvePolicy?.({
          principalKind: 'mcp',
          principalId: 'mcp:remote-test',
        }),
      ),
    ).resolves.toBe(DEFAULT_DENY_NETWORK_POLICY);
  });

  it('revokes browser capability and engages fail-closed routing on refresh failure', async () => {
    const refreshError = new Error('connection drain failed');
    const harness = createHarness({ refreshError });
    const started = await start({ harness });
    const controlCenter = started.result.controlCenter;
    expectEnabled(controlCenter);
    const updatedGrant: NetworkPolicyDestinationGrant = {
      protocol: 'https',
      hostname: 'temporary.example.com',
      port: 443,
    };

    await expect(controlCenter.applyBrowserGrants([updatedGrant])).rejects.toBe(
      refreshError,
    );

    expect(controlCenter.getBrowserPolicy()).toMatchObject({
      version: 2,
      allowedDestinations: [updatedGrant],
    });
    expect(harness.revokeCapability).toHaveBeenCalledWith(
      harness.browserCapability,
    );
    expect(harness.engageFailClosed).toHaveBeenCalledOnce();
    expect(controlCenter.getRuntimeStatus().controlledBrowserActive).toBe(
      false,
    );
    expect(started.logger.error).toHaveBeenCalledWith(
      '[ControlledBrowserEgress] Policy refresh failed; engaging fail-closed routing',
      refreshError,
    );
  });
});
