import { describe, expect, it, vi } from 'vitest';
import {
  bindTrustedMcpFinalAuthorityToFence,
  createTrustedMcpApprovalAuthority,
  createTrustedMcpDescriptorCommitment,
  createTrustedMcpFenceAuthority,
} from './trusted-dispatch-gateway';

const descriptor = createTrustedMcpDescriptorCommitment({
  domain: 'registry-mcp',
  authorityId: 'registry:test',
  toolName: 'write',
  descriptor: { name: 'write' },
  authorityBinding: { serverId: 'test' },
  classification: {
    readOnly: false,
    destructive: true,
    requiresApproval: true,
  },
});
const effect = {
  principalId: 'agent-1',
  toolCallId: 'tool-1',
  arguments: { value: 'approved' },
};

describe('trusted MCP final-authority clocks', () => {
  it('rejects a malformed clock before issuing either authority', () => {
    expect(() =>
      createTrustedMcpApprovalAuthority({
        descriptor,
        effect,
        now: () => Number.NaN,
      }),
    ).toThrow('clock is invalid');
    expect(() =>
      createTrustedMcpFenceAuthority(() => {}, { now: () => -1 }),
    ).toThrow('clock is invalid');
  });

  it('rejects an expiration that cannot be represented safely', () => {
    expect(() =>
      createTrustedMcpFenceAuthority(() => {}, {
        now: () => Number.MAX_SAFE_INTEGER - 1,
        ttlMs: 2,
      }),
    ).toThrow('expiry is invalid');
  });

  it('expires approval authority at the exact deadline', () => {
    let now = 10;
    const authority = createTrustedMcpApprovalAuthority({
      descriptor,
      effect,
      ttlMs: 5,
      now: () => now,
    });
    now = 15;

    expect(() => authority.assertAndConsume({ descriptor, effect })).toThrow(
      'expired before dispatch',
    );
  });

  it('revalidates the clock before a fence is prepared', () => {
    let now = 10;
    const fence = vi.fn();
    const authority = createTrustedMcpFenceAuthority(fence, {
      ttlMs: 5,
      now: () => now,
    });
    now = Number.POSITIVE_INFINITY;

    expect(() => authority.prepareFinalCheck()).toThrow('clock is invalid');
    expect(fence).not.toHaveBeenCalled();
  });

  it('rechecks a bound lifecycle fence immediately before consumption', () => {
    let epoch = 1;
    const delegatedFence = vi.fn();
    const onConsumed = vi.fn();
    const authority = bindTrustedMcpFinalAuthorityToFence(
      createTrustedMcpFenceAuthority(delegatedFence, { onConsumed }),
      () => {
        if (epoch !== 1) throw new Error('lifecycle superseded');
      },
    );

    authority.prepareFinalCheck();
    epoch = 2;

    expect(() => authority.assertAndConsume({ descriptor, effect })).toThrow(
      'lifecycle superseded',
    );
    expect(delegatedFence).toHaveBeenCalledTimes(1);
    expect(onConsumed).not.toHaveBeenCalled();
    expect(() => authority.assertAndConsume({ descriptor, effect })).toThrow(
      'already consumed',
    );
  });

  it('burns a bound authority when its lifecycle is stale before preparation', () => {
    const delegatedFence = vi.fn();
    const authority = bindTrustedMcpFinalAuthorityToFence(
      createTrustedMcpFenceAuthority(delegatedFence),
      () => {
        throw new Error('lifecycle superseded');
      },
    );

    expect(() => authority.prepareFinalCheck()).toThrow('lifecycle superseded');
    expect(delegatedFence).not.toHaveBeenCalled();
    expect(() => authority.prepareFinalCheck()).toThrow('already consumed');
  });
});
