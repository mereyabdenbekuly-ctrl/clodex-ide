import { describe, expect, it } from 'vitest';
import {
  INTENT_CONTRACT_PAYLOAD_TYPE,
  canonicalizeJson,
  encodeBase64Url,
  encodeUtf8,
  verifySignedIntentContract,
  type HashPort,
  type SafeCodingAction,
  type SafeCodingEffectAttestation,
  type SafeCodingIntentContract,
} from '@clodex/contracts';
import {
  SafeCodingGuardian,
  type SafeCodingCallerContext,
  type SafeCodingFinalAuthorityPort,
  type SafeCodingMandatoryPolicyPort,
  type TrustedSafeCodingAdapterBinding,
} from '@clodex/guardian';
import { InMemorySafeCodingKernel } from '@clodex/kernel';
import type { KernelCommitPermit } from '@clodex/kernel';
import {
  ReferenceSafeCodingRuntime,
  SafeCodingRuntimeError,
  type SafeCodingRuntimeAdapter,
  type ReferenceSafeCodingRuntimeDependencies,
} from './reference-runtime.js';
import {
  RecordingSafeCodingAdapter,
  RecordingSafeCodingAdapterRegistry,
  type RecordingSafeCodingAdapterOptions,
} from './testing/recording-adapter.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const CONTRACT_ID = '00000000-0000-4000-8000-000000000001';

const hash: HashPort = { sha256: () => HASH_A };

class MutableClock {
  public constructor(public value = '2026-07-14T00:10:00Z') {}
  public now(): string {
    return this.value;
  }
}

class SequentialIds {
  #ticket = 1;
  #attestation = 1;
  #reservation = 1;
  #nonce = 1;

  public nextTicketId(): string {
    return uuid(this.#ticket++);
  }
  public nextAttestationId(): string {
    return uuid(10_000 + this.#attestation++);
  }
  public nextReservationId(): string {
    return `reservation:${this.#reservation++}`;
  }
  public nextNonce(): string {
    return encodeBase64Url(new Uint8Array(16).fill(this.#nonce++));
  }
}

class RecordingEvidenceSink {
  public readonly records: SafeCodingEffectAttestation[] = [];
  public fail = false;

  public record(attestation: SafeCodingEffectAttestation): void {
    if (this.fail) throw new Error('evidence sink unavailable');
    this.records.push(attestation);
  }
}

function contractFixture(): SafeCodingIntentContract {
  return {
    kind: 'clodex.intent-contract',
    specVersion: '1.0.0',
    contractId: CONTRACT_ID,
    revision: 1,
    previousRevisionHash: null,
    issuedAt: '2026-07-14T00:00:00Z',
    validity: {
      notBefore: '2026-07-14T00:00:00Z',
      expiresAt: '2026-07-14T02:00:00Z',
    },
    subject: { principalId: 'agent:one', instanceId: 'runtime:one' },
    audience: {
      guardianId: 'guardian:local',
      executorId: 'executor:sandbox',
      runtimeEpoch: 7,
      taskId: 'task:auth',
      workspaceId: 'workspace:auth',
    },
    bindings: {
      policyDigest: HASH_A,
      adapterRegistryDigest: HASH_B,
      runnerRegistryDigest: HASH_C,
      effectRegistryDigest: HASH_D,
      approvalRendererVersion: 'renderer:1',
    },
    authority: {
      filesystem: [
        {
          action: 'filesystem.replace',
          selector: { kind: 'file', path: 'src/auth/login.ts' },
        },
      ],
      git: [],
      testProfiles: [],
      allowedEffectClasses: ['local.reversible'],
      limits: {
        maxUniqueModifiedFiles: 12,
        maxMutationBytes: 1_048_576,
        maxTestRuns: 4,
      },
      ambientAuthority: {
        network: false,
        secrets: false,
        shell: false,
        delete: false,
        gitCommit: false,
        gitPush: false,
      },
      delegation: { allowed: false, maxDepth: 0 },
    },
    nonAuthoritative: { goalLabel: 'Fix auth tests', notes: [] },
  };
}

function actionFixture(requestId = 'request:one'): SafeCodingAction {
  return {
    requestId,
    action: 'filesystem.replace',
    selector: { kind: 'file', path: 'src/auth/login.ts' },
    beforeSha256: HASH_B,
    contentSha256: HASH_C,
    contentBytes: 128,
  };
}

function callerFixture(): SafeCodingCallerContext {
  return {
    principalId: 'agent:one',
    instanceId: 'runtime:one',
    guardianId: 'guardian:local',
    executorId: 'executor:sandbox',
    runtimeEpoch: 7,
    taskId: 'task:auth',
    workspaceId: 'workspace:auth',
  };
}

function adapterBinding(): TrustedSafeCodingAdapterBinding {
  return {
    action: 'filesystem.replace',
    policyDigest: HASH_A,
    adapterId: 'safe-file-adapter',
    adapterDigest: HASH_E,
    adapterRegistryDigest: HASH_B,
    runnerRegistryDigest: HASH_C,
    effectRegistryDigest: HASH_D,
    effectClass: 'local.reversible',
  };
}

function signedContract(contract = contractFixture()): unknown {
  const payload = canonicalizeJson(contract);
  return {
    payloadType: INTENT_CONTRACT_PAYLOAD_TYPE,
    payload: encodeBase64Url(encodeUtf8(payload)),
    signatures: [
      {
        keyId: 'human:key',
        algorithm: 'P-256-SHA256-P1363',
        signature: encodeBase64Url(new Uint8Array(64)),
      },
    ],
  };
}

async function createHarness(
  adapterOptions: Partial<RecordingSafeCodingAdapterOptions> = {},
  options: {
    finalAuthority?: SafeCodingFinalAuthorityPort;
    mandatoryPolicy?: SafeCodingMandatoryPolicyPort;
    onCommitPermit?: () => void;
    commitPermitOverride?: (input: {
      ticket: Parameters<InMemorySafeCodingKernel['commitPermit']>[0];
      kernel: InMemorySafeCodingKernel;
    }) => KernelCommitPermit;
    runtimeAdapter?: SafeCodingRuntimeAdapter;
    runtimeHash?: HashPort;
  } = {},
) {
  const contract = contractFixture();
  const signed = signedContract(contract);
  const clock = new MutableClock();
  const ids = new SequentialIds();
  const kernel = new InMemorySafeCodingKernel({ clock });
  const verified = await verifySignedIntentContract(signed, {
    hash,
    signatures: {
      resolveTrustedSigner: (keyId) => ({
        keyId,
        role: 'human-authorizer',
        trustEpoch: 1,
        registryDigest: HASH_E,
      }),
      verify: () => true,
      assertTrusted: () => undefined,
    },
  });
  kernel.activateContract({
    verifiedContract: verified,
    expectedPrevious: null,
  });

  const binding = adapterBinding();
  const adapter = new RecordingSafeCodingAdapter({
    binding,
    result: { ok: true },
    preStateHash: HASH_B,
    postStateHash: HASH_C,
    ...adapterOptions,
  });
  const guardianRegistry = new RecordingSafeCodingAdapterRegistry([adapter]);
  const runtimeRegistry = new RecordingSafeCodingAdapterRegistry([
    options.runtimeAdapter ?? adapter,
  ]);
  const guardian = new SafeCodingGuardian({
    hash,
    signatures: {
      resolveTrustedSigner: (keyId) => ({
        keyId,
        role: 'human-authorizer',
        trustEpoch: 1,
        registryDigest: HASH_E,
      }),
      verify: () => true,
      assertTrusted: () => undefined,
    },
    state: kernel,
    ids,
    clock,
    identity: { authenticate: () => callerFixture() },
    mandatoryPolicy: options.mandatoryPolicy ?? {
      evaluate: () => ({ allowed: true }),
    },
    adapters: { resolve: (action) => guardianRegistry.resolveBinding(action) },
    prepare: {
      prepare: () => ({
        resolvedObjectId: 'object:src/auth/login.ts',
        stateCommitmentHash: HASH_B,
      }),
    },
    finalAuthority: options.finalAuthority ?? {
      assertCurrent: () => undefined,
    },
  });
  const evidence = new RecordingEvidenceSink();
  const runtimeDependencies: ReferenceSafeCodingRuntimeDependencies = {
    guardian,
    kernel: {
      commitPermit: (ticket) => {
        options.onCommitPermit?.();
        if (options.commitPermitOverride) {
          return options.commitPermitOverride({ ticket, kernel });
        }
        return kernel.commitPermit(ticket);
      },
      failBeforeCommit: (ticketId, reason) =>
        kernel.failBeforeCommit(ticketId, reason),
      settleTicket: (input) => kernel.settleTicket(input),
      getTicket: (ticketId) => kernel.getTicket(ticketId),
    },
    adapters: runtimeRegistry,
    hash: options.runtimeHash ?? hash,
    clock,
    ids,
    evidence,
    runner: {
      runnerId: 'runner:recording',
      runnerDigest: HASH_D,
      observerId: 'observer:recording',
    },
  };
  const runtime = new ReferenceSafeCodingRuntime(runtimeDependencies);
  return {
    action: actionFixture(),
    adapter,
    binding,
    clock,
    contract,
    evidence,
    guardian,
    ids,
    kernel,
    runtime,
    runtimeDependencies,
    runtimeRegistry,
    signed,
  };
}

describe('ReferenceSafeCodingRuntime', () => {
  it('runs the actual signed-contract Guardian+Kernel flow exactly once and denies replay', async () => {
    const harness = await createHarness();
    const result = await harness.runtime.execute({
      signedContract: harness.signed,
      action: harness.action,
    });

    expect(result.result).toEqual({ ok: true });
    expect(result.attestation.status).toBe('committed');
    expect(harness.adapter.prepareCount).toBe(1);
    expect(harness.adapter.executeCount).toBe(1);
    expect(harness.adapter.effectCount).toBe(1);
    expect(harness.evidence.records).toHaveLength(1);
    expect(harness.kernel.getTicket(result.ticket.ticketId)?.status).toBe(
      'committed',
    );

    await expect(
      harness.runtime.execute({
        signedContract: harness.signed,
        action: harness.action,
      }),
    ).rejects.toMatchObject({ code: 'request-replay' });
    expect(harness.adapter.effectCount).toBe(1);
  });

  it('revocation during side-effect-free PREPARE prevents execution', async () => {
    let harness: Awaited<ReturnType<typeof createHarness>>;
    harness = await createHarness({
      duringPrepare: () => {
        const active = harness.kernel.getActiveContract(CONTRACT_ID)!;
        harness.kernel.revokeContract({
          contractId: CONTRACT_ID,
          expectedActive: {
            contractHash: active.contractHash,
            revision: active.revision,
            revocationEpoch: active.revocationEpoch,
          },
          reason: 'test revoke before final fence',
        });
      },
    });

    await expect(
      harness.runtime.execute({
        signedContract: harness.signed,
        action: harness.action,
      }),
    ).rejects.toMatchObject({ terminalStatus: 'failed-no-effect' });
    expect(harness.adapter.effectCount).toBe(0);
    expect(harness.evidence.records.at(-1)).toMatchObject({
      status: 'failed_no_effect',
      budgetCharges: {
        uniqueModifiedFiles: 0,
        mutationBytes: 0,
        testRuns: 0,
      },
    });
  });

  it('COMMIT_PERMIT before revocation allows the prepared effect to finish once', async () => {
    let harness: Awaited<ReturnType<typeof createHarness>>;
    harness = await createHarness({
      beforeExecute: () => {
        const active = harness.kernel.getActiveContract(CONTRACT_ID)!;
        harness.kernel.revokeContract({
          contractId: CONTRACT_ID,
          expectedActive: {
            contractHash: active.contractHash,
            revision: active.revision,
            revocationEpoch: active.revocationEpoch,
          },
          reason: 'test revoke after commit permit',
        });
      },
    });

    const result = await harness.runtime.execute({
      signedContract: harness.signed,
      action: harness.action,
    });
    expect(result.attestation.status).toBe('committed');
    expect(harness.adapter.effectCount).toBe(1);
    expect(harness.kernel.getTicket(result.ticket.ticketId)?.status).toBe(
      'committed',
    );
    expect(harness.kernel.getActiveContract(CONTRACT_ID)?.status).toBe(
      'revoked',
    );
  });

  it('revalidates live mandatory policy at the final execution fence', async () => {
    let policyAllowed = true;
    let policyEvaluations = 0;
    const harness = await createHarness(
      {
        duringPrepare: () => {
          policyAllowed = false;
        },
      },
      {
        mandatoryPolicy: {
          evaluate: () => {
            policyEvaluations += 1;
            return {
              allowed: policyAllowed,
              reason: policyAllowed
                ? undefined
                : 'policy revoked during dispatch',
            };
          },
        },
      },
    );

    await expect(
      harness.runtime.execute({
        signedContract: harness.signed,
        action: harness.action,
      }),
    ).rejects.toMatchObject({
      code: 'adapter-failed-before-effect',
      terminalStatus: 'failed-no-effect',
      originalCause: { reason: 'mandatory-policy-denied' },
    });
    expect(policyEvaluations).toBe(3);
    expect(harness.adapter.effectCount).toBe(0);
    expect(harness.evidence.records.at(-1)?.status).toBe('failed_no_effect');
  });

  it('keeps the prepared effect inert through the synchronous fence and commit call', async () => {
    const order: string[] = [];
    let allowed: Awaited<ReturnType<typeof createHarness>>;
    allowed = await createHarness(
      {
        beforeExecute: () => {
          expect(allowed.adapter.effectCount).toBe(0);
          order.push('execute');
        },
      },
      {
        finalAuthority: {
          assertCurrent: () => {
            expect(allowed.adapter.effectCount).toBe(0);
            order.push('final-authority');
          },
        },
        onCommitPermit: () => {
          expect(allowed.adapter.prepareCount).toBe(1);
          expect(allowed.adapter.executeCount).toBe(0);
          expect(allowed.adapter.effectCount).toBe(0);
          order.push('commit-permit');
        },
      },
    );
    await allowed.runtime.execute({
      signedContract: allowed.signed,
      action: allowed.action,
    });
    expect(order).toEqual(['final-authority', 'commit-permit', 'execute']);
    expect(allowed.adapter.executeCount).toBe(1);
    expect(allowed.adapter.effectCount).toBe(1);
  });

  it('denies stale synchronous authority without calling commit or execute', async () => {
    let commitCalls = 0;
    const denied = await createHarness(
      {},
      {
        finalAuthority: {
          assertCurrent: () => {
            throw new Error('synchronous authority snapshot is stale');
          },
        },
        onCommitPermit: () => {
          commitCalls += 1;
        },
      },
    );
    await expect(
      denied.runtime.execute({
        signedContract: denied.signed,
        action: denied.action,
      }),
    ).rejects.toMatchObject({
      code: 'adapter-failed-before-effect',
      terminalStatus: 'failed-no-effect',
      originalCause: expect.objectContaining({
        message: 'synchronous authority snapshot is stale',
      }),
    });
    expect(commitCalls).toBe(0);
    expect(denied.adapter.effectCount).toBe(0);
    expect(denied.evidence.records.at(-1)?.status).toBe('failed_no_effect');
  });

  it('treats a malformed post-consumption permit as uncertain without executing', async () => {
    const malformed = await createHarness(
      {},
      {
        commitPermitOverride: ({ ticket, kernel }) =>
          ({
            ...kernel.commitPermit(ticket),
            permittedAt: 'not-a-timestamp',
            unexpected: true,
          }) as KernelCommitPermit,
      },
    );

    await expect(
      malformed.runtime.execute({
        signedContract: malformed.signed,
        action: malformed.action,
      }),
    ).rejects.toMatchObject({
      code: 'runtime-state-invalid',
      terminalStatus: 'uncertain',
    });
    expect(malformed.adapter.executeCount).toBe(0);
    expect(malformed.adapter.effectCount).toBe(0);
    expect(malformed.evidence.records.at(-1)).toMatchObject({
      status: 'uncertain',
      evidenceLevel: 'attempt_only',
      reconciliationRef: null,
    });
  });

  it('terminalizes adapter PREPARE failure as failed-no-effect', async () => {
    const failed = await createHarness({ mode: 'fail-prepare' });
    await expect(
      failed.runtime.execute({
        signedContract: failed.signed,
        action: failed.action,
      }),
    ).rejects.toMatchObject({
      code: 'adapter-failed-before-effect',
      terminalStatus: 'failed-no-effect',
    });
    expect(failed.adapter.prepareCount).toBe(1);
    expect(failed.adapter.executeCount).toBe(0);
    expect(failed.adapter.effectCount).toBe(0);
    expect(failed.evidence.records.at(-1)?.status).toBe('failed_no_effect');
  });

  it('rejects an accessor-based prepared execute without evaluating it', async () => {
    let executeGetterReads = 0;
    const runtimeAdapter: SafeCodingRuntimeAdapter = {
      binding: adapterBinding(),
      prepare: () => {
        const prepared = {};
        Object.defineProperty(prepared, 'execute', {
          enumerable: true,
          get: () => {
            executeGetterReads += 1;
            return () => ({
              result: { unsafe: true },
              preStateHash: null,
              postStateHash: null,
              evidenceLevel: 'attempt_only' as const,
            });
          },
        });
        return prepared as never;
      },
    };
    const harness = await createHarness({}, { runtimeAdapter });

    await expect(
      harness.runtime.execute({
        signedContract: harness.signed,
        action: harness.action,
      }),
    ).rejects.toMatchObject({
      code: 'adapter-failed-before-effect',
      terminalStatus: 'failed-no-effect',
    });
    expect(executeGetterReads).toBe(0);
    expect(harness.evidence.records.at(-1)?.status).toBe('failed_no_effect');
  });

  it('rejects accessor-based adapter results without evaluating them or retrying', async () => {
    let resultGetterReads = 0;
    let executeCalls = 0;
    const runtimeAdapter: SafeCodingRuntimeAdapter = {
      binding: adapterBinding(),
      prepare: () => ({
        execute: () => {
          executeCalls += 1;
          const result = {
            preStateHash: HASH_B,
            postStateHash: HASH_C,
            evidenceLevel: 'adapter_observed' as const,
          };
          Object.defineProperty(result, 'result', {
            enumerable: true,
            get: () => {
              resultGetterReads += 1;
              return { unsafe: true };
            },
          });
          return result as never;
        },
      }),
    };
    const harness = await createHarness({}, { runtimeAdapter });

    await expect(
      harness.runtime.execute({
        signedContract: harness.signed,
        action: harness.action,
      }),
    ).rejects.toMatchObject({
      code: 'result-unavailable',
      terminalStatus: 'uncertain',
    });
    expect(executeCalls).toBe(1);
    expect(resultGetterReads).toBe(0);
    expect(harness.evidence.records.at(-1)).toMatchObject({
      status: 'uncertain',
      evidenceLevel: 'attempt_only',
    });
  });

  it('never retries a prepared-effect failure after COMMIT_PERMIT', async () => {
    const harness = await createHarness({ mode: 'fail-execute' });
    await expect(
      harness.runtime.execute({
        signedContract: harness.signed,
        action: harness.action,
      }),
    ).rejects.toMatchObject({
      code: 'adapter-failed-after-commit',
      terminalStatus: 'uncertain',
    });
    expect(harness.adapter.prepareCount).toBe(1);
    expect(harness.adapter.executeCount).toBe(1);
    expect(harness.adapter.effectCount).toBe(1);
    expect(harness.evidence.records).toHaveLength(1);
    expect(harness.evidence.records[0]?.status).toBe('uncertain');

    const undefinedFailure = await createHarness({
      mode: 'fail-execute',
      failure: undefined,
    });
    await expect(
      undefinedFailure.runtime.execute({
        signedContract: undefinedFailure.signed,
        action: undefinedFailure.action,
      }),
    ).rejects.toMatchObject({
      code: 'adapter-failed-after-commit',
      terminalStatus: 'uncertain',
    });
    expect(undefinedFailure.adapter.effectCount).toBe(1);
    expect(undefinedFailure.evidence.records[0]?.status).toBe('uncertain');
  });

  it('settles result-unavailable when result canonicalization fails after effect', async () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const harness = await createHarness({ result: cyclic });
    await expect(
      harness.runtime.execute({
        signedContract: harness.signed,
        action: harness.action,
      }),
    ).rejects.toMatchObject({
      code: 'result-unavailable',
      terminalStatus: 'result-unavailable',
    });
    expect(harness.adapter.effectCount).toBe(1);
    expect(harness.evidence.records[0]).toMatchObject({
      status: 'committed_result_unavailable',
      evidenceLevel: 'adapter_observed',
      postStateHash: HASH_C,
      resultHash: null,
      reconciliationRef: null,
    });
  });

  it('settles result-unavailable when attestation admission fails after effect', async () => {
    const harness = await createHarness();
    harness.evidence.fail = true;
    let caught: unknown;
    try {
      await harness.runtime.execute({
        signedContract: harness.signed,
        action: harness.action,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SafeCodingRuntimeError);
    expect(caught).toMatchObject({
      code: 'attestation-sink-unavailable',
      terminalStatus: 'result-unavailable',
    });
    const runtimeError = caught as SafeCodingRuntimeError;
    expect(runtimeError.attestation).toMatchObject({
      status: 'committed_result_unavailable',
      postStateHash: HASH_C,
      resultHash: null,
    });
    expect(harness.adapter.effectCount).toBe(1);
    expect(
      harness.kernel.getTicket(runtimeError.ticket!.ticketId)?.status,
    ).toBe('result-unavailable');
  });

  it('rejects runtime adapter substitution and action-hash drift before effect', async () => {
    const substituted = new RecordingSafeCodingAdapter({
      binding: {
        ...adapterBinding(),
        runnerRegistryDigest: 'f'.repeat(64),
      },
    });
    const bindingMismatch = await createHarness(
      {},
      { runtimeAdapter: substituted },
    );
    await expect(
      bindingMismatch.runtime.execute({
        signedContract: bindingMismatch.signed,
        action: bindingMismatch.action,
      }),
    ).rejects.toMatchObject({
      code: 'adapter-binding-mismatch',
      terminalStatus: 'failed-no-effect',
    });
    expect(substituted.effectCount).toBe(0);

    const actionDrift = await createHarness(
      {},
      {
        runtimeHash: { sha256: () => '9'.repeat(64) },
      },
    );
    await expect(
      actionDrift.runtime.execute({
        signedContract: actionDrift.signed,
        action: actionDrift.action,
      }),
    ).rejects.toMatchObject({
      code: 'action-hash-mismatch',
      terminalStatus: 'failed-no-effect',
    });
    expect(actionDrift.adapter.effectCount).toBe(0);

    const hashFailure = await createHarness(
      {},
      {
        runtimeHash: {
          sha256: () => {
            throw new Error('runtime hash unavailable');
          },
        },
      },
    );
    await expect(
      hashFailure.runtime.execute({
        signedContract: hashFailure.signed,
        action: hashFailure.action,
      }),
    ).rejects.toMatchObject({
      code: 'action-hash-mismatch',
      terminalStatus: 'failed-no-effect',
      originalCause: expect.objectContaining({
        message: 'runtime hash unavailable',
      }),
    });
    expect(hashFailure.adapter.effectCount).toBe(0);
  });

  it('pins constructor port methods against post-construction substitution', async () => {
    const mutableHash: HashPort = { sha256: () => HASH_A };
    const harness = await createHarness({}, { runtimeHash: mutableHash });
    mutableHash.sha256 = () => {
      throw new Error('substituted hash must be unreachable');
    };
    harness.runtimeRegistry.resolve = () => {
      throw new Error('substituted registry must be unreachable');
    };

    await expect(
      harness.runtime.execute({
        signedContract: harness.signed,
        action: harness.action,
      }),
    ).resolves.toMatchObject({ result: { ok: true } });
  });

  it('rejects constructor dependency, method, and runner accessors without evaluating getters', async () => {
    const harness = await createHarness();

    let dependencyReads = 0;
    const dependencyAccessor = {
      ...harness.runtimeDependencies,
    } as Record<string, unknown>;
    delete dependencyAccessor.hash;
    Object.defineProperty(dependencyAccessor, 'hash', {
      enumerable: true,
      get() {
        dependencyReads += 1;
        return hash;
      },
    });
    expect(
      () => new ReferenceSafeCodingRuntime(dependencyAccessor as never),
    ).toThrow(/own data field/);
    expect(dependencyReads).toBe(0);

    let methodReads = 0;
    const guardian = {
      revalidateExecutionTicket: () => undefined,
      assertFinalAuthority: () => undefined,
    } as Record<string, unknown>;
    Object.defineProperty(guardian, 'issueExecutionTicket', {
      enumerable: true,
      get() {
        methodReads += 1;
        return () => Promise.reject(new Error('unreachable'));
      },
    });
    expect(
      () =>
        new ReferenceSafeCodingRuntime({
          ...harness.runtimeDependencies,
          guardian: guardian as never,
        }),
    ).toThrow(/data method/);
    expect(methodReads).toBe(0);

    let runnerReads = 0;
    const runner = {
      runnerDigest: HASH_D,
      observerId: 'observer:recording',
    } as Record<string, unknown>;
    Object.defineProperty(runner, 'runnerId', {
      enumerable: true,
      get() {
        runnerReads += 1;
        return 'runner:recording';
      },
    });
    expect(
      () =>
        new ReferenceSafeCodingRuntime({
          ...harness.runtimeDependencies,
          runner: runner as never,
        }),
    ).toThrow(/closed data-only/);
    expect(runnerReads).toBe(0);
  });

  it('rejects adapter prepare accessors without evaluating them', async () => {
    let prepareReads = 0;
    const adapter = { binding: adapterBinding() } as Record<string, unknown>;
    Object.defineProperty(adapter, 'prepare', {
      enumerable: true,
      get() {
        prepareReads += 1;
        return () => Promise.reject(new Error('unreachable'));
      },
    });
    const harness = await createHarness(
      {},
      { runtimeAdapter: adapter as never },
    );
    await expect(
      harness.runtime.execute({
        signedContract: harness.signed,
        action: harness.action,
      }),
    ).rejects.toMatchObject({
      code: 'adapter-binding-mismatch',
      terminalStatus: 'failed-no-effect',
    });
    expect(prepareReads).toBe(0);
  });
});

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}
