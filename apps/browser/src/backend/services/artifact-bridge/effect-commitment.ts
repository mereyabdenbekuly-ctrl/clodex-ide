import type { McpServerConfig, McpToolDescriptor } from '@clodex/mcp-runtime';
import type { LanguageModel } from 'ai';
import type {
  ArtifactBridgeContext,
  ArtifactBridgePolicy,
} from '@shared/artifact-bridge';
import type { GeneratedAppIdentity } from '@shared/generated-app-manifest';
import { hashArtifactBridgeJson } from './canonical-json';

export const ARTIFACT_BRIDGE_MCP_ADAPTER_ID =
  'clodex.mcp-host-supervisor.call-tool';
export const ARTIFACT_BRIDGE_MCP_ADAPTER_VERSION = 1;
export const ARTIFACT_BRIDGE_MCP_CLASSIFIER_VERSION = 1;

export const ARTIFACT_BRIDGE_AGENT_ASK_ADAPTER_ID =
  'clodex.artifact-bridge.ai-sdk.generate-text';
export const ARTIFACT_BRIDGE_AGENT_ASK_ADAPTER_VERSION = 1;
export const ARTIFACT_BRIDGE_AGENT_ASK_MAX_OUTPUT_TOKENS = 1_024;
export const ARTIFACT_BRIDGE_AGENT_ASK_TIMEOUT_MS = 30_000;
export const ARTIFACT_BRIDGE_AGENT_ASK_MAX_RETRIES = 0;

export const ARTIFACT_BRIDGE_AUTOMATION_ADAPTER_ID =
  'clodex.automation-service.create-agent-send-message';
export const ARTIFACT_BRIDGE_AUTOMATION_ADAPTER_VERSION = 1;

export interface ArtifactBridgeAgentAskModelAdapterIdentity {
  modelId: string;
  resolvedProviderId: string;
  resolvedModelId: string;
  adapterId: typeof ARTIFACT_BRIDGE_AGENT_ASK_ADAPTER_ID;
  adapterVersion: typeof ARTIFACT_BRIDGE_AGENT_ASK_ADAPTER_VERSION;
  maxOutputTokens: typeof ARTIFACT_BRIDGE_AGENT_ASK_MAX_OUTPUT_TOKENS;
  timeoutMs: typeof ARTIFACT_BRIDGE_AGENT_ASK_TIMEOUT_MS;
  maxRetries: typeof ARTIFACT_BRIDGE_AGENT_ASK_MAX_RETRIES;
}

export function createArtifactBridgeAgentAskModelAdapterIdentity(
  modelId: string,
  resolved: {
    providerId?: string;
    modelId?: string;
  } = {},
): ArtifactBridgeAgentAskModelAdapterIdentity {
  return {
    modelId,
    resolvedProviderId: resolved.providerId ?? 'injected-artifact-bridge',
    resolvedModelId: resolved.modelId ?? modelId,
    adapterId: ARTIFACT_BRIDGE_AGENT_ASK_ADAPTER_ID,
    adapterVersion: ARTIFACT_BRIDGE_AGENT_ASK_ADAPTER_VERSION,
    maxOutputTokens: ARTIFACT_BRIDGE_AGENT_ASK_MAX_OUTPUT_TOKENS,
    timeoutMs: ARTIFACT_BRIDGE_AGENT_ASK_TIMEOUT_MS,
    maxRetries: ARTIFACT_BRIDGE_AGENT_ASK_MAX_RETRIES,
  };
}

/**
 * Binds an effect to the concrete AI SDK adapter captured for dispatch.
 * Registry string IDs and unknown model shapes are rejected because resolving
 * them later could select a different provider after the effect was prepared.
 */
export function createArtifactBridgeAgentAskModelAdapterIdentityFromResolvedModel(
  modelId: string,
  model: LanguageModel,
): ArtifactBridgeAgentAskModelAdapterIdentity {
  if (
    typeof model !== 'object' ||
    model === null ||
    !('specificationVersion' in model) ||
    (model.specificationVersion !== 'v2' &&
      model.specificationVersion !== 'v3') ||
    !('provider' in model) ||
    typeof model.provider !== 'string' ||
    !('modelId' in model) ||
    typeof model.modelId !== 'string'
  ) {
    throw new Error(
      'Artifact Bridge requires a concrete AI SDK model adapter identity',
    );
  }
  const providerId = model.provider.trim();
  const resolvedModelId = model.modelId.trim();
  if (
    providerId.length === 0 ||
    providerId.length > 256 ||
    resolvedModelId.length === 0 ||
    resolvedModelId.length > 256
  ) {
    throw new Error(
      'Artifact Bridge resolved invalid AI SDK model adapter metadata',
    );
  }
  return createArtifactBridgeAgentAskModelAdapterIdentity(modelId, {
    providerId,
    modelId: resolvedModelId,
  });
}

export const ARTIFACT_BRIDGE_AUTOMATION_ADAPTER_IDENTITY = {
  adapterId: ARTIFACT_BRIDGE_AUTOMATION_ADAPTER_ID,
  adapterVersion: ARTIFACT_BRIDGE_AUTOMATION_ADAPTER_VERSION,
  retryMode: 'no-blind-retry',
  failureMode: 'propagate',
  agentType: 'chat',
  defaultModelId: 'claude-sonnet-4.6',
  orderedSteps: [
    'agents.create',
    'agents.create.workspace-mounts',
    'agents.sendUserMessage',
  ],
} as const;

export type ArtifactBridgeTrustedMcpClassification =
  | { kind: 'read' }
  | { kind: 'write'; destructive: boolean }
  | {
      kind: 'sensitive-read';
      reasons: readonly ('remote-network' | 'credential-sensitive')[];
    }
  | {
      kind: 'sensitive-write';
      destructive: boolean;
      reasons: readonly ('remote-network' | 'credential-sensitive')[];
    };

export interface ArtifactBridgeGrantCommitment {
  grantId: string;
  revision: number;
}

export interface ArtifactBridgeMcpRuntimeCommitment {
  restartCount: number;
  catalogRevision: number;
  configurationRevision: number;
}

export interface ArtifactBridgeMcpSecurityProfileCommitment {
  /**
   * Classification semantics change when sensitive-egress enforcement is
   * enabled. Binding the gate prevents an ordinary reviewed call from crossing
   * a false -> true transition without fresh sensitive review.
   */
  sensitiveEgressEnabled: boolean;
}

export interface ArtifactBridgeMcpEffectCommitmentInput {
  context: ArtifactBridgeContext;
  identity: GeneratedAppIdentity;
  session: {
    sessionId: string;
    navigationEpoch: number;
    documentSlotId: string;
    hostGenerationId: string;
  } | null;
  grant: ArtifactBridgeGrantCommitment;
  server: McpServerConfig;
  runtime: ArtifactBridgeMcpRuntimeCommitment;
  descriptor: McpToolDescriptor;
  classification: ArtifactBridgeTrustedMcpClassification;
  securityProfile: ArtifactBridgeMcpSecurityProfileCommitment;
  arguments: Record<string, unknown>;
  policy: ArtifactBridgePolicy;
}

export interface ArtifactBridgeMcpEffectCommitment {
  version: 1;
  hash: string;
  contextHash: string;
  identityHash: string;
  sessionHash: string;
  grantHash: string;
  serverHash: string;
  runtimeHash: string;
  descriptorHash: string;
  classificationHash: string;
  securityProfileHash: string;
  argumentsHash: string;
  policyHash: string;
  adapterHash: string;
}

/**
 * Freezes every mutable fact used to authorize one MCP effect. Callers must
 * recompute this commitment at the final adapter boundary and require exact
 * equality before dispatch.
 */
export function createArtifactBridgeMcpEffectCommitment(
  input: ArtifactBridgeMcpEffectCommitmentInput,
): ArtifactBridgeMcpEffectCommitment {
  const parts = {
    contextHash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.effect.context.v1',
      input.context,
    ),
    identityHash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.effect.identity.v1',
      input.identity,
    ),
    sessionHash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.effect.session.v1',
      input.session,
    ),
    grantHash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.effect.grant.v1',
      input.grant,
    ),
    serverHash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.effect.server.v1',
      input.server,
    ),
    runtimeHash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.effect.runtime.v1',
      input.runtime,
    ),
    descriptorHash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.effect.descriptor.v1',
      input.descriptor,
    ),
    classificationHash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.effect.classification.v1',
      {
        classifierVersion: ARTIFACT_BRIDGE_MCP_CLASSIFIER_VERSION,
        classification: input.classification,
      },
    ),
    securityProfileHash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.effect.security-profile.v1',
      input.securityProfile,
    ),
    argumentsHash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.effect.arguments.v1',
      input.arguments,
    ),
    policyHash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.effect.policy.v1',
      input.policy,
    ),
    adapterHash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.effect.adapter.v1',
      {
        id: ARTIFACT_BRIDGE_MCP_ADAPTER_ID,
        version: ARTIFACT_BRIDGE_MCP_ADAPTER_VERSION,
      },
    ),
  };
  return {
    version: 1,
    ...parts,
    hash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.effect.commitment.v1',
      { version: 1, ...parts },
    ),
  };
}

export function artifactBridgeMcpCommitmentsEqual(
  left: ArtifactBridgeMcpEffectCommitment,
  right: ArtifactBridgeMcpEffectCommitment,
): boolean {
  return left.version === right.version && left.hash === right.hash;
}

export interface ArtifactBridgeUniversalEffectCommitmentInput {
  authority: unknown;
  action: unknown;
  definition: unknown;
  adapter: unknown;
}

export interface ArtifactBridgeUniversalEffectCommitment {
  version: 1;
  hash: string;
  authorityHash: string;
  actionHash: string;
  definitionHash: string;
  adapterHash: string;
}

/**
 * A content-free commitment shared by non-reviewed Artifact Bridge effects.
 * The WAL stores only these hashes, while the caller recomputes the complete
 * commitment synchronously at the final application-owned dispatch boundary.
 */
export function createArtifactBridgeUniversalEffectCommitment(
  input: ArtifactBridgeUniversalEffectCommitmentInput,
): ArtifactBridgeUniversalEffectCommitment {
  const parts = {
    authorityHash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.universal-effect.authority.v1',
      input.authority,
    ),
    actionHash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.universal-effect.action.v1',
      input.action,
    ),
    definitionHash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.universal-effect.definition.v1',
      input.definition,
    ),
    adapterHash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.universal-effect.adapter.v1',
      input.adapter,
    ),
  };
  return {
    version: 1,
    ...parts,
    hash: hashArtifactBridgeJson(
      'clodex.artifact-bridge.universal-effect.commitment.v1',
      { version: 1, ...parts },
    ),
  };
}

export function artifactBridgeUniversalCommitmentsEqual(
  left: ArtifactBridgeUniversalEffectCommitment,
  right: ArtifactBridgeUniversalEffectCommitment,
): boolean {
  return left.version === right.version && left.hash === right.hash;
}
