import { createHash } from 'node:crypto';
import {
  matchesArtifactBridgeToolPolicy,
  type ArtifactBridgeCapability,
  type ArtifactBridgeContext,
  type ArtifactBridgeOperationSnapshot,
  type ArtifactBridgePolicy,
  type ArtifactBridgeRequest,
  type ArtifactBridgeSensitiveEgressReason,
  type ArtifactBridgeSensitiveMcpProposal,
  type ArtifactBridgeWriteProposal,
} from '@shared/artifact-bridge';
import {
  getManifestAutomationIds,
  getManifestCapabilityTypes,
  getManifestMcpTools,
  getManifestMcpWriteTools,
  type GeneratedAppIdentity,
  type GeneratedAppManifest,
} from '@shared/generated-app-manifest';
import type { AgenticAppRuntimeDogfoodTelemetry } from '@shared/agentic-app-runtime-telemetry';
import type {
  ArtifactBridgeMcpEffectCommitment,
  ArtifactBridgeTrustedMcpClassification,
  ArtifactBridgeUniversalEffectCommitment,
} from './effect-commitment';
import type { ArtifactBridgeEffectWalRecord } from './effect-wal';
import { hashArtifactBridgeJson } from './canonical-json';
import {
  redactSensitiveText,
  sanitizeSensitiveValue,
} from './sensitive-egress';
import { TRUSTED_UI_REVIEWER_CONNECTION_ID } from '../trusted-ui-karton-transport';
import type {
  ParsedArtifactBridgeGrantInput,
  ValidatedArtifactBridgeHostSessionBinding,
  ValidatedGrantBinding,
} from './bridge-schemas';

export function isAuthorizationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /grant|granted|capability|requested|allowed|policy|quota|rate limit|concurrent|read-only|destructive/i.test(
    error.message,
  );
}

export type PreparedWrite = {
  proposal: ArtifactBridgeWriteProposal;
  sessionId: string | null;
  identity: GeneratedAppIdentity;
  arguments: Record<string, unknown>;
  argumentsHash: string;
  grantBinding: ValidatedGrantBinding;
  effectCommitment: ArtifactBridgeMcpEffectCommitment;
  classification: ArtifactBridgeTrustedMcpClassification;
  dispatchAuthorized: boolean;
  status:
    | 'prepared'
    | 'approved'
    | 'committing'
    | 'committed'
    | 'result-unavailable'
    | 'uncertain'
    | 'failed-pre-effect';
  commitToken: string | null;
  approvalAuditRecorded: boolean;
  approvalAuditPromise: Promise<void> | null;
  commitPromise: Promise<unknown> | null;
  result: unknown;
};

export type PreparedSensitiveMcpCall = {
  proposal: ArtifactBridgeSensitiveMcpProposal;
  sessionId: string | null;
  identity: GeneratedAppIdentity;
  arguments: Record<string, unknown>;
  argumentsHash: string;
  grantBinding: ValidatedGrantBinding;
  effectCommitment: ArtifactBridgeMcpEffectCommitment;
  classification: ArtifactBridgeTrustedMcpClassification;
  dispatchAuthorized: boolean;
  status:
    | 'prepared'
    | 'approved'
    | 'committing'
    | 'committed'
    | 'result-unavailable'
    | 'uncertain'
    | 'failed-pre-effect';
  commitToken: string | null;
  approvalAuditRecorded: boolean;
  approvalAuditPromise: Promise<void> | null;
  commitPromise: Promise<unknown> | null;
  operationId: string | null;
  result: unknown;
};

export type PreparedEffect = PreparedWrite | PreparedSensitiveMcpCall;

export type ArtifactBridgeOperation = {
  snapshot: ArtifactBridgeOperationSnapshot;
  sessionId: string | null;
  exactHostBinding?: ValidatedArtifactBridgeHostSessionBinding;
  grantBinding: ValidatedGrantBinding;
  controller: AbortController;
  active: boolean;
  finalDispatchPassed: boolean;
  retentionSeconds: number;
  result: unknown;
  timeout: ReturnType<typeof setTimeout> | null;
  effectId: string | null;
};

export type UniversalEffectPlan = {
  effectId: string;
  kind: Extract<
    ArtifactBridgeEffectWalRecord['kind'],
    'agent-ask' | 'automation' | 'mcp-read-async'
  >;
  commitment: ArtifactBridgeUniversalEffectCommitment;
  ticketHash: string;
};

export function isTerminalOperation(
  status: ArtifactBridgeOperationSnapshot['status'],
): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timed-out' ||
    status === 'uncertain'
  );
}

export function isTerminalEffectFailureStatus(
  status: PreparedEffect['status'],
): status is 'result-unavailable' | 'uncertain' | 'failed-pre-effect' {
  return (
    status === 'result-unavailable' ||
    status === 'uncertain' ||
    status === 'failed-pre-effect'
  );
}

export function throwTerminalEffectFailure(
  status: 'result-unavailable' | 'uncertain' | 'failed-pre-effect',
): never {
  switch (status) {
    case 'result-unavailable':
      throw new Error(
        'Effect completed but its result is unavailable; retry is forbidden',
      );
    case 'uncertain':
      throw new Error('Effect outcome is uncertain; retry is forbidden');
    case 'failed-pre-effect':
      throw new Error(
        'Execution ticket failed before effect dispatch; a new review is required',
      );
  }
}

export function artifactBridgeContextsEqual(
  left: ArtifactBridgeContext,
  right: ArtifactBridgeContext,
): boolean {
  if (left.kind !== right.kind || left.appId !== right.appId) return false;
  if (left.kind === 'package' && right.kind === 'package') {
    return left.packageId === right.packageId;
  }
  if (left.kind === 'agent' && right.kind === 'agent') {
    return (
      left.agentId === right.agentId &&
      (left.pluginId ?? null) === (right.pluginId ?? null)
    );
  }
  return false;
}

export function assertPolicyEnabled(policy: ArtifactBridgePolicy): void {
  if (!policy.enabled) {
    throw new Error('Generated app capabilities are disabled by policy');
  }
}

export function assertCapabilityAllowedByPolicy(
  policy: ArtifactBridgePolicy,
  capability: ArtifactBridgeCapability,
): void {
  if (!policy.allowedCapabilities.includes(capability)) {
    throw new Error(
      `Capability "${capability}" is disabled by organization policy`,
    );
  }
}

export function assertGrantMatchesPolicy(
  input: ParsedArtifactBridgeGrantInput,
  policy: ArtifactBridgePolicy,
  now: number,
): void {
  for (const capability of input.capabilities) {
    if (!policy.allowedCapabilities.includes(capability)) {
      throw new Error(
        `Capability "${capability}" is disabled by organization policy`,
      );
    }
  }
  for (const tool of input.mcpTools) {
    assertToolAllowedByPolicy(
      policy.allowedMcpReadTools,
      tool.serverId,
      tool.toolName,
      'read',
    );
  }
  for (const tool of input.mcpWriteTools) {
    assertToolAllowedByPolicy(
      policy.allowedMcpWriteTools,
      tool.serverId,
      tool.toolName,
      'write',
    );
  }
  if (!input.expiresAt) {
    if (!policy.allowNeverExpiringGrants) {
      throw new Error('Never-expiring grants are disabled by policy');
    }
    return;
  }
  if (
    Date.parse(input.expiresAt) - now >
    policy.maxGrantDurationHours * 3_600_000
  ) {
    throw new Error('Grant expiry exceeds the organization policy limit');
  }
}

export function assertToolAllowedByPolicy(
  patterns: string[],
  serverId: string,
  toolName: string,
  mode: 'read' | 'write',
): void {
  if (!matchesArtifactBridgeToolPolicy(patterns, serverId, toolName)) {
    throw new Error(
      `MCP ${mode} tool "${serverId}/${toolName}" is disabled by organization policy`,
    );
  }
}

export function assertSensitiveToolAllowedByPolicy(
  policy: ArtifactBridgePolicy,
  serverId: string,
  toolName: string,
): void {
  if (
    matchesArtifactBridgeToolPolicy(
      policy.deniedSensitiveMcpTools,
      serverId,
      toolName,
    ) ||
    !matchesArtifactBridgeToolPolicy(
      policy.allowedSensitiveMcpTools,
      serverId,
      toolName,
    )
  ) {
    throw new Error(
      `Sensitive MCP tool "${serverId}/${toolName}" is disabled by organization policy`,
    );
  }
}

export function sameSensitiveReasons(
  left: ArtifactBridgeSensitiveEgressReason[],
  right: ArtifactBridgeSensitiveEgressReason[],
): boolean {
  return (
    left.length === right.length &&
    left.every((reason) => right.includes(reason))
  );
}

export function capabilityKindForRequest(
  method: ArtifactBridgeRequest['method'],
): NonNullable<AgenticAppRuntimeDogfoodTelemetry['capability_kind']> {
  switch (method) {
    case 'getCapabilities':
      return 'discovery';
    case 'callMcpTool':
    case 'startMcpOperation':
      return 'mcp-read';
    case 'prepareSensitiveMcpCall':
    case 'commitSensitiveMcpCall':
      return 'mcp-sensitive';
    case 'prepareMcpWrite':
    case 'commitMcpWrite':
      return 'mcp-write';
    case 'askAgent':
      return 'agent-ask';
    case 'runAutomation':
    case 'startAutomationOperation':
      return 'automation';
    case 'getOperation':
    case 'getOperationResult':
    case 'cancelOperation':
      return 'async-control';
  }
}

export function hashJson(value: unknown): string {
  return hashArtifactBridgeJson(
    'clodex.artifact-bridge.arguments-integrity.v1',
    value,
  );
}

export function effectTicketHash(commitToken: string): string {
  return hashArtifactBridgeJson(
    'clodex.artifact-bridge.execution-ticket.v1',
    commitToken,
  );
}

export function universalEffectId(
  context: ArtifactBridgeContext,
  requestId: string,
): string {
  // This is deliberately a context-global request-ID reservation. Mutable
  // authority lineage (session, host generation, grant revision, policy) is
  // bound by the exact commitment stored under the reservation, not by minting
  // a new effect ID. Including those values here would let a navigation or
  // regrant turn the same logical retry into a second dispatch. The preload
  // generates cryptographically random request IDs, so accidental cross-session
  // collisions are negligible; an intentional collision fails closed on the
  // commitment mismatch and cannot cross authority lineages.
  const digest = hashArtifactBridgeJson(
    'clodex.artifact-bridge.universal-effect.request-id.v1',
    { context, requestId },
  );
  const variant = ((Number.parseInt(digest[16] ?? '0', 16) & 0x3) | 0x8)
    .toString(16)
    .slice(0, 1);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

export function universalEffectTicketHash(
  effectId: string,
  commitmentHash: string,
): string {
  return hashArtifactBridgeJson(
    'clodex.artifact-bridge.universal-effect.execution-ticket.v1',
    { effectId, commitmentHash },
  );
}

export function hashAuditIdentifier(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

export function safeMcpAuditResource(
  serverId: string,
  toolName: string,
): string {
  return redactSensitiveText(`${serverId}/${toolName}`).slice(0, 513);
}

export function createArgumentsPreview(
  arguments_: Record<string, unknown>,
): string {
  const redacted = sanitizeSensitiveValue(arguments_);
  const encoded = JSON.stringify(redacted, null, 2);
  return encoded.length <= 20_000
    ? encoded
    : `${encoded.slice(0, 19_980)}\n…[truncated]`;
}

export function assertTrustedReviewer(clientId: string): void {
  if (clientId !== TRUSTED_UI_REVIEWER_CONNECTION_ID) {
    throw new Error('Artifact capability grants require a trusted UI client');
  }
}

export function identitiesMatch(
  granted: GeneratedAppIdentity,
  current: GeneratedAppIdentity,
): boolean {
  return (
    granted.manifestSchemaVersion === current.manifestSchemaVersion &&
    granted.appVersion === current.appVersion &&
    granted.manifestHash === current.manifestHash &&
    granted.executableHash === current.executableHash &&
    granted.assetHash === current.assetHash
  );
}

export function assertGrantMatchesManifest(
  input: ParsedArtifactBridgeGrantInput,
  manifest: GeneratedAppManifest,
): void {
  const requestedCapabilities = new Set(getManifestCapabilityTypes(manifest));
  for (const capability of input.capabilities) {
    if (!requestedCapabilities.has(capability)) {
      throw new Error(
        `Capability "${capability}" was not requested by the generated app manifest`,
      );
    }
  }

  const requestedMcpTools = new Set(
    getManifestMcpTools(manifest).map(
      (tool) => `${tool.serverId}\0${tool.toolName}`,
    ),
  );
  for (const tool of input.mcpTools) {
    if (!requestedMcpTools.has(`${tool.serverId}\0${tool.toolName}`)) {
      throw new Error(
        `MCP tool "${tool.serverId}/${tool.toolName}" was not requested by the generated app manifest`,
      );
    }
  }
  if (input.mcpTools.length > 0 && !input.capabilities.includes('mcp:call')) {
    throw new Error('MCP tools require the "mcp:call" capability');
  }

  const requestedMcpWriteTools = new Set(
    getManifestMcpWriteTools(manifest).map(
      (tool) => `${tool.serverId}\0${tool.toolName}`,
    ),
  );
  for (const tool of input.mcpWriteTools) {
    if (!requestedMcpWriteTools.has(`${tool.serverId}\0${tool.toolName}`)) {
      throw new Error(
        `MCP write tool "${tool.serverId}/${tool.toolName}" was not requested by the generated app manifest`,
      );
    }
  }
  if (
    input.mcpWriteTools.length > 0 &&
    !input.capabilities.includes('mcp:write')
  ) {
    throw new Error('MCP write tools require the "mcp:write" capability');
  }

  const requestedAutomationIds = new Set(getManifestAutomationIds(manifest));
  for (const automationId of input.automationIds) {
    if (!requestedAutomationIds.has(automationId)) {
      throw new Error(
        `Automation "${automationId}" was not requested by the generated app manifest`,
      );
    }
  }
  if (
    input.automationIds.length > 0 &&
    !input.capabilities.includes('automation:run')
  ) {
    throw new Error(
      'Automation identifiers require the "automation:run" capability',
    );
  }
}
