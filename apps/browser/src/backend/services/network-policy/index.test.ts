import {
  DEFAULT_DENY_NETWORK_POLICY,
  type NetworkPolicy,
} from '@shared/network-policy';
import { describe, expect, it } from 'vitest';
import { evaluateNetworkPolicy, hashNetworkPolicy } from '.';

const policy = (overrides: Partial<NetworkPolicy> = {}): NetworkPolicy => ({
  id: 'test-policy',
  version: 1,
  mode: 'allowlist',
  allowedHosts: [],
  allowedPorts: [],
  allowedDestinations: [],
  allowPrivateNetworks: false,
  allowLoopback: false,
  allowIpLiterals: false,
  ...overrides,
});

describe('NetworkPolicyEngine', () => {
  it('denies all destinations with the default policy', () => {
    expect(
      evaluateNetworkPolicy(DEFAULT_DENY_NETWORK_POLICY, 'https://example.com'),
    ).toMatchObject({
      decision: 'deny',
      reason: 'policy-deny-all',
    });
  });

  it('allows exact allowlist matches', () => {
    expect(
      evaluateNetworkPolicy(
        policy({ allowedHosts: ['api.example.com'] }),
        'https://api.example.com/v1',
      ),
    ).toMatchObject({
      decision: 'allow',
      reason: 'allowlisted',
      destination: {
        hostname: 'api.example.com',
        port: 443,
        protocol: 'https',
      },
    });
  });

  it.each([
    ['https://api.example.com', 'allow'],
    ['https://deep.api.example.com', 'allow'],
    ['https://example.com', 'deny'],
    ['https://evil-example.com', 'deny'],
  ] as const)('enforces wildcard label boundaries for %s', (destination, expectedDecision) => {
    expect(
      evaluateNetworkPolicy(
        policy({ allowedHosts: ['*.example.com'] }),
        destination,
      ).decision,
    ).toBe(expectedDecision);
  });

  it('normalizes hostname case and a trailing dot', () => {
    expect(
      evaluateNetworkPolicy(
        policy({ allowedHosts: ['API.Example.COM.'] }),
        'https://api.example.com.',
      ),
    ).toMatchObject({
      decision: 'allow',
      destination: { hostname: 'api.example.com' },
    });
  });

  it('normalizes internationalized hostnames to ASCII', () => {
    expect(
      evaluateNetworkPolicy(
        policy({ allowedHosts: ['bücher.example'] }),
        'https://xn--bcher-kva.example',
      ),
    ).toMatchObject({
      decision: 'allow',
      destination: { hostname: 'xn--bcher-kva.example' },
    });
  });

  it('uses protocol defaults and enforces custom ports', () => {
    const portsPolicy = policy({
      allowedHosts: ['api.example.com'],
      allowedPorts: [443, 8443],
    });
    expect(
      evaluateNetworkPolicy(portsPolicy, 'https://api.example.com').decision,
    ).toBe('allow');
    expect(
      evaluateNetworkPolicy(portsPolicy, 'https://api.example.com:8443')
        .decision,
    ).toBe('allow');
    expect(
      evaluateNetworkPolicy(portsPolicy, 'https://api.example.com:9443'),
    ).toMatchObject({
      decision: 'deny',
      reason: 'port-not-allowed',
    });
  });

  it('allows only the exact protocol, hostname, and port in a destination grant', () => {
    const exactPolicy = policy({
      mode: 'unrestricted',
      allowedDestinations: [
        { protocol: 'http', hostname: 'localhost', port: 3000 },
      ],
    });

    expect(
      evaluateNetworkPolicy(exactPolicy, 'http://localhost:3000'),
    ).toMatchObject({
      decision: 'allow',
      reason: 'exact-destination-grant',
    });
    expect(
      evaluateNetworkPolicy(exactPolicy, 'http://localhost:3001'),
    ).toMatchObject({ decision: 'deny', reason: 'loopback-denied' });
    expect(
      evaluateNetworkPolicy(exactPolicy, 'http://127.0.0.1:3000'),
    ).toMatchObject({ decision: 'deny', reason: 'loopback-denied' });
    expect(
      evaluateNetworkPolicy(exactPolicy, 'https://example.com'),
    ).toMatchObject({ decision: 'allow', reason: 'unrestricted' });
  });

  it('ignores expired exact destination grants', () => {
    const exactPolicy = policy({
      mode: 'unrestricted',
      allowedDestinations: [
        {
          protocol: 'http',
          hostname: 'localhost',
          port: 3000,
          expiresAt: 1_000,
        },
      ],
    });

    expect(
      evaluateNetworkPolicy(exactPolicy, 'http://localhost:3000', 1_000),
    ).toMatchObject({ decision: 'deny', reason: 'loopback-denied' });
  });

  it('rejects URL credentials', () => {
    expect(
      evaluateNetworkPolicy(
        policy({ allowedHosts: ['api.example.com'] }),
        'https://user:secret@api.example.com',
      ),
    ).toMatchObject({
      decision: 'deny',
      reason: 'url-credentials-denied',
      destination: null,
    });
  });

  it('rejects unsupported protocols and malformed destinations', () => {
    expect(evaluateNetworkPolicy(policy(), 'ftp://example.com')).toMatchObject({
      decision: 'deny',
      reason: 'unsupported-protocol',
    });
    expect(evaluateNetworkPolicy(policy(), 'not a url')).toMatchObject({
      decision: 'deny',
      reason: 'invalid-destination',
    });
  });

  it.each([
    'http://localhost',
    'http://service.localhost',
    'http://127.0.0.1',
    'http://[::1]',
  ])('denies loopback destination %s by default', (destination) => {
    expect(
      evaluateNetworkPolicy(
        policy({
          mode: 'unrestricted',
          allowIpLiterals: true,
          allowPrivateNetworks: true,
        }),
        destination,
      ),
    ).toMatchObject({
      decision: 'deny',
      reason: 'loopback-denied',
    });
  });

  it.each([
    'http://10.1.2.3',
    'http://172.16.0.1',
    'http://192.168.1.1',
    'http://[fd00::1]',
    'http://[fe80::1]',
  ])('denies private destination %s by default', (destination) => {
    expect(
      evaluateNetworkPolicy(
        policy({ mode: 'unrestricted', allowIpLiterals: true }),
        destination,
      ),
    ).toMatchObject({
      decision: 'deny',
      reason: 'private-network-denied',
    });
  });

  it('denies public IP literals unless explicitly allowed', () => {
    expect(
      evaluateNetworkPolicy(
        policy({ mode: 'unrestricted' }),
        'https://8.8.8.8',
      ),
    ).toMatchObject({
      decision: 'deny',
      reason: 'ip-literal-denied',
    });
    expect(
      evaluateNetworkPolicy(
        policy({ mode: 'unrestricted', allowIpLiterals: true }),
        'https://8.8.8.8',
      ).decision,
    ).toBe('allow');
  });

  it('keeps unrestricted mode private-network safe by default', () => {
    expect(
      evaluateNetworkPolicy(
        policy({ mode: 'unrestricted', allowIpLiterals: true }),
        'http://192.168.1.10',
      ),
    ).toMatchObject({
      decision: 'deny',
      reason: 'private-network-denied',
    });
  });

  it('hashes equivalent policies identically regardless of ordering', () => {
    expect(
      hashNetworkPolicy(
        policy({
          allowedHosts: ['b.example.com', 'a.example.com', 'a.example.com'],
          allowedPorts: [8443, 443, 443],
          allowedDestinations: [
            { protocol: 'http', hostname: 'LOCALHOST.', port: 3000 },
          ],
        }),
      ),
    ).toBe(
      hashNetworkPolicy(
        policy({
          allowedHosts: ['a.example.com', 'b.example.com'],
          allowedPorts: [443, 8443],
          allowedDestinations: [
            { protocol: 'http', hostname: 'localhost', port: 3000 },
          ],
        }),
      ),
    );
  });
});
