import type { ClientRuntimeNode } from '@clodex/agent-runtime-node';
import { readAgentsMd as readAgentsMdCore } from '@clodex/agent-core/mount-manager';

/**
 * `ClientRuntimeNode`-flavored adapter around the canonical
 * `readAgentsMd` implementation that lives in `@clodex/agent-core`.
 * Existing callers still pass a `ClientRuntimeNode`; the shim resolves
 * its working directory and delegates to the core reader (which
 * enforces the 40 KB cap internally).
 */
export async function readAgentsMd(
  clientRuntime: ClientRuntimeNode,
): Promise<string | null> {
  const path = clientRuntime.fileSystem.getCurrentWorkingDirectory();
  return readAgentsMdCore(path);
}
