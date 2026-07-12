export {
  createShellSession,
  executeShellCommand,
  absoluteCwdToMountPrefix,
  CREATE_SHELL_SESSION_DESCRIPTION,
  EXECUTE_SHELL_COMMAND_DESCRIPTION,
} from './execute-shell-command';
export type {
  GuardianApprovalDeps,
  GuardianApprovalResult,
  SmartApprovalDeps,
  SmartApprovalClassifyInput,
  SmartApprovalClassifyResult,
} from './execute-shell-command';
export {
  createShellCapabilityAction,
  type ConsumeShellCapabilityInput,
  type ShellCapabilityAction,
  type ShellCapabilityAuthorization,
  type ShellCapabilityOperation,
  type ShellCapabilitySecurityDeps,
  type StageShellCapabilityInput,
} from './shell-capability';
