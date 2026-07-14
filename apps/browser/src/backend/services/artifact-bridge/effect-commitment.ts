import type { McpServerConfig, McpToolDescriptor } from '@clodex/mcp-runtime';
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
