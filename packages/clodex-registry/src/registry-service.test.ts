import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  encodeBase64Url,
  encodeUtf8,
  type EnvelopeSignature,
} from '@clodex/contracts';

import {
  InMemoryRegistryHeadReference,
  RegistryManifestValidationError,
  RegistrySecurityError,
  ScopedRegistryService,
  assembleSignedScopedRegistryManifest,
  createScopedRegistryManifestSigningRequest,
  hashScopedRegistryManifest,
  parseSignedScopedRegistryManifest,
  type AdapterRegistryManifest,
  type AdapterRegistryMember,
  type EffectRegistryManifest,
  type EffectRegistryMember,
  type RegistryManifestExpectation,
  type RunnerRegistryManifest,
  type RunnerRegistryMember,
  type ScopedRegistryManifest,
  type TrustedRegistrySignerSnapshot,
} from './index.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const ISSUER_KEY = 'registry:key:one';

const adapterMember: AdapterRegistryMember = {
  kind: 'adapter',
  adapterId: 'adapter:filesystem',
  adapterDigest: HASH_D,
  operation: 'filesystem.replace',
  argumentSchemaDigest: HASH_E,
  effectId: 'effect:filesystem.replace',
  runnerId: null,
  runnerDigest: null,
};

const runnerMember: RunnerRegistryMember = {
  kind: 'runner',
  runnerId: 'runner:sandbox',
  runnerDigest: HASH_D,
  profileId: 'tests.unit',
  profileDigest: HASH_E,
  imageDigest: HASH_A,
  network: false,
  credentials: false,
  hostWorkspaceReadOnly: true,
  disposableScratch: true,
};

const effectMember: EffectRegistryMember = {
  kind: 'effect',
  effectId: 'effect:filesystem.replace',
  adapterId: 'adapter:filesystem',
  adapterDigest: HASH_D,
  operation: 'filesystem.replace',
  argumentSchemaDigest: HASH_E,
  effectClass: 'local.reversible',
  commitProtocol: 'one-shot-commit-permit',
  idempotency: 'forbidden-retry',
  observerStrength: 'local_state_reconciled',
  reconciliation: 'required-on-uncertain',
  approval: 'canonical-review-required',
  secretHandling: 'forbidden',
};

function manifestFixture(
  registryType: 'adapter',
  overrides?: Partial<AdapterRegistryManifest>,
): AdapterRegistryManifest;
function manifestFixture(
  registryType: 'runner',
  overrides?: Partial<RunnerRegistryManifest>,
): RunnerRegistryManifest;
function manifestFixture(
  registryType: 'effect',
  overrides?: Partial<EffectRegistryManifest>,
): EffectRegistryManifest;
function manifestFixture(
  registryType: 'adapter' | 'effect' | 'runner',
  overrides: Partial<ScopedRegistryManifest> = {},
): ScopedRegistryManifest {
  const common = {
    kind: 'clodex.scoped-registry-manifest' as const,
    specVersion: '1.0.0' as const,
    workspaceId: 'workspace:repo',
    taskId: 'task:one',
    rootObjectId: 'root:workspace',
    policyDigest: HASH_A,
    configurationDigest: HASH_B,
    buildDigest: HASH_C,
    epoch: 1,
    previousManifestHash: null,
    validity: {
      notBefore: '2026-07-14T00:00:00Z',
      expiresAt: '2026-07-15T00:00:00Z',
    },
    issuer: { issuerId: 'registry:security', keyId: ISSUER_KEY },
  };
  if (registryType === 'adapter') {
    return {
      ...common,
      registryType,
      members: [adapterMember],
      ...(overrides as Partial<AdapterRegistryManifest>),
    };
  }
  if (registryType === 'runner') {
    return {
      ...common,
      registryType,
      members: [runnerMember],
      ...(overrides as Partial<RunnerRegistryManifest>),
    };
  }
  return {
    ...common,
    registryType,
    members: [effectMember],
    ...(overrides as Partial<EffectRegistryManifest>),
  };
}

const toyHash = {
  sha256(input: Uint8Array): string {
    let state = 2_166_136_261;
    for (const byte of input) {
      state = Math.imul(state ^ byte, 16_777_619) >>> 0;
    }
    return state.toString(16).padStart(8, '0').repeat(8);
  },
};

function signatureFor(message: Uint8Array, keyId = ISSUER_KEY): string {
  const key = encodeUtf8(keyId);
  const bytes = new Uint8Array(64);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] =
      (message[index % message.length]! ^
        key[index % key.length]! ^
        (index * 17)) &
      0xff;
  }
  bytes[0] = (bytes[0]! & 0x3f) | 1;
  bytes[32] = (bytes[32]! & 0x3f) | 1;
  return encodeBase64Url(bytes);
}

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function envelopeFor(manifest: ScopedRegistryManifest) {
  const request = createScopedRegistryManifestSigningRequest(manifest);
  return assembleSignedScopedRegistryManifest(manifest, {
    keyId: ISSUER_KEY,
    algorithm: 'P-256-SHA256-P1363',
    signature: signatureFor(request.message),
  });
}

async function expectationFor(
  manifest: ScopedRegistryManifest,
): Promise<RegistryManifestExpectation> {
  return {
    registryType: manifest.registryType,
    workspaceId: manifest.workspaceId,
    taskId: manifest.taskId,
    rootObjectId: manifest.rootObjectId,
    policyDigest: manifest.policyDigest,
    configurationDigest: manifest.configurationDigest,
    buildDigest: manifest.buildDigest,
    manifestHash: await hashScopedRegistryManifest(manifest, toyHash),
  };
}

interface HarnessState {
  now: string;
  trusted: boolean;
  signer: TrustedRegistrySignerSnapshot;
  afterVerify?: () => void;
}

function createHarness(head = new InMemoryRegistryHeadReference()) {
  const state: HarnessState = {
    now: '2026-07-14T12:00:00Z',
    trusted: true,
    signer: {
      keyId: ISSUER_KEY,
      issuerId: 'registry:security',
      role: 'registry-authority',
      trustEpoch: 7,
      trustRegistryDigest: HASH_E,
    },
  };
  const service = new ScopedRegistryService({
    hash: toyHash,
    clock: { now: () => state.now },
    head,
    signatures: {
      resolveTrustedSigner: () => clone(state.signer),
      verify: ({ message, signature, trustedSigner }) => {
        expect(Object.isFrozen(trustedSigner)).toBe(true);
        const valid = signature === signatureFor(message, trustedSigner.keyId);
        state.afterVerify?.();
        return valid;
      },
      assertTrusted: (snapshot) => {
        if (
          !state.trusted ||
          canonicalizeJson(snapshot) !== canonicalizeJson(state.signer)
        ) {
          throw new Error('revoked');
        }
      },
    },
  });
  return { service, head, state };
}

describe('signed scoped registry manifests', () => {
  it('admits exact adapter, runner, and effect manifests and resolves only exact members', async () => {
    const { service } = createHarness();
    const adapter = manifestFixture('adapter');
    const runner = manifestFixture('runner');
    const effect = manifestFixture('effect');

    const adapterAdmission = await service.admit({
      envelope: envelopeFor(adapter),
      expected: await expectationFor(adapter),
    });
    const runnerAdmission = await service.admit({
      envelope: envelopeFor(runner),
      expected: await expectationFor(runner),
    });
    const effectAdmission = await service.admit({
      envelope: envelopeFor(effect),
      expected: await expectationFor(effect),
    });

    expect(adapterAdmission.disposition).toBe('installed-genesis');
    expect(adapterAdmission.registry.resolveAdapter(adapterMember)).toEqual(
      adapterMember,
    );
    expect(
      adapterAdmission.registry.resolveAdapter({
        ...adapterMember,
        adapterDigest: HASH_A,
      }),
    ).toBeNull();
    expect(runnerAdmission.registry.resolveRunner(runnerMember)).toEqual(
      runnerMember,
    );
    expect(effectAdmission.registry.resolveEffect(effectMember)).toEqual(
      effectMember,
    );
  });

  it('rejects scope, policy, configuration, build, and committed-digest drift', async () => {
    const { service } = createHarness();
    const manifest = manifestFixture('adapter');
    const expected = await expectationFor(manifest);
    for (const drift of [
      { workspaceId: 'workspace:other' },
      { taskId: 'task:other' },
      { rootObjectId: 'root:other' },
      { policyDigest: HASH_D },
      { configurationDigest: HASH_D },
      { buildDigest: HASH_D },
    ]) {
      await expect(
        service.admit({
          envelope: envelopeFor(manifest),
          expected: { ...expected, ...drift },
        }),
      ).rejects.toMatchObject({ code: 'binding-mismatch' });
    }
    await expect(
      service.admit({
        envelope: envelopeFor(manifest),
        expected: { ...expected, manifestHash: HASH_D },
      }),
    ).rejects.toMatchObject({ code: 'digest-mismatch' });
  });

  it('rejects rollback, same-epoch forks, epoch gaps, and wrong predecessors', async () => {
    const { service } = createHarness();
    const genesis = manifestFixture('adapter');
    const genesisHash = await hashScopedRegistryManifest(genesis, toyHash);
    await service.admit({
      envelope: envelopeFor(genesis),
      expected: await expectationFor(genesis),
    });

    const successor = manifestFixture('adapter', {
      epoch: 2,
      previousManifestHash: genesisHash,
      members: [{ ...adapterMember, adapterDigest: HASH_A }],
    });
    await service.admit({
      envelope: envelopeFor(successor),
      expected: await expectationFor(successor),
    });

    await expect(
      service.admit({
        envelope: envelopeFor(genesis),
        expected: await expectationFor(genesis),
      }),
    ).rejects.toMatchObject({ code: 'rollback-detected' });

    const fork = manifestFixture('adapter', {
      epoch: 2,
      previousManifestHash: genesisHash,
      members: [{ ...adapterMember, adapterDigest: HASH_B }],
    });
    await expect(
      service.admit({
        envelope: envelopeFor(fork),
        expected: await expectationFor(fork),
      }),
    ).rejects.toMatchObject({ code: 'fork-detected' });

    const successorHash = await hashScopedRegistryManifest(successor, toyHash);
    const gap = manifestFixture('adapter', {
      epoch: 4,
      previousManifestHash: successorHash,
    });
    await expect(
      service.admit({
        envelope: envelopeFor(gap),
        expected: await expectationFor(gap),
      }),
    ).rejects.toMatchObject({ code: 'epoch-gap' });

    const wrongParent = manifestFixture('adapter', {
      epoch: 3,
      previousManifestHash: HASH_D,
    });
    await expect(
      service.admit({
        envelope: envelopeFor(wrongParent),
        expected: await expectationFor(wrongParent),
      }),
    ).rejects.toMatchObject({ code: 'fork-detected' });
  });

  it('rejects non-genesis admission without a protected head and CAS races', async () => {
    const { service } = createHarness();
    const detached = manifestFixture('adapter', {
      epoch: 2,
      previousManifestHash: HASH_D,
    });
    await expect(
      service.admit({
        envelope: envelopeFor(detached),
        expected: await expectationFor(detached),
      }),
    ).rejects.toMatchObject({ code: 'head-missing' });

    const conflictService = new ScopedRegistryService({
      hash: toyHash,
      clock: { now: () => '2026-07-14T12:00:00Z' },
      head: {
        readCurrent: () => null,
        compareAndSwap: () => 'CONFLICT',
        assertCurrent: () => undefined,
      },
      signatures: {
        resolveTrustedSigner: () => ({
          keyId: ISSUER_KEY,
          issuerId: 'registry:security',
          role: 'registry-authority',
          trustEpoch: 1,
          trustRegistryDigest: HASH_A,
        }),
        verify: ({ message, signature }) => signature === signatureFor(message),
        assertTrusted: () => undefined,
      },
    });
    const genesis = manifestFixture('adapter');
    await expect(
      conflictService.admit({
        envelope: envelopeFor(genesis),
        expected: await expectationFor(genesis),
      }),
    ).rejects.toMatchObject({ code: 'head-conflict' });
  });

  it('makes an admitted resolver fail closed after head rotation or signer revocation', async () => {
    const { service, state } = createHarness();
    const genesis = manifestFixture('adapter');
    const first = await service.admit({
      envelope: envelopeFor(genesis),
      expected: await expectationFor(genesis),
    });
    const successor = manifestFixture('adapter', {
      epoch: 2,
      previousManifestHash: await hashScopedRegistryManifest(genesis, toyHash),
    });
    await service.admit({
      envelope: envelopeFor(successor),
      expected: await expectationFor(successor),
    });
    expect(() => first.registry.resolveAdapter(adapterMember)).toThrow(
      RegistrySecurityError,
    );

    const second = await service.admit({
      envelope: envelopeFor(successor),
      expected: await expectationFor(successor),
    });
    expect(second.disposition).toBe('already-current');
    state.trusted = false;
    expect(() => second.registry.resolveAdapter(adapterMember)).toThrow(
      RegistrySecurityError,
    );
  });

  it('uses the immutable signer snapshot and detects trust drift after async verification', async () => {
    const { service, state } = createHarness();
    const manifest = manifestFixture('adapter');
    state.afterVerify = () => {
      state.trusted = false;
    };
    await expect(
      service.admit({
        envelope: envelopeFor(manifest),
        expected: await expectationFor(manifest),
      }),
    ).rejects.toMatchObject({ code: 'trust-drift' });
  });

  it('rejects asynchronous final trust and head fences', async () => {
    const manifest = manifestFixture('adapter');
    const head = new InMemoryRegistryHeadReference();
    const asyncTrust = new ScopedRegistryService({
      hash: toyHash,
      clock: { now: () => '2026-07-14T12:00:00Z' },
      head,
      signatures: {
        resolveTrustedSigner: () => ({
          keyId: ISSUER_KEY,
          issuerId: 'registry:security',
          role: 'registry-authority',
          trustEpoch: 1,
          trustRegistryDigest: HASH_A,
        }),
        verify: ({ message, signature }) => signature === signatureFor(message),
        assertTrusted: (() => Promise.resolve()) as unknown as () => void,
      },
    });
    await expect(
      asyncTrust.admit({
        envelope: envelopeFor(manifest),
        expected: await expectationFor(manifest),
      }),
    ).rejects.toMatchObject({ code: 'port-invalid' });

    const asyncHead = new ScopedRegistryService({
      hash: toyHash,
      clock: { now: () => '2026-07-14T12:00:00Z' },
      head: {
        readCurrent: () => null,
        compareAndSwap: (() =>
          Promise.resolve('APPLIED')) as unknown as () => 'APPLIED',
        assertCurrent: () => undefined,
      },
      signatures: {
        resolveTrustedSigner: () => ({
          keyId: ISSUER_KEY,
          issuerId: 'registry:security',
          role: 'registry-authority',
          trustEpoch: 1,
          trustRegistryDigest: HASH_A,
        }),
        verify: ({ message, signature }) => signature === signatureFor(message),
        assertTrusted: () => undefined,
      },
    });
    await expect(
      asyncHead.admit({
        envelope: envelopeFor(manifest),
        expected: await expectationFor(manifest),
      }),
    ).rejects.toMatchObject({ code: 'port-invalid' });
  });

  it('rejects expired/future manifests and stale resolution by trusted time', async () => {
    const { service, state } = createHarness();
    const manifest = manifestFixture('adapter');
    state.now = '2026-07-15T00:00:00Z';
    await expect(
      service.admit({
        envelope: envelopeFor(manifest),
        expected: await expectationFor(manifest),
      }),
    ).rejects.toMatchObject({ code: 'manifest-inactive' });

    state.now = '2026-07-14T12:00:00Z';
    const admission = await service.admit({
      envelope: envelopeFor(manifest),
      expected: await expectationFor(manifest),
    });
    state.now = '2026-07-15T00:00:00Z';
    expect(() => admission.registry.resolveAdapter(adapterMember)).toThrow(
      /validity window/,
    );
  });

  it('rejects noncanonical signature encodings, wrong signature sizes, and issuer-key mismatch', () => {
    const manifest = manifestFixture('adapter');
    const valid = envelopeFor(manifest);
    const padded = {
      ...valid,
      signatures: [
        {
          ...valid.signatures[0]!,
          signature: `${valid.signatures[0]!.signature}=`,
        },
      ],
    };
    expect(() => parseSignedScopedRegistryManifest(padded)).toThrow(
      RegistryManifestValidationError,
    );

    const shortSignature = {
      ...valid,
      signatures: [
        {
          ...valid.signatures[0]!,
          signature: encodeBase64Url(new Uint8Array(63)),
        },
      ],
    };
    expect(() => parseSignedScopedRegistryManifest(shortSignature)).toThrow(
      /64 bytes/,
    );

    const highSBytes = new Uint8Array(64);
    highSBytes[31] = 1;
    highSBytes[32] = 0x80;
    highSBytes[63] = 1;
    const highS = {
      ...valid,
      signatures: [
        {
          ...valid.signatures[0]!,
          signature: encodeBase64Url(highSBytes),
        },
      ],
    };
    expect(() => parseSignedScopedRegistryManifest(highS)).toThrow(/low-S/);

    const request = createScopedRegistryManifestSigningRequest(manifest);
    const wrongKey: EnvelopeSignature = {
      keyId: 'registry:key:other',
      algorithm: 'P-256-SHA256-P1363',
      signature: signatureFor(request.message, 'registry:key:other'),
    };
    expect(() =>
      assembleSignedScopedRegistryManifest(manifest, wrongKey),
    ).toThrow(/issuer key/);
  });

  it('rejects accessors, sparse arrays, extra fields, and unsorted/duplicate members without invoking getters', async () => {
    let reads = 0;
    const accessor = { ...manifestFixture('adapter') } as Record<
      string,
      unknown
    >;
    Object.defineProperty(accessor, 'workspaceId', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 'workspace:repo';
      },
    });
    expect(() => createScopedRegistryManifestSigningRequest(accessor)).toThrow(
      /accessors/,
    );
    expect(reads).toBe(0);

    const members: unknown[] = [];
    members.length = 1;
    expect(() =>
      createScopedRegistryManifestSigningRequest(
        manifestFixture('adapter', {
          members: members as AdapterRegistryMember[],
        }),
      ),
    ).toThrow(
      /closed canonical data: Canonical JSON arrays cannot have extra or hidden fields/,
    );

    expect(() =>
      createScopedRegistryManifestSigningRequest({
        ...manifestFixture('adapter'),
        unexpected: true,
      }),
    ).toThrow(/exactly/);

    const duplicate = manifestFixture('adapter', {
      members: [adapterMember, { ...adapterMember }],
    });
    await expect(
      hashScopedRegistryManifest(duplicate, toyHash),
    ).rejects.toThrow(/sorted and unique/);
  });

  it('rejects unsafe runner authority and contradictory operation classifications', () => {
    expect(() =>
      createScopedRegistryManifestSigningRequest(
        manifestFixture('runner', {
          members: [{ ...runnerMember, network: true as false }],
        }),
      ),
    ).toThrow(/network authority/);

    expect(() =>
      createScopedRegistryManifestSigningRequest(
        manifestFixture('adapter', {
          members: [
            {
              ...adapterMember,
              operation: 'test.run',
              runnerId: null,
              runnerDigest: null,
            },
          ],
        }),
      ),
    ).toThrow(/must bind an exact runner/);

    expect(() =>
      createScopedRegistryManifestSigningRequest(
        manifestFixture('effect', {
          members: [
            {
              ...effectMember,
              effectClass: 'local.observation',
              commitProtocol: 'observation-only',
            },
          ],
        }),
      ),
    ).toThrow(/fixed Safe Coding effect class/);
  });
});
