import { describe, expect, it } from 'vitest';
import {
  evaluateAgenticAppRuntimeReadiness,
  parseAgenticAppRuntimeEvaluationEvidence,
  type AgenticAppRuntimeEvaluationEvidence,
} from './agentic-app-runtime-evaluation';

const readyEvidence: AgenticAppRuntimeEvaluationEvidence = {
  schemaVersion: 1,
  runId: 'b419fb28-36f4-4ccb-a691-7fef2ee08b45',
  generatedAt: '2026-07-11T12:00:00.000Z',
  source: 'deterministic-local-harness',
  scenarios: [
    'session-replay',
    'one-time-commit',
    'cross-principal-isolation',
    'grant-revoke-latency',
    'credential-egress',
    'package-trust',
    'runtime-inspector-content-free',
  ].map((id) => ({
    id: id as AgenticAppRuntimeEvaluationEvidence['scenarios'][number]['id'],
    passed: true,
    durationMs: 1,
    assertionCount: 1,
    failureCode: null,
  })),
  metrics: {
    replay: { attempts: 2, violations: 0 },
    crossPrincipalIsolation: { attempts: 3, violations: 0 },
    secretEgress: { attempts: 5, violations: 0 },
    packageTrust: { attempts: 4, violations: 0 },
    grantRevokeLatency: {
      samples: 25,
      p50Ms: 2,
      p95Ms: 4,
      maxMs: 5,
    },
  },
  qualityGates: {
    reportContentFree: true,
    auditContentFree: true,
    inspectorContentFree: true,
    packageRevocationFailClosed: true,
  },
};

describe('Agentic App Runtime evaluation readiness', () => {
  it('passes complete fresh evidence at zero security violations', () => {
    expect(
      evaluateAgenticAppRuntimeReadiness(readyEvidence, {
        now: new Date('2026-07-11T13:00:00.000Z'),
      }),
    ).toMatchObject({
      ready: true,
      metrics: {
        scenarioFailureRate: 0,
        replayAcceptanceRate: 0,
        crossPrincipalLeakRate: 0,
        secretLeakRate: 0,
        packageTrustBypassRate: 0,
      },
    });
  });

  it('fails closed on any isolation violation or missing scenario', () => {
    const readiness = evaluateAgenticAppRuntimeReadiness(
      {
        ...readyEvidence,
        scenarios: readyEvidence.scenarios.slice(1),
        metrics: {
          ...readyEvidence.metrics,
          crossPrincipalIsolation: { attempts: 3, violations: 1 },
        },
      },
      { now: new Date('2026-07-11T13:00:00.000Z') },
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'all-required-scenarios-present',
          passed: false,
        }),
        expect.objectContaining({
          id: 'maximum-cross-principal-leak-rate',
          passed: false,
        }),
      ]),
    );
  });

  it('strictly rejects unsupported evidence fields', () => {
    expect(() =>
      parseAgenticAppRuntimeEvaluationEvidence({
        ...readyEvidence,
        rawRequestPayloads: ['must never be accepted'],
      }),
    ).toThrow();
  });

  it('rejects future evidence, duplicate scenarios, and inconsistent failure metadata', () => {
    const future = evaluateAgenticAppRuntimeReadiness(readyEvidence, {
      now: new Date('2026-07-10T12:00:00.000Z'),
    });
    expect(future.ready).toBe(false);
    expect(future.checks).toContainEqual(
      expect.objectContaining({
        id: 'evidence-not-from-future',
        passed: false,
      }),
    );

    const duplicate = evaluateAgenticAppRuntimeReadiness(
      {
        ...readyEvidence,
        scenarios: [...readyEvidence.scenarios, readyEvidence.scenarios[0]!],
      },
      { now: new Date('2026-07-11T13:00:00.000Z') },
    );
    expect(duplicate.ready).toBe(false);
    expect(duplicate.checks).toContainEqual(
      expect.objectContaining({ id: 'unique-scenario-ids', passed: false }),
    );

    expect(() =>
      parseAgenticAppRuntimeEvaluationEvidence({
        ...readyEvidence,
        scenarios: readyEvidence.scenarios.map((scenario, index) =>
          index === 0 ? { ...scenario, failureCode: 'impossible' } : scenario,
        ),
      }),
    ).toThrow('Passed scenarios cannot include a failure code');
  });
});
