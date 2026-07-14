import { describe, expect, it } from 'vitest';
import {
  artifactBridgeConnectSchema,
  artifactBridgeEnvelopeSchema,
  artifactBridgeGrantInputSchema,
  artifactBridgeGrantScopeSchema,
  artifactBridgeHelloSchema,
  artifactBridgeNavigationEpochSchema,
  artifactBridgePolicySchema,
  artifactBridgeResponseSchema,
  artifactBridgeSessionBindingSchema,
  getArtifactBridgeGrantExpiryPresets,
  isArtifactBridgeCapabilityAllowed,
  matchesArtifactBridgeToolPolicy,
} from './artifact-bridge';

describe('artifact bridge protocol envelope', () => {
  const navigationEpoch = 1;
  const request = {
    id: 'request-1',
    method: 'getCapabilities' as const,
    params: {},
  };

  it('accepts protocol v2 only with a UUID session binding', () => {
    const sessionId = crypto.randomUUID();

    expect(
      artifactBridgeEnvelopeSchema.safeParse({
        __clodexArtifactBridge: 2,
        type: 'request',
        sessionId,
        navigationEpoch,
        request,
      }).success,
    ).toBe(true);
    expect(
      artifactBridgeEnvelopeSchema.safeParse({
        __clodexArtifactBridge: 1,
        type: 'request',
        sessionId,
        navigationEpoch,
        request,
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeEnvelopeSchema.safeParse({
        __clodexArtifactBridge: 2,
        type: 'request',
        navigationEpoch,
        request,
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeEnvelopeSchema.safeParse({
        __clodexArtifactBridge: 2,
        type: 'request',
        sessionId: 'not-a-session-uuid',
        navigationEpoch,
        request,
      }).success,
    ).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a %s navigation epoch on requests', (_label, epoch) => {
    expect(
      artifactBridgeEnvelopeSchema.safeParse({
        __clodexArtifactBridge: 2,
        type: 'request',
        sessionId: crypto.randomUUID(),
        navigationEpoch: epoch,
        request,
      }).success,
    ).toBe(false);
  });

  it('requires protocol v2, a UUID session, and an epoch on responses', () => {
    const response = {
      __clodexArtifactBridge: 2,
      type: 'response',
      sessionId: crypto.randomUUID(),
      navigationEpoch,
      id: request.id,
      ok: true,
      result: { allowed: true },
    };

    expect(artifactBridgeResponseSchema.safeParse(response).success).toBe(true);
    expect(
      artifactBridgeResponseSchema.safeParse({
        ...response,
        __clodexArtifactBridge: 1,
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeResponseSchema.safeParse({
        ...response,
        sessionId: 'not-a-session-uuid',
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeResponseSchema.safeParse({
        ...response,
        sessionId: undefined,
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeResponseSchema.safeParse({
        ...response,
        navigationEpoch: undefined,
      }).success,
    ).toBe(false);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid response navigation epoch %s', (epoch) => {
    expect(
      artifactBridgeResponseSchema.safeParse({
        __clodexArtifactBridge: 2,
        type: 'response',
        sessionId: crypto.randomUUID(),
        navigationEpoch: epoch,
        id: request.id,
        ok: false,
        error: 'denied',
      }).success,
    ).toBe(false);
  });

  it('uses exact success and failure response schemas', () => {
    const base = {
      __clodexArtifactBridge: 2,
      type: 'response',
      sessionId: crypto.randomUUID(),
      navigationEpoch,
      id: request.id,
    } as const;

    expect(
      artifactBridgeResponseSchema.safeParse({
        ...base,
        ok: true,
        result: { allowed: true },
      }).success,
    ).toBe(true);
    expect(
      artifactBridgeResponseSchema.safeParse({
        ...base,
        ok: false,
        error: 'denied',
      }).success,
    ).toBe(true);
    expect(
      artifactBridgeResponseSchema.safeParse({
        ...base,
        ok: true,
        error: 'must not be accepted on success',
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeResponseSchema.safeParse({
        ...base,
        ok: false,
        error: 'denied',
        result: { mustNot: 'be accepted on failure' },
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeResponseSchema.safeParse({
        ...base,
        ok: true,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it('validates an exact host-issued connect and reusable session binding', () => {
    const sessionId = crypto.randomUUID();
    const connect = {
      __clodexArtifactBridge: 2,
      type: 'connect',
      sessionId,
      navigationEpoch,
    } as const;

    expect(artifactBridgeConnectSchema.safeParse(connect).success).toBe(true);
    expect(
      artifactBridgeSessionBindingSchema.safeParse({
        sessionId,
        navigationEpoch,
      }).success,
    ).toBe(true);
    expect(
      artifactBridgeConnectSchema.safeParse({
        ...connect,
        __clodexArtifactBridge: 1,
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeConnectSchema.safeParse({
        ...connect,
        sessionId: 'not-a-session-uuid',
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeConnectSchema.safeParse({
        ...connect,
        sessionId: undefined,
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeConnectSchema.safeParse({
        ...connect,
        navigationEpoch: undefined,
      }).success,
    ).toBe(false);
    for (const invalidEpoch of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        artifactBridgeConnectSchema.safeParse({
          ...connect,
          navigationEpoch: invalidEpoch,
        }).success,
      ).toBe(false);
    }
    expect(
      artifactBridgeConnectSchema.safeParse({
        ...connect,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeSessionBindingSchema.safeParse({
        sessionId,
        navigationEpoch,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it('validates an exact child hello without modeling its out-of-band port', () => {
    const hello = {
      __clodexArtifactBridge: 2,
      type: 'hello',
      contentRevision: 'a'.repeat(64),
    } as const;

    expect(artifactBridgeHelloSchema.safeParse(hello).success).toBe(true);
    expect(
      artifactBridgeHelloSchema.safeParse({
        ...hello,
        __clodexArtifactBridge: 1,
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeHelloSchema.safeParse({
        ...hello,
        type: 'connect',
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeHelloSchema.safeParse({
        __clodexArtifactBridge: 2,
        type: 'hello',
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeHelloSchema.safeParse({
        ...hello,
        contentRevision: 'A'.repeat(64),
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeHelloSchema.safeParse({
        ...hello,
        sessionId: crypto.randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeHelloSchema.safeParse({
        ...hello,
        port: 'MessagePort is transferred out-of-band',
      }).success,
    ).toBe(false);
  });

  it('defines navigation epochs as positive safe integers', () => {
    expect(artifactBridgeNavigationEpochSchema.safeParse(1).success).toBe(true);
    expect(
      artifactBridgeNavigationEpochSchema.safeParse(Number.MAX_SAFE_INTEGER)
        .success,
    ).toBe(true);
    for (const invalid of [
      undefined,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        artifactBridgeNavigationEpochSchema.safeParse(invalid).success,
      ).toBe(false);
    }
  });
});

describe('artifact bridge organization policy helpers', () => {
  it('matches exact and component wildcard MCP tool patterns', () => {
    expect(
      matchesArtifactBridgeToolPolicy(['docs/search'], 'docs', 'search'),
    ).toBe(true);
    expect(matchesArtifactBridgeToolPolicy(['docs/*'], 'docs', 'update')).toBe(
      true,
    );
    expect(matchesArtifactBridgeToolPolicy(['*/search'], 'crm', 'search')).toBe(
      true,
    );
    expect(matchesArtifactBridgeToolPolicy(['*/*'], 'crm', 'update')).toBe(
      true,
    );
    expect(
      matchesArtifactBridgeToolPolicy(['docs/search'], 'docs', 'update'),
    ).toBe(false);
  });

  it('rejects malformed organization tool policy patterns', () => {
    expect(() =>
      artifactBridgePolicySchema.parse({
        allowedMcpReadTools: ['docs'],
      }),
    ).toThrow('server/tool');
    expect(() =>
      artifactBridgePolicySchema.parse({
        allowedMcpWriteTools: ['docs/search/extra'],
      }),
    ).toThrow('server/tool');
  });

  it('builds expiry choices that cannot exceed organization policy', () => {
    const bounded = artifactBridgePolicySchema.parse({
      allowNeverExpiringGrants: false,
      maxGrantDurationHours: 48,
    });
    expect(getArtifactBridgeGrantExpiryPresets(bounded)).toEqual([
      { value: 'day', label: '1 day', hours: 24 },
      {
        value: 'policy-max',
        label: 'Policy maximum (2 days)',
        hours: 48,
      },
    ]);

    const short = artifactBridgePolicySchema.parse({
      allowNeverExpiringGrants: true,
      maxGrantDurationHours: 12,
    });
    expect(getArtifactBridgeGrantExpiryPresets(short)).toEqual([
      {
        value: 'policy-max',
        label: 'Policy maximum (12 hours)',
        hours: 12,
      },
      { value: 'never', label: 'No expiry', hours: null },
    ]);
  });

  it('treats a disabled policy as denying every capability', () => {
    const policy = artifactBridgePolicySchema.parse({
      enabled: false,
      allowedCapabilities: ['agent:ask'],
    });
    expect(isArtifactBridgeCapabilityAllowed(policy, 'agent:ask')).toBe(false);
  });

  it('applies bounded runtime quota defaults and permits explicit zero limits', () => {
    expect(artifactBridgePolicySchema.parse({})).toMatchObject({
      maxConcurrentInvocations: 2,
      maxAgentAsksPerHour: 20,
      maxAutomationRunsPerHour: 30,
    });
    expect(
      artifactBridgePolicySchema.parse({
        maxConcurrentInvocations: 1,
        maxAgentAsksPerHour: 0,
        maxAutomationRunsPerHour: 0,
      }),
    ).toMatchObject({
      maxConcurrentInvocations: 1,
      maxAgentAsksPerHour: 0,
      maxAutomationRunsPerHour: 0,
    });
    expect(() =>
      artifactBridgePolicySchema.parse({ maxConcurrentInvocations: 17 }),
    ).toThrow();
  });

  it('defaults legacy grant inputs to persistent scope and validates session binding', () => {
    const base = {
      context: { kind: 'agent' as const, agentId: 'agent-1', appId: 'app-1' },
      identity: {
        manifestSchemaVersion: 1 as const,
        appVersion: '1.0.0',
        manifestHash: 'a'.repeat(64),
        executableHash: 'b'.repeat(64),
        assetHash: 'c'.repeat(64),
      },
      capabilities: [],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    };
    expect(artifactBridgeGrantInputSchema.parse(base).scope).toEqual({
      kind: 'persistent',
    });
    const legacyInput = artifactBridgeGrantInputSchema.parse({
      context: base.context,
      capabilities: base.capabilities,
      mcpTools: base.mcpTools,
      mcpWriteTools: base.mcpWriteTools,
      automationIds: base.automationIds,
      expiresAt: base.expiresAt,
    });
    expect(legacyInput.identity).toBeUndefined();
    expect(legacyInput.scope).toEqual({ kind: 'persistent' });
    expect(
      artifactBridgeGrantScopeSchema.parse({
        kind: 'session',
        sessionId: crypto.randomUUID(),
      }),
    ).toMatchObject({ kind: 'session' });
    expect(() =>
      artifactBridgeGrantScopeSchema.parse({
        kind: 'session',
        sessionId: 'replayed-or-malformed',
      }),
    ).toThrow();
  });
});
