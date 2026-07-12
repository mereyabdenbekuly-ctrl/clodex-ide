import { describe, expect, it } from 'vitest';
import {
  artifactBridgeGrantInputSchema,
  artifactBridgeGrantScopeSchema,
  artifactBridgePolicySchema,
  getArtifactBridgeGrantExpiryPresets,
  isArtifactBridgeCapabilityAllowed,
  matchesArtifactBridgeToolPolicy,
} from './artifact-bridge';

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
