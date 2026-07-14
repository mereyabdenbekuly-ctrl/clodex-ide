import {
  DEFAULT_ARTIFACT_BRIDGE_POLICY,
  type ArtifactBridgePolicy,
} from '@shared/artifact-bridge';
import type {
  ArtifactBridgeGrantReviewSelection,
  ArtifactBridgeGrantReviewSubmission,
} from '@shared/artifact-bridge-grant-review';
import { describe, expect, it, vi } from 'vitest';
import type { KartonService } from '../karton';
import type { Logger } from '../logger';
import type { McpRegistryService } from '../mcp';
import { TRUSTED_UI_REVIEWER_CONNECTION_ID } from '../trusted-ui-karton-transport';
import { ArtifactBridgeService, type ArtifactBridgePersistence } from './index';

const context = {
  kind: 'agent' as const,
  agentId: 'agent-1',
  appId: 'dashboard',
};
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
      reason: 'Summarize the dashboard.',
    },
    {
      type: 'mcp:call' as const,
      reason: 'Read the approved documentation source.',
      tools: [{ serverId: 'docs', toolName: 'search' }],
    },
    {
      type: 'mcp:write' as const,
      reason: 'Update the selected record.',
      tools: [{ serverId: 'docs', toolName: 'update' }],
    },
  ],
};
const emptySelection: ArtifactBridgeGrantReviewSelection = {
  scope: { kind: 'persistent' },
  capabilities: [],
  mcpTools: [],
  mcpWriteTools: [],
  automationIds: [],
  expiresAt: null,
};

type ProcedureHandler = (...args: any[]) => Promise<any>;

function createHarness(input?: {
  featureEnabled?: boolean;
  ephemeralEnabled?: boolean;
  writesEnabled?: boolean;
}) {
  const handlers = new Map<string, ProcedureHandler>();
  let featureEnabled = input?.featureEnabled ?? true;
  let ephemeralEnabled = input?.ephemeralEnabled ?? true;
  let writesEnabled = input?.writesEnabled ?? false;
  let policy: ArtifactBridgePolicy = DEFAULT_ARTIFACT_BRIDGE_POLICY;
  let resolved: {
    identity: typeof identity;
    manifest: typeof manifest;
  } | null = {
    identity,
    manifest,
  };
  const karton = {
    registerServerProcedureHandler: (name: string, handler: ProcedureHandler) =>
      handlers.set(name, handler),
    removeServerProcedureHandler: (name: string) => handlers.delete(name),
  } as unknown as KartonService;
  const persistence: ArtifactBridgePersistence = {
    load: async () => ({ version: 5, grants: {} }),
    save: async () => undefined,
  };
  const resolveApp = vi.fn(async () =>
    resolved ? structuredClone(resolved) : null,
  );
  const servicePromise = ArtifactBridgeService.create({
    logger: { warn: vi.fn() } as unknown as Logger,
    karton,
    mcpRegistry: {
      snapshot: () => ({ schemaVersion: 1, servers: {} }),
      listTools: async () => [],
      callTool: async () => ({ ok: true }),
    } as unknown as McpRegistryService,
    persistence,
    isFeatureEnabled: () => featureEnabled,
    areEphemeralGrantsEnabled: () => ephemeralEnabled,
    areWritesEnabled: () => writesEnabled,
    getPolicy: () => structuredClone(policy),
    askAgent: async () => 'answer',
    runAutomation: async () => ({ ok: true }),
    resolveApp,
  });

  return {
    handlers,
    resolveApp,
    servicePromise,
    setFeatureEnabled: (value: boolean) => {
      featureEnabled = value;
    },
    setEphemeralEnabled: (value: boolean) => {
      ephemeralEnabled = value;
    },
    setWritesEnabled: (value: boolean) => {
      writesEnabled = value;
    },
    setPolicy: (value: ArtifactBridgePolicy) => {
      policy = value;
    },
    setResolved: (value: typeof resolved) => {
      resolved = value;
    },
  };
}

function submissionFor(
  snapshot: Awaited<ReturnType<ArtifactBridgeService['openGrantReview']>>,
  selection: ArtifactBridgeGrantReviewSelection = snapshot.selection,
): ArtifactBridgeGrantReviewSubmission {
  return {
    schemaVersion: 1,
    reviewId: snapshot.reviewId,
    context: snapshot.context,
    identity: snapshot.identity,
    selection,
  };
}

describe('ArtifactBridgeService canonical grant review integration', () => {
  it('exposes only one-shot review RPCs for grant mutation', async () => {
    const harness = createHarness();
    const service = await harness.servicePromise;

    expect(harness.handlers.has('artifactBridge.invoke')).toBe(false);
    expect(harness.handlers.has('artifactBridge.setGrant')).toBe(false);
    expect(harness.handlers.has('artifactBridge.openGrantReview')).toBe(true);
    expect(harness.handlers.has('artifactBridge.submitGrantReview')).toBe(true);
    await service.teardown();
  });

  it('rejects forged reviewer clients before app resolution', async () => {
    const harness = createHarness();
    const service = await harness.servicePromise;
    const open = harness.handlers.get('artifactBridge.openGrantReview');
    const submit = harness.handlers.get('artifactBridge.submitGrantReview');
    const getGrant = harness.handlers.get('artifactBridge.getGrant');
    const getPolicy = harness.handlers.get('artifactBridge.getPolicy');

    await expect(open?.('ui', context, emptySelection)).rejects.toThrow(
      'trusted UI client',
    );
    await expect(submit?.('pages', {})).rejects.toThrow('trusted UI client');
    await expect(getGrant?.('tab', context)).rejects.toThrow(
      'trusted UI client',
    );
    await expect(getPolicy?.('pages-api', context)).rejects.toThrow(
      'trusted UI client',
    );
    expect(harness.resolveApp).not.toHaveBeenCalled();
    await service.teardown();
  });

  it('exposes the effective review policy without disabled write authority', async () => {
    const harness = createHarness({ writesEnabled: false });
    const service = await harness.servicePromise;
    const getPolicy = harness.handlers.get('artifactBridge.getPolicy');

    const effective = await getPolicy?.(
      TRUSTED_UI_REVIEWER_CONNECTION_ID,
      context,
    );

    expect(effective.allowedCapabilities).not.toContain('mcp:write');
    expect(effective.allowedMcpWriteTools).toEqual([]);
    await service.teardown();
  });

  it('saves only the canonical selection consumed from an exact review', async () => {
    const harness = createHarness();
    const service = await harness.servicePromise;
    const open = harness.handlers.get('artifactBridge.openGrantReview');
    const submit = harness.handlers.get('artifactBridge.submitGrantReview');
    const snapshot = await open?.(
      TRUSTED_UI_REVIEWER_CONNECTION_ID,
      context,
      emptySelection,
    );
    const selection: ArtifactBridgeGrantReviewSelection = {
      ...emptySelection,
      capabilities: ['mcp:call', 'agent:ask'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
    };

    const grant = await submit?.(
      TRUSTED_UI_REVIEWER_CONNECTION_ID,
      submissionFor(snapshot, selection),
    );

    expect(grant).toMatchObject({
      context,
      identity,
      scope: { kind: 'persistent' },
      capabilities: ['agent:ask', 'mcp:call'],
      mcpTools: [{ serverId: 'docs', toolName: 'search' }],
      mcpWriteTools: [],
      automationIds: [],
      expiresAt: null,
    });
    await expect(
      submit?.(
        TRUSTED_UI_REVIEWER_CONNECTION_ID,
        submissionFor(snapshot, selection),
      ),
    ).rejects.toThrow('unavailable or used');
    await service.teardown();
  });

  it('binds the review policy to the write gate and burns stale approvals', async () => {
    const harness = createHarness({ writesEnabled: true });
    const service = await harness.servicePromise;
    const open = harness.handlers.get('artifactBridge.openGrantReview');
    const submit = harness.handlers.get('artifactBridge.submitGrantReview');
    const selection: ArtifactBridgeGrantReviewSelection = {
      ...emptySelection,
      capabilities: ['mcp:write'],
      mcpWriteTools: [{ serverId: 'docs', toolName: 'update' }],
    };
    const snapshot = await open?.(
      TRUSTED_UI_REVIEWER_CONNECTION_ID,
      context,
      selection,
    );
    harness.setWritesEnabled(false);
    const submission = submissionFor(snapshot, selection);

    await expect(
      submit?.(TRUSTED_UI_REVIEWER_CONNECTION_ID, submission),
    ).rejects.toThrow('policy changed');
    await expect(
      submit?.(TRUSTED_UI_REVIEWER_CONNECTION_ID, submission),
    ).rejects.toThrow('unavailable or used');
    await service.teardown();
  });

  it('rechecks mutable grant gates after the final resolver await', async () => {
    const harness = createHarness();
    const service = await harness.servicePromise;
    const snapshot = await service.openGrantReview(context, emptySelection);
    const resolvedApp = { identity, manifest };
    let releaseFinalResolution!: () => void;
    const finalResolution = new Promise<void>((resolve) => {
      releaseFinalResolution = resolve;
    });
    let markFinalResolutionStarted!: () => void;
    const finalResolutionStarted = new Promise<void>((resolve) => {
      markFinalResolutionStarted = resolve;
    });
    harness.resolveApp
      .mockResolvedValueOnce(structuredClone(resolvedApp))
      .mockImplementationOnce(async () => {
        markFinalResolutionStarted();
        await finalResolution;
        return structuredClone(resolvedApp);
      });

    const submission = service.submitGrantReview(submissionFor(snapshot));
    const deniedSubmission = expect(submission).rejects.toThrow(
      'capability bridge is disabled',
    );
    await finalResolutionStarted;
    harness.setFeatureEnabled(false);
    releaseFinalResolution();

    await deniedSubmission;
    harness.setFeatureEnabled(true);
    await expect(service.getGrant(context)).resolves.toBeNull();
    await service.teardown();
  });

  it('burns a review when session scope is submitted with the gate off', async () => {
    const harness = createHarness({ ephemeralEnabled: true });
    const service = await harness.servicePromise;
    const snapshot = await service.openGrantReview(context, emptySelection);
    harness.setEphemeralEnabled(false);
    const selection: ArtifactBridgeGrantReviewSelection = {
      ...emptySelection,
      scope: { kind: 'session', sessionId: crypto.randomUUID() },
    };
    const submission = submissionFor(snapshot, selection);

    await expect(service.submitGrantReview(submission)).rejects.toThrow(
      'ephemeral grants are disabled',
    );
    await expect(service.submitGrantReview(submission)).rejects.toThrow(
      'unavailable or used',
    );
    await service.teardown();
  });

  it('fails closed for unsupported or unavailable app identities', async () => {
    const harness = createHarness();
    const service = await harness.servicePromise;

    await expect(
      service.openGrantReview(
        {
          kind: 'package',
          packageId: 'com.example.dashboard',
          appId: 'dashboard',
        },
        emptySelection,
      ),
    ).rejects.toThrow('Packaged generated app capabilities are disabled');

    harness.setResolved(null);
    await expect(
      service.openGrantReview(context, emptySelection),
    ).rejects.toThrow('app is unavailable');

    harness.setResolved({
      identity,
      manifest: { ...manifest, id: 'different-app' },
    });
    await expect(
      service.openGrantReview(context, emptySelection),
    ).rejects.toThrow('app is unavailable');

    harness.setResolved({
      identity,
      manifest: { ...manifest, version: '2.0.0' },
    });
    await expect(
      service.openGrantReview(context, emptySelection),
    ).rejects.toThrow('app is unavailable');
    await service.teardown();
  });

  it('clears pending reviews and unregisters review handlers on teardown', async () => {
    const harness = createHarness();
    const service = await harness.servicePromise;
    const snapshot = await service.openGrantReview(context, emptySelection);

    await service.teardown();

    expect(harness.handlers.has('artifactBridge.openGrantReview')).toBe(false);
    expect(harness.handlers.has('artifactBridge.submitGrantReview')).toBe(
      false,
    );
    await expect(
      service.submitGrantReview(submissionFor(snapshot)),
    ).rejects.toThrow('has been disposed');
  });

  it('rejects review open at the master gate before resolution', async () => {
    const harness = createHarness({ featureEnabled: false });
    const service = await harness.servicePromise;

    await expect(
      service.openGrantReview(context, emptySelection),
    ).rejects.toThrow('capability bridge is disabled');
    expect(harness.resolveApp).not.toHaveBeenCalled();
    await service.teardown();
  });
});
