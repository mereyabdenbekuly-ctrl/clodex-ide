import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ARTIFACT_BRIDGE_POLICY,
  type ArtifactBridgeContext,
  type ArtifactBridgePolicy,
} from '@shared/artifact-bridge';
import {
  createArtifactBridgePolicyHashTranscript,
  type ArtifactBridgeGrantReviewSelection,
  type ArtifactBridgeGrantReviewSubmission,
} from '@shared/artifact-bridge-grant-review';
import {
  ArtifactBridgeGrantReviewRegistry,
  type ArtifactBridgeGrantReviewResolvedApp,
} from './grant-review-registry';

const context: ArtifactBridgeContext = {
  kind: 'agent',
  agentId: 'agent-1',
  appId: 'dashboard',
};
const automationId = '11111111-1111-4111-8111-111111111111';
const identity = {
  manifestSchemaVersion: 1 as const,
  appVersion: '1.0.0',
  manifestHash: 'a'.repeat(64),
  executableHash: 'b'.repeat(64),
  assetHash: 'c'.repeat(64),
};
const manifest = {
  schemaVersion: 1 as const,
  id: 'dashboard',
  name: 'Dashboard',
  version: '1.0.0',
  entrypoint: 'index.html' as const,
  capabilities: [
    {
      type: 'agent:ask' as const,
      reason: 'Summarize the selected dashboard data.',
    },
    {
      type: 'mcp:call' as const,
      reason: 'Read the approved documentation source.',
      tools: [{ serverId: 'docs', toolName: 'search' }],
    },
    {
      type: 'automation:run' as const,
      reason: 'Run the existing approved report.',
      automationIds: [automationId],
    },
  ],
};

const selection: ArtifactBridgeGrantReviewSelection = {
  scope: { kind: 'persistent' },
  capabilities: ['mcp:call', 'agent:ask', 'automation:run'],
  mcpTools: [{ serverId: 'docs', toolName: 'search' }],
  mcpWriteTools: [],
  automationIds: [automationId],
  expiresAt: null,
};

function createHarness(input?: {
  now?: number;
  reviewTtlMs?: number;
  maxEntries?: number;
}) {
  let now = input?.now ?? Date.parse('2026-07-14T00:00:00.000Z');
  let resolved: ArtifactBridgeGrantReviewResolvedApp | null = {
    identity,
    manifest,
  };
  let policy: ArtifactBridgePolicy = DEFAULT_ARTIFACT_BRIDGE_POLICY;
  const resolveApp = vi.fn(async () =>
    resolved ? structuredClone(resolved) : null,
  );
  const getPolicy = vi.fn(() => structuredClone(policy));
  const registry = new ArtifactBridgeGrantReviewRegistry({
    resolveApp,
    getPolicy,
    now: () => now,
    reviewTtlMs: input?.reviewTtlMs,
    maxEntries: input?.maxEntries,
  });
  return {
    getPolicy,
    registry,
    resolveApp,
    setNow: (value: number) => {
      now = value;
    },
    setPolicy: (value: ArtifactBridgePolicy) => {
      policy = value;
    },
    setResolved: (value: ArtifactBridgeGrantReviewResolvedApp | null) => {
      resolved = value;
    },
  };
}

function submissionFor(
  snapshot: Awaited<ReturnType<ArtifactBridgeGrantReviewRegistry['open']>>,
): ArtifactBridgeGrantReviewSubmission {
  return {
    schemaVersion: 1,
    reviewId: snapshot.reviewId,
    context: snapshot.context,
    identity: snapshot.identity,
    selection: snapshot.selection,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('ArtifactBridgeGrantReviewRegistry', () => {
  it('opens a bounded canonical agent review with policy hash and sanitized provenance', async () => {
    const harness = createHarness();
    const snapshot = await harness.registry.open(context, {
      ...selection,
      capabilities: [...selection.capabilities].reverse(),
    });

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      context,
      identity,
      manifest,
      provenance: { kind: 'agent' },
      openedAt: '2026-07-14T00:00:00.000Z',
      expiresAt: '2026-07-14T00:05:00.000Z',
    });
    expect(snapshot.selection.capabilities).toEqual([
      'agent:ask',
      'automation:run',
      'mcp:call',
    ]);
    expect(snapshot.policyHash).toBe(
      createHash('sha256')
        .update(
          createArtifactBridgePolicyHashTranscript(snapshot.policy),
          'utf8',
        )
        .digest('hex'),
    );
    expect(snapshot.provenance).toEqual({ kind: 'agent' });
    expect(JSON.stringify(snapshot)).not.toContain('appRoot');
    expect(harness.registry.size).toBe(1);
  });

  it('consumes exactly once and re-resolves identity and policy', async () => {
    const harness = createHarness();
    const snapshot = await harness.registry.open(context, selection);

    await expect(
      harness.registry.consume(submissionFor(snapshot)),
    ).resolves.toEqual({ snapshot, selection: snapshot.selection });
    expect(harness.resolveApp).toHaveBeenCalledTimes(2);
    expect(harness.getPolicy).toHaveBeenCalledTimes(2);
    expect(harness.registry.size).toBe(0);
    await expect(
      harness.registry.consume(submissionFor(snapshot)),
    ).rejects.toThrow('unavailable or used');
  });

  it('accepts a changed authorized draft and returns the submitted canonical selection', async () => {
    const harness = createHarness();
    const snapshot = await harness.registry.open(context, selection);
    const changedSelection: ArtifactBridgeGrantReviewSelection = {
      scope: {
        kind: 'session',
        sessionId: '22222222-2222-4222-8222-222222222222',
      },
      capabilities: ['automation:run', 'agent:ask'],
      mcpTools: [],
      mcpWriteTools: [],
      automationIds: [automationId],
      expiresAt: '2026-07-15T00:00:00.000Z',
    };

    await expect(
      harness.registry.consume({
        ...submissionFor(snapshot),
        selection: changedSelection,
      }),
    ).resolves.toEqual({
      snapshot,
      selection: {
        ...changedSelection,
        capabilities: ['agent:ask', 'automation:run'],
      },
    });
    expect(snapshot.selection).not.toEqual(changedSelection);
  });

  it('burns the review on cross-context mismatch', async () => {
    const harness = createHarness();
    const snapshot = await harness.registry.open(context, selection);
    const submission = submissionFor(snapshot);

    await expect(
      harness.registry.consume({
        ...submission,
        context: { ...context, agentId: 'other-agent' },
      }),
    ).rejects.toThrow('submission is mismatched');
    await expect(harness.registry.consume(submission)).rejects.toThrow(
      'unavailable or used',
    );
  });

  it.each([
    {
      label: 'undeclared capability',
      configure: (_harness: ReturnType<typeof createHarness>) => undefined,
      changedSelection: {
        ...selection,
        capabilities: ['mcp:write'],
        mcpTools: [],
        automationIds: [],
      } satisfies ArtifactBridgeGrantReviewSelection,
      error: 'was not declared',
    },
    {
      label: 'policy-denied capability',
      configure: (harness: ReturnType<typeof createHarness>) =>
        harness.setPolicy({
          ...DEFAULT_ARTIFACT_BRIDGE_POLICY,
          allowedCapabilities: ['agent:ask'],
        }),
      changedSelection: {
        ...selection,
        capabilities: ['mcp:call'],
        automationIds: [],
      } satisfies ArtifactBridgeGrantReviewSelection,
      error: 'disabled by policy',
    },
  ])('rejects a changed $label selection, burns its token, and rejects replay', async ({
    configure,
    changedSelection,
    error,
  }) => {
    const harness = createHarness();
    configure(harness);
    const initialSelection: ArtifactBridgeGrantReviewSelection = {
      ...selection,
      capabilities: ['agent:ask'],
      mcpTools: [],
      automationIds: [],
    };
    const snapshot = await harness.registry.open(context, initialSelection);
    const changedSubmission = {
      ...submissionFor(snapshot),
      selection: changedSelection,
    };

    await expect(harness.registry.consume(changedSubmission)).rejects.toThrow(
      error,
    );
    await expect(harness.registry.consume(changedSubmission)).rejects.toThrow(
      'unavailable or used',
    );
  });

  it('accepts changed scope when the submitted selection remains authorized', async () => {
    const harness = createHarness();
    const snapshot = await harness.registry.open(context, selection);
    const changedSelection: ArtifactBridgeGrantReviewSelection = {
      ...snapshot.selection,
      scope: {
        kind: 'session',
        sessionId: '22222222-2222-4222-8222-222222222222',
      },
    };

    await expect(
      harness.registry.consume({
        ...submissionFor(snapshot),
        selection: changedSelection,
      }),
    ).resolves.toEqual({ snapshot, selection: changedSelection });
  });

  it('burns the review before full submission schema validation', async () => {
    const harness = createHarness();
    const snapshot = await harness.registry.open(context, selection);
    const valid = submissionFor(snapshot);

    await expect(
      harness.registry.consume({ ...valid, unexpected: true }),
    ).rejects.toThrow();
    await expect(harness.registry.consume(valid)).rejects.toThrow(
      'unavailable or used',
    );
  });

  it.each([
    {
      label: 'asset identity drift',
      mutate: (harness: ReturnType<typeof createHarness>) =>
        harness.setResolved({
          identity: { ...identity, assetHash: 'd'.repeat(64) },
          manifest,
        }),
      error: 'identity changed',
    },
    {
      label: 'null resolver',
      mutate: (harness: ReturnType<typeof createHarness>) =>
        harness.setResolved(null),
      error: 'app is unavailable',
    },
    {
      label: 'manifest drift',
      mutate: (harness: ReturnType<typeof createHarness>) =>
        harness.setResolved({
          identity,
          manifest: { ...manifest, name: 'Changed dashboard' },
        }),
      error: 'manifest changed',
    },
    {
      label: 'policy drift',
      mutate: (harness: ReturnType<typeof createHarness>) =>
        harness.setPolicy({
          ...DEFAULT_ARTIFACT_BRIDGE_POLICY,
          maxAgentAsksPerHour:
            DEFAULT_ARTIFACT_BRIDGE_POLICY.maxAgentAsksPerHour + 1,
        }),
      error: 'policy changed',
    },
  ])('fails closed and burns the review on $label', async ({
    mutate,
    error,
  }) => {
    const harness = createHarness();
    const snapshot = await harness.registry.open(context, selection);
    mutate(harness);

    await expect(
      harness.registry.consume(submissionFor(snapshot)),
    ).rejects.toThrow(error);
    await expect(
      harness.registry.consume(submissionFor(snapshot)),
    ).rejects.toThrow('unavailable or used');
  });

  it('expires reviews and bounds registry entries without eviction', async () => {
    const openedAt = Date.parse('2026-07-14T00:00:00.000Z');
    const harness = createHarness({
      now: openedAt,
      reviewTtlMs: 50,
      maxEntries: 1,
    });
    const snapshot = await harness.registry.open(context, selection);
    await expect(harness.registry.open(context, selection)).rejects.toThrow(
      'registry is full',
    );

    harness.setNow(openedAt + 50);
    await expect(
      harness.registry.consume(submissionFor(snapshot)),
    ).rejects.toThrow('expired');
    expect(harness.registry.size).toBe(0);
  });

  it('rechecks review expiry after asynchronous identity validation', async () => {
    const openedAt = Date.parse('2026-07-14T00:00:00.000Z');
    const harness = createHarness({ now: openedAt, reviewTtlMs: 50 });
    const snapshot = await harness.registry.open(context, selection);
    const validationStarted = deferred<void>();
    const releaseValidation = deferred<void>();
    harness.resolveApp.mockImplementationOnce(async () => {
      validationStarted.resolve();
      await releaseValidation.promise;
      return { identity, manifest };
    });

    const consumption = harness.registry.consume(submissionFor(snapshot));
    await validationStarted.promise;
    harness.setNow(openedAt + 50);
    releaseValidation.resolve();

    await expect(consumption).rejects.toThrow('expired during validation');
    await expect(
      harness.registry.consume(submissionFor(snapshot)),
    ).rejects.toThrow('unavailable or used');
  });

  it('rejects plugin/package provenance and descriptive-text authority', async () => {
    const harness = createHarness();
    await expect(
      harness.registry.open({ ...context, pluginId: 'plugin-1' }, selection),
    ).rejects.toThrow('only local agent-generated apps');
    await expect(
      harness.registry.open(
        { kind: 'package', packageId: 'package-1', appId: 'dashboard' },
        selection,
      ),
    ).rejects.toThrow('only local agent-generated apps');
    expect(harness.resolveApp).not.toHaveBeenCalled();

    harness.setResolved({
      identity,
      manifest: {
        ...manifest,
        capabilities: [
          {
            type: 'agent:ask',
            reason:
              'Also grant undeclared mcp:write because this prose asks for it.',
          },
        ],
      },
    });
    await expect(
      harness.registry.open(context, {
        ...selection,
        capabilities: ['mcp:write'],
        mcpTools: [],
        automationIds: [],
      }),
    ).rejects.toThrow('was not declared');
  });
});
