import {
  encodeUtf8,
  hashSafeCodingAction,
  type HashPort,
  type SafeCodingAction,
  type SafeCodingExecutionTicket,
} from '@clodex/contracts';
import type { TrustedSafeCodingAdapterBinding } from '@clodex/guardian';
import { ReferenceSafeCodingRuntime } from '@clodex/runtime';
import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_CONFINED_REFERENCE_ADAPTER_PROFILE,
  CapabilityConfinedAdapterRegistry,
  HARDENED_GIT_POLICY_KIND,
  HARDENED_GIT_POLICY_SPEC_VERSION,
  ReferenceAdapterError,
  ReferenceFilesystemCreateAdapter,
  ReferenceFilesystemMkdirAdapter,
  ReferenceFilesystemReplaceAdapter,
  ReferenceGitDiffAdapter,
  ReferenceGitStatusAdapter,
  ReferenceTestRunAdapter,
  TEST_SANDBOX_PROFILE_KIND,
  TEST_SANDBOX_PROFILE_SPEC_VERSION,
  hashHardenedGitPolicy,
  hashTestSandboxProfile,
  type FilesystemCreateCapabilityPort,
  type FilesystemCreateExecuteInput,
  type FilesystemCreateInspectInput,
  type CapabilityScope,
  type GitDiffCapabilityPort,
  type GitDiffExecuteInput,
  type GitDiffInspectInput,
  type HardenedGitPolicy,
  type RegisteredTestSandboxProfile,
  type TestRunCapabilityPort,
  type TestRunExecuteInput,
  type TestRunInspectInput,
  type TestSandboxProfile,
} from './index.js';
import {
  IN_MEMORY_ADAPTER_PORT_PROFILE,
  InMemoryContentResolver,
  InMemoryFilesystemCapabilityPort,
  InMemoryGitCapabilityPort,
  InMemoryTestRunCapabilityPort,
  InMemoryTestSandboxProfileRegistry,
} from './testing/index.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const HASH_F = 'f'.repeat(64);
const CAPABILITY_SCOPE: CapabilityScope = Object.freeze({
  workspaceId: 'workspace:test',
  taskId: 'task:test',
  rootObjectId: 'root:test-workspace',
});

const hash: HashPort = {
  sha256(input) {
    const lanes = [
      0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344, 0xa4093822, 0x299f31d0,
      0x082efa98, 0xec4e6c89,
    ];
    for (let index = 0; index < input.length; index += 1) {
      const byte = input[index]!;
      for (let lane = 0; lane < lanes.length; lane += 1) {
        lanes[lane] = Math.imul(
          (lanes[lane]! ^ (byte + index + lane)) >>> 0,
          0x01000193,
        );
      }
    }
    return lanes
      .map((lane) => (lane >>> 0).toString(16).padStart(8, '0'))
      .join('');
  },
};

function binding<K extends SafeCodingAction['action']>(
  action: K,
): TrustedSafeCodingAdapterBinding & { readonly action: K } {
  return {
    action,
    policyDigest: HASH_A,
    adapterId: `adapter:${action}`,
    adapterDigest: HASH_B,
    adapterRegistryDigest: HASH_C,
    runnerRegistryDigest: HASH_D,
    effectRegistryDigest: HASH_E,
    effectClass:
      action === 'git.status' || action === 'git.diff'
        ? 'local.observation'
        : action === 'test.run'
          ? 'sandbox.ephemeral'
          : 'local.reversible',
  };
}

async function digest(bytes: Uint8Array): Promise<string> {
  return await hash.sha256(bytes);
}

async function ticketFor(
  action: SafeCodingAction,
  adapterBinding: TrustedSafeCodingAdapterBinding,
  prepared: {
    readonly resolvedObjectId: string;
    readonly stateCommitmentHash: string;
  },
  overrides: Partial<SafeCodingExecutionTicket> = {},
): Promise<SafeCodingExecutionTicket> {
  return {
    kind: 'clodex.execution-ticket',
    specVersion: '1.0.0',
    ticketId: '00000000-0000-4000-8000-000000000001',
    requestId: action.requestId,
    contractHash: HASH_F,
    contractRevision: 1,
    subject: { principalId: 'principal:test', instanceId: 'instance:test' },
    audience: {
      guardianId: 'guardian:test',
      executorId: 'executor:test',
      runtimeEpoch: 1,
      taskId: 'task:test',
      workspaceId: 'workspace:test',
    },
    actionHash: await hashSafeCodingAction(action, hash),
    argumentsHash: HASH_A,
    resolvedObjectId: prepared.resolvedObjectId,
    stateCommitmentHash: prepared.stateCommitmentHash,
    adapterId: adapterBinding.adapterId,
    adapterDigest: adapterBinding.adapterDigest,
    policyDigest: adapterBinding.policyDigest,
    registryDigest: adapterBinding.adapterRegistryDigest,
    runnerRegistryDigest: adapterBinding.runnerRegistryDigest,
    effectRegistryDigest: adapterBinding.effectRegistryDigest,
    effectClass: adapterBinding.effectClass,
    revocationEpoch: 0,
    budgetReservationId: 'reservation:test',
    nonce: 'AQIDBAUGBwgJCgsMDQ4PEA',
    issuedAt: '2026-07-14T00:00:00Z',
    expiresAt: '2026-07-14T00:01:00Z',
    ...overrides,
  };
}

function hardenedPolicy(): HardenedGitPolicy {
  return {
    kind: HARDENED_GIT_POLICY_KIND,
    specVersion: HARDENED_GIT_POLICY_SPEC_VERSION,
    fixedOperationsOnly: true,
    arbitraryArguments: false,
    shell: false,
    hooks: false,
    pager: false,
    externalDiff: false,
    textconv: false,
    configOverrides: false,
    credentialHelpers: false,
    network: false,
    repositoryReadOnly: true,
    optionalLocks: false,
  };
}

async function hardenedCommitment() {
  const policy = hardenedPolicy();
  return {
    policy,
    policyDigest: await hashHardenedGitPolicy(policy, hash),
  };
}

function testProfile(): TestSandboxProfile {
  return {
    kind: TEST_SANDBOX_PROFILE_KIND,
    specVersion: TEST_SANDBOX_PROFILE_SPEC_VERSION,
    profileId: 'unit-safe',
    testPlanDigest: HASH_A,
    runnerId: 'runner:test-sandbox',
    runnerDigest: HASH_B,
    sandboxImageDigest: HASH_C,
    network: false,
    credentials: false,
    hostWorkspaceReadOnly: true,
    disposableScratch: true,
  };
}

async function registeredProfile(): Promise<RegisteredTestSandboxProfile> {
  const profile = testProfile();
  return {
    profile,
    profileDigest: await hashTestSandboxProfile(profile, hash),
  };
}

describe('capability-confined reference adapter profile', () => {
  it('states its non-production confinement boundary honestly', () => {
    expect(CAPABILITY_CONFINED_REFERENCE_ADAPTER_PROFILE).toEqual({
      authorityModel: 'injected-fixed-operation-ports',
      durability: 'port-defined-not-provided',
      filesystemConfinement: 'protocol-only-not-openat2',
      gitConfinement: 'policy-commitment-not-cli-implementation',
      testConfinement: 'profile-commitment-not-os-sandbox',
      hostWorkspaceAdapter: false,
    });
    expect(IN_MEMORY_ADAPTER_PORT_PROFILE).toMatchObject({
      durability: 'memory-only',
      osIsolation: 'none',
      productionSuitable: false,
    });
  });
});

describe('filesystem fixed-operation adapters', () => {
  it('resolves create content by exact digest and bytes, stays inert, and is one-shot', async () => {
    const content = encodeUtf8('exact content');
    const contentSha256 = await digest(content);
    const contents = new InMemoryContentResolver([{ contentSha256, content }]);
    const capability = new InMemoryFilesystemCapabilityPort(hash);
    const adapter = new ReferenceFilesystemCreateAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.create'),
      hash,
      contents,
      capability,
    });
    const action = {
      requestId: 'request:create',
      action: 'filesystem.create',
      selector: { kind: 'file', path: 'src/new.ts' },
      contentSha256,
      contentBytes: content.byteLength,
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const ticket = await ticketFor(action, adapter.binding, preparedAction);
    const prepared = await adapter.prepare({ action, ticket });

    expect(capability.inspectCount).toBe(2);
    expect(capability.executeCount).toBe(0);
    expect(capability.snapshot('src/new.ts')).toBeNull();
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.keys(prepared)).toEqual(['execute']);

    const result = await prepared.execute();
    expect(capability.executeCount).toBe(1);
    expect(capability.snapshot('src/new.ts')).toEqual({
      kind: 'file',
      contentSha256,
      contentBytes: content.byteLength,
    });
    expect(result.preStateHash).toBe(ticket.stateCommitmentHash);
    expect(result.result).toMatchObject({
      operation: 'filesystem.create',
      ticketId: ticket.ticketId,
      contentSha256,
      contentBytes: content.byteLength,
    });
    await expect(prepared.execute()).rejects.toMatchObject({
      code: 'prepared-effect-consumed',
      stage: 'execute',
    });
    expect(capability.executeCount).toBe(1);
  });

  it('rejects digest or byte-length substitution before inspection or execution', async () => {
    const expected = encodeUtf8('expected');
    const substituted = encodeUtf8('substitute');
    const contentSha256 = await digest(expected);
    const contents = new InMemoryContentResolver([
      { contentSha256, content: substituted },
    ]);
    const capability = new InMemoryFilesystemCapabilityPort(hash);
    const adapter = new ReferenceFilesystemCreateAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.create'),
      hash,
      contents,
      capability,
    });
    const action = {
      requestId: 'request:substitution',
      action: 'filesystem.create',
      selector: { kind: 'file', path: 'src/no.ts' },
      contentSha256,
      contentBytes: expected.byteLength,
    } as const;

    await expect(adapter.prepareAuthorization(action)).rejects.toMatchObject({
      code: 'content-integrity-mismatch',
      stage: 'prepare',
    });
    expect(capability.inspectCount).toBe(0);
    expect(capability.executeCount).toBe(0);
  });

  it('rejects an action/ticket adapter substitution before returning an effect', async () => {
    const content = encodeUtf8('safe');
    const contentSha256 = await digest(content);
    const contents = new InMemoryContentResolver([{ contentSha256, content }]);
    const capability = new InMemoryFilesystemCapabilityPort(hash);
    const adapter = new ReferenceFilesystemCreateAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.create'),
      hash,
      contents,
      capability,
    });
    const action = {
      requestId: 'request:ticket',
      action: 'filesystem.create',
      selector: { kind: 'file', path: 'src/ticket.ts' },
      contentSha256,
      contentBytes: content.byteLength,
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const ticket = await ticketFor(action, adapter.binding, preparedAction, {
      adapterDigest: HASH_D,
    });

    await expect(adapter.prepare({ action, ticket })).rejects.toMatchObject({
      code: 'adapter-binding-mismatch',
      stage: 'prepare',
    });
    expect(capability.executeCount).toBe(0);
  });

  it('rejects prepared object/state that differs from the ticket', async () => {
    const content = encodeUtf8('safe');
    const contentSha256 = await digest(content);
    const contents = new InMemoryContentResolver([{ contentSha256, content }]);
    const capability = new InMemoryFilesystemCapabilityPort(hash);
    const adapter = new ReferenceFilesystemCreateAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.create'),
      hash,
      contents,
      capability,
    });
    const action = {
      requestId: 'request:state',
      action: 'filesystem.create',
      selector: { kind: 'file', path: 'src/state.ts' },
      contentSha256,
      contentBytes: content.byteLength,
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const ticket = await ticketFor(action, adapter.binding, preparedAction, {
      stateCommitmentHash: HASH_F,
    });

    await expect(adapter.prepare({ action, ticket })).rejects.toMatchObject({
      code: 'prepared-state-mismatch',
      stage: 'prepare',
    });
    expect(capability.executeCount).toBe(0);
  });

  it('passes exact expected state to execution and fails stale CAS after PREPARE', async () => {
    const content = encodeUtf8('safe');
    const contentSha256 = await digest(content);
    const contents = new InMemoryContentResolver([{ contentSha256, content }]);
    const capability = new InMemoryFilesystemCapabilityPort(hash);
    const adapter = new ReferenceFilesystemCreateAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.create'),
      hash,
      contents,
      capability,
    });
    const action = {
      requestId: 'request:cas',
      action: 'filesystem.create',
      selector: { kind: 'file', path: 'src/cas.ts' },
      contentSha256,
      contentBytes: content.byteLength,
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const ticket = await ticketFor(action, adapter.binding, preparedAction);
    const prepared = await adapter.prepare({ action, ticket });

    capability.setTree('src/cas.ts');
    await expect(prepared.execute()).rejects.toMatchObject({
      code: 'prepared-state-mismatch',
      stage: 'execute',
    });
    expect(capability.snapshot('src/cas.ts')).toEqual({ kind: 'tree' });
  });

  it('requires replace before-content commitment and executes exact replacement', async () => {
    const before = encodeUtf8('before');
    const after = encodeUtf8('after');
    const beforeSha256 = await digest(before);
    const contentSha256 = await digest(after);
    const contents = new InMemoryContentResolver([
      { contentSha256, content: after },
    ]);
    const capability = new InMemoryFilesystemCapabilityPort(hash);
    capability.setFile('src/existing.ts', beforeSha256, before.byteLength);
    const adapter = new ReferenceFilesystemReplaceAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.replace'),
      hash,
      contents,
      capability,
    });
    const action = {
      requestId: 'request:replace',
      action: 'filesystem.replace',
      selector: { kind: 'file', path: 'src/existing.ts' },
      beforeSha256,
      contentSha256,
      contentBytes: after.byteLength,
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const ticket = await ticketFor(action, adapter.binding, preparedAction);
    const prepared = await adapter.prepare({ action, ticket });
    const result = await prepared.execute();

    expect(capability.snapshot('src/existing.ts')).toEqual({
      kind: 'file',
      contentSha256,
      contentBytes: after.byteLength,
    });
    expect(result.result).toMatchObject({
      beforeSha256,
      contentSha256,
      contentBytes: after.byteLength,
    });
  });

  it('fails replace authorization when reviewed before digest is stale', async () => {
    const after = encodeUtf8('after');
    const contentSha256 = await digest(after);
    const contents = new InMemoryContentResolver([
      { contentSha256, content: after },
    ]);
    const capability = new InMemoryFilesystemCapabilityPort(hash);
    capability.setFile('src/stale.ts', HASH_A, 1);
    const adapter = new ReferenceFilesystemReplaceAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.replace'),
      hash,
      contents,
      capability,
    });
    const action = {
      requestId: 'request:stale-before',
      action: 'filesystem.replace',
      selector: { kind: 'file', path: 'src/stale.ts' },
      beforeSha256: HASH_B,
      contentSha256,
      contentBytes: after.byteLength,
    } as const;

    await expect(adapter.prepareAuthorization(action)).rejects.toMatchObject({
      code: 'port-result-invalid',
      stage: 'prepare',
    });
    expect(capability.executeCount).toBe(0);
  });

  it('creates only an absent directory through mkdir-specific capability', async () => {
    const capability = new InMemoryFilesystemCapabilityPort(hash);
    const adapter = new ReferenceFilesystemMkdirAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.mkdir'),
      hash,
      capability,
    });
    const action = {
      requestId: 'request:mkdir',
      action: 'filesystem.mkdir',
      selector: { kind: 'tree', path: 'src/generated' },
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const ticket = await ticketFor(action, adapter.binding, preparedAction);
    const prepared = await adapter.prepare({ action, ticket });

    expect(capability.snapshot('src/generated')).toBeNull();
    await prepared.execute();
    expect(capability.snapshot('src/generated')).toEqual({ kind: 'tree' });
  });

  it('rejects accessor-bearing execution results without invoking getter', async () => {
    const content = encodeUtf8('safe');
    const contentSha256 = await digest(content);
    let getterCalls = 0;
    const port: FilesystemCreateCapabilityPort = {
      inspectCreate() {
        return {
          operation: 'filesystem.create',
          resolvedObjectId: 'object:create',
          stateCommitmentHash: HASH_A,
          targetState: 'absent',
        };
      },
      executeCreate(input) {
        const result = {
          operation: 'filesystem.create',
          ticketId: input.ticketId,
          resolvedObjectId: input.resolvedObjectId,
          preStateHash: input.expectedStateCommitmentHash,
          postStateHash: HASH_B,
          contentSha256: input.contentSha256,
        } as Record<string, unknown>;
        Object.defineProperty(result, 'contentBytes', {
          enumerable: true,
          get() {
            getterCalls += 1;
            return input.contentBytes;
          },
        });
        return result;
      },
    };
    const adapter = new ReferenceFilesystemCreateAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.create'),
      hash,
      contents: new InMemoryContentResolver([{ contentSha256, content }]),
      capability: port,
    });
    const action = {
      requestId: 'request:getter',
      action: 'filesystem.create',
      selector: { kind: 'file', path: 'src/getter.ts' },
      contentSha256,
      contentBytes: content.byteLength,
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const ticket = await ticketFor(action, adapter.binding, preparedAction);
    const prepared = await adapter.prepare({ action, ticket });

    await expect(prepared.execute()).rejects.toMatchObject({
      code: 'port-result-invalid',
      stage: 'execute',
    });
    expect(getterCalls).toBe(0);
  });

  it('passes one immutable capability scope to content, inspect, and execute ports', async () => {
    const content = encodeUtf8('scoped');
    const contentSha256 = await digest(content);
    const observed: {
      readonly port: string;
      readonly scope: CapabilityScope;
    }[] = [];
    const contents = {
      resolveExact(input: { capabilityScope: CapabilityScope }) {
        observed.push({ port: 'content', scope: input.capabilityScope });
        return content;
      },
    };
    const capability: FilesystemCreateCapabilityPort = {
      inspectCreate(input) {
        observed.push({ port: 'inspect', scope: input.capabilityScope });
        return {
          operation: 'filesystem.create',
          resolvedObjectId: 'object:scoped-create',
          stateCommitmentHash: HASH_A,
          targetState: 'absent',
        };
      },
      executeCreate(input) {
        observed.push({ port: 'execute', scope: input.capabilityScope });
        return {
          operation: 'filesystem.create',
          ticketId: input.ticketId,
          resolvedObjectId: input.resolvedObjectId,
          preStateHash: input.expectedStateCommitmentHash,
          postStateHash: HASH_B,
          contentSha256: input.contentSha256,
          contentBytes: input.contentBytes,
        };
      },
    };
    const adapter = new ReferenceFilesystemCreateAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.create'),
      hash,
      contents,
      capability,
    });
    const action = {
      requestId: 'request:scoped-ports',
      action: 'filesystem.create',
      selector: { kind: 'file', path: 'src/scoped.ts' },
      contentSha256,
      contentBytes: content.byteLength,
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const ticket = await ticketFor(action, adapter.binding, preparedAction);
    await (await adapter.prepare({ action, ticket })).execute();

    expect(observed.map((entry) => entry.port)).toEqual([
      'content',
      'inspect',
      'content',
      'inspect',
      'execute',
    ]);
    for (const entry of observed) {
      expect(entry.scope).toEqual(CAPABILITY_SCOPE);
      expect(Object.isFrozen(entry.scope)).toBe(true);
    }
  });

  it.each([
    ['workspaceId', 'workspace:other'],
    ['taskId', 'task:other'],
  ] as const)('rejects cross-scope ticket %s before content or inspection PREPARE', async (field, substituted) => {
    const content = encodeUtf8('scope mismatch');
    const contentSha256 = await digest(content);
    let contentCalls = 0;
    const contents = {
      resolveExact() {
        contentCalls += 1;
        return content;
      },
    };
    const capability = new InMemoryFilesystemCapabilityPort(hash);
    const adapter = new ReferenceFilesystemCreateAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.create'),
      hash,
      contents,
      capability,
    });
    const action = {
      requestId: `request:cross-${field}`,
      action: 'filesystem.create',
      selector: { kind: 'file', path: `src/${field}.ts` },
      contentSha256,
      contentBytes: content.byteLength,
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const audience = {
      guardianId: 'guardian:test',
      executorId: 'executor:test',
      runtimeEpoch: 1,
      taskId: CAPABILITY_SCOPE.taskId,
      workspaceId: CAPABILITY_SCOPE.workspaceId,
      [field]: substituted,
    };
    const ticket = await ticketFor(action, adapter.binding, preparedAction, {
      audience,
    });
    const beforeContent = contentCalls;
    const beforeInspect = capability.inspectCount;

    await expect(adapter.prepare({ action, ticket })).rejects.toMatchObject({
      code: 'capability-scope-mismatch',
      stage: 'prepare',
    });
    expect(contentCalls).toBe(beforeContent);
    expect(capability.inspectCount).toBe(beforeInspect);
    expect(capability.executeCount).toBe(0);
  });
});

describe('fixed hardened Git observation adapters', () => {
  it('rejects mismatched hardened-policy digest before port inspection', async () => {
    const capability = new InMemoryGitCapabilityPort({
      hash,
      summaryDigest: HASH_A,
      worktreeDiffDigest: HASH_B,
      stagedDiffDigest: HASH_C,
    });
    const adapter = new ReferenceGitStatusAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('git.status'),
      hash,
      hardenedPolicy: { policy: hardenedPolicy(), policyDigest: HASH_D },
      capability,
    });

    await expect(
      adapter.prepareAuthorization({
        requestId: 'request:policy',
        action: 'git.status',
      }),
    ).rejects.toMatchObject({
      code: 'hardened-policy-invalid',
      stage: 'prepare',
    });
    expect(capability.inspectCount).toBe(0);
  });

  it('runs fixed git.status with immutable explicit hardening commitment', async () => {
    const policy = await hardenedCommitment();
    const capability = new InMemoryGitCapabilityPort({
      hash,
      clean: false,
      summaryDigest: HASH_A,
      worktreeDiffDigest: HASH_B,
      stagedDiffDigest: HASH_C,
    });
    const adapter = new ReferenceGitStatusAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('git.status'),
      hash,
      hardenedPolicy: policy,
      capability,
    });
    const action = {
      requestId: 'request:status',
      action: 'git.status',
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const ticket = await ticketFor(action, adapter.binding, preparedAction);
    const prepared = await adapter.prepare({ action, ticket });
    const result = await prepared.execute();

    expect(result.preStateHash).toBe(ticket.stateCommitmentHash);
    expect(result.postStateHash).toBe(ticket.stateCommitmentHash);
    expect(result.result).toMatchObject({
      operation: 'git.status',
      hardenedPolicyDigest: policy.policyDigest,
      clean: false,
      summaryDigest: HASH_A,
    });
  });

  it('exposes only fixed git.diff scope and policy fields, never argv/config/env', async () => {
    const policy = await hardenedCommitment();
    let inspectKeys: string[] = [];
    let executeKeys: string[] = [];
    const capability: GitDiffCapabilityPort = {
      inspectDiff(input: GitDiffInspectInput) {
        inspectKeys = Object.keys(input).sort();
        expect(input.capabilityScope).toEqual(CAPABILITY_SCOPE);
        expect(Object.isFrozen(input.capabilityScope)).toBe(true);
        return {
          operation: 'git.diff',
          resolvedObjectId: 'git:repository',
          stateCommitmentHash: HASH_A,
          hardenedPolicyDigest: input.hardenedPolicyDigest,
        };
      },
      executeDiff(input: GitDiffExecuteInput) {
        executeKeys = Object.keys(input).sort();
        expect(input.capabilityScope).toEqual(CAPABILITY_SCOPE);
        return {
          operation: 'git.diff',
          scope: input.scope,
          ticketId: input.ticketId,
          resolvedObjectId: input.resolvedObjectId,
          preStateHash: input.expectedStateCommitmentHash,
          postStateHash: input.expectedStateCommitmentHash,
          hardenedPolicyDigest: input.hardenedPolicyDigest,
          changedFiles: 2,
          diffDigest: HASH_B,
        };
      },
    };
    const adapter = new ReferenceGitDiffAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('git.diff'),
      hash,
      hardenedPolicy: policy,
      capability,
    });
    const action = {
      requestId: 'request:diff',
      action: 'git.diff',
      scope: 'staged',
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const ticket = await ticketFor(action, adapter.binding, preparedAction);
    const prepared = await adapter.prepare({ action, ticket });
    const result = await prepared.execute();

    expect(inspectKeys).toEqual([
      'capabilityScope',
      'hardenedPolicy',
      'hardenedPolicyDigest',
      'requestId',
      'scope',
    ]);
    expect(executeKeys).toEqual([
      'capabilityScope',
      'expectedStateCommitmentHash',
      'hardenedPolicy',
      'hardenedPolicyDigest',
      'requestId',
      'resolvedObjectId',
      'scope',
      'ticketId',
    ]);
    expect(result.result).toMatchObject({
      operation: 'git.diff',
      scope: 'staged',
      changedFiles: 2,
      diffDigest: HASH_B,
    });
  });

  it('fails Git observation if repository state changes after PREPARE', async () => {
    const capability = new InMemoryGitCapabilityPort({
      hash,
      summaryDigest: HASH_A,
      worktreeDiffDigest: HASH_B,
      stagedDiffDigest: HASH_C,
    });
    const adapter = new ReferenceGitStatusAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('git.status'),
      hash,
      hardenedPolicy: await hardenedCommitment(),
      capability,
    });
    const action = {
      requestId: 'request:git-cas',
      action: 'git.status',
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const ticket = await ticketFor(action, adapter.binding, preparedAction);
    const prepared = await adapter.prepare({ action, ticket });

    capability.mutate({ clean: false, summaryDigest: HASH_D });
    await expect(prepared.execute()).rejects.toMatchObject({
      code: 'prepared-state-mismatch',
      stage: 'execute',
    });
  });

  it('rejects Git policy enabling network or arbitrary arguments', () => {
    const unsafe = {
      ...hardenedPolicy(),
      network: true,
      arbitraryArguments: true,
    };
    expect(
      () =>
        new ReferenceGitStatusAdapter({
          capabilityScope: CAPABILITY_SCOPE,
          binding: binding('git.status'),
          hash,
          hardenedPolicy: { policy: unsafe as never, policyDigest: HASH_A },
          capability: new InMemoryGitCapabilityPort({
            hash,
            summaryDigest: HASH_A,
            worktreeDiffDigest: HASH_B,
            stagedDiffDigest: HASH_C,
          }),
        }),
    ).toThrow(ReferenceAdapterError);
  });
});

describe('registered digest-pinned test sandbox adapter', () => {
  it('runs only registered safe profile without command, args, paths, or env', async () => {
    const profile = await registeredProfile();
    const profileMemory = new InMemoryTestSandboxProfileRegistry([profile]);
    const profileScopes: CapabilityScope[] = [];
    const profiles = {
      resolveProfile(input: {
        readonly capabilityScope: CapabilityScope;
        readonly profileId: string;
      }) {
        profileScopes.push(input.capabilityScope);
        return profileMemory.resolveProfile(input);
      },
    };
    let inspectKeys: string[] = [];
    let executeKeys: string[] = [];
    const memory = new InMemoryTestRunCapabilityPort({
      hash,
      outcome: 'passed',
      reportDigest: HASH_D,
    });
    const capability: TestRunCapabilityPort = {
      inspectRun(input: TestRunInspectInput) {
        inspectKeys = Object.keys(input).sort();
        return memory.inspectRun(input);
      },
      executeRun(input: TestRunExecuteInput) {
        executeKeys = Object.keys(input).sort();
        return memory.executeRun(input);
      },
    };
    const adapter = new ReferenceTestRunAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('test.run'),
      hash,
      profiles,
      capability,
    });
    const action = {
      requestId: 'request:test',
      action: 'test.run',
      profileId: 'unit-safe',
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const ticket = await ticketFor(action, adapter.binding, preparedAction);
    const prepared = await adapter.prepare({ action, ticket });
    const result = await prepared.execute();

    expect(inspectKeys).toEqual([
      'capabilityScope',
      'profile',
      'profileDigest',
      'requestId',
    ]);
    expect(executeKeys).toEqual([
      'capabilityScope',
      'expectedStateCommitmentHash',
      'profile',
      'profileDigest',
      'requestId',
      'resolvedObjectId',
      'ticketId',
    ]);
    expect(result.result).toMatchObject({
      operation: 'test.run',
      profileId: 'unit-safe',
      profileDigest: profile.profileDigest,
      runnerDigest: profile.profile.runnerDigest,
      outcome: 'passed',
      exitCode: 0,
    });
    expect(profileScopes).toEqual([CAPABILITY_SCOPE, CAPABILITY_SCOPE]);
    expect(profileScopes.every((scope) => Object.isFrozen(scope))).toBe(true);
  });

  it('fails closed when requested profile is unregistered', async () => {
    const capability = new InMemoryTestRunCapabilityPort({
      hash,
      reportDigest: HASH_A,
    });
    const adapter = new ReferenceTestRunAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('test.run'),
      hash,
      profiles: new InMemoryTestSandboxProfileRegistry(),
      capability,
    });

    await expect(
      adapter.prepareAuthorization({
        requestId: 'request:missing-profile',
        action: 'test.run',
        profileId: 'missing',
      }),
    ).rejects.toMatchObject({
      code: 'sandbox-profile-unavailable',
      stage: 'prepare',
    });
    expect(capability.inspectCount).toBe(0);
  });

  it('rejects profiles unless all sandbox safety flags are exact', async () => {
    const unsafe = {
      ...(await registeredProfile()),
      profile: {
        ...testProfile(),
        network: true,
        credentials: true,
        hostWorkspaceReadOnly: false,
        disposableScratch: false,
      },
    };
    expect(() => new InMemoryTestSandboxProfileRegistry([unsafe])).toThrow(
      ReferenceAdapterError,
    );
  });

  it('rejects profile substitution against digest before inspection', async () => {
    const profile = await registeredProfile();
    const profiles = new InMemoryTestSandboxProfileRegistry([
      { ...profile, profileDigest: HASH_F },
    ]);
    const capability = new InMemoryTestRunCapabilityPort({
      hash,
      reportDigest: HASH_A,
    });
    const adapter = new ReferenceTestRunAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('test.run'),
      hash,
      profiles,
      capability,
    });

    await expect(
      adapter.prepareAuthorization({
        requestId: 'request:profile-digest',
        action: 'test.run',
        profileId: 'unit-safe',
      }),
    ).rejects.toMatchObject({
      code: 'sandbox-profile-invalid',
      stage: 'prepare',
    });
    expect(capability.inspectCount).toBe(0);
  });

  it('fails test run if execution state changes after PREPARE', async () => {
    const profile = await registeredProfile();
    const capability = new InMemoryTestRunCapabilityPort({
      hash,
      reportDigest: HASH_A,
    });
    const adapter = new ReferenceTestRunAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('test.run'),
      hash,
      profiles: new InMemoryTestSandboxProfileRegistry([profile]),
      capability,
    });
    const action = {
      requestId: 'request:test-cas',
      action: 'test.run',
      profileId: 'unit-safe',
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const ticket = await ticketFor(action, adapter.binding, preparedAction);
    const prepared = await adapter.prepare({ action, ticket });

    capability.mutate({ reportDigest: HASH_B });
    await expect(prepared.execute()).rejects.toMatchObject({
      code: 'prepared-state-mismatch',
      stage: 'execute',
    });
  });

  it('treats non-zero registered test outcome as a result', async () => {
    const profile = await registeredProfile();
    const capability = new InMemoryTestRunCapabilityPort({
      hash,
      outcome: 'failed',
      exitCode: 7,
      reportDigest: HASH_A,
    });
    const adapter = new ReferenceTestRunAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('test.run'),
      hash,
      profiles: new InMemoryTestSandboxProfileRegistry([profile]),
      capability,
    });
    const action = {
      requestId: 'request:test-failed',
      action: 'test.run',
      profileId: 'unit-safe',
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const ticket = await ticketFor(action, adapter.binding, preparedAction);
    const result = await (await adapter.prepare({ action, ticket })).execute();

    expect(result.result).toMatchObject({ outcome: 'failed', exitCode: 7 });
  });
});

describe('shared Guardian/runtime adapter registry', () => {
  it('pins one adapter snapshot behind separate Guardian and runtime ports', async () => {
    const capability = new InMemoryFilesystemCapabilityPort(hash);
    const adapter = new ReferenceFilesystemMkdirAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.mkdir'),
      hash,
      capability,
    });
    const registry = new CapabilityConfinedAdapterRegistry([adapter]);
    const action = {
      requestId: 'request:registry',
      action: 'filesystem.mkdir',
      selector: { kind: 'tree', path: 'generated' },
    } as const;

    const guardianBinding = await registry.guardianAdapters.resolve(action);
    const runtimeAdapter = await registry.runtimeAdapters.resolve(action);
    expect(guardianBinding).toEqual(adapter.binding);
    expect(registry.capabilityScope).toEqual(CAPABILITY_SCOPE);
    expect(Object.isFrozen(registry.capabilityScope)).toBe(true);
    expect(runtimeAdapter?.binding).toEqual(adapter.binding);
    expect(Object.isFrozen(guardianBinding)).toBe(true);
    const prepared = await registry.guardianPrepare.prepare(
      action,
      guardianBinding!,
    );
    expect(prepared.resolvedObjectId).toMatch(/^object:/);
    expect(
      await registry.runtimeAdapters.resolve({
        requestId: 'request:read',
        action: 'filesystem.read',
        selector: { kind: 'file', path: 'src/read.ts' },
      }),
    ).toBeNull();
  });

  it('rejects duplicate registrations and Guardian binding substitution', async () => {
    const first = new ReferenceFilesystemMkdirAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.mkdir'),
      hash,
      capability: new InMemoryFilesystemCapabilityPort(hash),
    });
    const second = new ReferenceFilesystemMkdirAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.mkdir'),
      hash,
      capability: new InMemoryFilesystemCapabilityPort(hash),
    });
    expect(
      () => new CapabilityConfinedAdapterRegistry([first, second]),
    ).toThrowError(/Duplicate adapter/);

    const registry = new CapabilityConfinedAdapterRegistry([first]);
    const action = {
      requestId: 'request:binding-substitution',
      action: 'filesystem.mkdir',
      selector: { kind: 'tree', path: 'substitution' },
    } as const;
    await expect(
      registry.guardianPrepare.prepare(action, {
        ...first.binding,
        adapterDigest: HASH_D,
      }),
    ).rejects.toMatchObject({
      code: 'adapter-binding-mismatch',
      stage: 'prepare',
    });
  });

  it('rejects adapters from different workspace/task/root capability scopes', () => {
    for (const changed of [
      { workspaceId: 'workspace:other' },
      { taskId: 'task:other' },
      { rootObjectId: 'root:other' },
    ]) {
      const first = new ReferenceFilesystemMkdirAdapter({
        capabilityScope: CAPABILITY_SCOPE,
        binding: binding('filesystem.mkdir'),
        hash,
        capability: new InMemoryFilesystemCapabilityPort(hash),
      });
      const second = new ReferenceFilesystemMkdirAdapter({
        capabilityScope: { ...CAPABILITY_SCOPE, ...changed },
        binding: binding('filesystem.mkdir'),
        hash,
        capability: new InMemoryFilesystemCapabilityPort(hash),
      });
      expect(
        () => new CapabilityConfinedAdapterRegistry([first, second]),
      ).toThrowError(/different capability scopes/);
    }
  });

  it('rejects scope and registry-array accessors without invoking getters', () => {
    let scopeReads = 0;
    const accessorScope = {
      taskId: CAPABILITY_SCOPE.taskId,
      rootObjectId: CAPABILITY_SCOPE.rootObjectId,
    } as Record<string, unknown>;
    Object.defineProperty(accessorScope, 'workspaceId', {
      enumerable: true,
      get() {
        scopeReads += 1;
        return CAPABILITY_SCOPE.workspaceId;
      },
    });
    expect(
      () =>
        new ReferenceFilesystemMkdirAdapter({
          capabilityScope: accessorScope as never,
          binding: binding('filesystem.mkdir'),
          hash,
          capability: new InMemoryFilesystemCapabilityPort(hash),
        }),
    ).toThrowError(/closed data-only object/);
    expect(scopeReads).toBe(0);

    let optionReads = 0;
    const options = {
      binding: binding('filesystem.mkdir'),
      hash,
      capability: new InMemoryFilesystemCapabilityPort(hash),
    } as Record<string, unknown>;
    Object.defineProperty(options, 'capabilityScope', {
      enumerable: true,
      get() {
        optionReads += 1;
        return CAPABILITY_SCOPE;
      },
    });
    expect(
      () => new ReferenceFilesystemMkdirAdapter(options as never),
    ).toThrowError(/own data field/);
    expect(optionReads).toBe(0);

    const adapter = new ReferenceFilesystemMkdirAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.mkdir'),
      hash,
      capability: new InMemoryFilesystemCapabilityPort(hash),
    });
    let arrayReads = 0;
    const adapters: unknown[] = [];
    Object.defineProperty(adapters, '0', {
      enumerable: true,
      get() {
        arrayReads += 1;
        return adapter;
      },
    });
    adapters.length = 1;
    expect(
      () => new CapabilityConfinedAdapterRegistry(adapters as never),
    ).toThrowError(/accessors/);
    expect(arrayReads).toBe(0);
  });

  it('snapshots methods so later replacement cannot widen authority', async () => {
    let originalCalls = 0;
    let replacementCalls = 0;
    const capability: FilesystemCreateCapabilityPort = {
      inspectCreate(_input: FilesystemCreateInspectInput) {
        originalCalls += 1;
        return {
          operation: 'filesystem.create',
          resolvedObjectId: 'object:snapshot',
          stateCommitmentHash: HASH_A,
          targetState: 'absent',
        };
      },
      executeCreate(_input: FilesystemCreateExecuteInput) {
        throw new Error('unused');
      },
    };
    const content = encodeUtf8('snapshot');
    const contentSha256 = await digest(content);
    const adapter = new ReferenceFilesystemCreateAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.create'),
      hash,
      contents: new InMemoryContentResolver([{ contentSha256, content }]),
      capability,
    });
    capability.inspectCreate = () => {
      replacementCalls += 1;
      throw new Error('replacement authority');
    };

    await adapter.prepareAuthorization({
      requestId: 'request:method-snapshot',
      action: 'filesystem.create',
      selector: { kind: 'file', path: 'src/snapshot.ts' },
      contentSha256,
      contentBytes: content.byteLength,
    });
    expect(originalCalls).toBe(1);
    expect(replacementCalls).toBe(0);
  });
});

describe('reference runtime phase compatibility', () => {
  it('closes content-resolution failure before COMMIT_PERMIT as failed-no-effect', async () => {
    const content = encodeUtf8('runtime-before');
    const contentSha256 = await digest(content);
    const contents = new InMemoryContentResolver([{ contentSha256, content }]);
    const capability = new InMemoryFilesystemCapabilityPort(hash);
    const adapter = new ReferenceFilesystemCreateAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.create'),
      hash,
      contents,
      capability,
    });
    const action = {
      requestId: 'request:runtime-before',
      action: 'filesystem.create',
      selector: { kind: 'file', path: 'src/runtime-before.ts' },
      contentSha256,
      contentBytes: content.byteLength,
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const ticket = await ticketFor(action, adapter.binding, preparedAction);
    contents.delete(contentSha256);
    const registry = new CapabilityConfinedAdapterRegistry([adapter]);
    const harness = runtimeHarness(ticket, registry);

    await expect(
      harness.runtime.execute({ signedContract: {}, action }),
    ).rejects.toMatchObject({
      code: 'adapter-failed-before-effect',
      terminalStatus: 'failed-no-effect',
    });
    expect(harness.kernel.commitCount).toBe(0);
    expect(harness.kernel.status()).toBe('failed-no-effect');
    expect(capability.executeCount).toBe(0);
    expect(harness.attestations).toHaveLength(1);
    expect(harness.attestations[0]).toMatchObject({
      status: 'failed_no_effect',
      evidenceLevel: 'attempt_only',
    });
  });

  it('treats CAS failure during prepared execute after COMMIT_PERMIT as uncertain', async () => {
    const content = encodeUtf8('runtime-after');
    const contentSha256 = await digest(content);
    const contents = new InMemoryContentResolver([{ contentSha256, content }]);
    const capability = new InMemoryFilesystemCapabilityPort(hash);
    const adapter = new ReferenceFilesystemCreateAdapter({
      capabilityScope: CAPABILITY_SCOPE,
      binding: binding('filesystem.create'),
      hash,
      contents,
      capability,
    });
    const action = {
      requestId: 'request:runtime-after',
      action: 'filesystem.create',
      selector: { kind: 'file', path: 'src/runtime-after.ts' },
      contentSha256,
      contentBytes: content.byteLength,
    } as const;
    const preparedAction = await adapter.prepareAuthorization(action);
    const ticket = await ticketFor(action, adapter.binding, preparedAction);
    const registry = new CapabilityConfinedAdapterRegistry([adapter]);
    const harness = runtimeHarness(ticket, registry, () => {
      capability.setTree('src/runtime-after.ts');
    });

    await expect(
      harness.runtime.execute({ signedContract: {}, action }),
    ).rejects.toMatchObject({
      code: 'adapter-failed-after-commit',
      terminalStatus: 'uncertain',
    });
    expect(harness.kernel.commitCount).toBe(1);
    expect(harness.kernel.status()).toBe('uncertain');
    expect(capability.executeCount).toBe(1);
    expect(capability.snapshot('src/runtime-after.ts')).toEqual({
      kind: 'tree',
    });
    expect(harness.attestations[0]).toMatchObject({
      status: 'uncertain',
      evidenceLevel: 'attempt_only',
    });
  });
});

function runtimeHarness(
  ticket: SafeCodingExecutionTicket,
  registry: CapabilityConfinedAdapterRegistry,
  onRevalidate: () => void = () => {},
) {
  let status:
    | 'registered'
    | 'commit-permit'
    | 'failed-no-effect'
    | 'committed'
    | 'result-unavailable'
    | 'uncertain' = 'registered';
  let terminalReason: string | null = null;
  let resultHash: string | null = null;
  const attestations: unknown[] = [];
  const kernel = {
    commitCount: 0,
    status: () => status,
    commitPermit(value: SafeCodingExecutionTicket) {
      expect(value).toEqual(ticket);
      this.commitCount += 1;
      status = 'commit-permit';
      return {
        ticketId: ticket.ticketId,
        requestId: ticket.requestId,
        contractHash: ticket.contractHash,
        contractRevision: ticket.contractRevision,
        revocationEpoch: ticket.revocationEpoch,
        budgetReservationId: ticket.budgetReservationId,
        permittedAt: '2026-07-14T00:00:10Z',
      };
    },
    failBeforeCommit(_ticketId: string, reason: string) {
      status = 'failed-no-effect';
      terminalReason = reason;
      return record();
    },
    settleTicket(input: {
      readonly status:
        | 'failed-no-effect'
        | 'committed'
        | 'result-unavailable'
        | 'uncertain';
      readonly resultHash?: string | null;
      readonly reason?: string | null;
    }) {
      status = input.status;
      terminalReason = input.reason ?? null;
      resultHash = input.resultHash ?? null;
      return record();
    },
    getTicket(_ticketId: string) {
      return record();
    },
  };
  const record = () => ({
    ticket,
    contractId: 'contract:test',
    status,
    registeredAt: ticket.issuedAt,
    commitPermittedAt:
      status === 'registered' || status === 'failed-no-effect'
        ? null
        : '2026-07-14T00:00:10Z',
    terminalAt:
      status === 'registered' || status === 'commit-permit'
        ? null
        : '2026-07-14T00:00:10Z',
    terminalReason,
    resultHash,
    reservedCharge: {
      uniqueModifiedFiles: 1,
      mutationBytes: 0,
      testRuns: 0,
    },
    aggregateCharge: {
      uniqueModifiedFiles: 1,
      mutationBytes: 0,
      testRuns: 0,
    },
  });
  const runtime = new ReferenceSafeCodingRuntime({
    guardian: {
      issueExecutionTicket: async () => ticket,
      revalidateExecutionTicket: async () => {
        onRevalidate();
      },
      assertFinalAuthority: () => {},
    },
    kernel,
    adapters: registry.runtimeAdapters,
    hash,
    clock: { now: () => '2026-07-14T00:00:10Z' },
    ids: {
      nextAttestationId: () => '00000000-0000-4000-8000-000000000099',
    },
    evidence: {
      record: (attestation) => {
        attestations.push(attestation);
      },
    },
    runner: {
      runnerId: 'runner:reference',
      runnerDigest: HASH_A,
      observerId: 'observer:reference',
    },
  });
  return { runtime, kernel, attestations };
}
