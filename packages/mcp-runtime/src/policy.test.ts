import { describe, expect, it } from 'vitest';
import { createDefaultMcpServerPolicy, evaluateMcpToolPolicy } from './policy';

describe('MCP policy', () => {
  it('defaults custom servers to ask even for read-only annotations', () => {
    const policy = createDefaultMcpServerPolicy({ kind: 'user' });
    expect(
      evaluateMcpToolPolicy(
        { source: { kind: 'user' }, policy },
        { name: 'read_data', readOnlyHint: true },
      ),
    ).toEqual({ decision: 'ask', reason: 'default-ask' });
  });

  it('allows trusted builtin read-only tools by default', () => {
    const source = { kind: 'builtin', builtinId: 'clodex-cloud' } as const;
    const policy = createDefaultMcpServerPolicy(source);
    expect(
      evaluateMcpToolPolicy(
        { source, policy },
        { name: 'tcp_check', readOnlyHint: true },
      ),
    ).toEqual({ decision: 'allow', reason: 'default-read-only' });
  });

  it('never auto-allows destructive tools', () => {
    expect(
      evaluateMcpToolPolicy(
        {
          source: { kind: 'user' },
          policy: {
            default: 'allow-read-only',
            tools: { delete_remote: 'allow' },
          },
        },
        {
          name: 'delete_remote',
          readOnlyHint: true,
          destructiveHint: true,
        },
      ),
    ).toEqual({ decision: 'ask', reason: 'irreversible' });
  });

  it('honors explicit deny before every other signal', () => {
    expect(
      evaluateMcpToolPolicy(
        {
          source: { kind: 'builtin', builtinId: 'clodex-cloud' },
          policy: {
            default: 'allow-read-only',
            tools: { tcp_check: 'deny' },
          },
        },
        { name: 'tcp_check', readOnlyHint: true },
      ),
    ).toEqual({ decision: 'deny', reason: 'explicit-deny' });
  });

  it('does not trust untrusted read-only annotations under a permissive default', () => {
    expect(
      evaluateMcpToolPolicy(
        {
          source: {
            kind: 'imported',
            importer: 'claude-desktop',
            importedAt: 1,
          },
          policy: { default: 'allow-read-only', tools: {} },
        },
        { name: 'pretend_safe', readOnlyHint: true },
      ),
    ).toEqual({ decision: 'ask', reason: 'read-only-untrusted' });
  });
});
