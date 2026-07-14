import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  artifactBridgePolicySchema,
  matchesArtifactBridgeToolPolicy,
  type ArtifactBridgeContext,
  type ArtifactBridgePolicy,
} from '@shared/artifact-bridge';
import {
  artifactBridgeGrantReviewContextSchema,
  artifactBridgeGrantReviewIdentitySchema,
  artifactBridgeGrantReviewSnapshotSchema,
  artifactBridgeGrantReviewSubmissionSchema,
  canonicalizeArtifactBridgeGrantReviewSelection,
  canonicalizeArtifactBridgePolicy,
  createArtifactBridgePolicyHashTranscript,
  type ArtifactBridgeGrantReviewSelection,
  type ArtifactBridgeGrantReviewSnapshot,
  type ArtifactBridgeGrantReviewSubmission,
} from '@shared/artifact-bridge-grant-review';
import {
  canonicalizeGeneratedAppManifest,
  generatedAppManifestSchema,
  getManifestAutomationIds,
  getManifestCapabilityTypes,
  getManifestMcpTools,
  getManifestMcpWriteTools,
  type GeneratedAppIdentity,
  type GeneratedAppManifest,
} from '@shared/generated-app-manifest';

const DEFAULT_REVIEW_TTL_MS = 5 * 60_000;
const MAX_REVIEW_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 100;
const MAX_ENTRIES_LIMIT = 500;

export type ArtifactBridgeGrantReviewResolvedApp = {
  identity: GeneratedAppIdentity;
  manifest: GeneratedAppManifest;
};

export type ArtifactBridgeGrantReviewConsumption = {
  snapshot: ArtifactBridgeGrantReviewSnapshot;
  selection: ArtifactBridgeGrantReviewSelection;
};

export interface ArtifactBridgeGrantReviewRegistryOptions {
  resolveApp: (
    context: ArtifactBridgeContext,
  ) => Promise<ArtifactBridgeGrantReviewResolvedApp | null>;
  getPolicy: (context: ArtifactBridgeContext) => ArtifactBridgePolicy;
  now?: () => number;
  reviewTtlMs?: number;
  maxEntries?: number;
}

export class ArtifactBridgeGrantReviewRegistry {
  private readonly entries = new Map<
    string,
    ArtifactBridgeGrantReviewSnapshot
  >();
  private readonly now: () => number;
  private readonly reviewTtlMs: number;
  private readonly maxEntries: number;

  public constructor(
    private readonly options: ArtifactBridgeGrantReviewRegistryOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.reviewTtlMs = boundedInteger(
      options.reviewTtlMs ?? DEFAULT_REVIEW_TTL_MS,
      1,
      MAX_REVIEW_TTL_MS,
      'review TTL',
    );
    this.maxEntries = boundedInteger(
      options.maxEntries ?? DEFAULT_MAX_ENTRIES,
      1,
      MAX_ENTRIES_LIMIT,
      'entry limit',
    );
  }

  public get size(): number {
    this.cleanupExpired(this.now());
    return this.entries.size;
  }

  public async open(
    rawContext: ArtifactBridgeContext,
    rawSelection: ArtifactBridgeGrantReviewSelection,
  ): Promise<ArtifactBridgeGrantReviewSnapshot> {
    const now = this.now();
    const context = artifactBridgeGrantReviewContextSchema.parse(rawContext);
    assertSupportedAgentContext(context);
    const selection =
      canonicalizeArtifactBridgeGrantReviewSelection(rawSelection);
    const resolved = await this.resolveCurrent(context);
    const identity = artifactBridgeGrantReviewIdentitySchema.parse(
      resolved.identity,
    );
    const manifest = generatedAppManifestSchema.parse(resolved.manifest);
    if (manifest.id !== context.appId) {
      throw new Error('Grant review app manifest identity is mismatched');
    }
    const policy = artifactBridgePolicySchema.parse(
      this.options.getPolicy(context),
    );
    assertSelectionAuthorized(selection, manifest, policy, now);

    this.cleanupExpired(now);
    if (this.entries.size >= this.maxEntries) {
      throw new Error('Artifact Bridge grant review registry is full');
    }

    const snapshot = artifactBridgeGrantReviewSnapshotSchema.parse({
      schemaVersion: 1,
      reviewId: this.createReviewId(),
      context,
      identity,
      manifest,
      policy,
      policyHash: hashPolicy(policy),
      provenance: { kind: 'agent' },
      openedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.reviewTtlMs).toISOString(),
      selection,
    });
    this.entries.set(snapshot.reviewId, snapshot);
    return structuredClone(snapshot);
  }

  public async consume(
    rawSubmission: unknown,
  ): Promise<ArtifactBridgeGrantReviewConsumption> {
    const now = this.now();
    const reference = z
      .object({ reviewId: z.string().uuid() })
      .passthrough()
      .safeParse(rawSubmission);
    if (!reference.success) {
      throw new Error('Invalid Artifact Bridge grant review submission');
    }

    const snapshot = this.entries.get(reference.data.reviewId);
    if (!snapshot) {
      throw new Error('Artifact Bridge grant review is unavailable or used');
    }
    // Consumption is deliberately irreversible before any validation or
    // asynchronous resolver call. A failed, stale, or malicious submission
    // cannot retry the same approval ceremony.
    this.entries.delete(reference.data.reviewId);

    const submission =
      artifactBridgeGrantReviewSubmissionSchema.parse(rawSubmission);
    this.assertSubmissionMatchesSnapshot(submission, snapshot);
    const selection = canonicalizeArtifactBridgeGrantReviewSelection(
      submission.selection,
    );
    if (Date.parse(snapshot.expiresAt) <= now) {
      throw new Error('Artifact Bridge grant review has expired');
    }

    const current = await this.resolveCurrent(snapshot.context);
    const currentIdentity = artifactBridgeGrantReviewIdentitySchema.parse(
      current.identity,
    );
    const currentManifest = generatedAppManifestSchema.parse(current.manifest);
    if (!exactJsonEqual(snapshot.identity, currentIdentity)) {
      throw new Error('Artifact Bridge grant review identity changed');
    }
    if (
      canonicalizeGeneratedAppManifest(snapshot.manifest) !==
      canonicalizeGeneratedAppManifest(currentManifest)
    ) {
      throw new Error('Artifact Bridge grant review manifest changed');
    }

    const currentPolicy = artifactBridgePolicySchema.parse(
      this.options.getPolicy(snapshot.context),
    );
    if (
      snapshot.policyHash !== hashPolicy(currentPolicy) ||
      canonicalizeArtifactBridgePolicy(snapshot.policy) !==
        canonicalizeArtifactBridgePolicy(currentPolicy)
    ) {
      throw new Error('Artifact Bridge grant review policy changed');
    }
    assertSelectionAuthorized(selection, currentManifest, currentPolicy, now);
    if (Date.parse(snapshot.expiresAt) <= this.now()) {
      throw new Error('Artifact Bridge grant review expired during validation');
    }
    return structuredClone({ snapshot, selection });
  }

  public delete(reviewId: string): void {
    this.entries.delete(reviewId);
  }

  public deleteContext(rawContext: ArtifactBridgeContext): void {
    const context = artifactBridgeGrantReviewContextSchema.parse(rawContext);
    for (const [reviewId, snapshot] of this.entries) {
      if (exactJsonEqual(snapshot.context, context)) {
        this.entries.delete(reviewId);
      }
    }
  }

  public clear(): void {
    this.entries.clear();
  }

  private async resolveCurrent(
    context: ArtifactBridgeContext,
  ): Promise<ArtifactBridgeGrantReviewResolvedApp> {
    const resolved = await this.options.resolveApp(context);
    if (!resolved) {
      throw new Error('Artifact Bridge grant review app is unavailable');
    }
    return resolved;
  }

  private assertSubmissionMatchesSnapshot(
    submission: ArtifactBridgeGrantReviewSubmission,
    snapshot: ArtifactBridgeGrantReviewSnapshot,
  ): void {
    if (
      submission.reviewId !== snapshot.reviewId ||
      !exactJsonEqual(submission.context, snapshot.context) ||
      !exactJsonEqual(submission.identity, snapshot.identity)
    ) {
      throw new Error('Artifact Bridge grant review submission is mismatched');
    }
  }

  private cleanupExpired(now: number): void {
    for (const [reviewId, snapshot] of this.entries) {
      if (Date.parse(snapshot.expiresAt) <= now) {
        this.entries.delete(reviewId);
      }
    }
  }

  private createReviewId(): string {
    let reviewId = randomUUID();
    while (this.entries.has(reviewId)) reviewId = randomUUID();
    return reviewId;
  }
}

function assertSupportedAgentContext(context: ArtifactBridgeContext): void {
  if (context.kind !== 'agent' || context.pluginId !== undefined) {
    throw new Error(
      'Grant review currently supports only local agent-generated apps',
    );
  }
}

function assertSelectionAuthorized(
  selection: ArtifactBridgeGrantReviewSelection,
  manifest: GeneratedAppManifest,
  policy: ArtifactBridgePolicy,
  now: number,
): void {
  if (!policy.enabled) {
    throw new Error('Generated app capabilities are disabled by policy');
  }
  const declaredCapabilities = new Set(getManifestCapabilityTypes(manifest));
  for (const capability of selection.capabilities) {
    if (!declaredCapabilities.has(capability)) {
      throw new Error(`Capability "${capability}" was not declared`);
    }
    if (!policy.allowedCapabilities.includes(capability)) {
      throw new Error(`Capability "${capability}" is disabled by policy`);
    }
  }

  assertSelectedTools(
    selection.mcpTools,
    selection.capabilities.includes('mcp:call'),
    getManifestMcpTools(manifest),
    policy.allowedMcpReadTools,
    'MCP read',
  );
  assertSelectedTools(
    selection.mcpWriteTools,
    selection.capabilities.includes('mcp:write'),
    getManifestMcpWriteTools(manifest),
    policy.allowedMcpWriteTools,
    'MCP write',
  );

  const declaredAutomationIds = new Set(getManifestAutomationIds(manifest));
  if (
    selection.automationIds.length > 0 &&
    !selection.capabilities.includes('automation:run')
  ) {
    throw new Error('Automation IDs require automation:run selection');
  }
  for (const automationId of selection.automationIds) {
    if (!declaredAutomationIds.has(automationId)) {
      throw new Error(`Automation "${automationId}" was not declared`);
    }
  }

  if (!selection.expiresAt) {
    if (!policy.allowNeverExpiringGrants) {
      throw new Error('Never-expiring grants are disabled by policy');
    }
    return;
  }
  const expiresAt = Date.parse(selection.expiresAt);
  if (expiresAt <= now) throw new Error('Grant expiry is not in the future');
  if (expiresAt - now > policy.maxGrantDurationHours * 3_600_000) {
    throw new Error('Grant expiry exceeds the policy limit');
  }
}

function assertSelectedTools(
  selected: readonly { serverId: string; toolName: string }[],
  capabilitySelected: boolean,
  declared: readonly { serverId: string; toolName: string }[],
  allowedPatterns: readonly string[],
  label: string,
): void {
  if (selected.length > 0 && !capabilitySelected) {
    throw new Error(`${label} tools require their capability selection`);
  }
  const declaredKeys = new Set(declared.map(toolKey));
  for (const tool of selected) {
    if (!declaredKeys.has(toolKey(tool))) {
      throw new Error(`${label} tool was not declared`);
    }
    if (
      !matchesArtifactBridgeToolPolicy(
        allowedPatterns,
        tool.serverId,
        tool.toolName,
      )
    ) {
      throw new Error(`${label} tool is disabled by policy`);
    }
  }
}

function hashPolicy(policy: ArtifactBridgePolicy): string {
  return createHash('sha256')
    .update(createArtifactBridgePolicyHashTranscript(policy), 'utf8')
    .digest('hex');
}

function toolKey(tool: { serverId: string; toolName: string }): string {
  return `${tool.serverId}\0${tool.toolName}`;
}

function exactJsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Artifact Bridge grant review ${label} is invalid`);
  }
  return value;
}
