import { describe, expect, it, vi } from 'vitest';

import { bootstrapProductionAuthority } from './production-bootstrap.js';
import type { ProductionAuthorityBootstrapInput } from './production-model.js';
import {
  EXPIRES_AT,
  NOW,
  attestationFixture,
  deploymentFixture,
  digest,
  protectedHeadFixture,
} from './production-test-fixtures.js';

function poisonInput(expectedDeployment: unknown) {
  const calls = {
    now: vi.fn(() => '2026-07-15T12:00:00Z'),
    sha256: vi.fn(() => digest('a')),
    readDeployment: vi.fn(async () => deploymentFixture()),
    assertDeployment: vi.fn(() => undefined),
    readAttestation: vi.fn(async () => {
      throw new Error('must not reach adapter attestation');
    }),
    promotionVerify: vi.fn(async () => false),
    recovery: vi.fn(async () => {
      throw new Error('must not reach recovery');
    }),
  };
  const input = {
    expectedDeployment,
    deployment: {
      readCurrent: calls.readDeployment,
      assertCurrentSynchronously: calls.assertDeployment,
    },
    clock: { now: calls.now },
    hash: { sha256: calls.sha256 },
    registry: {},
    adapters: { readConfinementAttestation: calls.readAttestation },
    promotion: { trust: { verifyEvidence: calls.promotionVerify } },
    controlPlane: {},
    recovery: { reconcile: calls.recovery },
  } as unknown as ProductionAuthorityBootstrapInput;
  return { input, calls };
}

function expectNoAuthorityCallbacks(
  calls: ReturnType<typeof poisonInput>['calls'],
) {
  expect(calls.now).not.toHaveBeenCalled();
  expect(calls.sha256).not.toHaveBeenCalled();
  expect(calls.readDeployment).not.toHaveBeenCalled();
  expect(calls.assertDeployment).not.toHaveBeenCalled();
  expect(calls.readAttestation).not.toHaveBeenCalled();
  expect(calls.promotionVerify).not.toHaveBeenCalled();
  expect(calls.recovery).not.toHaveBeenCalled();
}

function stagedInput() {
  const deployment = deploymentFixture();
  const calls = {
    readDeployment: vi.fn(async () => deployment),
    assertDeployment: vi.fn(() => undefined),
    readAttestation: vi.fn(async () => attestationFixture(deployment)),
    assertAttestation: vi.fn(() => undefined),
    assertProtectedHead: vi.fn(() => undefined),
    promotionVerify: vi.fn(async () => false),
    recovery: vi.fn(async () => {
      throw new Error('must not reach recovery');
    }),
  };
  const clock = { now: () => NOW };
  const adapters = {
    capabilityScope: {
      workspaceId: deployment.workspaceId,
      taskId: deployment.taskId,
      rootObjectId: deployment.rootObjectId,
    },
    readConfinementAttestation: calls.readAttestation,
    assertConfinementCurrentSynchronously: calls.assertAttestation,
  };
  const head: { protection: unknown } & Record<string, unknown> = {
    protection: protectedHeadFixture(deployment),
    assertProtectionCurrentSynchronously: calls.assertProtectedHead,
  };
  const input = {
    expectedDeployment: deployment,
    deployment: {
      readCurrent: calls.readDeployment,
      assertCurrentSynchronously: calls.assertDeployment,
    },
    clock,
    hash: { sha256: () => digest('a') },
    adapters,
    registry: {
      head,
    },
    promotion: { trust: { verifyEvidence: calls.promotionVerify } },
    controlPlane: {},
    recovery: { reconcile: calls.recovery },
  } as unknown as ProductionAuthorityBootstrapInput;
  return { input, calls, deployment, adapters, clock, head };
}

describe('bootstrapProductionAuthority fail-closed publication', () => {
  it('returns authority null before invoking any port for an invalid deployment', async () => {
    const harness = poisonInput({ ...deploymentFixture(), extra: true });
    const result = await bootstrapProductionAuthority(harness.input);

    expect(result.authority).toBeNull();
    expect(result.diagnostic).toMatchObject({
      status: 'disabled',
      authorityPublished: false,
      authorityGateDefault: 'off',
      automaticPromotion: false,
      blockerCode: 'input-invalid',
      stage: 'input',
      authorityId: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.diagnostic)).toBe(true);
    expectNoAuthorityCallbacks(harness.calls);
  });

  it('does not invoke a hostile top-level accessor or publish callbacks', async () => {
    const harness = poisonInput(deploymentFixture());
    let getterReads = 0;
    Object.defineProperty(harness.input, 'expectedDeployment', {
      enumerable: true,
      get() {
        getterReads += 1;
        return deploymentFixture();
      },
    });

    const result = await bootstrapProductionAuthority(harness.input);
    expect(result.authority).toBeNull();
    expect(result.diagnostic).toMatchObject({
      blockerCode: 'input-invalid',
      authorityPublished: false,
    });
    expect(getterReads).toBe(0);
    expectNoAuthorityCallbacks(harness.calls);
  });

  it('does not cross the deployment boundary after current binding drift', async () => {
    const harness = poisonInput(deploymentFixture());
    harness.calls.readDeployment.mockResolvedValueOnce({
      ...deploymentFixture(),
      buildDigest: digest('0'),
    });

    const result = await bootstrapProductionAuthority(harness.input);
    expect(result.authority).toBeNull();
    expect(result.diagnostic).toMatchObject({
      blockerCode: 'deployment-binding-mismatch',
      stage: 'deployment',
      deploymentId: 'deployment:one',
      authorityPublished: false,
    });
    expect(harness.calls.readDeployment).toHaveBeenCalledOnce();
    expect(harness.calls.assertDeployment).not.toHaveBeenCalled();
    expect(harness.calls.readAttestation).not.toHaveBeenCalled();
    expect(harness.calls.promotionVerify).not.toHaveBeenCalled();
    expect(harness.calls.recovery).not.toHaveBeenCalled();
  });

  it('rejects a Promise-returning synchronous deployment fence before adapters', async () => {
    const harness = poisonInput(deploymentFixture());
    harness.calls.assertDeployment.mockImplementationOnce((() =>
      Promise.resolve()) as unknown as () => undefined);

    const result = await bootstrapProductionAuthority(harness.input);
    expect(result.authority).toBeNull();
    expect(result.diagnostic).toMatchObject({
      blockerCode: 'final-fence-failed',
      stage: 'final-fence',
      authorityPublished: false,
    });
    expect(harness.calls.readDeployment).toHaveBeenCalledOnce();
    expect(harness.calls.assertDeployment).toHaveBeenCalledOnce();
    expect(harness.calls.readAttestation).not.toHaveBeenCalled();
    expect(harness.calls.promotionVerify).not.toHaveBeenCalled();
    expect(harness.calls.recovery).not.toHaveBeenCalled();
  });

  it('blocks capability-scope drift before reading adapter attestation', async () => {
    const harness = stagedInput();
    harness.adapters.capabilityScope = {
      workspaceId: 'workspace:other',
      taskId: harness.deployment.taskId,
      rootObjectId: harness.deployment.rootObjectId,
    };

    const result = await bootstrapProductionAuthority(harness.input);
    expect(result.authority).toBeNull();
    expect(result.diagnostic).toMatchObject({
      blockerCode: 'adapter-binding-mismatch',
      stage: 'adapters',
      authorityPublished: false,
    });
    expect(harness.calls.assertDeployment).toHaveBeenCalledOnce();
    expect(harness.calls.readAttestation).not.toHaveBeenCalled();
    expect(harness.calls.assertAttestation).not.toHaveBeenCalled();
    expect(harness.calls.assertProtectedHead).not.toHaveBeenCalled();
    expect(harness.calls.promotionVerify).not.toHaveBeenCalled();
    expect(harness.calls.recovery).not.toHaveBeenCalled();
  });

  it('blocks a stale adapter attestation before its current fence', async () => {
    const harness = stagedInput();
    harness.calls.readAttestation.mockResolvedValueOnce({
      ...attestationFixture(harness.deployment),
      expiresAt: EXPIRES_AT,
    });
    harness.clock.now = () => EXPIRES_AT;

    const result = await bootstrapProductionAuthority(harness.input);
    expect(result.authority).toBeNull();
    expect(result.diagnostic).toMatchObject({
      blockerCode: 'platform-attestation-stale',
      stage: 'platform',
      authorityPublished: false,
    });
    expect(harness.calls.readAttestation).toHaveBeenCalledOnce();
    expect(harness.calls.assertAttestation).not.toHaveBeenCalled();
    expect(harness.calls.assertProtectedHead).not.toHaveBeenCalled();
    expect(harness.calls.promotionVerify).not.toHaveBeenCalled();
    expect(harness.calls.recovery).not.toHaveBeenCalled();
  });

  it('rejects an asynchronous adapter fence before protected-head admission', async () => {
    const harness = stagedInput();
    harness.calls.assertAttestation.mockImplementationOnce((() =>
      Promise.resolve()) as unknown as () => undefined);

    const result = await bootstrapProductionAuthority(harness.input);
    expect(result.authority).toBeNull();
    expect(result.diagnostic).toMatchObject({
      blockerCode: 'final-fence-failed',
      stage: 'final-fence',
      authorityPublished: false,
    });
    expect(harness.calls.assertAttestation).toHaveBeenCalledOnce();
    expect(harness.calls.assertProtectedHead).not.toHaveBeenCalled();
    expect(harness.calls.promotionVerify).not.toHaveBeenCalled();
    expect(harness.calls.recovery).not.toHaveBeenCalled();
  });

  it('rejects a non-independent registry head before registry admission', async () => {
    const harness = stagedInput();
    harness.head.protection = {
      ...protectedHeadFixture(harness.deployment),
      independentlyProtected: false,
    };

    const result = await bootstrapProductionAuthority(harness.input);
    expect(result.authority).toBeNull();
    expect(result.diagnostic).toMatchObject({
      blockerCode: 'input-invalid',
      stage: 'input',
      authorityPublished: false,
    });
    expect(harness.calls.assertAttestation).toHaveBeenCalledOnce();
    expect(harness.calls.assertProtectedHead).not.toHaveBeenCalled();
    expect(harness.calls.promotionVerify).not.toHaveBeenCalled();
    expect(harness.calls.recovery).not.toHaveBeenCalled();
  });
});
