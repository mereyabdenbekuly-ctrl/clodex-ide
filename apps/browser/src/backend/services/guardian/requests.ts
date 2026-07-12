import type {
  GuardianAssessmentRequest,
  GuardianCapability,
  GuardianOperationClass,
  GuardianResourceScope,
  GuardianTargetTrust,
} from '@shared/guardian';
import type { BrowserUseCapability } from '@shared/agent-os';
import type { RemoteControlCommand } from '@shared/remote-control-protocol';

export interface ShellGuardianRequestInput {
  command: string;
  cwdPrefix: string;
}

export interface NetworkGuardianRequestInput {
  origin: string;
  capability: BrowserUseCapability;
}

export interface McpGuardianRequestInput {
  toolName: string;
  readOnly: boolean;
  destructive: boolean;
  requiresApproval: boolean;
}

const HOST_DESTRUCTIVE_SHELL_PATTERN =
  /(?:^|[;&|]\s*)(?:sudo\s+)?(?:rm\s+-[^\n;|&]*r[^\n;|&]*f|rm\s+-[^\n;|&]*f[^\n;|&]*r)\s+(?:\/|~)(?:\s|$|[;&|])|(?:^|\s)mkfs(?:\.|\s)|dd\s+[^;\n]*\bof=\/dev\//i;
const SHELL_DELETE_PATTERN =
  /(?:^|[;&|]\s*)(?:sudo\s+)?(?:rm|rmdir)\b|git\s+(?:push\b[^\n;]*--delete|branch\s+-D)\b/i;
const SHELL_WRITE_PATTERN =
  /(?:^|[;&|]\s*)(?:cp|mv|mkdir|touch|truncate|tee|install)\b|(?:^|[^<])>{1,2}(?!>)|git\s+(?:add|commit|merge|rebase|reset|checkout|switch|restore)\b/i;
const SHELL_NETWORK_PATTERN =
  /\b(?:curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet)\b|git\s+(?:fetch|pull|push|clone)\b|\b(?:npm|pnpm|yarn|bun|pip|pipx|cargo)\s+(?:install|add|publish|upload)\b/i;
const SHELL_REMOTE_EXECUTION_PATTERN =
  /\b(?:ssh|scp|sftp)\b|git\s+push\b|\b(?:npm|pnpm|yarn|cargo|twine)\s+(?:publish|upload)\b/i;
const SHELL_PRIVILEGED_PATTERN =
  /\b(?:sudo|doas|su|chmod|chown|systemctl|launchctl|defaults\s+write)\b/i;
const SHELL_POLICY_CHANGE_PATTERN = /\b(?:guardian|feature[-_ ]?gate)\b/i;
const SHELL_IRREVERSIBLE_PATTERN =
  /\bgit\s+push\b[^\n;]*(?:--force|-f\b|--delete)\b|\b(?:npm|pnpm|yarn|cargo)\s+publish\b|\btwine\s+upload\b/i;
const SHELL_HOST_RESOURCE_PATTERN = /\s(?:~\/|\/[^\s])/;
const SHELL_CREDENTIAL_READ_PATTERN =
  /\b(?:env|printenv)\b|(?:^|[/\s])(?:\.env|\.ssh|\.aws)(?:[/\s]|$)|\b(?:credentials|id_rsa|id_ed25519|keychain)\b/i;

export function createShellGuardianRequest(
  input: ShellGuardianRequestInput,
): GuardianAssessmentRequest {
  const command = input.command.trim();
  const hostDestructive = HOST_DESTRUCTIVE_SHELL_PATTERN.test(command);
  const capabilities = new Set<GuardianCapability>();
  let resourceScope: GuardianResourceScope = input.cwdPrefix
    ? 'workspace'
    : 'unknown';
  let targetTrust: GuardianTargetTrust = 'local';
  let operation: GuardianOperationClass = 'execute';

  if (hostDestructive) {
    capabilities.add('delete');
    capabilities.add('privileged-access');
    resourceScope = 'host';
    operation = 'admin';
  } else if (isReadOnlyShellCommand(command)) {
    capabilities.add('read');
    operation = 'inspect';
  } else {
    capabilities.add('execute');
    capabilities.add('arbitrary-code');
  }

  if (
    resourceScope === 'workspace' &&
    SHELL_HOST_RESOURCE_PATTERN.test(command)
  ) {
    resourceScope = 'host';
  }
  if (SHELL_CREDENTIAL_READ_PATTERN.test(command)) {
    capabilities.add('credential-access');
  }
  if (SHELL_DELETE_PATTERN.test(command)) capabilities.add('delete');
  if (SHELL_WRITE_PATTERN.test(command)) capabilities.add('write');
  if (SHELL_NETWORK_PATTERN.test(command)) {
    capabilities.add('network');
    targetTrust = 'known-remote';
  }
  if (SHELL_REMOTE_EXECUTION_PATTERN.test(command)) {
    capabilities.add('remote-execution');
    resourceScope = 'remote';
    targetTrust = 'known-remote';
  }
  if (SHELL_PRIVILEGED_PATTERN.test(command)) {
    capabilities.add('privileged-access');
    if (resourceScope !== 'remote') resourceScope = 'host';
    operation = 'admin';
  }
  if (
    SHELL_POLICY_CHANGE_PATTERN.test(command) &&
    (capabilities.has('write') || capabilities.has('privileged-access'))
  ) {
    capabilities.add('policy-change');
  }

  const irreversible =
    hostDestructive ||
    capabilities.has('delete') ||
    SHELL_IRREVERSIBLE_PATTERN.test(command);
  const readOnly =
    capabilities.size === 1 && capabilities.has('read') && !irreversible;

  return {
    kind: 'shell',
    summary: hostDestructive
      ? 'Run destructive host shell operation'
      : readOnly
        ? 'Inspect data with a shell command'
        : 'Run a shell command',
    readOnly,
    irreversible,
    context: {
      resourceScope,
      targetTrust,
      operation,
      capabilities: [...capabilities],
    },
  };
}

export function createNetworkGuardianRequest(
  input: NetworkGuardianRequestInput,
): GuardianAssessmentRequest {
  const localTarget =
    input.origin.startsWith('file:') ||
    input.origin.startsWith('local:') ||
    input.origin.startsWith('about:');
  const capabilities = new Set<GuardianCapability>();
  let operation: GuardianOperationClass = 'inspect';
  let readOnly = input.capability === 'read';
  let irreversible = false;

  capabilities.add('network');
  if (readOnly) capabilities.add('read');

  switch (input.capability) {
    case 'read':
      break;
    case 'history':
      capabilities.add('read');
      capabilities.add('privileged-access');
      readOnly = true;
      break;
    case 'click':
      capabilities.add('write');
      operation = 'modify';
      break;
    case 'fileTransfer':
      capabilities.add('file-transfer');
      capabilities.add('write');
      operation = 'transfer';
      irreversible = true;
      break;
    case 'fullCdpAccess':
      capabilities.add('privileged-access');
      capabilities.add('arbitrary-code');
      operation = 'admin';
      break;
  }

  return {
    kind: 'network',
    summary: `Use browser ${input.capability} capability`,
    readOnly,
    irreversible,
    requiresHumanApproval: input.capability !== 'read',
    context: {
      resourceScope: localTarget ? 'host' : 'remote',
      targetTrust: localTarget ? 'local' : 'known-remote',
      operation,
      capabilities: [...capabilities],
    },
  };
}

export function createRemoteControlGuardianRequest(
  command: RemoteControlCommand,
): GuardianAssessmentRequest {
  switch (command) {
    case 'openThread':
      return {
        kind: 'network',
        summary: 'Open an agent from a paired remote client',
        readOnly: true,
        irreversible: false,
        context: {
          resourceScope: 'agent',
          targetTrust: 'known-remote',
          operation: 'inspect',
          capabilities: ['read', 'network'],
        },
      };
    case 'pushToTalkStop':
      return {
        kind: 'network',
        summary: 'Stop remote push-to-talk capture',
        readOnly: true,
        irreversible: false,
        context: {
          resourceScope: 'agent',
          targetTrust: 'known-remote',
          operation: 'inspect',
          capabilities: ['read', 'network'],
        },
      };
    case 'rejectTool':
      return {
        kind: 'network',
        summary: 'Reject an agent tool from a paired remote client',
        readOnly: false,
        irreversible: false,
        requiresHumanApproval: true,
        context: {
          resourceScope: 'agent',
          targetTrust: 'known-remote',
          operation: 'modify',
          capabilities: ['write', 'network'],
        },
      };
    case 'sendMessage':
      return {
        kind: 'network',
        summary: 'Send an agent message from a paired remote client',
        readOnly: false,
        irreversible: false,
        requiresHumanApproval: true,
        context: {
          resourceScope: 'agent',
          targetTrust: 'known-remote',
          operation: 'modify',
          capabilities: ['write', 'network'],
        },
      };
    case 'newAgent':
      return {
        kind: 'network',
        summary: 'Create an agent from a paired remote client',
        readOnly: false,
        irreversible: false,
        requiresHumanApproval: true,
        context: {
          resourceScope: 'agent',
          targetTrust: 'known-remote',
          operation: 'execute',
          capabilities: ['execute', 'network'],
        },
      };
    case 'stopAgent':
      return {
        kind: 'network',
        summary: 'Stop an agent from a paired remote client',
        readOnly: false,
        irreversible: false,
        requiresHumanApproval: true,
        context: {
          resourceScope: 'agent',
          targetTrust: 'known-remote',
          operation: 'modify',
          capabilities: ['write', 'execute', 'network'],
        },
      };
    case 'pushToTalkStart':
      return {
        kind: 'network',
        summary: 'Start microphone capture from a paired remote client',
        readOnly: false,
        irreversible: false,
        requiresHumanApproval: true,
        context: {
          resourceScope: 'host',
          targetTrust: 'known-remote',
          operation: 'admin',
          capabilities: ['write', 'network', 'privileged-access'],
        },
      };
    case 'approveTool':
      return {
        kind: 'network',
        summary: 'Approve an agent tool from a paired remote client',
        readOnly: false,
        irreversible: true,
        requiresHumanApproval: true,
        context: {
          resourceScope: 'remote',
          targetTrust: 'known-remote',
          operation: 'admin',
          capabilities: ['write', 'network', 'privileged-access'],
        },
      };
  }
}

export function createMcpGuardianRequest(
  input: McpGuardianRequestInput,
): GuardianAssessmentRequest {
  const capabilities = new Set<GuardianCapability>(['network']);
  if (input.readOnly) capabilities.add('read');
  else capabilities.add('remote-execution');
  if (input.destructive) capabilities.add('delete');

  return {
    kind: 'mcp',
    summary: input.readOnly
      ? 'Run a read-only remote MCP tool'
      : 'Run a remote MCP tool',
    readOnly: input.readOnly,
    irreversible: input.destructive || input.requiresApproval,
    context: {
      resourceScope: 'remote',
      targetTrust: 'known-remote',
      operation: input.readOnly ? 'inspect' : 'execute',
      capabilities: [...capabilities],
    },
  };
}

export function createSandboxGuardianRequest(
  script: string,
): GuardianAssessmentRequest {
  const capabilities = new Set<GuardianCapability>(['execute']);
  let resourceScope: GuardianResourceScope = 'agent';
  let operation: GuardianOperationClass = 'execute';

  if (
    /\b(?:fs|fsp)\.(?:write|append|truncate|rename|copyFile|mkdir)|\bAPI\.createAttachment\s*\(/i.test(
      script,
    )
  ) {
    capabilities.add('write');
    resourceScope = 'workspace';
    operation = 'modify';
  }
  if (/\b(?:fs|fsp)\.(?:rm|rmdir|unlink)|\bAPI\.delete/i.test(script)) {
    capabilities.add('delete');
    resourceScope = 'workspace';
    operation = 'modify';
  }
  if (/\bfetch\s*\(|\bAPI\.sendCDP\s*\(/i.test(script)) {
    capabilities.add('network');
  }
  if (/\bAPI\.sendCDP\s*\(|\bAPI\.(?:onCDPEvent|openApp)\s*\(/i.test(script)) {
    capabilities.add('privileged-access');
  }
  if (/\bAPI\.getCredential\s*\(/i.test(script)) {
    capabilities.add('credential-access');
  }
  if (/\b(?:eval|Function)\s*\(|\bprocess\b|\brequire\s*\(/i.test(script)) {
    capabilities.add('arbitrary-code');
  }

  const irreversible = capabilities.has('delete');
  return {
    kind: 'sandbox',
    summary:
      capabilities.size === 1
        ? 'Run bounded sandbox JavaScript'
        : 'Run sandbox JavaScript with external capabilities',
    readOnly: false,
    irreversible,
    context: {
      resourceScope,
      targetTrust: capabilities.has('network') ? 'unknown' : 'local',
      operation,
      capabilities: [...capabilities],
    },
  };
}

function isReadOnlyShellCommand(command: string): boolean {
  if (!command || /(?:^|[^<])>{1,2}(?!>)/.test(command)) return false;
  const segments = command
    .split(/\|\||&&|[;|\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;

  return segments.every((segment) => {
    const normalized = segment
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, '')
      .replace(/^command\s+/, '');
    if (
      /^(?:pwd|ls|cat|head|tail|wc|stat|file|du|df|which|whereis|type|env|printenv|rg|grep)\b/i.test(
        normalized,
      )
    ) {
      return true;
    }
    if (/^find\b/i.test(normalized)) {
      return !/\s-(?:delete|exec|execdir|ok|okdir)\b/i.test(normalized);
    }
    return /^git\s+(?:status|log|diff|show|rev-parse|ls-files|grep|remote\s+-v)\b/i.test(
      normalized,
    );
  });
}
