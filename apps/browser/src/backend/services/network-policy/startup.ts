import type {
  McpNetworkProxyConfig,
  ResolvedMcpTransport,
} from '@clodex/mcp-runtime';
import type { FeatureGateId } from '@shared/feature-gates';
import {
  toNetworkPolicyDestinationGrant,
  type PersistentNetworkEgressGrant,
} from '@shared/network-egress-control';
import {
  DEFAULT_DENY_NETWORK_POLICY,
  type NetworkPolicy,
  type NetworkPolicyDestinationGrant,
  type NetworkPolicyEvaluator,
} from '@shared/network-policy';
import { NetworkPolicyEngine } from '.';
import {
  CONTROLLED_BROWSER_PRINCIPAL_ID,
  ControlledBrowserEgressSession,
  createControlledBrowserNetworkPolicy,
  createControlledBrowserTabEgressOptions,
  parseControlledBrowserAllowedHosts,
  type ControlledBrowserTabEgressOptions,
} from './controlled-browser';
import type { NetworkEgressRuntimeStatus } from './control-center';
import { createRemoteMcpNetworkPolicy } from './mcp-policy';
import {
  type EgressProxyCapability,
  TransparentEgressProxy,
} from './transparent-proxy';

export interface GuardianEgressFeatureFlags {
  readonly egressPolicyEnabled: boolean;
  readonly remoteMcpProxyEnabled: boolean;
  readonly controlledBrowserEgressEnabled: boolean;
  readonly egressControlCenterEnabled: boolean;
}

export interface GuardianEgressStartupDependencies {
  createNetworkPolicyEngine: typeof NetworkPolicyEngine.create;
  createTransparentEgressProxy: typeof TransparentEgressProxy.create;
  createControlledBrowserEgressSession: typeof ControlledBrowserEgressSession.create;
  now: () => number;
}

interface GuardianEgressLogger {
  debug(message: string): void;
  warn(message: string, error?: unknown): void;
  error(message: string, error?: unknown): void;
}

export interface GuardianEgressStartupOptions {
  logger: GuardianEgressLogger;
  isFeatureEnabled: (feature: FeatureGateId) => boolean;
  getBrowserGrants: () => readonly PersistentNetworkEgressGrant[];
  getAuditPath: () => string;
  controlledBrowserAllowedHosts?: string;
  dependencies?: GuardianEgressStartupDependencies;
}

export type GuardianEgressControlCenterStartup =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly getRuntimeStatus: () => NetworkEgressRuntimeStatus;
      readonly getBrowserPolicy: () => NetworkPolicy | null;
      readonly applyBrowserGrants: (
        grants: readonly NetworkPolicyDestinationGrant[],
      ) => Promise<void>;
    };

export type GuardianEgressRemoteMcpStartup =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly resolveNetworkProxy: (
        serverId: string,
        transport: ResolvedMcpTransport,
      ) => McpNetworkProxyConfig | undefined;
      readonly revokeNetworkProxy: (
        serverId: string,
        proxy: McpNetworkProxyConfig,
      ) => void;
    };

export interface GuardianEgressStartupResult {
  readonly networkPolicyEvaluator: NetworkPolicyEvaluator | null;
  readonly transparentEgressProxy: Pick<
    TransparentEgressProxy,
    'teardown'
  > | null;
  readonly controlledBrowserEgressSession: Pick<
    ControlledBrowserEgressSession,
    'teardown'
  > | null;
  readonly controlledBrowserTabEgressOptions:
    | ControlledBrowserTabEgressOptions
    | undefined;
  readonly controlCenter: GuardianEgressControlCenterStartup;
  readonly remoteMcp: GuardianEgressRemoteMcpStartup;
}

const DEFAULT_DEPENDENCIES: GuardianEgressStartupDependencies = {
  createNetworkPolicyEngine: (options) => NetworkPolicyEngine.create(options),
  createTransparentEgressProxy: (options) =>
    TransparentEgressProxy.create(options),
  createControlledBrowserEgressSession: (options) =>
    ControlledBrowserEgressSession.create(options),
  now: () => Date.now(),
};

class GuardianEgressStartupState implements GuardianEgressStartupResult {
  private readonly networkPolicies = new Map<string, NetworkPolicy>();
  private networkPolicyEngine: NetworkPolicyEngine | null = null;
  private evaluator: NetworkPolicyEvaluator | null = null;
  private egressProxy: TransparentEgressProxy | null = null;
  private browserSession: ControlledBrowserEgressSession | null = null;
  private browserCapability: EgressProxyCapability | null = null;
  private browserPolicyVersion = 1;

  public constructor(
    private readonly featureFlags: GuardianEgressFeatureFlags,
    private readonly controlledBrowserAllowedHosts: readonly string[],
    private readonly logger: GuardianEgressLogger,
    private readonly dependencies: GuardianEgressStartupDependencies,
  ) {}

  public get networkPolicyEvaluator(): NetworkPolicyEvaluator | null {
    return this.evaluator;
  }

  public get transparentEgressProxy(): TransparentEgressProxy | null {
    return this.egressProxy;
  }

  public get controlledBrowserEgressSession(): ControlledBrowserEgressSession | null {
    return this.browserSession;
  }

  public get controlledBrowserTabEgressOptions():
    | ControlledBrowserTabEgressOptions
    | undefined {
    return this.featureFlags.controlledBrowserEgressEnabled
      ? createControlledBrowserTabEgressOptions(
          this.browserSession?.handleProxyAuthentication,
        )
      : undefined;
  }

  public get controlCenter(): GuardianEgressControlCenterStartup {
    return this.featureFlags.egressControlCenterEnabled
      ? {
          enabled: true,
          getRuntimeStatus: this.getRuntimeStatus,
          getBrowserPolicy: this.getBrowserPolicy,
          applyBrowserGrants: this.applyBrowserGrants,
        }
      : { enabled: false };
  }

  public get remoteMcp(): GuardianEgressRemoteMcpStartup {
    return this.featureFlags.remoteMcpProxyEnabled
      ? {
          enabled: true,
          resolveNetworkProxy: this.resolveMcpNetworkProxy,
          revokeNetworkProxy: this.revokeMcpNetworkProxy,
        }
      : { enabled: false };
  }

  public async initialize(
    getAuditPath: () => string,
    initialControlledBrowserGrants: readonly NetworkPolicyDestinationGrant[],
  ): Promise<void> {
    if (this.featureFlags.egressPolicyEnabled) {
      try {
        this.networkPolicyEngine =
          await this.dependencies.createNetworkPolicyEngine({
            auditPath: getAuditPath(),
            resolvePolicy: (scope) =>
              this.networkPolicies.get(scope.principalId) ??
              DEFAULT_DENY_NETWORK_POLICY,
          });
        this.evaluator = this.networkPolicyEngine;
      } catch (error) {
        this.logger.error(
          '[NetworkPolicyEngine] Initialization failed; managed network egress will fail closed',
          error,
        );
        this.evaluator = {
          evaluate: async () => {
            throw new Error(
              'Network policy engine is unavailable; managed network egress blocked',
            );
          },
        };
      }
    }

    if (
      this.featureFlags.remoteMcpProxyEnabled ||
      this.featureFlags.controlledBrowserEgressEnabled
    ) {
      if (!this.networkPolicyEngine) {
        this.logger.error(
          '[TransparentEgressProxy] Policy engine is unavailable; controlled runtimes will fail closed',
        );
      } else {
        try {
          this.egressProxy =
            await this.dependencies.createTransparentEgressProxy({
              engine: this.networkPolicyEngine,
            });
        } catch (error) {
          this.logger.error(
            '[TransparentEgressProxy] Initialization failed; controlled runtimes will fail closed',
            error,
          );
        }
      }
    }

    if (this.featureFlags.controlledBrowserEgressEnabled) {
      if (this.egressProxy) {
        this.networkPolicies.set(
          CONTROLLED_BROWSER_PRINCIPAL_ID,
          createControlledBrowserNetworkPolicy(
            this.controlledBrowserAllowedHosts,
            initialControlledBrowserGrants,
            this.browserPolicyVersion,
          ),
        );
        try {
          this.browserCapability = this.egressProxy.issueCapability({
            principalKind: 'browser',
            principalId: CONTROLLED_BROWSER_PRINCIPAL_ID,
          });
        } catch (error) {
          this.networkPolicies.delete(CONTROLLED_BROWSER_PRINCIPAL_ID);
          this.logger.error(
            '[ControlledBrowserEgress] Capability issuance failed; browser networking will fail closed',
            error,
          );
        }
      }
      try {
        this.browserSession =
          await this.dependencies.createControlledBrowserEgressSession({
            capability: this.browserCapability,
          });
        if (this.browserCapability) {
          this.logger.debug(
            `[ControlledBrowserEgress] Browser session routed through managed proxy (${this.controlledBrowserAllowedHosts.length > 0 ? `${this.controlledBrowserAllowedHosts.length} allowed host pattern(s)` : 'public web ports 80/443'})`,
          );
        } else {
          this.logger.warn(
            '[ControlledBrowserEgress] Managed proxy unavailable; browser networking is fail closed',
          );
        }
      } catch (error) {
        if (this.browserCapability) {
          this.egressProxy?.revokeCapability(this.browserCapability);
          this.browserCapability = null;
          this.networkPolicies.delete(CONTROLLED_BROWSER_PRINCIPAL_ID);
        }
        this.logger.error(
          '[ControlledBrowserEgress] Session proxy configuration failed; browser networking remains fail closed',
          error,
        );
      }
    }
  }

  private readonly getRuntimeStatus = (): NetworkEgressRuntimeStatus => ({
    policyEngineEnabled: this.featureFlags.egressPolicyEnabled,
    policyEngineAvailable: this.networkPolicyEngine !== null,
    proxyRequired:
      this.featureFlags.remoteMcpProxyEnabled ||
      this.featureFlags.controlledBrowserEgressEnabled,
    proxyAvailable: this.egressProxy !== null,
    controlledBrowserEnabled: this.featureFlags.controlledBrowserEgressEnabled,
    controlledBrowserActive:
      this.browserCapability !== null &&
      this.browserSession?.managedProxyActive === true,
  });

  private readonly getBrowserPolicy = (): NetworkPolicy | null =>
    this.networkPolicies.get(CONTROLLED_BROWSER_PRINCIPAL_ID) ?? null;

  private readonly applyBrowserGrants = async (
    grants: readonly NetworkPolicyDestinationGrant[],
  ): Promise<void> => {
    if (!this.featureFlags.controlledBrowserEgressEnabled) return;
    this.browserPolicyVersion++;
    this.networkPolicies.set(
      CONTROLLED_BROWSER_PRINCIPAL_ID,
      createControlledBrowserNetworkPolicy(
        this.controlledBrowserAllowedHosts,
        grants,
        this.browserPolicyVersion,
      ),
    );
    if (!this.browserSession) return;
    try {
      await this.browserSession.refreshNetworkBoundary();
    } catch (error) {
      this.logger.error(
        '[ControlledBrowserEgress] Policy refresh failed; engaging fail-closed routing',
        error,
      );
      if (this.browserCapability) {
        this.egressProxy?.revokeCapability(this.browserCapability);
        this.browserCapability = null;
      }
      await this.browserSession.engageFailClosed();
      throw error;
    }
  };

  private readonly resolveMcpNetworkProxy = (
    serverId: string,
    transport: ResolvedMcpTransport,
  ): McpNetworkProxyConfig | undefined => {
    if (transport.type === 'stdio') return undefined;
    if (!this.egressProxy) {
      throw new Error(
        'Transparent egress proxy is unavailable; remote MCP connection blocked',
      );
    }
    const principalId = `mcp:${serverId}`;
    this.networkPolicies.set(
      principalId,
      createRemoteMcpNetworkPolicy(serverId, transport),
    );
    try {
      return this.egressProxy.issueCapability({
        principalKind: 'mcp',
        principalId,
      });
    } catch (error) {
      this.networkPolicies.delete(principalId);
      throw error;
    }
  };

  private readonly revokeMcpNetworkProxy = (
    serverId: string,
    proxy: McpNetworkProxyConfig,
  ): void => {
    this.egressProxy?.revokeCapability(proxy);
    this.networkPolicies.delete(`mcp:${serverId}`);
  };
}

export async function initializeGuardianEgressStartup(
  options: GuardianEgressStartupOptions,
): Promise<GuardianEgressStartupResult> {
  const dependencies = options.dependencies ?? DEFAULT_DEPENDENCIES;
  const featureFlags: GuardianEgressFeatureFlags = {
    egressPolicyEnabled: options.isFeatureEnabled('egress-policy-engine'),
    remoteMcpProxyEnabled: options.isFeatureEnabled('egress-transparent-proxy'),
    controlledBrowserEgressEnabled: options.isFeatureEnabled(
      'egress-controlled-browser',
    ),
    egressControlCenterEnabled: options.isFeatureEnabled(
      'egress-control-center',
    ),
  };
  const controlledBrowserAllowedHosts = parseControlledBrowserAllowedHosts(
    options.controlledBrowserAllowedHosts,
  );
  const initialControlledBrowserGrants = featureFlags.egressControlCenterEnabled
    ? options
        .getBrowserGrants()
        .filter(
          (grant) =>
            grant.expiresAt === null || grant.expiresAt > dependencies.now(),
        )
        .map(toNetworkPolicyDestinationGrant)
    : [];
  const state = new GuardianEgressStartupState(
    featureFlags,
    controlledBrowserAllowedHosts,
    options.logger,
    dependencies,
  );
  await state.initialize(options.getAuditPath, initialControlledBrowserGrants);
  return state;
}
