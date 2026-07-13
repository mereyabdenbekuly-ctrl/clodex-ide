import { describe, expect, it } from 'vitest';
import {
  createPendingMcpPackagedAcceptanceChecks,
  mcpPackagedAcceptanceReportSchema,
  MCP_PACKAGED_ACCEPTANCE_CHECK_IDS,
} from './mcp-packaged-acceptance';

describe('MCP packaged acceptance evidence', () => {
  it('accepts only the canonical content-free passed report', () => {
    const checks = createPendingMcpPackagedAcceptanceChecks().map((check) => ({
      ...check,
      status: 'pass' as const,
      reasonCode: `${check.id}-passed` as
        | 'handshake-passed'
        | 'tool-discovery-passed'
        | 'safe-invoke-passed'
        | 'disconnect-passed'
        | 'teardown-passed',
    }));
    const report = mcpPackagedAcceptanceReportSchema.parse({
      schemaVersion: 1,
      status: 'passed',
      checks,
      counts: { servers: 1, tools: 1 },
    });

    expect(report.checks.map((check) => check.id)).toEqual(
      MCP_PACKAGED_ACCEPTANCE_CHECK_IDS,
    );
    expect(JSON.stringify(report)).not.toMatch(
      /(?:content|credential|prompt|result|workspace|\/private\/)/i,
    );
  });

  it('rejects free-form evidence and inconsistent status', () => {
    const checks = createPendingMcpPackagedAcceptanceChecks();
    checks[0] = {
      id: 'handshake',
      status: 'fail',
      reasonCode: 'handshake-failed',
    };

    expect(() =>
      mcpPackagedAcceptanceReportSchema.parse({
        schemaVersion: 1,
        status: 'passed',
        checks,
        counts: { servers: 1, tools: 0 },
        output: 'raw server output',
      }),
    ).toThrow();
  });
});
