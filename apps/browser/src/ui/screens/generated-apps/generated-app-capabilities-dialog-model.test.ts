import { artifactBridgePolicySchema } from '@shared/artifact-bridge';
import {
  artifactBridgeGrantReviewSnapshotSchema,
  type ArtifactBridgeGrantReviewSelection,
} from '@shared/artifact-bridge-grant-review';
import { describe, expect, it } from 'vitest';
import {
  createGeneratedAppGrantReviewSubmission,
  createInitialGeneratedAppGrantReviewSelection,
  getGeneratedAppGrantReviewCapabilityOptions,
  getGeneratedAppGrantReviewExpiryState,
  getGeneratedAppGrantReviewMcpToolOptions,
  setGeneratedAppGrantReviewCapability,
  setGeneratedAppGrantReviewExpiry,
  setGeneratedAppGrantReviewMcpTool,
} from './generated-app-capabilities-dialog-model';

const openedAt = '2026-07-14T00:00:00.000Z';
const automationId = '11111111-1111-4111-8111-111111111111';

const policy = artifactBridgePolicySchema.parse({
  enabled: true,
  allowedCapabilities: ['agent:ask', 'automation:run', 'mcp:call', 'mcp:write'],
  allowedMcpReadTools: ['docs/search'],
  allowNeverExpiringGrants: false,
  maxGrantDurationHours: 48,
});

const snapshot = artifactBridgeGrantReviewSnapshotSchema.parse({
  schemaVersion: 1,
  reviewId: '22222222-2222-4222-8222-222222222222',
  context: {
    kind: 'agent',
    agentId: 'agent-1',
    appId: 'dashboard',
  },
  identity: {
    manifestSchemaVersion: 1,
    appVersion: '1.4.0',
    manifestHash: 'a'.repeat(64),
    executableHash: 'b'.repeat(64),
    assetHash: 'c'.repeat(64),
  },
  manifest: {
    schemaVersion: 1,
    id: 'dashboard',
    name: 'Revenue dashboard',
    description: 'Shows exact revenue data.',
    version: '1.4.0',
    entrypoint: 'index.html',
    capabilities: [
      {
        type: 'agent:ask',
        reason: 'Summarize the visible report.',
      },
      {
        type: 'automation:run',
        reason: 'Refresh the report on request.',
        automationIds: [automationId],
      },
      {
        type: 'mcp:call',
        reason: 'Read source documentation.',
        tools: [
          { serverId: 'docs', toolName: 'search' },
          { serverId: 'private', toolName: 'lookup' },
        ],
      },
      {
        type: 'mcp:write',
        reason: 'Publish a report.',
        tools: [{ serverId: 'reports', toolName: 'publish' }],
      },
    ],
  },
  policy,
  policyHash: 'd'.repeat(64),
  provenance: { kind: 'agent' },
  openedAt,
  expiresAt: '2026-07-14T00:05:00.000Z',
  selection: {
    scope: { kind: 'persistent' },
    capabilities: ['agent:ask', 'mcp:call'],
    mcpTools: [{ serverId: 'docs', toolName: 'search' }],
    mcpWriteTools: [],
    automationIds: [],
    expiresAt: '2026-07-15T00:00:00.000Z',
  },
});

describe('generated app canonical grant review model', () => {
  it('builds every selector from the backend snapshot and preserves reasons', () => {
    expect(
      getGeneratedAppGrantReviewCapabilityOptions(snapshot, snapshot.selection),
    ).toEqual([
      expect.objectContaining({
        type: 'agent:ask',
        reason: 'Summarize the visible report.',
        selected: true,
        editable: true,
      }),
      expect.objectContaining({
        type: 'automation:run',
        reason: 'Refresh the report on request.',
        selected: false,
        editable: true,
      }),
      expect.objectContaining({
        type: 'mcp:call',
        reason: 'Read source documentation.',
        selected: true,
        editable: true,
      }),
      expect.objectContaining({
        type: 'mcp:write',
        reason: 'Publish a report.',
        editable: false,
        restriction:
          'Write capability review is handled by a separate reviewed flow.',
      }),
    ]);
    expect(
      getGeneratedAppGrantReviewMcpToolOptions(snapshot, snapshot.selection),
    ).toEqual([
      {
        serverId: 'docs',
        toolName: 'search',
        selected: true,
        allowedByPolicy: true,
      },
      {
        serverId: 'private',
        toolName: 'lookup',
        selected: false,
        allowedByPolicy: false,
      },
    ]);
  });

  it('uses exact existing grant selection and a policy-bounded empty default', () => {
    const existing = {
      schemaVersion: 5 as const,
      context: snapshot.context,
      identity: snapshot.identity,
      scope: { kind: 'persistent' as const },
      capabilities: ['mcp:call' as const],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: '2026-07-15T12:00:00.000Z',
      updatedAt: openedAt,
    };
    expect(
      createInitialGeneratedAppGrantReviewSelection(
        existing,
        policy,
        Date.parse(openedAt),
      ),
    ).toEqual({
      scope: existing.scope,
      capabilities: ['mcp:call'],
      mcpTools: existing.mcpTools,
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: existing.expiresAt,
    });

    expect(
      createInitialGeneratedAppGrantReviewSelection(
        null,
        policy,
        Date.parse(openedAt),
      ),
    ).toEqual({
      scope: { kind: 'persistent' },
      capabilities: [],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: '2026-07-15T00:00:00.000Z',
    });
  });

  it('narrows a stale existing draft to the current effective review policy', () => {
    const restrictedPolicy = artifactBridgePolicySchema.parse({
      ...policy,
      allowedCapabilities: ['agent:ask'],
      allowedMcpReadTools: [],
      allowedMcpWriteTools: [],
      maxGrantDurationHours: 24,
    });
    const existing = {
      schemaVersion: 5 as const,
      context: snapshot.context,
      identity: snapshot.identity,
      scope: { kind: 'persistent' as const },
      capabilities: [
        'agent:ask' as const,
        'mcp:call' as const,
        'mcp:write' as const,
      ],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [{ serverId: 'reports', toolName: 'publish' }],
      automationIds: [],
      expiresAt: '2026-07-20T00:00:00.000Z',
      updatedAt: openedAt,
    };

    expect(
      createInitialGeneratedAppGrantReviewSelection(
        existing,
        restrictedPolicy,
        Date.parse(openedAt),
      ),
    ).toEqual({
      scope: { kind: 'persistent' },
      capabilities: ['agent:ask'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: '2026-07-15T00:00:00.000Z',
    });
  });

  it('offers only canonical expiry choices allowed by the snapshot policy', () => {
    expect(
      getGeneratedAppGrantReviewExpiryState(snapshot, snapshot.selection),
    ).toEqual({
      value: 'day',
      options: [
        {
          value: 'day',
          label: '1 day',
          expiresAt: '2026-07-15T00:00:00.000Z',
        },
        {
          value: 'policy-max',
          label: 'Policy maximum (2 days)',
          expiresAt: '2026-07-16T00:00:00.000Z',
        },
      ],
    });
  });

  it('submits the exact backend review binding with the editable draft', () => {
    let selection = setGeneratedAppGrantReviewCapability(
      snapshot,
      snapshot.selection,
      'automation:run',
      true,
    );
    selection = setGeneratedAppGrantReviewExpiry(
      snapshot,
      selection,
      'policy-max',
    );
    const submission = createGeneratedAppGrantReviewSubmission(
      snapshot,
      selection,
    );

    expect(submission).toMatchObject({
      schemaVersion: 1,
      reviewId: snapshot.reviewId,
      context: snapshot.context,
      identity: snapshot.identity,
      selection: {
        capabilities: ['agent:ask', 'automation:run', 'mcp:call'],
        expiresAt: '2026-07-16T00:00:00.000Z',
      },
    });
  });

  it('rejects renderer-invented tools, scope, expiry, and write authority', () => {
    expect(() =>
      setGeneratedAppGrantReviewMcpTool(
        snapshot,
        snapshot.selection,
        { serverId: 'invented', toolName: 'tool' },
        true,
      ),
    ).toThrow('not selectable');

    const mutations: ArtifactBridgeGrantReviewSelection[] = [
      {
        ...snapshot.selection,
        scope: {
          kind: 'session',
          sessionId: '33333333-3333-4333-8333-333333333333',
        },
      },
      {
        ...snapshot.selection,
        expiresAt: '2026-07-15T12:34:56.000Z',
      },
      {
        ...snapshot.selection,
        capabilities: [...snapshot.selection.capabilities, 'mcp:write'],
        mcpWriteTools: [{ serverId: 'reports', toolName: 'publish' }],
      },
    ];
    for (const selection of mutations) {
      expect(() =>
        createGeneratedAppGrantReviewSubmission(snapshot, selection),
      ).toThrow();
    }
  });
});
