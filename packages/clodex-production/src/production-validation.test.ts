import { describe, expect, it } from 'vitest';
import type { TrustedSafeCodingAdapterBinding } from '@clodex/guardian';

import { ProductionBootstrapError } from './production-model.js';
import {
  assertBindingMatchesMembership,
  hashProductionValue,
  pinMethod,
  readOwnData,
  requireCurrentTimestamp,
  requireDigest,
  requireIdentifier,
  requireSynchronousVoid,
  requireTimestamp,
  validateAdapterBinding,
  validateAdapterBindings,
  validateProductionAdapterAttestation,
  validateProductionDeploymentBinding,
  validateProductionOperationMemberships,
  validateProductionProtectedHeadProfile,
  validateProductionRecoveryAdmission,
  validateProductionRecoveryProfile,
  validateProductionReviewedGateDecision,
  validateRegistryExpectationForDeployment,
} from './production-validation.js';
import {
  EXPIRES_AT,
  ISSUED_AT,
  NOW,
  attestationFixture,
  deploymentFixture,
  digest,
  membershipFixture,
  promotionAssessmentFixture,
  protectedHeadFixture,
  recoveryAdmissionFixture,
  recoveryProfileFixture,
  reviewedDecisionFixture,
} from './production-test-fixtures.js';

function expectBlocker(
  callback: () => unknown,
  code: ProductionBootstrapError['code'],
  stage?: ProductionBootstrapError['stage'],
): void {
  try {
    callback();
    throw new Error('Expected a ProductionBootstrapError');
  } catch (error) {
    expect(error).toBeInstanceOf(ProductionBootstrapError);
    expect(error).toMatchObject({ code, ...(stage ? { stage } : {}) });
  }
}

function bindingFixture(): TrustedSafeCodingAdapterBinding {
  const deployment = deploymentFixture();
  const membership = membershipFixture();
  return {
    action: membership.operation,
    policyDigest: deployment.policyDigest,
    adapterId: membership.adapter.adapterId,
    adapterDigest: membership.adapter.adapterDigest,
    adapterRegistryDigest: deployment.adapterRegistryManifestHash,
    runnerRegistryDigest: deployment.runnerRegistryManifestHash,
    effectRegistryDigest: deployment.effectRegistryManifestHash,
    effectClass: membership.effect.effectClass,
  };
}

describe('production deployment validation', () => {
  it('accepts, snapshots, and deeply freezes one exact closed binding', () => {
    const source = deploymentFixture();
    const result = validateProductionDeploymentBinding(source);
    expect(result).toEqual(source);
    expect(result).not.toBe(source);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    { name: 'unknown field', mutate: (value: any) => (value.extra = true) },
    {
      name: 'uppercase digest',
      mutate: (value: any) => (value.buildDigest = digest('A')),
    },
    {
      name: 'empty identifier',
      mutate: (value: any) => (value.deploymentId = ''),
    },
  ])('rejects $name', ({ mutate }) => {
    const value: any = { ...deploymentFixture() };
    mutate(value);
    expectBlocker(
      () => validateProductionDeploymentBinding(value),
      'input-invalid',
      'input',
    );
  });

  it('rejects accessors, hidden fields, symbols, and foreign prototypes without reading them', () => {
    let getterReads = 0;
    const accessor = { ...deploymentFixture() } as Record<string, unknown>;
    Object.defineProperty(accessor, 'deploymentId', {
      enumerable: true,
      get() {
        getterReads += 1;
        return 'deployment:unsafe';
      },
    });
    expectBlocker(
      () => validateProductionDeploymentBinding(accessor),
      'input-invalid',
    );
    expect(getterReads).toBe(0);

    const hidden = { ...deploymentFixture() };
    Object.defineProperty(hidden, 'hidden', { value: true });
    expectBlocker(
      () => validateProductionDeploymentBinding(hidden),
      'input-invalid',
    );

    const symbol = { ...deploymentFixture(), [Symbol('unsafe')]: true };
    expectBlocker(
      () => validateProductionDeploymentBinding(symbol),
      'input-invalid',
    );

    const inherited = Object.assign(
      Object.create({ inherited: true }),
      deploymentFixture(),
    );
    expectBlocker(
      () => validateProductionDeploymentBinding(inherited),
      'input-invalid',
    );
  });
});

describe('production platform and gate validation', () => {
  it('admits only a fresh exact Linux confinement attestation', () => {
    const deployment = deploymentFixture();
    const admitted = validateProductionAdapterAttestation(
      attestationFixture(deployment),
      deployment,
      NOW,
    );
    expect(admitted.platform).toBe('linux');
    expect(Object.isFrozen(admitted)).toBe(true);

    expectBlocker(
      () =>
        validateProductionAdapterAttestation(
          { ...attestationFixture(deployment), buildDigest: digest('0') },
          deployment,
          NOW,
        ),
      'platform-attestation-invalid',
      'platform',
    );
    expectBlocker(
      () =>
        validateProductionAdapterAttestation(
          attestationFixture(deployment),
          deployment,
          EXPIRES_AT,
        ),
      'platform-attestation-stale',
      'platform',
    );
    expectBlocker(
      () =>
        validateProductionAdapterAttestation(
          attestationFixture(deployment),
          deployment,
          '2026-07-15T10:59:59Z',
        ),
      'platform-attestation-stale',
      'platform',
    );
  });

  it('requires every protected-head property and exact deployment binding', () => {
    const deployment = deploymentFixture();
    expect(
      validateProductionProtectedHeadProfile(
        protectedHeadFixture(deployment),
        deployment,
      ),
    ).toMatchObject({ independentlyProtected: true, antiRollback: true });

    for (const drift of [
      { independentlyProtected: false },
      { multiProcess: false },
      { antiRollback: false },
    ]) {
      expectBlocker(
        () =>
          validateProductionProtectedHeadProfile(
            { ...protectedHeadFixture(deployment), ...drift },
            deployment,
          ),
        'input-invalid',
      );
    }
    expectBlocker(
      () =>
        validateProductionProtectedHeadProfile(
          {
            ...protectedHeadFixture(deployment),
            deploymentId: 'deployment:other',
          },
          deployment,
        ),
      'protected-head-insufficient',
      'protected-head',
    );
  });

  it('binds the reviewed decision to current promotion evidence and expiry', () => {
    const deployment = deploymentFixture();
    const assessment = promotionAssessmentFixture(deployment);
    expect(
      validateProductionReviewedGateDecision(
        reviewedDecisionFixture(deployment, assessment),
        deployment,
        assessment,
        NOW,
      ),
    ).toMatchObject({ enabled: true, decisionId: 'reviewed-decision:one' });

    for (const drift of [
      { enabled: false },
      { evidenceBundleDigest: digest('0') },
      { reviewReceiptDigest: 'not-a-digest' },
    ]) {
      expectBlocker(
        () =>
          validateProductionReviewedGateDecision(
            { ...reviewedDecisionFixture(deployment, assessment), ...drift },
            deployment,
            assessment,
            NOW,
          ),
        drift.enabled === false || drift.reviewReceiptDigest
          ? 'input-invalid'
          : 'reviewed-decision-invalid',
      );
    }
    expectBlocker(
      () =>
        validateProductionReviewedGateDecision(
          reviewedDecisionFixture(deployment, assessment),
          deployment,
          assessment,
          EXPIRES_AT,
        ),
      'reviewed-decision-invalid',
      'reviewed-decision',
    );
  });
});

describe('production recovery validation', () => {
  it('requires a complete exact recovery profile', () => {
    const deployment = deploymentFixture();
    const profile = recoveryProfileFixture(deployment);
    expect(validateProductionRecoveryProfile(profile, deployment)).toEqual(
      profile,
    );

    expectBlocker(
      () =>
        validateProductionRecoveryProfile(
          { ...profile, effectReplayForbidden: false },
          deployment,
        ),
      'input-invalid',
    );
    expectBlocker(
      () =>
        validateProductionRecoveryProfile(
          { ...profile, policyDigest: digest('0') },
          deployment,
        ),
      'recovery-unresolved',
      'recovery',
    );
  });

  it('rejects unresolved, replayed, future, or drifted recovery admission', () => {
    const deployment = deploymentFixture();
    const profile = recoveryProfileFixture(deployment);
    const admission = recoveryAdmissionFixture(deployment, profile);
    const expected = {
      recordSetDigest: admission.recordSetDigest,
      recordCount: admission.recordCount,
      recoveredMutationCount: admission.recoveredMutationCount,
      uncertainRecordCount: admission.uncertainRecordCount,
    };
    expect(
      validateProductionRecoveryAdmission(
        admission,
        deployment,
        profile,
        expected,
        NOW,
      ),
    ).toEqual(admission);

    for (const drift of [
      { unresolvedRecordCount: 1 },
      { effectReplayAttempted: true },
      { recordSetDigest: digest('0') },
      { recordCount: 3 },
      { admittedAt: EXPIRES_AT },
    ]) {
      expectBlocker(
        () =>
          validateProductionRecoveryAdmission(
            { ...admission, ...drift },
            deployment,
            profile,
            expected,
            NOW,
          ),
        drift.unresolvedRecordCount === 1 ||
          drift.effectReplayAttempted === true
          ? 'input-invalid'
          : 'recovery-unresolved',
      );
    }
  });
});

describe('registry membership and adapter binding validation', () => {
  it('accepts one exact signed operation membership and matching binding', () => {
    const deployment = deploymentFixture();
    const membership = membershipFixture();
    const binding = bindingFixture();
    expect(validateProductionOperationMemberships([membership])).toEqual([
      membership,
    ]);
    expect(validateAdapterBinding(binding)).toEqual(binding);
    expect(validateAdapterBindings([binding])).toEqual([binding]);
    expect(() =>
      assertBindingMatchesMembership(binding, membership, deployment),
    ).not.toThrow();
  });

  it('rejects sparse/extended arrays, mismatched effects, and drifted bindings', () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    expectBlocker(
      () => validateProductionOperationMemberships(sparse),
      'input-invalid',
    );

    const extended = [membershipFixture()] as unknown[] & { extra?: boolean };
    extended.extra = true;
    expectBlocker(
      () => validateProductionOperationMemberships(extended),
      'input-invalid',
    );

    const membership = membershipFixture();
    expectBlocker(
      () =>
        validateProductionOperationMemberships([
          {
            ...membership,
            effect: { ...membership.effect, adapterDigest: digest('0') },
          },
        ]),
      'registry-membership-mismatch',
      'registries',
    );

    expectBlocker(
      () =>
        assertBindingMatchesMembership(
          { ...bindingFixture(), adapterDigest: digest('0') },
          membership,
          deploymentFixture(),
        ),
      'adapter-binding-mismatch',
      'adapters',
    );
  });

  it('binds registry expectations to every deployment dimension', () => {
    const deployment = deploymentFixture();
    const expected = {
      registryType: 'adapter' as const,
      workspaceId: deployment.workspaceId,
      taskId: deployment.taskId,
      rootObjectId: deployment.rootObjectId,
      policyDigest: deployment.policyDigest,
      configurationDigest: deployment.configurationDigest,
      buildDigest: deployment.buildDigest,
      manifestHash: deployment.adapterRegistryManifestHash,
    };
    expect(
      validateRegistryExpectationForDeployment(expected, 'adapter', deployment),
    ).toEqual(expected);
    expectBlocker(
      () =>
        validateRegistryExpectationForDeployment(
          { ...expected, workspaceId: 'workspace:other' },
          'adapter',
          deployment,
        ),
      'deployment-binding-mismatch',
      'registries',
    );
  });
});

describe('adversarial primitive validation', () => {
  it.each([
    '2026-07-15T12:00:00+00:00',
    '2026-07-15T12:00:00.00Z',
    '2026-02-30T12:00:00Z',
    '2026-07-15t12:00:00z',
  ])('rejects a non-canonical timestamp: %s', (value) => {
    expectBlocker(() => requireTimestamp(value, 'Timestamp'), 'input-invalid');
  });

  it('accepts canonical timestamps/digests/identifiers and rejects Promise fences', () => {
    expect(requireTimestamp(ISSUED_AT, 'Timestamp')).toBe(ISSUED_AT);
    expect(requireDigest(digest('a'), 'Digest')).toBe(digest('a'));
    expect(requireIdentifier('id:one/path', 'ID')).toBe('id:one/path');
    expect(requireCurrentTimestamp(() => NOW)).toBe(NOW);
    expectBlocker(
      () => requireSynchronousVoid(Promise.resolve(), 'Fence'),
      'final-fence-failed',
      'final-fence',
    );
  });

  it('reads only own data and pins methods without invoking accessors', () => {
    expect(readOwnData({ value: 1 }, 'value', 'Value')).toBe(1);
    expectBlocker(
      () => readOwnData(Object.create({ value: 1 }), 'value', 'Value'),
      'input-invalid',
    );

    let getterReads = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'method', {
      get() {
        getterReads += 1;
        return () => undefined;
      },
    });
    expectBlocker(
      () => pinMethod(accessor, 'method' as never, 'Method'),
      'input-invalid',
    );
    expect(getterReads).toBe(0);

    const owner = { method: () => 'pinned' };
    const pinned = pinMethod(owner, 'method', 'Method');
    owner.method = () => 'replacement';
    expect(pinned()).toBe('pinned');
  });

  it('fails closed when a hash port returns a malformed digest', () => {
    expectBlocker(
      () =>
        hashProductionValue('domain', { safe: true }, { sha256: () => 'bad' }),
      'input-invalid',
    );
  });
});
