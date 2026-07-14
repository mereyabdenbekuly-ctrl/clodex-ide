import {
  getArtifactBridgeGrantExpiryPresets,
  matchesArtifactBridgeToolPolicy,
  type ArtifactBridgeCapability,
  type ArtifactBridgeGrant,
  type ArtifactBridgePolicy,
} from '@shared/artifact-bridge';
import {
  artifactBridgeGrantReviewSnapshotSchema,
  artifactBridgeGrantReviewSubmissionSchema,
  canonicalizeArtifactBridgeGrantReviewSelection,
  type ArtifactBridgeGrantReviewSelection,
  type ArtifactBridgeGrantReviewSnapshot,
  type ArtifactBridgeGrantReviewSubmission,
} from '@shared/artifact-bridge-grant-review';
import type { GeneratedAppManifestCapability } from '@shared/generated-app-manifest';

const REVIEWABLE_CAPABILITIES = new Set<ArtifactBridgeCapability>([
  'agent:ask',
  'automation:run',
  'mcp:call',
]);

export type GeneratedAppGrantReviewCapabilityOption = {
  type: ArtifactBridgeCapability;
  reason: string;
  selected: boolean;
  allowedByPolicy: boolean;
  editable: boolean;
  restriction: string | null;
};

export type GeneratedAppGrantReviewToolOption = {
  serverId: string;
  toolName: string;
  selected: boolean;
  allowedByPolicy: boolean;
};

export type GeneratedAppGrantReviewAutomationOption = {
  automationId: string;
  selected: boolean;
};

export type GeneratedAppGrantReviewExpiryOption = {
  value: string;
  label: string;
  expiresAt: string | null;
};

export type GeneratedAppGrantReviewExpiryState = {
  value: string;
  options: GeneratedAppGrantReviewExpiryOption[];
};

export function createInitialGeneratedAppGrantReviewSelection(
  grant: ArtifactBridgeGrant | null,
  policy: ArtifactBridgePolicy,
  now: number,
): ArtifactBridgeGrantReviewSelection {
  if (grant) {
    const capabilities = grant.capabilities.filter(
      (capability) =>
        policy.enabled && policy.allowedCapabilities.includes(capability),
    );
    return canonicalizeArtifactBridgeGrantReviewSelection({
      scope: grant.scope,
      capabilities,
      mcpTools: capabilities.includes('mcp:call')
        ? grant.mcpTools.filter((tool) =>
            matchesArtifactBridgeToolPolicy(
              policy.allowedMcpReadTools,
              tool.serverId,
              tool.toolName,
            ),
          )
        : [],
      mcpWriteTools: capabilities.includes('mcp:write')
        ? grant.mcpWriteTools.filter((tool) =>
            matchesArtifactBridgeToolPolicy(
              policy.allowedMcpWriteTools,
              tool.serverId,
              tool.toolName,
            ),
          )
        : [],
      automationIds: capabilities.includes('automation:run')
        ? grant.automationIds
        : [],
      expiresAt: getInitialGrantReviewExpiry(grant.expiresAt, policy, now),
    });
  }

  return canonicalizeArtifactBridgeGrantReviewSelection({
    scope: { kind: 'persistent' },
    capabilities: [],
    mcpTools: [],
    mcpWriteTools: [],
    automationIds: [],
    expiresAt: getInitialGrantReviewExpiry(undefined, policy, now),
  });
}

function getInitialGrantReviewExpiry(
  currentExpiry: string | null | undefined,
  policy: ArtifactBridgePolicy,
  now: number,
): string | null {
  if (currentExpiry) {
    const expiresAt = Date.parse(currentExpiry);
    if (
      expiresAt > now &&
      expiresAt - now <= policy.maxGrantDurationHours * 3_600_000
    ) {
      return currentExpiry;
    }
  } else if (currentExpiry === null && policy.allowNeverExpiringGrants) {
    return null;
  }

  const presets = getArtifactBridgeGrantExpiryPresets(policy);
  const preferredPreset =
    presets.find((preset) => preset.value === 'week') ??
    presets.find((preset) => preset.value === 'day') ??
    presets.find((preset) => preset.hours !== null) ??
    presets.find((preset) => preset.value === 'never');
  if (!preferredPreset) {
    throw new Error('Organization policy exposes no valid grant expiry');
  }
  return preferredPreset.hours === null
    ? null
    : new Date(now + preferredPreset.hours * 3_600_000).toISOString();
}

export function parseGeneratedAppGrantReviewSnapshot(
  rawSnapshot: unknown,
): ArtifactBridgeGrantReviewSnapshot {
  return artifactBridgeGrantReviewSnapshotSchema.parse(rawSnapshot);
}

export function getGeneratedAppGrantReviewCapabilityOptions(
  snapshot: ArtifactBridgeGrantReviewSnapshot,
  selection: ArtifactBridgeGrantReviewSelection,
): GeneratedAppGrantReviewCapabilityOption[] {
  return snapshot.manifest.capabilities.map((capability) => {
    const allowedByPolicy =
      snapshot.policy.enabled &&
      snapshot.policy.allowedCapabilities.includes(capability.type);
    const reviewable = REVIEWABLE_CAPABILITIES.has(capability.type);
    return {
      type: capability.type,
      reason: capability.reason,
      selected: selection.capabilities.includes(capability.type),
      allowedByPolicy,
      editable: allowedByPolicy && reviewable,
      restriction: !allowedByPolicy
        ? 'Disabled by organization policy.'
        : reviewable
          ? null
          : 'Write capability review is handled by a separate reviewed flow.',
    };
  });
}

export function getGeneratedAppGrantReviewMcpToolOptions(
  snapshot: ArtifactBridgeGrantReviewSnapshot,
  selection: ArtifactBridgeGrantReviewSelection,
): GeneratedAppGrantReviewToolOption[] {
  const capability = findManifestCapability(snapshot, 'mcp:call');
  if (!capability || capability.type !== 'mcp:call') return [];
  return capability.tools.map((tool) => ({
    ...tool,
    selected: selection.mcpTools.some(
      (selected) => toolKey(selected) === toolKey(tool),
    ),
    allowedByPolicy:
      snapshot.policy.enabled &&
      snapshot.policy.allowedCapabilities.includes('mcp:call') &&
      matchesArtifactBridgeToolPolicy(
        snapshot.policy.allowedMcpReadTools,
        tool.serverId,
        tool.toolName,
      ),
  }));
}

export function getGeneratedAppGrantReviewAutomationOptions(
  snapshot: ArtifactBridgeGrantReviewSnapshot,
  selection: ArtifactBridgeGrantReviewSelection,
): GeneratedAppGrantReviewAutomationOption[] {
  const capability = findManifestCapability(snapshot, 'automation:run');
  if (!capability || capability.type !== 'automation:run') return [];
  return capability.automationIds.map((automationId) => ({
    automationId,
    selected: selection.automationIds.includes(automationId),
  }));
}

export function getGeneratedAppGrantReviewExpiryState(
  snapshot: ArtifactBridgeGrantReviewSnapshot,
  selection: ArtifactBridgeGrantReviewSelection,
): GeneratedAppGrantReviewExpiryState {
  const openedAt = Date.parse(snapshot.openedAt);
  const canonicalOptions = getArtifactBridgeGrantExpiryPresets(
    snapshot.policy,
  ).map((preset) => ({
    value: preset.value,
    label: preset.label,
    expiresAt:
      preset.hours === null
        ? null
        : new Date(openedAt + preset.hours * 3_600_000).toISOString(),
  }));
  const selectedPreset = canonicalOptions.find(
    (option) => option.expiresAt === selection.expiresAt,
  );
  if (selectedPreset) {
    return { value: selectedPreset.value, options: canonicalOptions };
  }
  return {
    value: 'current',
    options: [
      {
        value: 'current',
        label: selection.expiresAt
          ? `Keep current (${selection.expiresAt})`
          : 'Keep current (no expiry)',
        expiresAt: selection.expiresAt,
      },
      ...canonicalOptions,
    ],
  };
}

export function setGeneratedAppGrantReviewCapability(
  snapshot: ArtifactBridgeGrantReviewSnapshot,
  selection: ArtifactBridgeGrantReviewSelection,
  capability: ArtifactBridgeCapability,
  enabled: boolean,
): ArtifactBridgeGrantReviewSelection {
  const option = getGeneratedAppGrantReviewCapabilityOptions(
    snapshot,
    selection,
  ).find((candidate) => candidate.type === capability);
  if (!option?.editable) {
    throw new Error('Capability is not editable in this grant review');
  }
  const capabilities = enabled
    ? selection.capabilities.includes(capability)
      ? selection.capabilities
      : [...selection.capabilities, capability]
    : selection.capabilities.filter((candidate) => candidate !== capability);
  return canonicalizeArtifactBridgeGrantReviewSelection({
    ...selection,
    capabilities,
    mcpTools: !enabled && capability === 'mcp:call' ? [] : selection.mcpTools,
    automationIds:
      !enabled && capability === 'automation:run'
        ? []
        : selection.automationIds,
  });
}

export function setGeneratedAppGrantReviewMcpTool(
  snapshot: ArtifactBridgeGrantReviewSnapshot,
  selection: ArtifactBridgeGrantReviewSelection,
  tool: { serverId: string; toolName: string },
  enabled: boolean,
): ArtifactBridgeGrantReviewSelection {
  if (!selection.capabilities.includes('mcp:call')) {
    throw new Error('MCP tools require the mcp:call capability');
  }
  const option = getGeneratedAppGrantReviewMcpToolOptions(
    snapshot,
    selection,
  ).find((candidate) => toolKey(candidate) === toolKey(tool));
  if (!option?.allowedByPolicy) {
    throw new Error('MCP tool is not selectable from this grant review');
  }
  const mcpTools = enabled
    ? uniqueTools([...selection.mcpTools, tool])
    : selection.mcpTools.filter(
        (candidate) => toolKey(candidate) !== toolKey(tool),
      );
  return canonicalizeArtifactBridgeGrantReviewSelection({
    ...selection,
    mcpTools,
  });
}

export function setGeneratedAppGrantReviewAutomation(
  snapshot: ArtifactBridgeGrantReviewSnapshot,
  selection: ArtifactBridgeGrantReviewSelection,
  automationId: string,
  enabled: boolean,
): ArtifactBridgeGrantReviewSelection {
  if (!selection.capabilities.includes('automation:run')) {
    throw new Error('Automation IDs require automation:run');
  }
  const declared = getGeneratedAppGrantReviewAutomationOptions(
    snapshot,
    selection,
  ).some((candidate) => candidate.automationId === automationId);
  if (!declared) {
    throw new Error('Automation is not selectable from this grant review');
  }
  const automationIds = enabled
    ? selection.automationIds.includes(automationId)
      ? selection.automationIds
      : [...selection.automationIds, automationId]
    : selection.automationIds.filter((candidate) => candidate !== automationId);
  return canonicalizeArtifactBridgeGrantReviewSelection({
    ...selection,
    automationIds,
  });
}

export function setGeneratedAppGrantReviewExpiry(
  snapshot: ArtifactBridgeGrantReviewSnapshot,
  selection: ArtifactBridgeGrantReviewSelection,
  value: string,
): ArtifactBridgeGrantReviewSelection {
  const state = getGeneratedAppGrantReviewExpiryState(snapshot, selection);
  const option = state.options.find((candidate) => candidate.value === value);
  if (!option) throw new Error('Grant expiry choice is unavailable');
  return canonicalizeArtifactBridgeGrantReviewSelection({
    ...selection,
    expiresAt: option.expiresAt,
  });
}

export function hasUnsupportedGeneratedAppWriteSelection(
  selection: ArtifactBridgeGrantReviewSelection,
): boolean {
  return (
    selection.capabilities.includes('mcp:write') ||
    selection.mcpWriteTools.length > 0
  );
}

export function createGeneratedAppGrantReviewSubmission(
  rawSnapshot: ArtifactBridgeGrantReviewSnapshot,
  rawSelection: ArtifactBridgeGrantReviewSelection,
): ArtifactBridgeGrantReviewSubmission {
  const snapshot = artifactBridgeGrantReviewSnapshotSchema.parse(rawSnapshot);
  const selection =
    canonicalizeArtifactBridgeGrantReviewSelection(rawSelection);
  assertSelectionComesFromSnapshot(snapshot, selection);
  return artifactBridgeGrantReviewSubmissionSchema.parse({
    schemaVersion: snapshot.schemaVersion,
    reviewId: snapshot.reviewId,
    context: snapshot.context,
    identity: snapshot.identity,
    selection,
  });
}

function assertSelectionComesFromSnapshot(
  snapshot: ArtifactBridgeGrantReviewSnapshot,
  selection: ArtifactBridgeGrantReviewSelection,
): void {
  if (
    JSON.stringify(selection.scope) !== JSON.stringify(snapshot.selection.scope)
  ) {
    throw new Error('Grant review scope cannot be changed by the renderer');
  }
  const options = getGeneratedAppGrantReviewCapabilityOptions(
    snapshot,
    selection,
  );
  const selectableCapabilities = new Set(
    options.filter((option) => option.editable).map((option) => option.type),
  );
  for (const capability of selection.capabilities) {
    if (capability !== 'mcp:write' && !selectableCapabilities.has(capability)) {
      throw new Error('Grant review capability was not selectable');
    }
  }

  const initialWriteSelected =
    snapshot.selection.capabilities.includes('mcp:write');
  if (
    selection.capabilities.includes('mcp:write') !== initialWriteSelected ||
    !sameTools(selection.mcpWriteTools, snapshot.selection.mcpWriteTools)
  ) {
    throw new Error('Write selections cannot be changed by this dialog');
  }
  if (
    selection.mcpTools.length > 0 &&
    !selection.capabilities.includes('mcp:call')
  ) {
    throw new Error('MCP tools require the mcp:call capability');
  }
  if (
    selection.automationIds.length > 0 &&
    !selection.capabilities.includes('automation:run')
  ) {
    throw new Error('Automation IDs require automation:run');
  }

  const selectableTools = new Set(
    getGeneratedAppGrantReviewMcpToolOptions(snapshot, selection)
      .filter((option) => option.allowedByPolicy)
      .map(toolKey),
  );
  if (selection.mcpTools.some((tool) => !selectableTools.has(toolKey(tool)))) {
    throw new Error('Grant review MCP tool was not selectable');
  }

  const selectableAutomations = new Set(
    getGeneratedAppGrantReviewAutomationOptions(snapshot, selection).map(
      (option) => option.automationId,
    ),
  );
  if (
    selection.automationIds.some(
      (automationId) => !selectableAutomations.has(automationId),
    )
  ) {
    throw new Error('Grant review automation was not selectable');
  }

  const expiryState = getGeneratedAppGrantReviewExpiryState(
    snapshot,
    snapshot.selection,
  );
  const allowedExpiries = new Set(
    expiryState.options.map((option) => option.expiresAt),
  );
  if (!allowedExpiries.has(selection.expiresAt)) {
    throw new Error('Grant review expiry was not a canonical choice');
  }
}

function findManifestCapability(
  snapshot: ArtifactBridgeGrantReviewSnapshot,
  type: ArtifactBridgeCapability,
): GeneratedAppManifestCapability | undefined {
  return snapshot.manifest.capabilities.find(
    (capability) => capability.type === type,
  );
}

function uniqueTools(
  tools: readonly { serverId: string; toolName: string }[],
): Array<{ serverId: string; toolName: string }> {
  const unique: Array<{ serverId: string; toolName: string }> = [];
  const keys = new Set<string>();
  for (const tool of tools) {
    const key = toolKey(tool);
    if (keys.has(key)) continue;
    keys.add(key);
    unique.push(tool);
  }
  return unique;
}

function sameTools(
  left: readonly { serverId: string; toolName: string }[],
  right: readonly { serverId: string; toolName: string }[],
): boolean {
  if (left.length !== right.length) return false;
  const rightKeys = new Set(right.map(toolKey));
  return left.every((tool) => rightKeys.has(toolKey(tool)));
}

function toolKey(tool: { serverId: string; toolName: string }): string {
  return `${tool.serverId}\0${tool.toolName}`;
}
