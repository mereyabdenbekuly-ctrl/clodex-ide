import { Button } from '@clodex/stage-ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@clodex/stage-ui/components/dialog';
import { Input } from '@clodex/stage-ui/components/input';
import { toast } from '@clodex/stage-ui/components/toaster';
import type { ChatProject } from '@shared/karton-contracts/ui/agent';
import type {
  CreateSpaceInput,
  SpaceDefinition,
  SpacesSnapshot,
} from '@shared/spaces';
import { useKartonProcedure } from '@ui/hooks/use-karton';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BookOpenIcon,
  ExternalLinkIcon,
  FolderIcon,
  Layers3Icon,
  LinkIcon,
  Loader2Icon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSidebarCollapsed } from '../main/_components/sidebar-collapsed-context';
import { SidebarTitlebarRow } from '../main/_components/sidebar-titlebar-row';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSectionHeader,
  SettingsSummaryCard,
} from '../settings/_components/settings-page';

interface SpaceFormState {
  name: string;
  description: string;
  workspacePaths: string;
  links: string;
  instructions: string;
}

function emptyForm(): SpaceFormState {
  return {
    name: '',
    description: '',
    workspacePaths: '',
    links: '',
    instructions: '',
  };
}

function formFromSpace(space: SpaceDefinition): SpaceFormState {
  return {
    name: space.name,
    description: space.description,
    workspacePaths: space.workspacePaths.join('\n'),
    links: space.links.map((link) => `${link.title} | ${link.url}`).join('\n'),
    instructions: space.instructions,
  };
}

function inputFromForm(form: SpaceFormState): CreateSpaceInput {
  const links = form.links
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('|');
      const title =
        separator === -1 ? line : line.slice(0, separator).trim() || line;
      const url = (separator === -1 ? line : line.slice(separator + 1)).trim();
      try {
        new URL(url);
      } catch {
        throw new Error(`Invalid link URL: ${url}`);
      }
      return { id: crypto.randomUUID(), title, url };
    });

  const name = form.name.trim();
  if (!name) throw new Error('Space name is required.');
  return {
    name,
    description: form.description.trim(),
    workspacePaths: Array.from(
      new Set(
        form.workspacePaths
          .split('\n')
          .map((path) => path.trim())
          .filter(Boolean),
      ),
    ),
    links,
    instructions: form.instructions,
    archived: false,
  };
}

function notify(
  title: string,
  message: string,
  type: 'info' | 'error' = 'info',
) {
  toast({
    id: `spaces-${Date.now()}`,
    title,
    message,
    type,
    duration: 4_000,
    actions: [],
  });
}

function SpaceEditor({
  open,
  space,
  busy,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  space: SpaceDefinition | null;
  busy: boolean;
  onOpenChange: (value: boolean) => void;
  onSave: (input: CreateSpaceInput) => Promise<void>;
}) {
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(space ? formFromSpace(space) : emptyForm());
    setError(null);
  }, [open, space]);

  const save = async () => {
    try {
      setError(null);
      await onSave(inputFromForm(form));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Space was not saved.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] w-[min(720px,calc(100vw-2rem))] overflow-y-auto sm:min-w-0">
        <DialogClose />
        <DialogHeader>
          <DialogTitle>{space ? 'Edit space' : 'Create space'}</DialogTitle>
          <DialogDescription>
            Combine workspaces, links, instructions, and related tasks in one
            persistent context.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <span className="font-medium text-sm text-token-text-primary">
              Name
            </span>
            <Input
              value={form.name}
              onValueChange={(name) => setForm((value) => ({ ...value, name }))}
              placeholder="Product launch"
            />
          </div>
          <div className="grid gap-1.5">
            <span className="font-medium text-sm text-token-text-primary">
              Description
            </span>
            <Input
              value={form.description}
              onValueChange={(description) =>
                setForm((value) => ({ ...value, description }))
              }
              placeholder="Shared context for the launch workstream"
            />
          </div>
          <div className="grid gap-1.5">
            <span className="font-medium text-sm text-token-text-primary">
              Workspace paths, one per line
            </span>
            <textarea
              aria-label="Workspace paths"
              value={form.workspacePaths}
              onChange={(event) =>
                setForm((value) => ({
                  ...value,
                  workspacePaths: event.currentTarget.value,
                }))
              }
              className="min-h-20 resize-y rounded-xl border border-token-border-light bg-token-main-surface-primary p-3 font-mono text-token-text-primary text-xs outline-none focus:ring-1 focus:ring-token-focus-border"
            />
          </div>
          <div className="grid gap-1.5">
            <span className="font-medium text-sm text-token-text-primary">
              Links, one “Title | URL” per line
            </span>
            <textarea
              aria-label="Space links"
              value={form.links}
              onChange={(event) =>
                setForm((value) => ({
                  ...value,
                  links: event.currentTarget.value,
                }))
              }
              placeholder="Design brief | https://example.com/brief"
              className="min-h-20 resize-y rounded-xl border border-token-border-light bg-token-main-surface-primary p-3 text-token-text-primary text-xs outline-none focus:ring-1 focus:ring-token-focus-border"
            />
          </div>
          <div className="grid gap-1.5">
            <span className="font-medium text-sm text-token-text-primary">
              Persistent instructions
            </span>
            <textarea
              aria-label="Persistent instructions"
              value={form.instructions}
              onChange={(event) =>
                setForm((value) => ({
                  ...value,
                  instructions: event.currentTarget.value,
                }))
              }
              placeholder="Use the launch checklist and keep status updates concise…"
              className="min-h-28 resize-y rounded-xl border border-token-border-light bg-token-main-surface-primary p-3 text-sm text-token-text-primary outline-none focus:ring-1 focus:ring-token-focus-border"
            />
          </div>
          {error && (
            <div className="rounded-xl border border-error-solid/25 bg-error-solid/8 p-3 text-error-solid text-sm">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button disabled={busy} onClick={() => void save()}>
            {busy && <Loader2Icon className="size-4 animate-spin" />}
            {space ? 'Save changes' : 'Create space'}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SpacesIndex({ onBack }: { onBack: () => void }) {
  const { collapsed: sidebarCollapsed } = useSidebarCollapsed();
  const [, setOpenAgent] = useOpenAgent();
  const getSnapshot = useKartonProcedure((p) => p.spaces.getSnapshot);
  const createSpace = useKartonProcedure((p) => p.spaces.create);
  const updateSpace = useKartonProcedure((p) => p.spaces.update);
  const deleteSpace = useKartonProcedure((p) => p.spaces.delete);
  const importProjects = useKartonProcedure((p) => p.spaces.importProjects);
  const getProjects = useKartonProcedure((p) => p.agents.getChatProjects);
  const createAgent = useKartonProcedure((p) => p.agents.create);
  const setLastOpenAgentId = useKartonProcedure(
    (p) => p.browser.setLastOpenAgentId,
  );
  const closeProjects = useKartonProcedure((p) => p.appScreen.closeProjects);

  const [snapshot, setSnapshot] = useState<SpacesSnapshot | null>(null);
  const [projects, setProjects] = useState<ChatProject[]>([]);
  const [editing, setEditing] = useState<SpaceDefinition | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [spaces, projectPage] = await Promise.all([
        getSnapshot(),
        getProjects(0, 200),
      ]);
      setSnapshot(spaces);
      setProjects(projectPage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Spaces did not load.');
    }
  }, [getProjects, getSnapshot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeSpaces = useMemo(
    () => snapshot?.spaces.filter((space) => !space.archived) ?? [],
    [snapshot],
  );
  const relatedSessions = useCallback(
    (space: SpaceDefinition) =>
      projects
        .filter(
          (project) =>
            project.rootPath && space.workspacePaths.includes(project.rootPath),
        )
        .flatMap((project) => project.sessions)
        .sort(
          (left, right) =>
            new Date(right.lastMessageAt).getTime() -
            new Date(left.lastMessageAt).getTime(),
        ),
    [projects],
  );

  const save = async (input: CreateSpaceInput) => {
    setBusyId(editing?.id ?? 'create');
    try {
      if (editing) {
        await updateSpace({
          id: editing.id,
          ...input,
          archived: editing.archived,
        });
      } else {
        await createSpace(input);
      }
      setEditorOpen(false);
      setEditing(null);
      await refresh();
      notify(
        editing ? 'Space updated' : 'Space created',
        'Changes were saved.',
      );
    } finally {
      setBusyId(null);
    }
  };

  const startTask = async (space: SpaceDefinition) => {
    setBusyId(space.id);
    try {
      const prompt = space.instructions.trim()
        ? `Use these Space instructions for this task:\n\n${space.instructions}`
        : undefined;
      const agentId = await createAgent(
        undefined,
        prompt,
        undefined,
        space.workspacePaths.length ? space.workspacePaths : undefined,
        space.workspacePaths.length > 0,
      );
      setOpenAgent(agentId);
      await setLastOpenAgentId(agentId);
      await closeProjects();
    } catch (cause) {
      notify(
        'Task could not be created',
        cause instanceof Error ? cause.message : 'Please try again.',
        'error',
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="relative h-full">
      {sidebarCollapsed && (
        <SidebarTitlebarRow absolute sidebarCollapsed agentTitle="Spaces" />
      )}
      <SettingsPage
        eyebrow="Workspace"
        title="Spaces"
        description="Persistent work contexts that combine repositories, references, instructions, and related sessions."
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setEditing(null);
                setEditorOpen(true);
              }}
            >
              <PlusIcon className="size-3.5" />
              New space
            </Button>
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeftIcon className="size-3.5" />
              Projects
            </Button>
          </>
        }
        toolbar={
          snapshot ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <SettingsSummaryCard
                accent
                label="active spaces"
                value={activeSpaces.length}
                icon={<Layers3Icon className="size-4" />}
              />
              <SettingsSummaryCard
                label="connected workspaces"
                value={
                  new Set(activeSpaces.flatMap((space) => space.workspacePaths))
                    .size
                }
                icon={<FolderIcon className="size-4" />}
              />
              <SettingsSummaryCard
                label="saved references"
                value={activeSpaces.reduce(
                  (total, space) => total + space.links.length,
                  0,
                )}
                icon={<LinkIcon className="size-4" />}
              />
            </div>
          ) : undefined
        }
      >
        <div className="space-y-5">
          <SettingsSectionHeader
            title="Your spaces"
            description="Existing Projects can be imported once as a starting point."
            trailing={
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!snapshot || busyId !== null}
                  onClick={() => {
                    setBusyId('import');
                    void importProjects()
                      .then((result) => {
                        setSnapshot(result);
                        notify(
                          'Projects imported',
                          'Workspace projects are now available as Spaces.',
                        );
                      })
                      .catch((cause) =>
                        notify(
                          'Import failed',
                          cause instanceof Error
                            ? cause.message
                            : 'Please try again.',
                          'error',
                        ),
                      )
                      .finally(() => setBusyId(null));
                  }}
                >
                  <RefreshCwIcon className="size-3.5" />
                  Import projects
                </Button>
              </div>
            }
          />

          {error ? (
            <SettingsPanel className="p-5 text-error-solid text-sm">
              {error}
            </SettingsPanel>
          ) : !snapshot ? (
            <SettingsPanel className="flex min-h-52 items-center justify-center">
              <Loader2Icon className="size-5 animate-spin text-token-text-tertiary" />
            </SettingsPanel>
          ) : activeSpaces.length === 0 ? (
            <SettingsPanel className="flex min-h-64 flex-col items-center justify-center p-8 text-center">
              <Layers3Icon className="size-9 text-token-text-tertiary" />
              <h2 className="mt-3 font-medium text-token-text-primary">
                Create your first Space
              </h2>
              <p className="mt-1 max-w-md text-sm text-token-text-secondary">
                Group multiple repositories and links under persistent
                instructions, then start correctly configured tasks in one
                click.
              </p>
            </SettingsPanel>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {activeSpaces.map((space) => {
                const sessions = relatedSessions(space).slice(0, 4);
                return (
                  <SettingsPanel
                    key={space.id}
                    className="flex min-h-72 flex-col overflow-hidden"
                  >
                    <div className="flex items-start gap-3 p-5">
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-codex-blue-400/20 bg-codex-blue-400/8 text-codex-blue-400">
                        <Layers3Icon className="size-4.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h2 className="font-semibold text-token-text-primary">
                          {space.name}
                        </h2>
                        <p className="mt-1 line-clamp-2 text-sm text-token-text-secondary">
                          {space.description || 'No description'}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {space.workspacePaths.map((path) => (
                            <code
                              key={path}
                              title={path}
                              className="max-w-48 truncate rounded-md bg-token-bg-secondary px-2 py-1 text-[10px] text-token-text-tertiary"
                            >
                              {path}
                            </code>
                          ))}
                        </div>
                      </div>
                      <div className="flex">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Edit"
                          onClick={() => {
                            setEditing(space);
                            setEditorOpen(true);
                          }}
                        >
                          <PencilIcon className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Archive"
                          onClick={() => {
                            setBusyId(space.id);
                            void updateSpace({ id: space.id, archived: true })
                              .then(refresh)
                              .finally(() => setBusyId(null));
                          }}
                        >
                          <ArchiveIcon className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Delete"
                          onClick={() => {
                            if (
                              !window.confirm(`Delete Space “${space.name}”?`)
                            )
                              return;
                            setBusyId(space.id);
                            void deleteSpace(space.id)
                              .then(refresh)
                              .finally(() => setBusyId(null));
                          }}
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </div>
                    </div>

                    {(space.instructions || space.links.length > 0) && (
                      <div className="mx-5 grid gap-2 border-token-border-light border-t py-3">
                        {space.instructions && (
                          <p className="flex gap-2 text-token-text-secondary text-xs">
                            <BookOpenIcon className="mt-0.5 size-3.5 shrink-0" />
                            <span className="line-clamp-2">
                              {space.instructions}
                            </span>
                          </p>
                        )}
                        {space.links.slice(0, 3).map((link) => (
                          <button
                            key={link.id}
                            type="button"
                            className="flex items-center gap-2 truncate text-left text-codex-blue-400 text-xs hover:underline"
                            onClick={() => window.open(link.url, '_blank')}
                          >
                            <ExternalLinkIcon className="size-3 shrink-0" />
                            {link.title}
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="min-h-0 flex-1 px-5 py-3">
                      <p className="mb-2 font-medium text-[10px] text-token-text-tertiary uppercase tracking-[0.08em]">
                        Related tasks
                      </p>
                      {sessions.length === 0 ? (
                        <p className="text-token-text-tertiary text-xs">
                          No tasks match this Space yet.
                        </p>
                      ) : (
                        sessions.map((session) => (
                          <button
                            key={session.id}
                            type="button"
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-token-list-hover-background"
                            onClick={() => {
                              setOpenAgent(session.id);
                              void setLastOpenAgentId(session.id);
                              void closeProjects();
                            }}
                          >
                            <MessageSquareIcon className="size-3.5 text-token-text-tertiary" />
                            <span className="truncate text-sm text-token-text-primary">
                              {session.title || 'Untitled task'}
                            </span>
                          </button>
                        ))
                      )}
                    </div>

                    <div className="border-token-border-light border-t bg-token-bg-secondary/30 p-3">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="w-full"
                        disabled={busyId === space.id}
                        onClick={() => void startTask(space)}
                      >
                        {busyId === space.id ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <PlusIcon className="size-3.5" />
                        )}
                        New task in Space
                      </Button>
                    </div>
                  </SettingsPanel>
                );
              })}
            </div>
          )}
        </div>

        <SpaceEditor
          open={editorOpen}
          space={editing}
          busy={busyId === (editing?.id ?? 'create')}
          onOpenChange={(open) => {
            if (busyId) return;
            setEditorOpen(open);
            if (!open) setEditing(null);
          }}
          onSave={save}
        />
      </SettingsPage>
    </div>
  );
}
