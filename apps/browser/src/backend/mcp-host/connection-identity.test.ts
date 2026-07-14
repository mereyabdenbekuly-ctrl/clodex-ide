import { describe, expect, it } from 'vitest';
import {
  deleteExactMcpConnection,
  isExactMcpConnection,
  requireExactMcpConnection,
} from './connection-identity';

describe('MCP host connection identity', () => {
  it('cannot let a stale close callback delete a replacement connection', () => {
    const oldClient = {};
    const currentClient = {};
    const connections = new Map([
      [
        'docs',
        {
          connectionId: '22222222-2222-4222-8222-222222222222',
          client: currentClient,
        },
      ],
    ]);

    expect(
      deleteExactMcpConnection(
        connections,
        'docs',
        oldClient,
        '11111111-1111-4111-8111-111111111111',
      ),
    ).toBeUndefined();
    expect(connections.get('docs')?.client).toBe(currentClient);
    expect(
      isExactMcpConnection(
        connections,
        'docs',
        currentClient,
        '22222222-2222-4222-8222-222222222222',
      ),
    ).toBe(true);
  });

  it('fails closed when an awaited catalog refresh belongs to an old token', () => {
    const client = {};
    const connections = new Map([
      [
        'docs',
        {
          connectionId: '22222222-2222-4222-8222-222222222222',
          client,
        },
      ],
    ]);

    expect(() =>
      requireExactMcpConnection(
        connections,
        'docs',
        client,
        '11111111-1111-4111-8111-111111111111',
      ),
    ).toThrow('connection is no longer current');
  });
});
