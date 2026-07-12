import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import net from 'node:net';
import {
  DEFAULT_DENY_NETWORK_POLICY,
  networkEgressRequestSchema,
  networkPolicyDecisionSchema,
  networkPolicySchema,
  type NetworkEgressRequest,
  type NetworkPolicy,
  type NetworkPolicyDecision,
  type NetworkPolicyDestinationGrant,
  type NetworkPolicyEvaluator,
  type NetworkPolicyScope,
} from '@shared/network-policy';
import { NetworkPolicyAuditLedger } from './audit-ledger';

const SUPPORTED_PROTOCOLS = new Map([
  ['http:', { protocol: 'http' as const, defaultPort: 80 }],
  ['https:', { protocol: 'https' as const, defaultPort: 443 }],
  ['ws:', { protocol: 'ws' as const, defaultPort: 80 }],
  ['wss:', { protocol: 'wss' as const, defaultPort: 443 }],
]);

export type NetworkPolicyResolver = (
  scope: NetworkPolicyScope,
) => NetworkPolicy | Promise<NetworkPolicy>;

export interface NetworkPolicyEngineOptions {
  auditPath: string;
  resolvePolicy?: NetworkPolicyResolver;
  resolveDns?: NetworkDnsResolver;
  now?: () => number;
}

export interface NetworkDnsAddress {
  address: string;
  family: 4 | 6;
}

export type NetworkDnsResolver = (
  hostname: string,
) => Promise<readonly NetworkDnsAddress[]>;

export interface ResolvedNetworkPolicyDecision {
  decision: NetworkPolicyDecision;
  pinnedAddress: NetworkDnsAddress | null;
}

export class NetworkPolicyEngine implements NetworkPolicyEvaluator {
  private constructor(
    private readonly audit: NetworkPolicyAuditLedger,
    private readonly resolvePolicy: NetworkPolicyResolver,
    private readonly resolveDns: NetworkDnsResolver,
    private readonly now: () => number,
  ) {}

  public static async create(
    options: NetworkPolicyEngineOptions,
  ): Promise<NetworkPolicyEngine> {
    const now = options.now ?? Date.now;
    const audit = await NetworkPolicyAuditLedger.create(options.auditPath, now);
    return new NetworkPolicyEngine(
      audit,
      options.resolvePolicy ?? (() => DEFAULT_DENY_NETWORK_POLICY),
      options.resolveDns ?? defaultDnsResolver,
      now,
    );
  }

  public async evaluate(
    rawInput: NetworkEgressRequest,
  ): Promise<NetworkPolicyDecision> {
    const input = networkEgressRequestSchema.parse(rawInput);
    const policy = normalizeNetworkPolicy(
      networkPolicySchema.parse(await this.resolvePolicy(input.scope)),
    );
    const result = evaluateNormalizedNetworkPolicy(
      policy,
      input.destination,
      this.now(),
    );
    await this.audit.recordDecision(input.scope, result);
    return result;
  }

  /**
   * Evaluates the hostname policy, resolves DNS exactly once, validates every
   * returned address, and returns one address that the caller must pin to the
   * outbound socket. No denied hostname is resolved.
   */
  public async resolveAndEvaluate(
    rawInput: NetworkEgressRequest,
  ): Promise<ResolvedNetworkPolicyDecision> {
    const input = networkEgressRequestSchema.parse(rawInput);
    const policy = normalizeNetworkPolicy(
      networkPolicySchema.parse(await this.resolvePolicy(input.scope)),
    );
    const preflight = evaluateNormalizedNetworkPolicy(
      policy,
      input.destination,
      this.now(),
    );
    if (preflight.decision === 'deny' || !preflight.destination) {
      await this.audit.recordDecision(input.scope, preflight);
      return { decision: preflight, pinnedAddress: null };
    }

    if (preflight.destination.ipLiteral) {
      const address = toNetworkDnsAddress(preflight.destination.hostname);
      if (!address) {
        const decision = replaceDecisionReason(
          preflight,
          'dns-resolution-failed',
        );
        await this.audit.recordDecision(input.scope, decision);
        return { decision, pinnedAddress: null };
      }
      await this.audit.recordDecision(input.scope, preflight);
      return { decision: preflight, pinnedAddress: address };
    }

    let resolved: readonly NetworkDnsAddress[];
    try {
      resolved = await this.resolveDns(preflight.destination.hostname);
    } catch {
      const decision = replaceDecisionReason(
        preflight,
        'dns-resolution-failed',
      );
      await this.audit.recordDecision(input.scope, decision);
      return { decision, pinnedAddress: null };
    }
    const addresses = normalizeDnsAddresses(resolved);
    if (addresses.length === 0) {
      const decision = replaceDecisionReason(
        preflight,
        'dns-resolution-failed',
      );
      await this.audit.recordDecision(input.scope, decision);
      return { decision, pinnedAddress: null };
    }
    const exactDestinationGranted =
      preflight.reason === 'exact-destination-grant';
    if (
      !exactDestinationGranted &&
      !policy.allowLoopback &&
      addresses.some(({ address }) => isLoopbackHost(address))
    ) {
      const decision = replaceDecisionReason(
        preflight,
        'resolved-loopback-denied',
      );
      await this.audit.recordDecision(input.scope, decision);
      return { decision, pinnedAddress: null };
    }
    if (
      !exactDestinationGranted &&
      !policy.allowPrivateNetworks &&
      addresses.some(({ address }) => isPrivateIpAddress(address))
    ) {
      const decision = replaceDecisionReason(
        preflight,
        'resolved-private-network-denied',
      );
      await this.audit.recordDecision(input.scope, decision);
      return { decision, pinnedAddress: null };
    }

    await this.audit.recordDecision(input.scope, preflight);
    return { decision: preflight, pinnedAddress: addresses[0] ?? null };
  }
}

export function hashNetworkPolicy(policy: NetworkPolicy): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeNetworkPolicy(policy)))
    .digest('hex');
}

export function evaluateNetworkPolicy(
  rawPolicy: NetworkPolicy,
  destination: string,
  now: number = Date.now(),
): NetworkPolicyDecision {
  return evaluateNormalizedNetworkPolicy(
    normalizeNetworkPolicy(networkPolicySchema.parse(rawPolicy)),
    destination,
    now,
  );
}

function evaluateNormalizedNetworkPolicy(
  policy: NetworkPolicy,
  destinationValue: string,
  now: number,
): NetworkPolicyDecision {
  const policyHash = hashNetworkPolicy(policy);
  const base = {
    policyId: policy.id,
    policyVersion: policy.version,
    policyHash,
  };
  const parsed = parseDestination(destinationValue);
  if (!parsed.ok) {
    return networkPolicyDecisionSchema.parse({
      ...base,
      decision: 'deny',
      reason: parsed.reason,
      destination: null,
    });
  }
  const destination = parsed.destination;
  const deny = (
    reason: NetworkPolicyDecision['reason'],
  ): NetworkPolicyDecision =>
    networkPolicyDecisionSchema.parse({
      ...base,
      decision: 'deny',
      reason,
      destination,
    });

  if (policy.mode === 'deny-all') return deny('policy-deny-all');
  const exactGrant = policy.allowedDestinations.find(
    (grant) =>
      grant.protocol === destination.protocol &&
      grant.hostname === destination.hostname &&
      grant.port === destination.port &&
      (grant.expiresAt === undefined || grant.expiresAt > now),
  );
  if (exactGrant) {
    return networkPolicyDecisionSchema.parse({
      ...base,
      decision: 'allow',
      reason: 'exact-destination-grant',
      destination,
    });
  }
  if (isLoopbackHost(destination.hostname) && !policy.allowLoopback) {
    return deny('loopback-denied');
  }
  if (
    destination.ipLiteral &&
    isPrivateIpAddress(destination.hostname) &&
    !policy.allowPrivateNetworks
  ) {
    return deny('private-network-denied');
  }
  if (destination.ipLiteral && !policy.allowIpLiterals) {
    return deny('ip-literal-denied');
  }
  if (
    policy.allowedPorts.length > 0 &&
    !policy.allowedPorts.includes(destination.port)
  ) {
    return deny('port-not-allowed');
  }
  if (
    policy.mode === 'allowlist' &&
    !policy.allowedHosts.some((pattern) =>
      hostMatchesPattern(destination.hostname, pattern),
    )
  ) {
    return deny('host-not-allowed');
  }
  return networkPolicyDecisionSchema.parse({
    ...base,
    decision: 'allow',
    reason: policy.mode === 'allowlist' ? 'allowlisted' : 'unrestricted',
    destination,
  });
}

function parseDestination(value: string):
  | {
      ok: true;
      destination: NonNullable<NetworkPolicyDecision['destination']>;
    }
  | {
      ok: false;
      reason:
        | 'invalid-destination'
        | 'unsupported-protocol'
        | 'url-credentials-denied';
    } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'invalid-destination' };
  }
  const protocol = SUPPORTED_PROTOCOLS.get(url.protocol);
  if (!protocol) return { ok: false, reason: 'unsupported-protocol' };
  if (url.username || url.password) {
    return { ok: false, reason: 'url-credentials-denied' };
  }
  const hostname = normalizeHostname(url.hostname);
  if (!hostname) return { ok: false, reason: 'invalid-destination' };
  const port = url.port ? Number(url.port) : protocol.defaultPort;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, reason: 'invalid-destination' };
  }
  return {
    ok: true,
    destination: {
      protocol: protocol.protocol,
      hostname,
      port,
      ipLiteral: net.isIP(stripIpv6Brackets(hostname)) !== 0,
    },
  };
}

function normalizeNetworkPolicy(policy: NetworkPolicy): NetworkPolicy {
  return networkPolicySchema.parse({
    ...policy,
    allowedHosts: [
      ...new Set(policy.allowedHosts.map(normalizeHostPattern)),
    ].sort(),
    allowedPorts: [...new Set(policy.allowedPorts)].sort(
      (left, right) => left - right,
    ),
    allowedDestinations: normalizeDestinationGrants(policy.allowedDestinations),
  });
}

export function normalizeNetworkPolicyDestinationGrant(
  grant: NetworkPolicyDestinationGrant,
): NetworkPolicyDestinationGrant {
  const hostname = normalizeHostname(grant.hostname);
  if (!hostname) {
    throw new Error(
      `Invalid network policy destination hostname: ${grant.hostname}`,
    );
  }
  return {
    protocol: grant.protocol,
    hostname,
    port: grant.port,
    ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
  };
}

function normalizeDestinationGrants(
  grants: readonly NetworkPolicyDestinationGrant[],
): NetworkPolicyDestinationGrant[] {
  const normalized = new Map<string, NetworkPolicyDestinationGrant>();
  for (const rawGrant of grants) {
    const grant = normalizeNetworkPolicyDestinationGrant(rawGrant);
    const key = `${grant.protocol}\0${grant.hostname}\0${grant.port}`;
    const current = normalized.get(key);
    if (
      !current ||
      (current.expiresAt !== undefined &&
        (grant.expiresAt === undefined || grant.expiresAt > current.expiresAt))
    ) {
      normalized.set(key, grant);
    }
  }
  return [...normalized.values()].sort(
    (left, right) =>
      left.protocol.localeCompare(right.protocol) ||
      left.hostname.localeCompare(right.hostname) ||
      left.port - right.port ||
      (left.expiresAt ?? Number.MAX_SAFE_INTEGER) -
        (right.expiresAt ?? Number.MAX_SAFE_INTEGER),
  );
}

function normalizeHostPattern(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, '');
  const wildcard = trimmed.startsWith('*.');
  const hostname = normalizeHostname(wildcard ? trimmed.slice(2) : trimmed);
  if (!hostname || (wildcard && net.isIP(stripIpv6Brackets(hostname)) !== 0)) {
    throw new Error(`Invalid network policy host pattern: ${value}`);
  }
  return wildcard ? `*.${hostname}` : hostname;
}

function normalizeHostname(value: string): string | null {
  const withoutBrackets = stripIpv6Brackets(value.trim().toLowerCase());
  if (!withoutBrackets || withoutBrackets.includes('%')) return null;
  if (net.isIP(withoutBrackets) !== 0) return withoutBrackets;
  const ascii = domainToASCII(withoutBrackets).toLowerCase().replace(/\.$/, '');
  if (
    !ascii ||
    ascii.length > 253 ||
    ascii.split('.').some((label) => !label || label.length > 63)
  ) {
    return null;
  }
  return ascii;
}

function hostMatchesPattern(hostname: string, pattern: string): boolean {
  if (!pattern.startsWith('*.')) return hostname === pattern;
  const suffix = pattern.slice(2);
  return hostname.length > suffix.length && hostname.endsWith(`.${suffix}`);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname);
  const mappedIpv4 = extractMappedIpv4(normalized);
  if (mappedIpv4) return isLoopbackHost(mappedIpv4);
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1'
  ) {
    return true;
  }
  if (net.isIP(normalized) === 4) {
    return Number(normalized.split('.')[0]) === 127;
  }
  return false;
}

function isPrivateIpAddress(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase();
  const mappedIpv4 = extractMappedIpv4(normalized);
  if (mappedIpv4) return isPrivateIpAddress(mappedIpv4);
  if (net.isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number);
    const [first = -1, second = -1] = octets;
    return (
      first === 0 ||
      first === 10 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && octets[2] === 100) ||
      (first === 203 && second === 0 && octets[2] === 113) ||
      first >= 224
    );
  }
  if (net.isIP(normalized) === 6) {
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('2001:db8') ||
      normalized.startsWith('ff')
    );
  }
  return false;
}

function stripIpv6Brackets(value: string): string {
  return value.replace(/^\[|\]$/g, '');
}

function extractMappedIpv4(value: string): string | null {
  const normalized = value.toLowerCase();
  if (!normalized.startsWith('::ffff:')) return null;
  const suffix = normalized.slice('::ffff:'.length);
  if (net.isIP(suffix) === 4) return suffix;
  const groups = suffix.split(':');
  if (
    groups.length !== 2 ||
    groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group))
  ) {
    return null;
  }
  const high = Number.parseInt(groups[0] ?? '', 16);
  const low = Number.parseInt(groups[1] ?? '', 16);
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(
    '.',
  );
}

function replaceDecisionReason(
  decision: NetworkPolicyDecision,
  reason:
    | 'dns-resolution-failed'
    | 'resolved-loopback-denied'
    | 'resolved-private-network-denied',
): NetworkPolicyDecision {
  return networkPolicyDecisionSchema.parse({
    ...decision,
    decision: 'deny',
    reason,
  });
}

function normalizeDnsAddresses(
  addresses: readonly NetworkDnsAddress[],
): NetworkDnsAddress[] {
  const normalized = new Map<string, NetworkDnsAddress>();
  for (const candidate of addresses) {
    const address = stripIpv6Brackets(candidate.address.trim().toLowerCase());
    const family = net.isIP(address);
    if (family !== 4 && family !== 6) continue;
    normalized.set(`${family}:${address}`, { address, family });
  }
  return [...normalized.values()].sort(
    (left, right) =>
      left.family - right.family || left.address.localeCompare(right.address),
  );
}

function toNetworkDnsAddress(value: string): NetworkDnsAddress | null {
  const address = stripIpv6Brackets(value);
  const family = net.isIP(address);
  return family === 4 || family === 6 ? { address, family } : null;
}

async function defaultDnsResolver(
  hostname: string,
): Promise<readonly NetworkDnsAddress[]> {
  const addresses = await dns.lookup(hostname, {
    all: true,
    verbatim: true,
  });
  return addresses.flatMap(({ address, family }) =>
    family === 4 || family === 6 ? [{ address, family }] : [],
  );
}
