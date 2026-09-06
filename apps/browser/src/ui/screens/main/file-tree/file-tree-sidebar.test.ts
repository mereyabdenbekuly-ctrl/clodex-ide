// @vitest-environment jsdom

import {
  act,
  createElement,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppState,
  MountedWorkspaceGitDiffSummary,
} from '@shared/karton-contracts/ui';
import { FileTreeSidebar } from './file-tree-sidebar';

const mocks = vi.hoisted(() => ({
  state: {} as AppState,
  getWorkspaceDiffSummary: vi.fn(),
  setActiveWorkspace: vi.fn(),
  setViewMode: vi.fn(),
  openFileTab: vi.fn(),
  setVisible: vi.fn(),
  fileViewMounts: 0,
  previewRenders: [] as Array<{
    workspaceKey: string | null;
    previewTargetPath: string | null;
  }>,
  diffRenders: [] as Array<{
    workspaceKey: string | null;
    data: MountedWorkspaceGitDiffSummary | null;
    loading: boolean;
  }>,
}));

vi.mock('@ui/hooks/use-karton', () => ({
  useKartonState: (selector: (state: AppState) => unknown) =>
    selector(mocks.state),
  useComparingSelector: (selector: unknown) => selector,
  useKartonProcedure: (selector: (procedures: unknown) => unknown) =>
    selector({
      fileTree: {
        setActiveWorkspace: mocks.setActiveWorkspace,
        setViewMode: mocks.setViewMode,
        setVisible: mocks.setVisible,
        openFileTab: mocks.openFileTab,
      },
      toolbox: { getWorkspaceDiffSummary: mocks.getWorkspaceDiffSummary },
    }),
}));

vi.mock('@ui/hooks/use-open-chat', () => ({
  useOpenAgent: () => ['agent-1'],
}));
vi.mock('../command-center', () => ({
  useCommandCenter: () => ({ open: vi.fn() }),
}));
vi.mock('@ui/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}));
vi.mock('@clodex/stage-ui/components/button', () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => createElement('button', { type: 'button', ...props }),
}));
vi.mock('@clodex/stage-ui/components/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));
vi.mock('@clodex/icons', () => ({
  IconFileSearchOutline18: () => null,
  IconFolder5Outline18: () => null,
  IconFolderSearchOutline18: () => null,
}));
vi.mock('@ui/components/hotkey-combo', () => ({ HotkeyCombo: () => null }));
vi.mock('@ui/components/tutorial', () => ({ Tutorial: () => null }));
vi.mock('./file-tree-preview-coordinator', () => ({
  FileTreePreviewCoordinator: ({
    workspaceKey,
    previewTargetPath,
  }: {
    workspaceKey: string | null;
    previewTargetPath: string | null;
  }) => {
    mocks.previewRenders.push({ workspaceKey, previewTargetPath });
    return createElement('div', {
      'data-testid': 'preview',
      'data-workspace': workspaceKey ?? '',
      'data-path': previewTargetPath ?? '',
    });
  },
}));
vi.mock('./file-tree-workspace-view', async () => {
  const { useEffect } = await import('react');
  return {
    FileTreeWorkspaceView: ({
      onPreviewTargetChange,
    }: {
      onPreviewTargetChange: (path: string) => void;
    }) => {
      useEffect(() => {
        mocks.fileViewMounts += 1;
      }, []);
      return createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'preview-file',
          onClick: () => onPreviewTargetChange('src/shared.ts'),
        },
        'Preview shared file',
      );
    },
  };
});
vi.mock('./file-tree-diff-view', () => ({
  FileTreeDiffView: ({
    workspaceKey,
    data,
    loading,
    onOpenFile,
  }: {
    workspaceKey: string | null;
    data: MountedWorkspaceGitDiffSummary | null;
    loading: boolean;
    onOpenFile: (path: string, staged: boolean, oldPath?: string) => void;
  }) => {
    mocks.diffRenders.push({ workspaceKey, data, loading });
    return createElement(
      'div',
      {
        'data-testid': 'diff',
        'data-workspace': workspaceKey ?? '',
        'data-loading': String(loading),
      },
      loading ? 'Loading diff…' : null,
      ...(data?.entries ?? []).map((entry) =>
        createElement(
          'button',
          {
            key: entry.path,
            type: 'button',
            onClick: () => onOpenFile(entry.path, entry.staged, entry.oldPath),
          },
          entry.path,
        ),
      ),
    );
  },
}));

const WORKSPACE_A = 'w1:/workspace/alpha';
const WORKSPACE_B = 'w2:/workspace/beta';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function summary(
  path: string,
  added = 12,
  deleted = 3,
): MountedWorkspaceGitDiffSummary {
  return {
    entries: [{ path, added, deleted, changeType: 'modified', staged: false }],
    totalAdded: added,
    totalDeleted: deleted,
  };
}

describe('FileTreeSidebar workspace isolation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.fileViewMounts = 0;
    mocks.previewRenders = [];
    mocks.diffRenders = [];
    const mounts = [
      { prefix: 'w1', path: '/workspace/alpha' },
      { prefix: 'w2', path: '/workspace/beta' },
    ];
    mocks.state = {
      contentTabs: { activeTabId: null, tabs: {} },
      fileTree: {
        activeWorkspaceKey: WORKSPACE_A,
        viewMode: 'diff',
        workspaceRevisions: {},
      },
      toolbox: { 'agent-1': { workspace: { mounts } } },
      workspaceMounts: mounts,
    } as unknown as AppState;
    mocks.setActiveWorkspace.mockImplementation(async (key: string | null) => {
      mocks.state.fileTree.activeWorkspaceKey = key;
    });
    mocks.setViewMode.mockImplementation(async (mode: 'files' | 'diff') => {
      mocks.state.fileTree.viewMode = mode;
    });
    mocks.getWorkspaceDiffSummary.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => root.render(createElement(FileTreeSidebar)));
  }

  async function selectWorkspace(key: string | null) {
    mocks.state.fileTree.activeWorkspaceKey = key;
    await render();
  }

  function diff() {
    const element = container.querySelector('[data-testid="diff"]');
    expect(element).not.toBeNull();
    return element!;
  }

  it('hides the previous workspace diff rows and totals until the new request resolves', async () => {
    const first = deferred<MountedWorkspaceGitDiffSummary | null>();
    const second = deferred<MountedWorkspaceGitDiffSummary | null>();
    mocks.getWorkspaceDiffSummary
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    await render();
    expect(diff().getAttribute('data-loading')).toBe('true');
    await act(async () => first.resolve(summary('alpha-only.ts')));
    expect(container.textContent).toContain('alpha-only.ts');
    expect(container.textContent).toContain('+12');
    mocks.diffRenders = [];

    await selectWorkspace(WORKSPACE_B);

    expect(mocks.diffRenders[0]).toEqual({
      workspaceKey: WORKSPACE_B,
      data: null,
      loading: true,
    });
    expect(diff().getAttribute('data-workspace')).toBe(WORKSPACE_B);
    expect(diff().getAttribute('data-loading')).toBe('true');
    expect(container.textContent).not.toContain('alpha-only.ts');
    expect(container.textContent).not.toContain('+12');
    expect(container.textContent).not.toContain('-3');
    expect(diff().querySelector('button')).toBeNull();
    expect(mocks.getWorkspaceDiffSummary.mock.calls).toEqual([
      ['/workspace/alpha'],
      ['/workspace/beta'],
    ]);

    await act(async () => second.resolve(summary('beta-only.ts', 8, 1)));
    expect(diff().getAttribute('data-loading')).toBe('false');
    expect(container.textContent).toContain('beta-only.ts');
    expect(container.textContent).toContain('+8');
    await act(async () => {
      (diff().querySelector('button') as HTMLButtonElement).click();
    });
    expect(mocks.openFileTab).toHaveBeenCalledWith(
      WORKSPACE_B,
      'beta-only.ts',
      'agent-1',
      { showDiff: true, diffStaged: false, diffOldPath: undefined },
    );
  });

  it('ignores an earlier workspace response that arrives after the current response', async () => {
    const first = deferred<MountedWorkspaceGitDiffSummary | null>();
    const second = deferred<MountedWorkspaceGitDiffSummary | null>();
    mocks.getWorkspaceDiffSummary
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await render();
    await selectWorkspace(WORKSPACE_B);
    await act(async () => second.resolve(summary('beta-only.ts')));
    await act(async () => first.resolve(null));

    expect(diff().getAttribute('data-workspace')).toBe(WORKSPACE_B);
    expect(container.textContent).toContain('beta-only.ts');
    expect(mocks.setViewMode).not.toHaveBeenCalled();
  });

  it('keeps the same workspace diff visible while a revision refresh is pending', async () => {
    const refresh = deferred<MountedWorkspaceGitDiffSummary | null>();
    mocks.getWorkspaceDiffSummary
      .mockResolvedValueOnce(summary('existing.ts'))
      .mockReturnValueOnce(refresh.promise);
    await render();
    mocks.state.fileTree.workspaceRevisions[WORKSPACE_A] = 1;
    await render();

    expect(diff().getAttribute('data-loading')).toBe('false');
    expect(container.textContent).toContain('existing.ts');
    expect(container.textContent).toContain('+12');

    await act(async () => refresh.resolve(summary('updated.ts', 5, 0)));
    expect(container.textContent).toContain('updated.ts');
    expect(container.textContent).not.toContain('existing.ts');
    expect(container.textContent).toContain('+5');
  });

  it('ignores stale responses after rapidly returning to a previous workspace', async () => {
    const firstA = deferred<MountedWorkspaceGitDiffSummary | null>();
    const firstB = deferred<MountedWorkspaceGitDiffSummary | null>();
    const secondA = deferred<MountedWorkspaceGitDiffSummary | null>();
    mocks.getWorkspaceDiffSummary
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(firstB.promise)
      .mockReturnValueOnce(secondA.promise);
    await render();
    await selectWorkspace(WORKSPACE_B);
    await selectWorkspace(WORKSPACE_A);
    await act(async () => secondA.resolve(summary('latest-alpha.ts', 5, 0)));
    await act(async () => firstA.resolve(summary('stale-alpha.ts')));
    await act(async () => firstB.resolve(null));

    expect(diff().getAttribute('data-workspace')).toBe(WORKSPACE_A);
    expect(container.textContent).toContain('latest-alpha.ts');
    expect(container.textContent).not.toContain('stale-alpha.ts');
    expect(container.textContent).toContain('+5');
    expect(mocks.setViewMode).not.toHaveBeenCalled();
  });

  it('ignores a superseded revision request for the same workspace', async () => {
    const older = deferred<MountedWorkspaceGitDiffSummary | null>();
    const newer = deferred<MountedWorkspaceGitDiffSummary | null>();
    mocks.getWorkspaceDiffSummary
      .mockResolvedValueOnce(summary('initial.ts'))
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    await render();
    mocks.state.fileTree.workspaceRevisions[WORKSPACE_A] = 1;
    await render();
    mocks.state.fileTree.workspaceRevisions[WORKSPACE_A] = 2;
    await render();
    await act(async () => newer.resolve(summary('latest.ts')));
    await act(async () => older.reject(new Error('Superseded request failed')));

    expect(container.textContent).toContain('latest.ts');
    expect(diff().getAttribute('data-loading')).toBe('false');
    expect(mocks.setViewMode).not.toHaveBeenCalled();
  });

  it('clears preview targets on workspace changes without remounting the file view', async () => {
    mocks.state.fileTree.viewMode = 'files';
    mocks.getWorkspaceDiffSummary.mockResolvedValue(summary('src/shared.ts'));
    await render();
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="preview-file"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(
      container
        .querySelector('[data-testid="preview"]')
        ?.getAttribute('data-path'),
    ).toBe('src/shared.ts');
    mocks.previewRenders = [];

    await selectWorkspace(WORKSPACE_B);

    expect(mocks.previewRenders[0]).toEqual({
      workspaceKey: WORKSPACE_B,
      previewTargetPath: null,
    });
    const preview = container.querySelector('[data-testid="preview"]');
    expect(preview?.getAttribute('data-workspace')).toBe(WORKSPACE_B);
    expect(preview?.getAttribute('data-path')).toBe('');
    expect(mocks.fileViewMounts).toBe(1);
  });

  it('uses the mounted fallback when the active workspace key is stale', async () => {
    mocks.state.fileTree.activeWorkspaceKey = 'missing:/old-workspace';
    mocks.getWorkspaceDiffSummary.mockResolvedValue(summary('fallback.ts'));
    await render();

    expect(mocks.setActiveWorkspace).toHaveBeenCalledWith(WORKSPACE_A);
    expect(mocks.getWorkspaceDiffSummary).toHaveBeenCalledWith(
      '/workspace/alpha',
    );
    expect(diff().getAttribute('data-workspace')).toBe(WORKSPACE_A);
    expect(container.textContent).toContain('fallback.ts');
  });

  it('clears the diff and spinner when all workspaces are removed during a request', async () => {
    const request = deferred<MountedWorkspaceGitDiffSummary | null>();
    mocks.getWorkspaceDiffSummary.mockReturnValue(request.promise);
    await render();
    mocks.state.toolbox = {};
    mocks.state.workspaceMounts = [];
    await selectWorkspace(null);

    expect(diff().getAttribute('data-workspace')).toBe('');
    expect(diff().getAttribute('data-loading')).toBe('false');
    expect(container.textContent).not.toContain('Loading diff');
    await act(async () => request.resolve(summary('removed.ts')));
    expect(container.textContent).not.toContain('removed.ts');
    expect(mocks.getWorkspaceDiffSummary).toHaveBeenCalledTimes(1);
  });

  it('clears old rows after a failed request for the new workspace', async () => {
    const second = deferred<MountedWorkspaceGitDiffSummary | null>();
    mocks.getWorkspaceDiffSummary
      .mockResolvedValueOnce(summary('alpha-only.ts'))
      .mockReturnValueOnce(second.promise);
    await render();
    await selectWorkspace(WORKSPACE_B);
    await act(async () => second.reject(new Error('Git unavailable')));

    expect(diff().getAttribute('data-loading')).toBe('false');
    expect(container.textContent).not.toContain('alpha-only.ts');
    expect(container.textContent).not.toContain('+12');
    expect(diff().querySelector('button')).toBeNull();
  });
});
