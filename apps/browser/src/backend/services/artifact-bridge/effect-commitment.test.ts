import { describe, expect, it } from 'vitest';
import type { McpToolDescriptor } from '@clodex/mcp-runtime';
import { mcpServerConfigSchema } from '@clodex/mcp-runtime';
import { DEFAULT_ARTIFACT_BRIDGE_POLICY } from '@shared/artifact-bridge';
import {
  artifactBridgeMcpCommitmentsEqual,
  createArtifactBridgeMcpEffectCommitment,
  type ArtifactBridgeMcpEffectCommitmentInput,
} from './effect-commitment';

const server = mcpServerConfigSchema.parse({
  id: 'files',
  displayName: 'Files',
  enabled: true,
  source: { kind: 'user' },
  transport: {
    type: 'streamable-http',
    url: 'https://mcp.example.test/v1',
    headers: {},
  },
  policy: { default: 'ask', tools: {} },
});

const descriptor = {
  name: 'write_file',
  description: 'Write a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, text: { type: 'string' } },
    required: ['path', 'text'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
} as McpToolDescriptor;

function input(): ArtifactBridgeMcpEffectCommitmentInput {
  return {
    context: { kind: 'agent', agentId: 'agent-1', appId: 'app-1' },
    identity: {
      appVersion: '1.0.0',
      manifestSchemaVersion: 1,
      manifestHash: 'a'.repeat(64),
      executableHash: 'b'.repeat(64),
      assetHash: 'c'.repeat(64),
    },
    session: {
      sessionId: '00000000-0000-4000-8000-000000000001',
      navigationEpoch: 1,
      documentSlotId: '00000000-0000-4000-8000-000000000002',
      hostGenerationId: '00000000-0000-4000-8000-000000000003',
    },
    grant: { grantId: 'grant-1', revision: 1 },
    server: structuredClone(server),
    runtime: {
      restartCount: 0,
      catalogRevision: 2,
      configurationRevision: 1,
    },
    descriptor: structuredClone(descriptor),
    classification: { kind: 'write', destructive: false },
    securityProfile: { sensitiveEgressEnabled: false },
    arguments: { path: 'a.txt', text: 'hello' },
    policy: structuredClone(DEFAULT_ARTIFACT_BRIDGE_POLICY),
  };
}

describe('Artifact Bridge MCP effect commitment', () => {
  it('is stable across record key insertion order', () => {
    const left = input();
    const right = input();
    right.arguments = { text: 'hello', path: 'a.txt' };
    expect(
      artifactBridgeMcpCommitmentsEqual(
        createArtifactBridgeMcpEffectCommitment(left),
        createArtifactBridgeMcpEffectCommitment(right),
      ),
    ).toBe(true);
  });

  it.each([
    [
      'endpoint',
      (value: ArtifactBridgeMcpEffectCommitmentInput) => {
        (value.server.transport as { url: string }).url =
          'https://other.example.test/v1';
      },
    ],
    [
      'runtime generation',
      (value: ArtifactBridgeMcpEffectCommitmentInput) => {
        value.runtime.catalogRevision += 1;
      },
    ],
    [
      'schema',
      (value: ArtifactBridgeMcpEffectCommitmentInput) => {
        value.descriptor.inputSchema = { type: 'string' };
      },
    ],
    [
      'annotations',
      (value: ArtifactBridgeMcpEffectCommitmentInput) => {
        value.descriptor.annotations = { destructiveHint: true };
      },
    ],
    [
      'grant revision',
      (value: ArtifactBridgeMcpEffectCommitmentInput) => {
        value.grant.revision += 1;
      },
    ],
    [
      'arguments',
      (value: ArtifactBridgeMcpEffectCommitmentInput) => {
        value.arguments.text = 'changed';
      },
    ],
    [
      'policy',
      (value: ArtifactBridgeMcpEffectCommitmentInput) => {
        value.policy.enabled = false;
      },
    ],
    [
      'sensitive-egress enforcement profile',
      (value: ArtifactBridgeMcpEffectCommitmentInput) => {
        value.securityProfile.sensitiveEgressEnabled = true;
      },
    ],
  ])('changes when %s drifts', (_label, mutate) => {
    const original = input();
    const changed = input();
    mutate(changed);
    expect(createArtifactBridgeMcpEffectCommitment(changed).hash).not.toBe(
      createArtifactBridgeMcpEffectCommitment(original).hash,
    );
  });

  it('fails closed for non-canonical arguments', () => {
    const value = input();
    value.arguments = { amount: 1n };
    expect(() => createArtifactBridgeMcpEffectCommitment(value)).toThrow(
      'bigint',
    );
  });
});
