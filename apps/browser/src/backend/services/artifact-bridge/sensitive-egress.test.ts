import { describe, expect, it } from 'vitest';
import {
  assertNoRawSecrets,
  classifySensitiveMcpOperation,
  redactSensitiveText,
  sanitizeSensitiveValue,
} from './sensitive-egress';

describe('artifact bridge sensitive egress', () => {
  it('classifies remote and credential-sensitive MCP operations', () => {
    expect(
      classifySensitiveMcpOperation({
        transportType: 'streamable-http',
        serverId: 'crm',
        descriptor: {
          name: 'lookup',
          inputSchema: {
            type: 'object',
            properties: { access_token: { type: 'string' } },
          },
        },
        arguments: { accountId: '123' },
      }),
    ).toEqual(['remote-network', 'credential-sensitive']);
  });

  it('does not classify a local ordinary read', () => {
    expect(
      classifySensitiveMcpOperation({
        transportType: 'stdio',
        serverId: 'docs',
        descriptor: {
          name: 'search',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
          },
        },
        arguments: { query: 'password reset documentation' },
      }),
    ).toEqual([]);
  });

  it('blocks raw credential values before MCP invocation', () => {
    expect(() =>
      assertNoRawSecrets({ authorization: 'Bearer abcdefghijklmnop' }),
    ).toThrow('Raw credentials are not allowed');
    expect(() => assertNoRawSecrets({ query: 'password reset' })).not.toThrow();
  });

  it('redacts credential-shaped result fields and error text', () => {
    expect(
      sanitizeSensitiveValue({
        ok: true,
        access_token: 'secret-value',
        nested: { message: 'Bearer abcdefghijklmnop' },
      }),
    ).toEqual({
      ok: true,
      access_token: '[REDACTED]',
      nested: { message: '[REDACTED]' },
    });
    expect(sanitizeSensitiveValue({ token_count: 42 })).toEqual({
      token_count: 42,
    });
    expect(redactSensitiveText('failed token=abcdefghijklmnop')).toBe(
      'failed [REDACTED]',
    );
  });
});
