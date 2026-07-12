import { describe, expect, it, vi } from 'vitest';
import { createOAuthOriginBoundFetch, createOriginBoundFetch } from './network';

describe('MCP origin-bound fetch', () => {
  it('rejects requests that escape the configured origin', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const restricted = createOriginBoundFetch(
      'https://mcp.example.com',
      fetchImpl,
    );

    await expect(restricted('https://attacker.example/rpc')).rejects.toThrow(
      'does not match configured origin',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forces manual redirects and rejects redirect responses', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/rpc' },
        }),
    );
    const restricted = createOriginBoundFetch(
      'https://mcp.example.com',
      fetchImpl,
    );

    await expect(
      restricted('https://mcp.example.com/rpc', {
        redirect: 'follow',
      }),
    ).rejects.toThrow('redirect was blocked');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://mcp.example.com/rpc',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('allows only the MCP and registered OAuth origins', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('{}', { status: 200 }),
    );
    const restricted = createOAuthOriginBoundFetch(
      'https://mcp.example.com',
      ['https://auth.example.com'],
      fetchImpl,
    );

    await restricted('https://auth.example.com/token', { method: 'POST' });
    await expect(
      restricted('https://attacker.example/token', { method: 'POST' }),
    ).rejects.toThrow('outside the registered origin set');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not forward MCP custom headers to a separate OAuth origin', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response('{}', { status: 200 }),
    );
    const restricted = createOAuthOriginBoundFetch(
      'https://mcp.example.com',
      ['https://auth.example.com'],
      fetchImpl,
    );
    await restricted('https://auth.example.com/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Basic registered-client',
        'x-private-mcp-header': 'must-not-leak',
      },
    });
    const forwarded = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(forwarded.get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(forwarded.get('authorization')).toBe('Basic registered-client');
    expect(forwarded.has('x-private-mcp-header')).toBe(false);
  });
});
