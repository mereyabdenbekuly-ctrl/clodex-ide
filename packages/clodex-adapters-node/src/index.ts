export {
  OPENAT2_HELPER_PROTOCOL_VERSION,
  OPENAT2_HELPER_STDIO_ROOT_FD,
  LinuxOpenat2FilesystemCapability,
} from './filesystem-capability.js';
export type {
  HeldWorkspaceTreeCommitmentPort,
  LinuxOpenat2FilesystemCapabilityOptions,
  WorkspaceTreeCommitment,
  WorkspaceTreeCommitmentPort,
} from './filesystem-capability.js';

export { DigestPinnedGitCapability } from './git-capability.js';
export type { DigestPinnedGitCapabilityOptions } from './git-capability.js';

export { DigestPinnedTestCapability } from './test-capability.js';
export type {
  DigestPinnedTestCapabilityOptions,
  RegisteredNodeTestPlan,
} from './test-capability.js';

export {
  LINUX_CONFINED_ADAPTER_PROFILE,
  NodeAdapterSecurityError,
} from './node-security.js';
export type {
  NodeAdapterErrorCode,
  NodeAdapterStage,
  PinnedDataFileDescriptor,
  PinnedDirectoryDescriptor,
  PinnedDirectoryLease,
  PinnedExecutableDescriptor,
} from './node-security.js';

/* Descriptor-only configuration is public; the generic Docker/process
 * authority implementation intentionally is not part of the package API. */
export type {
  DigestPinnedDockerEngineOptions,
  DockerResourceLimits,
} from './container-engine.js';
