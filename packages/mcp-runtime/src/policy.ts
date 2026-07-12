import type {
  McpServerConfig,
  McpServerPolicy,
  McpToolPolicyDecision,
} from './config';

export interface McpToolPolicySignals {
  name: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  irreversible?: boolean;
}

export interface McpEffectiveToolPolicy {
  decision: McpToolPolicyDecision;
  reason:
    | 'explicit-deny'
    | 'explicit-ask'
    | 'explicit-allow'
    | 'irreversible'
    | 'default-deny'
    | 'default-ask'
    | 'default-read-only'
    | 'read-only-untrusted';
}

export function createDefaultMcpServerPolicy(
  source: McpServerConfig['source'],
): McpServerPolicy {
  return {
    default: source.kind === 'builtin' ? 'allow-read-only' : 'ask',
    tools: {},
  };
}

export function evaluateMcpToolPolicy(
  server: Pick<McpServerConfig, 'source' | 'policy'>,
  tool: McpToolPolicySignals,
): McpEffectiveToolPolicy {
  const override = server.policy.tools[tool.name];
  const irreversible =
    tool.irreversible === true || tool.destructiveHint === true;

  if (override === 'deny') {
    return { decision: 'deny', reason: 'explicit-deny' };
  }
  if (irreversible) {
    return { decision: 'ask', reason: 'irreversible' };
  }
  if (override === 'ask') {
    return { decision: 'ask', reason: 'explicit-ask' };
  }
  if (override === 'allow') {
    return { decision: 'allow', reason: 'explicit-allow' };
  }

  switch (server.policy.default) {
    case 'deny':
      return { decision: 'deny', reason: 'default-deny' };
    case 'ask':
      return { decision: 'ask', reason: 'default-ask' };
    case 'allow-read-only':
      if (tool.readOnlyHint === true) {
        if (
          server.source.kind === 'user' ||
          server.source.kind === 'imported'
        ) {
          return { decision: 'ask', reason: 'read-only-untrusted' };
        }
        return { decision: 'allow', reason: 'default-read-only' };
      }
      return { decision: 'ask', reason: 'default-ask' };
  }
}
