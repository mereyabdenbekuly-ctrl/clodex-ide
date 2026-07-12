import { describe, expect, it } from 'vitest';
import {
  evaluateRunnerRoutingPromotion,
  scoreRunnerRoutingPolicy,
  type RunnerRoutingCandidate,
  type RunnerRoutingObservation,
} from '.';

const local = candidate('local-runner', 'local', 'host');
const ssh = candidate('ssh-runner:dev', 'ssh', 'host');
const docker = candidate('docker-runner:image', 'docker', 'none');

describe('scoreRunnerRoutingPolicy', () => {
  it('keeps the actual provider when evidence is insufficient', () => {
    const decision = scoreRunnerRoutingPolicy(
      intent('local-runner', 'local'),
      [local, ssh],
      [observation('ssh-runner:dev', 'ssh', 'completed', false, 1_000)],
    );

    expect(decision.recommendedProviderId).toBe('local-runner');
    expect(decision.reasonCodes).toEqual(['insufficient-evidence']);
    expect(decision.confidence).toBe(0);
  });

  it('excludes unavailable and network-isolated providers', () => {
    const unavailable = { ...ssh, available: false };
    const decision = scoreRunnerRoutingPolicy(
      { ...intent('local-runner', 'local'), requiresNetwork: true },
      [local, unavailable, docker],
      [],
    );

    expect(decision.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: unavailable.providerId,
          reasonCodes: ['candidate-unavailable'],
        }),
        expect.objectContaining({
          providerId: docker.providerId,
          reasonCodes: ['network-capability-required'],
        }),
      ]),
    );
  });

  it('lets hard safety constraints override the conservative actual-provider tie', () => {
    const decision = scoreRunnerRoutingPolicy(
      {
        ...intent('docker-runner:image', 'docker'),
        requiresNetwork: true,
      },
      [local, docker],
      [],
    );

    expect(decision.recommendedProviderId).toBe('local-runner');
    expect(decision.confidence).toBe(0);
    expect(decision.reasonCodes).toEqual([
      'insufficient-evidence',
      'network-capability-required',
    ]);
  });

  it('moves away from a provider with repeated timeouts', () => {
    const observations: RunnerRoutingObservation[] = [
      observation('local-runner', 'local', 'failed', true, 60_000),
      observation('local-runner', 'local', 'failed', true, 60_000),
      observation('local-runner', 'local', 'failed', true, 60_000),
      observation('ssh-runner:dev', 'ssh', 'completed', false, 8_000),
      observation('ssh-runner:dev', 'ssh', 'completed', false, 7_000),
      observation('ssh-runner:dev', 'ssh', 'completed', false, 9_000),
    ];
    const decision = scoreRunnerRoutingPolicy(
      intent('local-runner', 'local'),
      [local, ssh],
      observations,
    );

    expect(decision.recommendedProviderId).toBe('ssh-runner:dev');
    expect(decision.reasonCodes).toContain('observed-success');
    expect(decision.ranked[0]?.score).toBeGreaterThan(
      decision.ranked[1]?.score ?? Number.NEGATIVE_INFINITY,
    );
  });

  it('is deterministic and never includes command content', () => {
    const first = scoreRunnerRoutingPolicy(
      intent('local-runner', 'local'),
      [local, ssh],
      [],
    );
    const second = scoreRunnerRoutingPolicy(
      intent('local-runner', 'local'),
      [local, ssh],
      [],
    );

    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain('pnpm test');
    expect(first.policyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not propose routing session lifecycle operations', () => {
    const decision = scoreRunnerRoutingPolicy(
      {
        ...intent('ssh-runner:dev', 'ssh'),
        operation: 'create-session',
        commandClassHash: null,
      },
      [local, ssh],
      [],
    );

    expect(decision.recommendedProviderId).toBe('ssh-runner:dev');
    expect(decision.reasonCodes).toEqual(['non-command-operation']);
  });

  it('promotes only environment-bound recommendations with strong clean evidence', () => {
    const observations: RunnerRoutingObservation[] = [
      ...Array.from({ length: 6 }, () =>
        observation('local-runner', 'local', 'failed', false, 40_000),
      ),
      ...Array.from({ length: 6 }, () =>
        observation('ssh-runner:dev', 'ssh', 'completed', false, 4_000),
      ),
    ];
    const decision = scoreRunnerRoutingPolicy(
      intent('local-runner', 'local'),
      [local, ssh],
      observations,
    );

    expect(
      evaluateRunnerRoutingPromotion(decision, [local, ssh], observations),
    ).toMatchObject({
      mode: 'automatic',
      selectedProviderId: 'ssh-runner:dev',
      promoted: true,
      providerEvidenceSamples: 6,
      successRate: 1,
      timeoutRate: 0,
      reasonCodes: ['promotion-approved'],
    });
  });

  it('retains the configured provider when the candidate environment is unknown', () => {
    const observations = Array.from({ length: 6 }, () =>
      observation('ssh-runner:dev', 'ssh', 'completed', false, 4_000),
    );
    const unknownEnvironment = {
      ...ssh,
      environmentFingerprintHash: null,
    };
    const decision = {
      ...scoreRunnerRoutingPolicy(
        intent('local-runner', 'local'),
        [local, ssh],
        observations,
      ),
      recommendedProviderId: ssh.providerId,
      recommendedProviderKind: ssh.providerKind,
      confidence: 1,
    };

    expect(
      evaluateRunnerRoutingPromotion(
        decision,
        [local, unknownEnvironment],
        observations,
      ),
    ).toMatchObject({
      mode: 'retain-configured',
      selectedProviderId: 'local-runner',
      promoted: false,
      reasonCodes: ['promotion-environment-unverified'],
    });
  });

  it('retains the configured provider after any observed candidate timeout', () => {
    const clean = Array.from({ length: 5 }, () =>
      observation('ssh-runner:dev', 'ssh', 'completed', false, 4_000),
    );
    const observations = [
      ...Array.from({ length: 6 }, () =>
        observation('local-runner', 'local', 'failed', false, 40_000),
      ),
      ...clean,
      observation('ssh-runner:dev', 'ssh', 'failed', true, 60_000),
    ];
    const decision = {
      ...scoreRunnerRoutingPolicy(
        intent('local-runner', 'local'),
        [local, ssh],
        observations,
      ),
      confidence: 1,
      recommendedProviderId: ssh.providerId,
      recommendedProviderKind: ssh.providerKind,
    };

    expect(
      evaluateRunnerRoutingPromotion(decision, [local, ssh], observations),
    ).toMatchObject({
      mode: 'retain-configured',
      promoted: false,
      reasonCodes: expect.arrayContaining(['promotion-timeout-observed']),
    });
  });
});

function candidate(
  providerId: string,
  providerKind: RunnerRoutingCandidate['providerKind'],
  networkAccess: RunnerRoutingCandidate['capabilities']['networkAccess'],
): RunnerRoutingCandidate {
  return {
    providerId,
    providerKind,
    available: true,
    environmentFingerprintHash: 'a'.repeat(64),
    capabilities: {
      persistentSessions: true,
      streamingOutput: true,
      stdin: true,
      cancellation: true,
      workspaceLeases: true,
      networkAccess,
    },
  };
}

function intent(
  actualProviderId: string,
  actualProviderKind: RunnerRoutingCandidate['providerKind'],
) {
  return {
    operation: 'execute-command' as const,
    commandClassHash: 'b'.repeat(64),
    actualProviderId,
    actualProviderKind,
    requiresNetwork: false,
    requiresInteractive: false,
    requiresCancellation: false,
    requiresWorkspaceLease: true,
  };
}

function observation(
  providerId: string,
  providerKind: RunnerRoutingCandidate['providerKind'],
  outcome: RunnerRoutingObservation['outcome'],
  timedOut: boolean,
  durationMs: number,
): RunnerRoutingObservation {
  return {
    commandClassHash: 'b'.repeat(64),
    providerId,
    providerKind,
    environmentFingerprintHash: 'a'.repeat(64),
    outcome,
    durationMs,
    timedOut,
    exitCodeClass: outcome === 'completed' ? 'zero' : 'non-zero',
  };
}
