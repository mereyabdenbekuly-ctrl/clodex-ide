import { describe, expect, it, vi } from 'vitest';
import type { AgentStore } from '@clodex/agent-core';
import type { MountManager } from '@clodex/agent-core/mount-manager';

import { createCliToolboxPort } from './cli-toolbox-port.js';

function harness(mounts: readonly { readonly path: string }[] = []) {
  const mountWorkspace = vi.fn(async () => undefined);
  const mountManager = { mountWorkspace } as unknown as MountManager;
  const store = {
    get: () => ({
      toolbox: {
        agent: { workspace: { mounts } },
      },
    }),
  } as unknown as AgentStore;
  return {
    mountWorkspace,
    port: createCliToolboxPort({ mountManager, store }),
  };
}

describe('createCliToolboxPort', () => {
  it('delegates workspace mounting and propagates a mount rejection', async () => {
    const success = harness();
    await expect(
      success.port.handleMountWorkspace('agent', '/workspace', []),
    ).resolves.toBeUndefined();
    expect(success.mountWorkspace).toHaveBeenCalledWith('agent', '/workspace');

    const failure = harness();
    failure.mountWorkspace.mockRejectedValueOnce(new Error('mount denied'));
    await expect(
      failure.port.handleMountWorkspace('agent', '/forbidden', []),
    ).rejects.toThrow('mount denied');
  });

  it('snapshots mounted paths without manufacturing permissions', () => {
    const { port } = harness([{ path: '/a' }, { path: '/b' }]);
    expect(port.getWorkspaceSnapshotForPersistence('agent')).toEqual([
      { path: '/a', permissions: [] },
      { path: '/b', permissions: [] },
    ]);
  });

  it('returns inert edit state instead of leaking unsupported callbacks', async () => {
    const { port } = harness();
    await expect(port.acceptAllPendingEditsForAgent('agent')).resolves.toBe(
      undefined,
    );
    await expect(port.getEditedFilePathsForAgent('agent')).resolves.toEqual([]);
    expect(
      port.cancelQuestion('agent', 'question', 'agent_stopped'),
    ).toBeUndefined();
    expect(port.setWorkspaceMdContent('agent', 'content')).toBeUndefined();
  });
});
