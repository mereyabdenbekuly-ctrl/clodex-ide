import { z } from 'zod';

export const MCP_PACKAGED_ACCEPTANCE_SCHEMA_VERSION = 1 as const;
export const MCP_PACKAGED_ACCEPTANCE_MARKER = 'MCP_PACKAGED_ACCEPTANCE ';

export const MCP_PACKAGED_ACCEPTANCE_CHECK_IDS = [
  'handshake',
  'tool-discovery',
  'safe-invoke',
  'disconnect',
  'teardown',
] as const;

export type McpPackagedAcceptanceCheckId =
  (typeof MCP_PACKAGED_ACCEPTANCE_CHECK_IDS)[number];

const checkStatusSchema = z.enum(['pass', 'fail', 'not-run']);

const reasonCodeSchema = z.enum([
  'handshake-passed',
  'handshake-failed',
  'tool-discovery-passed',
  'tool-discovery-failed',
  'safe-invoke-passed',
  'safe-invoke-failed',
  'disconnect-passed',
  'disconnect-failed',
  'teardown-passed',
  'teardown-failed',
  'not-run',
]);

export const mcpPackagedAcceptanceCheckSchema = z
  .object({
    id: z.enum(MCP_PACKAGED_ACCEPTANCE_CHECK_IDS),
    status: checkStatusSchema,
    reasonCode: reasonCodeSchema,
  })
  .strict();

export const mcpPackagedAcceptanceReportSchema = z
  .object({
    schemaVersion: z.literal(MCP_PACKAGED_ACCEPTANCE_SCHEMA_VERSION),
    status: z.enum(['passed', 'failed']),
    checks: z
      .array(mcpPackagedAcceptanceCheckSchema)
      .length(MCP_PACKAGED_ACCEPTANCE_CHECK_IDS.length),
    counts: z
      .object({
        servers: z.number().int().min(0).max(1),
        tools: z.number().int().min(0).max(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((report, context) => {
    for (
      let index = 0;
      index < MCP_PACKAGED_ACCEPTANCE_CHECK_IDS.length;
      index += 1
    ) {
      const id = MCP_PACKAGED_ACCEPTANCE_CHECK_IDS[index];
      const check = report.checks[index];
      if (check?.id !== id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['checks', index, 'id'],
          message: 'MCP packaged acceptance checks must use canonical order',
        });
      }
      const expectedReasonCode =
        check?.status === 'not-run' ? 'not-run' : `${id}-${check?.status}ed`;
      if (check?.reasonCode !== expectedReasonCode) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['checks', index, 'reasonCode'],
          message: 'MCP packaged acceptance reason code is inconsistent',
        });
      }
    }
    const allPassed = report.checks.every((check) => check.status === 'pass');
    if ((report.status === 'passed') !== allPassed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'MCP packaged acceptance status must match its checks',
      });
    }
  });

export type McpPackagedAcceptanceCheck = z.infer<
  typeof mcpPackagedAcceptanceCheckSchema
>;
export type McpPackagedAcceptanceReport = z.infer<
  typeof mcpPackagedAcceptanceReportSchema
>;

export function createPendingMcpPackagedAcceptanceChecks(): McpPackagedAcceptanceCheck[] {
  return MCP_PACKAGED_ACCEPTANCE_CHECK_IDS.map((id) => ({
    id,
    status: 'not-run',
    reasonCode: 'not-run',
  }));
}
