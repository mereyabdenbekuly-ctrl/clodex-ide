import net from 'node:net';
import type { ResolvedMcpTransport } from '@clodex/mcp-runtime';
import type { NetworkPolicy } from '@shared/network-policy';

export function createRemoteMcpNetworkPolicy(
  serverId: string,
  transport: Exclude<ResolvedMcpTransport, { type: 'stdio' }>,
): NetworkPolicy {
  const urls = [
    new URL(transport.url),
    ...(transport.oauth?.allowedAuthorizationOrigins ?? []).map(
      (origin) => new URL(origin),
    ),
  ];
  const allowedHosts = [...new Set(urls.map((url) => url.hostname))];
  const allowedPorts = [
    ...new Set(
      urls.map((url) =>
        Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      ),
    ),
  ];
  const configuredAddresses = allowedHosts.filter(
    (hostname) => net.isIP(stripIpv6Brackets(hostname)) !== 0,
  );
  return {
    id: `mcp-remote:${serverId}`,
    version: 1,
    mode: 'allowlist',
    allowedHosts,
    allowedPorts,
    allowedDestinations: [],
    allowLoopback: allowedHosts.some(isExplicitLoopbackHost),
    allowPrivateNetworks: configuredAddresses.some(isExplicitPrivateAddress),
    allowIpLiterals: configuredAddresses.length > 0,
  };
}

function isExplicitLoopbackHost(hostname: string): boolean {
  const value = stripIpv6Brackets(hostname).toLowerCase();
  return (
    value === 'localhost' ||
    value.endsWith('.localhost') ||
    value === '::1' ||
    (net.isIP(value) === 4 && Number(value.split('.')[0]) === 127)
  );
}

function isExplicitPrivateAddress(hostname: string): boolean {
  const value = stripIpv6Brackets(hostname).toLowerCase();
  if (net.isIP(value) === 4) {
    const [first = -1, second = -1] = value.split('.').map(Number);
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  return (
    net.isIP(value) === 6 &&
    (value.startsWith('fc') ||
      value.startsWith('fd') ||
      /^fe[89ab]/.test(value))
  );
}

function stripIpv6Brackets(value: string): string {
  return value.replace(/^\[|\]$/g, '');
}
