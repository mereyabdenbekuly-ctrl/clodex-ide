import { describe, expect, it } from 'vitest';
import {
  INTENT_CONTRACT_PAYLOAD_TYPE,
  canonicalizeJson,
  encodeBase64Url,
  encodeUtf8,
  type HashPort,
  type RootAuthorizerRole,
  type SafeCodingAction,
  type SafeCodingIntentContract,
} from '@clodex/contracts';
import {
  SafeCodingGuardian,
  SafeCodingGuardianDeniedError,
  budgetChargeFor,
  type ActiveIntentContractSnapshot,
  type PreparedSafeCodingAction,
  type SafeCodingCallerContext,
  type SafeCodingGuardianDependencies,
  type SafeCodingGuardianStatePort,
  type SafeCodingMandatoryPolicyDecision,
  type SafeCodingTicketRegistration,
  type TrustedSafeCodingAdapterBinding,
} from './safe-coding-guardian.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const CONTRACT_ID = '00000000-0000-4000-8000-000000000001';
const TICKET_ID = '00000000-0000-4000-8000-000000000002';

const action: SafeCodingAction = {
  requestId: 'request:one',
  action: 'filesystem.replace',
  selector: { kind: 'file', path: 'src/auth/login.ts' },
  beforeSha256: HASH_B,
  contentSha256: HASH_C,
  contentBytes: 128,
};

const caller: SafeCodingCallerContext = {
  principalId: 'agent:one',
  instanceId: 'runtime:one',
  guardianId: 'guardian:local',
  executorId: 'executor:sandbox',
  runtimeEpoch: 7,
  taskId: 'task:auth',
  workspaceId: 'workspace:auth',
};

const adapterBinding: TrustedSafeCodingAdapterBinding = {
  action: 'filesystem.replace',
  policyDigest: HASH_A,
  adapterId: 'safe-file-adapter',
  adapterDigest: HASH_E,
  adapterRegistryDigest: HASH_B,
  runnerRegistryDigest: HASH_C,
  effectRegistryDigest: HASH_D,
  effectClass: 'local.reversible',
};

const preparedAction: PreparedSafeCodingAction = {
  resolvedObjectId: 'object:login',
  stateCommitmentHash: HASH_B,
};

function createContract(): SafeCodingIntentContract {
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
          action: 'filesystem.read',
          selector: { kind: 'tree', path: 'src/auth' },
        },
        {
          action: 'filesystem.replace',
          selector: { kind: 'file', path: 'src/auth/login.ts' },
        },
      ],
      git: [{ action: 'git.diff' }, { action: 'git.status' }],
      testProfiles: ['tests.auth.unit'],
      allowedEffectClasses: [
        'local.observation',
        'local.reversible',
        'sandbox.ephemeral',
      ],
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

function signedContract(
  contract = createContract(),
  keyId = 'human:key',
): unknown {
  return {
    payloadType: INTENT_CONTRACT_PAYLOAD_TYPE,
    payload: encodeBase64Url(encodeUtf8(canonicalizeJson(contract))),
    signatures: [
      {
        keyId,
        algorithm: 'P-256-SHA256-P1363',
        signature: encodeBase64Url(new Uint8Array(64)),
      },
    ],
  };
}

class RecordingState implements SafeCodingGuardianStatePort {
  public readonly registrations: SafeCodingTicketRegistration[] = [];
  public readonly requestIds = new Set<string>();

  public constructor(
    public active: ActiveIntentContractSnapshot | null = {
      contractId: CONTRACT_ID,
      contractHash: HASH_A,
      revision: 1,
      revocationEpoch: 3,
      status: 'active',
    },
  ) {}

  public getActiveContract(): ActiveIntentContractSnapshot | null {
    return this.active;
  }

  public registerTicket(input: SafeCodingTicketRegistration): void {
    if (this.requestIds.has(input.ticket.requestId)) {
      throw new Error('request replay');
    }
    this.requestIds.add(input.ticket.requestId);
    this.registrations.push(input);
  }
}

interface Harness {
  guardian: SafeCodingGuardian;
  state: RecordingState;
  prepareCalls: { value: number };
  registryCalls: { value: number };
  identity: { current: SafeCodingCallerContext };
  policy: { current: SafeCodingMandatoryPolicyDecision };
  adapter: { current: TrustedSafeCodingAdapterBinding | null };
  prepared: { current: PreparedSafeCodingAction };
  clock: { current: string };
  dependencies: SafeCodingGuardianDependencies;
}

function createHarness(options?: {
  state?: RecordingState;
  hash?: HashPort;
  signerRole?: 'human-authorizer' | 'model';
}): Harness {
  const state = options?.state ?? new RecordingState();
  const prepareCalls = { value: 0 };
  const registryCalls = { value: 0 };
  const identity = { current: { ...caller } };
  const policy = {
    current: { allowed: true } as SafeCodingMandatoryPolicyDecision,
  };
  const adapter = {
    current: { ...adapterBinding } as TrustedSafeCodingAdapterBinding | null,
  };
  const prepared = { current: { ...preparedAction } };
  const clock = { current: '2026-07-14T00:10:00Z' };
  const dependencies: SafeCodingGuardianDependencies = {
    hash: options?.hash ?? { sha256: () => HASH_A },
    signatures: {
      resolveTrustedSigner: (keyId) => ({
        keyId,
        role: options?.signerRole ?? 'human-authorizer',
        trustEpoch: 1,
        registryDigest: HASH_E,
      }),
      verify: () => true,
      assertTrusted: () => {},
    },
    state,
    ids: {
      nextTicketId: () => TICKET_ID,
      nextReservationId: () => 'reservation:one',
      nextNonce: () => encodeBase64Url(new Uint8Array(16)),
    },
    clock: { now: () => clock.current },
    identity: { authenticate: () => identity.current },
    mandatoryPolicy: { evaluate: () => policy.current },
    adapters: {
      resolve: () => {
        registryCalls.value += 1;
        return adapter.current;
      },
    },
    prepare: {
      prepare: () => {
        prepareCalls.value += 1;
        return prepared.current;
      },
    },
    finalAuthority: {
      assertCurrent: ({ ticket, action: finalAction }) => {
        if (
          canonicalizeJson(identity.current) !== canonicalizeJson(caller) ||
          !policy.current.allowed
        ) {
          throw new Error('final authority changed');
        }
        const current = adapter.current;
        if (
          !current ||
          current.action !== finalAction.action ||
          current.adapterId !== ticket.adapterId ||
          current.adapterDigest !== ticket.adapterDigest ||
          current.policyDigest !== ticket.policyDigest ||
          current.adapterRegistryDigest !== ticket.registryDigest ||
          current.runnerRegistryDigest !== ticket.runnerRegistryDigest ||
          current.effectRegistryDigest !== ticket.effectRegistryDigest ||
          current.effectClass !== ticket.effectClass
        ) {
          throw new Error('final registry commitment changed');
        }
      },
    },
  };
  return {
    guardian: new SafeCodingGuardian(dependencies),
    state,
    prepareCalls,
    registryCalls,
    identity,
    policy,
    adapter,
    prepared,
    clock,
    dependencies,
  };
}

async function issue(harness: Harness, actionValue: unknown = action) {
  return await harness.guardian.issueExecutionTicket({
    signedContract: signedContract(),
    action: actionValue,
  });
}

describe('safe-coding Guardian', () => {
  it('verifies, authorizes, prepares, and atomically registers an exact ticket', async () => {
    const harness = createHarness();
    const ticket = await issue(harness);

    expect(ticket).toMatchObject({
      ticketId: TICKET_ID,
      requestId: 'request:one',
      contractHash: HASH_A,
      contractRevision: 1,
      revocationEpoch: 3,
      adapterId: 'safe-file-adapter',
      resolvedObjectId: 'object:login',
      expiresAt: '2026-07-14T00:10:30Z',
    });
    expect(harness.prepareCalls.value).toBe(1);
    expect(harness.registryCalls.value).toBe(2);
    expect(harness.state.registrations).toHaveLength(1);
    expect(harness.state.registrations[0]).toMatchObject({
      expectedActive: { contractHash: HASH_A, revocationEpoch: 3 },
      charge: { uniqueModifiedFiles: 1, mutationBytes: 128, testRuns: 0 },
    });
  });

  it('rejects dependency and role-array accessors without evaluating them', () => {
    const harness = createHarness();
    let outerGetterReads = 0;
    const outerDependencies = { ...harness.dependencies };
    Object.defineProperty(outerDependencies, 'hash', {
      enumerable: true,
      get: () => {
        outerGetterReads += 1;
        return harness.dependencies.hash;
      },
    });
    expect(() => new SafeCodingGuardian(outerDependencies)).toThrow(
      'must be an own data property',
    );
    expect(outerGetterReads).toBe(0);

    let methodGetterReads = 0;
    const signatures = {
      verify: () => true,
      assertTrusted: () => undefined,
    } as Record<string, unknown>;
    Object.defineProperty(signatures, 'resolveTrustedSigner', {
      enumerable: true,
      get: () => {
        methodGetterReads += 1;
        return () => null;
      },
    });
    expect(
      () =>
        new SafeCodingGuardian({
          ...harness.dependencies,
          signatures: signatures as never,
        }),
    ).toThrow('must be a data method');
    expect(methodGetterReads).toBe(0);

    let roleGetterReads = 0;
    const roles: RootAuthorizerRole[] = [];
    Object.defineProperty(roles, '0', {
      enumerable: true,
      get: () => {
        roleGetterReads += 1;
        return 'human-authorizer';
      },
    });
    roles.length = 1;
    expect(
      () =>
        new SafeCodingGuardian({
          ...harness.dependencies,
          acceptedRootRoles: roles,
        }),
    ).toThrow('data elements');
    expect(roleGetterReads).toBe(0);
  });

  it('rejects a model key before identity, registry, or PREPARE', async () => {
    const harness = createHarness({ signerRole: 'model' });
    await expect(issue(harness)).rejects.toThrow(
      'no valid trusted root-authorizer signature',
    );
    expect(harness.registryCalls.value).toBe(0);
    expect(harness.prepareCalls.value).toBe(0);
  });

  it.each([
    {
      name: 'expired',
      configure: (harness: Harness) => {
        harness.clock.current = '2026-07-14T02:00:00Z';
      },
      reason: 'contract-expired',
    },
    {
      name: 'revoked',
      configure: (harness: Harness) => {
        harness.state.active = {
          contractId: CONTRACT_ID,
          contractHash: HASH_A,
          revision: 1,
          revocationEpoch: 4,
          status: 'revoked',
        };
      },
      reason: 'contract-not-active',
    },
    {
      name: 'wrong caller',
      configure: (harness: Harness) => {
        harness.identity.current = { ...caller, runtimeEpoch: 8 };
      },
      reason: 'request-context-mismatch',
    },
    {
      name: 'mandatory deny',
      configure: (harness: Harness) => {
        harness.policy.current = { allowed: false, reason: 'kill switch' };
      },
      reason: 'mandatory-policy-denied',
    },
  ])('denies $name before registry and PREPARE', async ({
    configure,
    reason,
  }) => {
    const harness = createHarness();
    configure(harness);
    await expect(issue(harness)).rejects.toMatchObject({ reason });
    expect(harness.registryCalls.value).toBe(0);
    expect(harness.prepareCalls.value).toBe(0);
    expect(harness.state.registrations).toHaveLength(0);
  });

  it('denies an out-of-scope path before registry and PREPARE', async () => {
    const harness = createHarness();
    await expect(
      issue(harness, {
        ...action,
        selector: { kind: 'file', path: 'src/payments/charge.ts' },
      }),
    ).rejects.toMatchObject({ reason: 'action-not-authorized' });
    expect(harness.registryCalls.value).toBe(0);
    expect(harness.prepareCalls.value).toBe(0);
  });

  it('denies registry mismatch before PREPARE', async () => {
    const harness = createHarness();
    harness.adapter.current = {
      ...adapterBinding,
      adapterRegistryDigest: 'f'.repeat(64),
    };
    await expect(issue(harness)).rejects.toMatchObject({
      reason: 'registry-binding-mismatch',
    });
    expect(harness.registryCalls.value).toBe(1);
    expect(harness.prepareCalls.value).toBe(0);
  });

  it('re-authenticates and reapplies mandatory policy after PREPARE', async () => {
    const harness = createHarness();
    let identityCalls = 0;
    harness.dependencies.identity.authenticate = () => {
      identityCalls += 1;
      if (identityCalls === 2) return { ...caller, runtimeEpoch: 8 };
      return caller;
    };
    harness.dependencies.mandatoryPolicy.evaluate = () => ({ allowed: true });
    const guardian = new SafeCodingGuardian(harness.dependencies);

    await expect(
      guardian.issueExecutionTicket({
        signedContract: signedContract(),
        action,
      }),
    ).rejects.toMatchObject({ reason: 'request-context-mismatch' });
    expect(harness.prepareCalls.value).toBe(1);
    expect(harness.state.registrations).toHaveLength(0);
  });

  it('denies when the mandatory overlay narrows authority during PREPARE', async () => {
    const harness = createHarness();
    let policyCalls = 0;
    harness.dependencies.mandatoryPolicy.evaluate = () => {
      policyCalls += 1;
      return policyCalls === 1
        ? { allowed: true }
        : { allowed: false, reason: 'late kill switch' };
    };
    const guardian = new SafeCodingGuardian(harness.dependencies);

    await expect(
      guardian.issueExecutionTicket({
        signedContract: signedContract(),
        action,
      }),
    ).rejects.toMatchObject({ reason: 'mandatory-policy-denied' });
    expect(harness.prepareCalls.value).toBe(1);
    expect(harness.state.registrations).toHaveLength(0);
  });

  it('rechecks the exact active revision after PREPARE', async () => {
    const harness = createHarness();
    harness.dependencies.prepare.prepare = () => {
      harness.prepareCalls.value += 1;
      harness.state.active = {
        contractId: CONTRACT_ID,
        contractHash: HASH_A,
        revision: 1,
        revocationEpoch: 4,
        status: 'revoked',
      };
      return preparedAction;
    };
    const guardian = new SafeCodingGuardian(harness.dependencies);

    await expect(
      guardian.issueExecutionTicket({
        signedContract: signedContract(),
        action,
      }),
    ).rejects.toMatchObject({ reason: 'contract-not-active' });
    expect(harness.prepareCalls.value).toBe(1);
    expect(harness.state.registrations).toHaveLength(0);
  });

  it('detects adapter mutation across awaited hashing and never uses mutable output', async () => {
    let hashCalls = 0;
    let releaseHash!: () => void;
    const blockedHash = new Promise<void>((resolve) => {
      releaseHash = resolve;
    });
    const harness = createHarness({
      hash: {
        async sha256() {
          hashCalls += 1;
          if (hashCalls === 3) await blockedHash;
          return HASH_A;
        },
      },
    });

    const pending = issue(harness);
    while (hashCalls < 3) await Promise.resolve();
    if (harness.adapter.current) {
      (
        harness.adapter.current as {
          adapterId: string;
        }
      ).adapterId = 'mutated-adapter';
    }
    releaseHash();

    await expect(pending).rejects.toMatchObject({
      reason: 'adapter-binding-mismatch',
    });
    expect(harness.state.registrations).toHaveLength(0);
  });

  it('snapshots PREPARE output before later awaits', async () => {
    let hashCalls = 0;
    let releaseHash!: () => void;
    const blockedHash = new Promise<void>((resolve) => {
      releaseHash = resolve;
    });
    const harness = createHarness({
      hash: {
        async sha256() {
          hashCalls += 1;
          if (hashCalls === 3) await blockedHash;
          return HASH_A;
        },
      },
    });

    const pending = issue(harness);
    while (hashCalls < 3) await Promise.resolve();
    (
      harness.prepared.current as {
        resolvedObjectId: string;
      }
    ).resolvedObjectId = 'object:mutated';
    releaseHash();

    const ticket = await pending;
    expect(ticket.resolvedObjectId).toBe('object:login');
  });

  it('snapshots constructor ports instead of rereading a mutable dependency bag', async () => {
    const harness = createHarness();
    const guardian = harness.guardian;
    harness.dependencies.identity.authenticate = () => ({
      ...caller,
      runtimeEpoch: 99,
    });
    harness.dependencies.adapters.resolve = () => null;
    harness.dependencies.prepare.prepare = () => {
      throw new Error('mutated prepare');
    };

    const ticket = await guardian.issueExecutionTicket({
      signedContract: signedContract(),
      action,
    });
    expect(ticket.requestId).toBe('request:one');
  });

  it('delegates replay and aggregate budgets to the atomic kernel port', async () => {
    const harness = createHarness();
    await issue(harness);
    await expect(issue(harness)).rejects.toThrow('request replay');
    expect(harness.state.registrations).toHaveLength(1);
  });

  it('revalidates live identity, mandatory policy, and adapter binding at final dispatch', async () => {
    const harness = createHarness();
    const ticket = await issue(harness);
    await expect(
      harness.guardian.revalidateExecutionTicket(ticket, action),
    ).resolves.toBeUndefined();
    expect(() =>
      harness.guardian.assertFinalAuthority(ticket, action),
    ).not.toThrow();

    harness.policy.current = { allowed: false, reason: 'runtime kill switch' };
    await expect(
      harness.guardian.revalidateExecutionTicket(ticket, action),
    ).rejects.toMatchObject({ reason: 'mandatory-policy-denied' });
    expect(() => harness.guardian.assertFinalAuthority(ticket, action)).toThrow(
      'final authority changed',
    );

    harness.policy.current = { allowed: true };
    harness.identity.current = { ...caller, runtimeEpoch: 8 };
    await expect(
      harness.guardian.revalidateExecutionTicket(ticket, action),
    ).rejects.toMatchObject({ reason: 'request-context-mismatch' });

    harness.identity.current = { ...caller };
    harness.adapter.current = {
      ...adapterBinding,
      runnerRegistryDigest: HASH_D,
    };
    await expect(
      harness.guardian.revalidateExecutionTicket(ticket, action),
    ).rejects.toMatchObject({ reason: 'adapter-binding-mismatch' });
    expect(() => harness.guardian.assertFinalAuthority(ticket, action)).toThrow(
      'final registry commitment changed',
    );
  });

  it('computes only deterministic first-slice budget charges', () => {
    expect(
      budgetChargeFor({
        requestId: 'request:test',
        action: 'test.run',
        profileId: 'tests.auth.unit',
      }),
    ).toEqual({ uniqueModifiedFiles: 0, mutationBytes: 0, testRuns: 1 });
    expect(
      budgetChargeFor({ requestId: 'request:git', action: 'git.status' }),
    ).toEqual({ uniqueModifiedFiles: 0, mutationBytes: 0, testRuns: 0 });
  });

  it('uses a typed fail-closed denial error', () => {
    const error = new SafeCodingGuardianDeniedError(
      'mandatory-policy-denied',
      'denied',
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SafeCodingGuardianDeniedError');
  });
});
