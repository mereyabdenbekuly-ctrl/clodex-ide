import { describe, expect, it } from 'vitest';
import { runAgenticAppRuntimeEvaluationSuite } from './evaluation-suite';

describe('Agentic App Runtime evaluation suite', () => {
  it('passes every deterministic security and latency gate without content leakage', async () => {
    const { evidence, readiness } = await runAgenticAppRuntimeEvaluationSuite({
      now: () => Date.parse('2026-07-11T12:00:00.000Z'),
    });

    expect(readiness.ready).toBe(true);
    expect(evidence.scenarios).toHaveLength(7);
    expect(evidence.scenarios.every((scenario) => scenario.passed)).toBe(true);
    expect(evidence.metrics).toMatchObject({
      replay: { violations: 0 },
      crossPrincipalIsolation: { violations: 0 },
      secretEgress: { violations: 0 },
      packageTrust: { violations: 0 },
      grantRevokeLatency: { samples: 25 },
    });
    expect(evidence.qualityGates).toEqual({
      reportContentFree: true,
      auditContentFree: true,
      inspectorContentFree: true,
      packageRevocationFailClosed: true,
    });
    expect(JSON.stringify(evidence)).not.toMatch(
      /eval-(?:secret|inspector)-[a-z-]+-canary/,
    );
  });
});
