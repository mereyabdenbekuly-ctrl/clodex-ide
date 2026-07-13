import {
  createPendingMcpPackagedAcceptanceChecks,
  mcpPackagedAcceptanceReportSchema,
  type McpPackagedAcceptanceCheck,
  type McpPackagedAcceptanceCheckId,
  type McpPackagedAcceptanceReport,
} from '@shared/mcp-packaged-acceptance';

export interface McpPackagedAcceptanceRuntime {
  connect(): Promise<void>;
  discoverTools(): Promise<number>;
  invokeSafeTool(): Promise<void>;
  disconnect(): Promise<void>;
  teardown(): Promise<void>;
}

type AcceptancePhase = Exclude<McpPackagedAcceptanceCheckId, 'teardown'>;

export async function runMcpPackagedAcceptanceWorkflow(
  createRuntime: () => Promise<McpPackagedAcceptanceRuntime>,
): Promise<McpPackagedAcceptanceReport> {
  const checks = createPendingMcpPackagedAcceptanceChecks();
  let runtime: McpPackagedAcceptanceRuntime | null = null;
  let activePhase: AcceptancePhase = 'handshake';
  let toolCount = 0;
  let disconnectAttempted = false;

  try {
    runtime = await createRuntime();
    await runtime.connect();
    pass(checks, 'handshake');

    activePhase = 'tool-discovery';
    toolCount = await runtime.discoverTools();
    if (toolCount !== 1) throw new Error('Unexpected MCP tool count');
    pass(checks, 'tool-discovery');

    activePhase = 'safe-invoke';
    await runtime.invokeSafeTool();
    pass(checks, 'safe-invoke');

    activePhase = 'disconnect';
    disconnectAttempted = true;
    await runtime.disconnect();
    pass(checks, 'disconnect');
  } catch {
    fail(checks, activePhase);
  } finally {
    if (runtime && !disconnectAttempted) {
      try {
        await runtime.disconnect();
        pass(checks, 'disconnect');
      } catch {
        fail(checks, 'disconnect');
      }
    }

    if (runtime) {
      try {
        await runtime.teardown();
        pass(checks, 'teardown');
      } catch {
        fail(checks, 'teardown');
      }
    }
  }

  return mcpPackagedAcceptanceReportSchema.parse({
    schemaVersion: 1,
    status: checks.every((check) => check.status === 'pass')
      ? 'passed'
      : 'failed',
    checks,
    counts: {
      servers: runtime ? 1 : 0,
      tools: toolCount === 1 ? 1 : 0,
    },
  });
}

function pass(
  checks: McpPackagedAcceptanceCheck[],
  id: McpPackagedAcceptanceCheckId,
): void {
  update(checks, id, 'pass', `${id}-passed`);
}

function fail(
  checks: McpPackagedAcceptanceCheck[],
  id: McpPackagedAcceptanceCheckId,
): void {
  update(checks, id, 'fail', `${id}-failed`);
}

function update(
  checks: McpPackagedAcceptanceCheck[],
  id: McpPackagedAcceptanceCheckId,
  status: 'pass' | 'fail',
  reasonCode: McpPackagedAcceptanceCheck['reasonCode'],
): void {
  const index = checks.findIndex((check) => check.id === id);
  if (index < 0) throw new Error(`Unknown MCP acceptance check: ${id}`);
  checks[index] = { id, status, reasonCode };
}
