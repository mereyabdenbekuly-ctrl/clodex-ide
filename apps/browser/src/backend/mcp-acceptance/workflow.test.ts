import { describe, expect, it, vi } from 'vitest';
import {
  type McpPackagedAcceptanceRuntime,
  runMcpPackagedAcceptanceWorkflow,
} from './workflow';

function makeRuntime(): McpPackagedAcceptanceRuntime & {
  connect: ReturnType<typeof vi.fn>;
  discoverTools: ReturnType<typeof vi.fn>;
  invokeSafeTool: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  teardown: ReturnType<typeof vi.fn>;
} {
  return {
    connect: vi.fn(async () => undefined),
    discoverTools: vi.fn(async () => 1),
    invokeSafeTool: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    teardown: vi.fn(async () => undefined),
  };
}

describe('MCP packaged acceptance workflow', () => {
  it('records handshake, discovery, safe invoke, and clean shutdown', async () => {
    const runtime = makeRuntime();
    const report = await runMcpPackagedAcceptanceWorkflow(async () => runtime);

    expect(report).toMatchObject({
      status: 'passed',
      counts: { servers: 1, tools: 1 },
    });
    expect(report.checks.every((check) => check.status === 'pass')).toBe(true);
    expect(runtime.disconnect).toHaveBeenCalledOnce();
    expect(runtime.teardown).toHaveBeenCalledOnce();
  });

  it('disconnects and tears down after a discovery failure', async () => {
    const runtime = makeRuntime();
    runtime.discoverTools.mockRejectedValueOnce(new Error('private failure'));

    const report = await runMcpPackagedAcceptanceWorkflow(async () => runtime);

    expect(report.status).toBe('failed');
    expect(report.checks).toContainEqual({
      id: 'tool-discovery',
      status: 'fail',
      reasonCode: 'tool-discovery-failed',
    });
    expect(report.checks).toContainEqual({
      id: 'disconnect',
      status: 'pass',
      reasonCode: 'disconnect-passed',
    });
    expect(JSON.stringify(report)).not.toContain('private failure');
    expect(runtime.teardown).toHaveBeenCalledOnce();
  });

  it('fails closed when teardown does not complete', async () => {
    const runtime = makeRuntime();
    runtime.teardown.mockRejectedValueOnce(new Error('teardown details'));

    const report = await runMcpPackagedAcceptanceWorkflow(async () => runtime);

    expect(report.status).toBe('failed');
    expect(report.checks.at(-1)).toEqual({
      id: 'teardown',
      status: 'fail',
      reasonCode: 'teardown-failed',
    });
    expect(JSON.stringify(report)).not.toContain('teardown details');
  });
});
