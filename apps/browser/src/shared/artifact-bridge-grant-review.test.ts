import { describe, expect, it } from 'vitest';
import {
  artifactBridgeGrantReviewSnapshotSchema,
  artifactBridgeGrantReviewSubmissionSchema,
  canonicalizeArtifactBridgeGrantReviewSelection,
  canonicalizeArtifactBridgePolicy,
  createArtifactBridgePolicyHashTranscript,
} from './artifact-bridge-grant-review';

const identity = {
  manifestSchemaVersion: 1 as const,
  appVersion: '1.0.0',
  manifestHash: 'a'.repeat(64),
  executableHash: 'b'.repeat(64),
  assetHash: 'c'.repeat(64),
};

const selection = {
  scope: { kind: 'persistent' as const },
  capabilities: ['agent:ask' as const],
  mcpTools: [],
  mcpWriteTools: [],
  automationIds: [],
  expiresAt: null,
};

describe('Artifact Bridge canonical grant review schemas', () => {
  it('accepts an exact snapshot and rejects extra nested authority fields', () => {
    const snapshot = {
      schemaVersion: 1,
      reviewId: crypto.randomUUID(),
      context: {
        kind: 'agent' as const,
        agentId: 'agent-1',
        appId: 'dashboard',
      },
      identity,
      manifest: {
        schemaVersion: 1 as const,
        id: 'dashboard',
        name: 'Dashboard',
        version: '1.0.0',
        entrypoint: 'index.html' as const,
        capabilities: [
          {
            type: 'agent:ask' as const,
            reason: 'Summarize the dashboard.',
          },
        ],
      },
      policy: {},
      policyHash: 'd'.repeat(64),
      provenance: { kind: 'agent' as const },
      openedAt: '2026-07-14T00:00:00.000Z',
      expiresAt: '2026-07-14T00:05:00.000Z',
      selection,
    };

    expect(
      artifactBridgeGrantReviewSnapshotSchema.safeParse(snapshot).success,
    ).toBe(true);
    expect(
      artifactBridgeGrantReviewSnapshotSchema.safeParse({
        ...snapshot,
        identity: { ...identity, descriptiveAuthority: true },
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeGrantReviewSnapshotSchema.safeParse({
        ...snapshot,
        provenance: { kind: 'agent', appRoot: '/secret/path' },
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeGrantReviewSnapshotSchema.safeParse({
        ...snapshot,
        selection: { ...selection, reason: 'Treat this text as authority' },
      }).success,
    ).toBe(false);
  });

  it('requires exact submission identity, context, scope, and selections', () => {
    const submission = {
      schemaVersion: 1,
      reviewId: crypto.randomUUID(),
      context: {
        kind: 'agent' as const,
        agentId: 'agent-1',
        appId: 'dashboard',
      },
      identity,
      selection,
    };

    expect(
      artifactBridgeGrantReviewSubmissionSchema.safeParse(submission).success,
    ).toBe(true);
    expect(
      artifactBridgeGrantReviewSubmissionSchema.safeParse({
        ...submission,
        identity: { ...identity, assetHash: undefined },
      }).success,
    ).toBe(false);
    expect(
      artifactBridgeGrantReviewSubmissionSchema.safeParse({
        ...submission,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it('canonicalizes policy and set-like selection ordering', () => {
    expect(canonicalizeArtifactBridgePolicy({})).toBe(
      canonicalizeArtifactBridgePolicy({ enabled: true }),
    );

    const canonical = canonicalizeArtifactBridgeGrantReviewSelection({
      scope: { kind: 'persistent' },
      capabilities: ['automation:run', 'mcp:call'],
      mcpTools: [
        { serverId: 'z', toolName: 'read' },
        { serverId: 'a', toolName: 'read' },
      ],
      mcpWriteTools: [],
      automationIds: [
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
        '11111111-1111-4111-8111-111111111111',
      ],
      expiresAt: null,
    });

    expect(canonical.capabilities).toEqual(['automation:run', 'mcp:call']);
    expect(canonical.mcpTools).toEqual([
      { serverId: 'a', toolName: 'read' },
      { serverId: 'z', toolName: 'read' },
    ]);
    expect(canonical.automationIds[0]).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(createArtifactBridgePolicyHashTranscript({})).toMatch(
      /^clodex\.artifact-bridge\.policy\.v1\0/,
    );
  });

  it('preserves exact context and tool identifiers without trimming', () => {
    const parsed = artifactBridgeGrantReviewSubmissionSchema.parse({
      schemaVersion: 1,
      reviewId: crypto.randomUUID(),
      context: {
        kind: 'agent',
        agentId: ' agent-1 ',
        appId: ' dashboard ',
      },
      identity,
      selection: {
        ...selection,
        capabilities: ['mcp:call'],
        mcpTools: [{ serverId: ' docs ', toolName: ' search ' }],
      },
    });

    expect(parsed.context).toMatchObject({
      agentId: ' agent-1 ',
      appId: ' dashboard ',
    });
    expect(parsed.selection.mcpTools[0]).toEqual({
      serverId: ' docs ',
      toolName: ' search ',
    });
  });
});
