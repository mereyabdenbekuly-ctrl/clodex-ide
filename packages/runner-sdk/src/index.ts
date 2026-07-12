import type {
  RunnerCapabilities,
  WorkspaceExecutionProvider,
  WorkspaceExecutionProviderKind,
} from '@clodex/agent-shell';

export const CLODEX_RUNNER_SDK_VERSION = 1 as const;

export interface ClodexRunnerManifest {
  sdkVersion: typeof CLODEX_RUNNER_SDK_VERSION;
  id: string;
  name: string;
  providerKind: WorkspaceExecutionProviderKind;
  capabilities: RunnerCapabilities;
  networkAccess: 'none' | 'restricted' | 'host';
}

export interface ClodexRunnerRegistration {
  readonly manifest: Readonly<ClodexRunnerManifest>;
  create(): WorkspaceExecutionProvider | Promise<WorkspaceExecutionProvider>;
}

export interface DefineClodexRunnerInput {
  manifest: ClodexRunnerManifest;
  create(): WorkspaceExecutionProvider | Promise<WorkspaceExecutionProvider>;
}

export function defineClodexRunner(
  input: DefineClodexRunnerInput,
): ClodexRunnerRegistration {
  const manifest = freezeManifest(validateManifest(input.manifest));
  if (typeof input.create !== 'function') {
    throw new Error('Runner registration requires a create function');
  }
  return Object.freeze({
    manifest,
    create: input.create,
  });
}

export function assertRunnerProviderIdentity(
  provider: WorkspaceExecutionProvider,
  expected: Pick<ClodexRunnerManifest, 'id' | 'providerKind'>,
): void {
  if (!provider || typeof provider !== 'object') {
    throw new Error('Runner provider must be an object');
  }
  if (provider.id !== expected.id) {
    throw new Error(
      `Runner provider id mismatch: expected ${expected.id}, received ${provider.id}`,
    );
  }
  if (provider.kind !== expected.providerKind) {
    throw new Error(
      `Runner provider kind mismatch: expected ${expected.providerKind}, received ${provider.kind}`,
    );
  }
  if (!provider.receiptPublicKey?.trim()) {
    throw new Error('Runner provider must expose a receipt verification key');
  }
  for (const method of [
    'getCapabilities',
    'prepareWorkspace',
    'createSession',
    'execute',
    'killSession',
    'disposeWorkspace',
  ] as const) {
    if (typeof provider[method] !== 'function') {
      throw new Error(`Runner provider is missing ${method}()`);
    }
  }
}

export async function assertRunnerProviderConformance(
  registration: ClodexRunnerRegistration,
  provider: WorkspaceExecutionProvider,
): Promise<void> {
  assertRunnerProviderIdentity(provider, registration.manifest);
  const actual = await provider.getCapabilities();
  for (const capability of [
    'persistentSessions',
    'streamingOutput',
    'stdin',
    'cancellation',
    'workspaceLeases',
  ] as const) {
    if (actual[capability] !== registration.manifest.capabilities[capability]) {
      throw new Error(
        `Runner capability mismatch for ${capability}: manifest=${registration.manifest.capabilities[capability]} provider=${actual[capability]}`,
      );
    }
  }
  if (!actual.workspaceLeases) {
    throw new Error(
      'Clodex runners must support snapshot-bound workspace leases',
    );
  }
}

export async function createClodexRunner(
  registration: ClodexRunnerRegistration,
): Promise<WorkspaceExecutionProvider> {
  const provider = await registration.create();
  await assertRunnerProviderConformance(registration, provider);
  return provider;
}

function validateManifest(
  manifest: ClodexRunnerManifest,
): ClodexRunnerManifest {
  if (manifest.sdkVersion !== CLODEX_RUNNER_SDK_VERSION) {
    throw new Error(`Unsupported runner SDK version: ${manifest.sdkVersion}`);
  }
  if (!/^[a-z0-9][a-z0-9._:-]{2,127}$/.test(manifest.id)) {
    throw new Error('Runner manifest id is invalid');
  }
  if (!manifest.name.trim() || manifest.name.length > 120) {
    throw new Error('Runner manifest name is invalid');
  }
  if (!['local', 'ssh', 'docker', 'cloud'].includes(manifest.providerKind)) {
    throw new Error('Runner manifest provider kind is invalid');
  }
  if (!manifest.capabilities.workspaceLeases) {
    throw new Error('Runner manifest must declare workspace lease support');
  }
  return manifest;
}

function freezeManifest(
  manifest: ClodexRunnerManifest,
): Readonly<ClodexRunnerManifest> {
  return Object.freeze({
    ...manifest,
    capabilities: Object.freeze({ ...manifest.capabilities }),
  });
}

export type {
  CommandExecutionRequest,
  CreateExecutionSessionRequest,
  ExecutionArtifactManifest,
  PrepareWorkspaceRequest,
  RunnerCapabilities,
  RunnerDispatchResult,
  RunnerExecutionError,
  RunnerExecutionStageTimings,
  RunnerJobAdmissionError,
  SignedExecutionReceipt,
  SignedRunnerJob,
  WorkspaceExecutionMaterialization,
  WorkspaceExecutionMountBinding,
  WorkspaceExecutionProvider,
  WorkspaceExecutionProviderKind,
  WorkspaceLease,
} from '@clodex/agent-shell';

export {
  EXECUTION_ARTIFACT_MANIFEST_VERSION,
  EXECUTION_RECEIPT_VERSION,
  RUNNER_JOB_VERSION,
  createSignedExecutionReceipt,
  hashRunnerExecutionStageTimings,
  hashExecutionArtifactManifest,
  hashRunnerPayload,
  verifySignedRunnerJob,
} from '@clodex/agent-shell';
