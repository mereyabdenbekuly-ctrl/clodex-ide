import { Switch } from '@clodex/stage-ui/components/switch';
import { IconPenDrawSparkleFillDuo18 } from 'nucleo-ui-fill-duo-18';
import {
  useComparingSelector,
  useKartonProcedure,
  useKartonState,
} from '@ui/hooks/use-karton';
import {
  useEffect,
  useState,
  useMemo,
  useCallback,
  useRef,
  useLayoutEffect,
} from 'react';
import { cn } from '@ui/utils';
import type { ContextFilesResult } from '@shared/karton-contracts/pages-api/types';
import type { MountEntry, AppState } from '@shared/karton-contracts/ui';
import type { Patch } from '@shared/karton-contracts/ui/shared-types';
import { Button } from '@clodex/stage-ui/components/button';
import {
  FolderIcon,
  Globe2Icon,
  Loader2Icon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
} from 'lucide-react';
import { getWorkspaceDisplayInfo } from '@ui/utils/workspace-display';
import { createRafResizeObserver } from '@ui/utils/resize-observer';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@clodex/stage-ui/components/tooltip';
import type { RefObject } from 'react';
import { SettingsScrollTabs } from '../_components/settings-scroll-tabs';
import { ALWAYS_ENABLED_GLOBAL_SKILL_PREFIXES } from '@shared/global-skill-prefixes';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSectionHeader,
  SettingsSummaryCard,
} from '../_components/settings-page';

// =============================================================================
// Vertical overflow detection (like useIsTruncated but for height)
// =============================================================================

function useIsOverflowing(ref: RefObject<HTMLElement | null>) {
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const check = () => {
      setIsOverflowing(el.isConnected && el.scrollHeight > el.clientHeight);
    };
    check();

    const { observer, disconnect } = createRafResizeObserver(check);
    observer.observe(el);
    return () => disconnect();
  });

  return { isOverflowing, tooltipOpen, setTooltipOpen };
}

// =============================================================================
// Workspace Subheader
// =============================================================================

// =============================================================================
// Skills Section
// =============================================================================

function skillMatchesQuery(
  skill: { name: string; description: string },
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;

  return (
    skill.name.toLocaleLowerCase().includes(normalizedQuery) ||
    skill.description.toLocaleLowerCase().includes(normalizedQuery)
  );
}

function WorkspaceSkillsList({
  workspacePath,
  skills,
  query,
}: {
  workspacePath: string;
  skills: Array<{ name: string; description: string }>;
  query: string;
}) {
  const preferences = useKartonState((s) => s.preferences);
  const updatePreferences = useKartonProcedure((p) => p.preferences.update);

  const disabledSkills = useMemo(
    () =>
      preferences?.agent?.workspaceSettings?.[workspacePath]?.disabledSkills ??
      [],
    [preferences, workspacePath],
  );

  const sortedSkills = useMemo(
    () =>
      skills
        .filter((skill) => skillMatchesQuery(skill, query))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [query, skills],
  );

  const handleToggleSkill = useCallback(
    async (skillName: string, enabled: boolean) => {
      const currentSettings =
        preferences?.agent?.workspaceSettings?.[workspacePath];
      const current = currentSettings?.disabledSkills ?? [];
      const next = enabled
        ? current.filter((s) => s !== skillName)
        : [...current, skillName];

      const patches: Patch[] = currentSettings
        ? [
            {
              op: 'replace' as const,
              path: [
                'agent',
                'workspaceSettings',
                workspacePath,
                'disabledSkills',
              ],
              value: next,
            },
          ]
        : [
            {
              op: 'add' as const,
              path: ['agent', 'workspaceSettings', workspacePath],
              value: { respectAgentsMd: false, disabledSkills: next },
            },
          ];

      await updatePreferences(patches);
    },
    [workspacePath, preferences, updatePreferences],
  );

  if (sortedSkills.length === 0) {
    return (
      <SettingsPanel className="px-4 py-8 text-center">
        <p className="text-sm text-token-text-secondary">
          {query.trim()
            ? 'No workspace skills match this search.'
            : 'No skills detected in this workspace.'}
        </p>
      </SettingsPanel>
    );
  }

  return (
    <SettingsPanel className="divide-y divide-token-border-light overflow-hidden">
      {sortedSkills.map((skill) => {
        const isEnabled = !disabledSkills.includes(skill.name);
        return (
          <SkillRow
            key={skill.name}
            skill={skill}
            isEnabled={isEnabled}
            onToggle={() => handleToggleSkill(skill.name, !isEnabled)}
          />
        );
      })}
    </SettingsPanel>
  );
}

function SkillRow({
  skill,
  isEnabled,
  onToggle,
}: {
  skill: { name: string; description: string };
  isEnabled: boolean;
  onToggle: () => void;
}) {
  const descRef = useRef<HTMLParagraphElement>(null);
  const { isOverflowing, tooltipOpen, setTooltipOpen } =
    useIsOverflowing(descRef);

  return (
    <Tooltip open={isOverflowing && tooltipOpen} onOpenChange={setTooltipOpen}>
      <TooltipTrigger delay={400}>
        <div
          className="flex cursor-pointer items-start gap-3.5 px-4 py-3.5 transition-colors hover:bg-token-list-hover-background"
          onClick={onToggle}
        >
          <span
            className={cn(
              'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg',
              isEnabled
                ? 'bg-clodex-green-400/9 text-clodex-green-400'
                : 'bg-token-bg-tertiary text-token-text-tertiary',
            )}
          >
            <SparklesIcon className="size-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                'font-medium text-sm',
                isEnabled
                  ? 'text-token-text-primary'
                  : 'text-token-text-secondary',
              )}
            >
              {skill.name}
            </p>
            <p
              ref={descRef}
              className={cn(
                'mt-0.5 max-h-10 overflow-hidden text-xs leading-5',
                isEnabled
                  ? 'text-token-text-secondary'
                  : 'text-token-text-tertiary',
                isOverflowing && 'mask-alpha',
              )}
              style={
                isOverflowing
                  ? {
                      maskImage:
                        'linear-gradient(to bottom, black 0%, transparent 100%)',
                      WebkitMaskImage:
                        'linear-gradient(to bottom, black 0%, transparent 100%)',
                    }
                  : undefined
              }
            >
              {skill.description}
            </p>
          </div>
          <div onClick={(e) => e.stopPropagation()}>
            <Switch
              checked={isEnabled}
              onCheckedChange={() => onToggle()}
              size="xs"
            />
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        <p className="max-w-xs text-xs leading-relaxed">{skill.description}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function WorkspaceDetails({
  mount,
  contextFiles,
  query,
}: {
  mount: MountEntry;
  contextFiles: ContextFilesResult | null;
  query: string;
}) {
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsSectionHeader
          title="Workspace skills"
          description="Enable or disable skills only for this workspace."
        />
        <WorkspaceSkillsList
          workspacePath={mount.path}
          skills={mount.skills}
          query={query}
        />
      </section>
      <section className="space-y-3">
        <SettingsSectionHeader
          title="Context files"
          description="Manage workspace instructions used by the agent."
        />
        <WorkspaceContextFilesList
          workspacePath={mount.path}
          workspaceMd={
            contextFiles?.[mount.path]?.workspaceMd ?? {
              exists: mount.workspaceMdContent !== null,
              path: null,
              content: null,
            }
          }
        />
      </section>
    </div>
  );
}

// =============================================================================
// Global Skills Section
// =============================================================================

/** Mount prefixes that are always enabled (not toggleable in the UI). */
/** Display metadata for each global skill directory. */
const GLOBAL_SKILL_DIR_META: Record<string, { label: string; dir: string }> = {
  'globalskills-sw': { label: 'Clodex', dir: '~/.clodex/skills' },
  'globalskills-agents': { label: 'Agents', dir: '~/.agents/skills' },
  'globalskills-codex': { label: 'Codex', dir: '~/.codex/skills' },
  'globalskills-claude': { label: 'Claude Code', dir: '~/.claude/skills' },
};

/** Stable ordering for global skill directory display. */
const GLOBAL_SKILL_DIR_ORDER = [
  'globalskills-sw',
  'globalskills-agents',
  'globalskills-codex',
  'globalskills-claude',
] as const;

/**
 * Lookup metadata for a global skill dir prefix. Throws if the prefix
 * is not in `GLOBAL_SKILL_DIR_META` — all callers use
 * `GLOBAL_SKILL_DIR_ORDER` so the key is always valid.
 */
function getGlobalSkillDirMeta(prefix: string): {
  label: string;
  dir: string;
} {
  const meta = GLOBAL_SKILL_DIR_META[prefix];
  if (!meta) throw new Error(`Unknown global skill dir prefix: ${prefix}`);
  return meta;
}

type GlobalSkillEntry = AppState['globalSkills'][number];

function GlobalSkillsDetails({ query }: { query: string }) {
  const preferences = useKartonState((s) => s.preferences);
  const updatePreferences = useKartonProcedure((p) => p.preferences.update);
  const globalSkills = useKartonState((s) => s.globalSkills);

  const enabledGlobalSkillDirs = useMemo(
    () => preferences?.agent?.enabledGlobalSkillDirs ?? [],
    [preferences],
  );
  const disabledGlobalSkills = useMemo(
    () => preferences?.agent?.disabledGlobalSkills ?? [],
    [preferences],
  );

  // Group skills by mount prefix for per-dir rendering.
  const skillsByPrefix = useMemo(() => {
    const map = new Map<string, GlobalSkillEntry[]>();
    for (const skill of globalSkills) {
      const arr = map.get(skill.mountPrefix) ?? [];
      arr.push(skill);
      map.set(skill.mountPrefix, arr);
    }
    // Sort skills within each group by name.
    for (const arr of Array.from(map.values())) {
      arr.sort((a: GlobalSkillEntry, b: GlobalSkillEntry) =>
        a.name.localeCompare(b.name),
      );
    }
    return map;
  }, [globalSkills]);

  const visibleGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();

    return GLOBAL_SKILL_DIR_ORDER.map((prefix) => {
      const meta = getGlobalSkillDirMeta(prefix);
      const allSkills = skillsByPrefix.get(prefix) ?? [];
      const groupMatches =
        !normalizedQuery ||
        meta.label.toLocaleLowerCase().includes(normalizedQuery) ||
        meta.dir.toLocaleLowerCase().includes(normalizedQuery);
      const skills = groupMatches
        ? allSkills
        : allSkills.filter((skill) => skillMatchesQuery(skill, query));

      return { prefix, meta, skills };
    }).filter(({ skills, meta }) => {
      if (!normalizedQuery) return true;
      return (
        skills.length > 0 ||
        meta.label.toLocaleLowerCase().includes(normalizedQuery) ||
        meta.dir.toLocaleLowerCase().includes(normalizedQuery)
      );
    });
  }, [query, skillsByPrefix]);

  const handleToggleDir = useCallback(
    async (prefix: string, enabled: boolean) => {
      const current = enabledGlobalSkillDirs;
      const next = enabled
        ? current.includes(prefix)
          ? current
          : [...current, prefix]
        : current.filter((p) => p !== prefix);
      await updatePreferences([
        {
          op: 'replace' as const,
          path: ['agent', 'enabledGlobalSkillDirs'],
          value: next,
        },
      ]);
    },
    [enabledGlobalSkillDirs, updatePreferences],
  );

  const handleToggleSkill = useCallback(
    async (skillName: string, enabled: boolean) => {
      const current = disabledGlobalSkills;
      const next = enabled
        ? current.filter((s) => s !== skillName)
        : [...current, skillName];
      await updatePreferences([
        {
          op: 'replace' as const,
          path: ['agent', 'disabledGlobalSkills'],
          value: next,
        },
      ]);
    },
    [disabledGlobalSkills, updatePreferences],
  );

  if (visibleGroups.length === 0) {
    return (
      <SettingsPanel className="px-4 py-10 text-center">
        <p className="text-sm text-token-text-secondary">
          No global skills match this search.
        </p>
      </SettingsPanel>
    );
  }

  return (
    <div className="space-y-4">
      {visibleGroups.map(({ prefix, meta, skills }) => {
        const isAlwaysEnabled =
          ALWAYS_ENABLED_GLOBAL_SKILL_PREFIXES.has(prefix);
        const dirEnabled =
          isAlwaysEnabled || enabledGlobalSkillDirs.includes(prefix);

        return (
          <SettingsPanel key={prefix} className="overflow-hidden">
            <section>
              <div
                className={cn(
                  'flex items-start justify-between gap-4 px-4 py-4',
                  !isAlwaysEnabled &&
                    'cursor-pointer transition-colors hover:bg-token-list-hover-background',
                )}
                role={isAlwaysEnabled ? undefined : 'button'}
                tabIndex={isAlwaysEnabled ? undefined : 0}
                onClick={() => {
                  if (!isAlwaysEnabled)
                    void handleToggleDir(prefix, !dirEnabled);
                }}
                onKeyDown={(e) => {
                  if (
                    !isAlwaysEnabled &&
                    (e.key === 'Enter' || e.key === ' ')
                  ) {
                    e.preventDefault();
                    void handleToggleDir(prefix, !dirEnabled);
                  }
                }}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    className={cn(
                      'flex size-9 shrink-0 items-center justify-center rounded-xl',
                      dirEnabled
                        ? 'bg-clodex-green-400/9 text-clodex-green-400'
                        : 'bg-token-bg-tertiary text-token-text-tertiary',
                    )}
                  >
                    <SparklesIcon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium text-sm text-token-text-primary">
                        {meta.label} skills
                      </h3>
                      {isAlwaysEnabled && (
                        <span className="rounded-full bg-token-bg-tertiary px-2 py-0.5 text-[10px] text-token-text-tertiary uppercase tracking-wide">
                          Core
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-token-text-tertiary text-xs">
                      {meta.dir}
                      {skills.length > 0 &&
                        ` · ${skills.length} skill${skills.length === 1 ? '' : 's'}`}
                    </p>
                  </div>
                </div>
                {!isAlwaysEnabled && (
                  <div
                    className="shrink-0"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <Switch
                      checked={dirEnabled}
                      onCheckedChange={() =>
                        void handleToggleDir(prefix, !dirEnabled)
                      }
                      size="xs"
                    />
                  </div>
                )}
              </div>

              {dirEnabled && skills.length > 0 && (
                <div className="divide-y divide-token-border-light border-token-border-light border-t">
                  {skills.map((skill) => {
                    const isSkillEnabled = !disabledGlobalSkills.includes(
                      skill.name,
                    );
                    return (
                      <SkillRow
                        key={`${prefix}:${skill.name}`}
                        skill={skill}
                        isEnabled={isSkillEnabled}
                        onToggle={() =>
                          handleToggleSkill(skill.name, !isSkillEnabled)
                        }
                      />
                    );
                  })}
                </div>
              )}

              {dirEnabled && skills.length === 0 && (
                <p className="border-token-border-light border-t px-4 py-4 text-sm text-token-text-tertiary italic">
                  No skills found in this directory.
                </p>
              )}
            </section>
          </SettingsPanel>
        );
      })}
    </div>
  );
}

// =============================================================================
// Context Files Section
// =============================================================================

function WorkspaceContextFilesList({
  workspacePath,
  workspaceMd,
}: {
  workspacePath: string;
  workspaceMd: { exists: boolean; path: string | null; content: string | null };
}) {
  const preferences = useKartonState((s) => s.preferences);
  const updatePreferences = useKartonProcedure((p) => p.preferences.update);
  const generateWorkspaceMd = useKartonProcedure(
    (p) => p.toolbox.generateWorkspaceMdForPath,
  );
  const isGenerating = useKartonState(
    (s) => !!s.workspaceMdGenerating[workspacePath],
  );

  const respectAgentsMd =
    preferences?.agent?.workspaceSettings?.[workspacePath]?.respectAgentsMd ??
    false;

  const handleGenerate = useCallback(async () => {
    await generateWorkspaceMd(workspacePath);
  }, [generateWorkspaceMd, workspacePath]);

  const handleToggleAgentsMd = useCallback(
    async (checked: boolean) => {
      const currentSettings =
        preferences?.agent?.workspaceSettings?.[workspacePath];

      const patches: Patch[] = currentSettings
        ? [
            {
              op: 'replace' as const,
              path: [
                'agent',
                'workspaceSettings',
                workspacePath,
                'respectAgentsMd',
              ],
              value: checked,
            },
          ]
        : [
            {
              op: 'add' as const,
              path: ['agent', 'workspaceSettings', workspacePath],
              value: { respectAgentsMd: checked },
            },
          ];

      await updatePreferences(patches);
    },
    [workspacePath, preferences, updatePreferences],
  );

  return (
    <SettingsPanel className="divide-y divide-token-border-light overflow-hidden">
      {/* WORKSPACE.md row */}
      <div className="flex items-start gap-4 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm text-token-text-primary">
            WORKSPACE.md
          </p>
          <p className="mt-0.5 text-token-text-secondary text-xs">
            {workspaceMd.exists
              ? 'Auto-generated project analysis.'
              : 'Not yet generated.'}
          </p>
        </div>
        {workspaceMd.exists ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={handleGenerate}
            disabled={isGenerating}
          >
            {isGenerating ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3" />
            )}
            {isGenerating ? 'Updating…' : 'Regenerate'}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="xs"
            onClick={handleGenerate}
            disabled={isGenerating}
          >
            {isGenerating ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <IconPenDrawSparkleFillDuo18 className="size-3" />
            )}
            {isGenerating ? 'Generating…' : 'Generate'}
          </Button>
        )}
      </div>

      {/* AGENTS.md row */}
      <div
        className="flex cursor-pointer items-start gap-4 px-4 py-3.5 transition-colors hover:bg-token-list-hover-background"
        onClick={() => handleToggleAgentsMd(!respectAgentsMd)}
      >
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'font-medium text-sm',
              respectAgentsMd
                ? 'text-token-text-primary'
                : 'text-token-text-secondary',
            )}
          >
            AGENTS.md
          </p>
          <p
            className={cn(
              'text-xs',
              respectAgentsMd
                ? 'text-token-text-secondary'
                : 'text-token-text-tertiary',
            )}
          >
            Include in agent context
          </p>
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={respectAgentsMd}
            onCheckedChange={handleToggleAgentsMd}
            size="xs"
          />
        </div>
      </div>
    </SettingsPanel>
  );
}

// =============================================================================
// Main Page Component
// =============================================================================

export function SkillsContextSection() {
  const [query, setQuery] = useState('');
  const workspaceMounts = useKartonState(
    useComparingSelector(
      (s): MountEntry[] => {
        const seen = new Map<string, MountEntry>();

        for (const agentId in s.toolbox) {
          const mounts = s.toolbox[agentId]?.workspace?.mounts ?? [];
          for (const mount of mounts) {
            if (!seen.has(mount.path)) seen.set(mount.path, mount);
          }
        }

        return Array.from(seen.values());
      },
      (a, b) => {
        if (a === b) return true;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) return false;
        }
        return true;
      },
    ),
  );
  const globalSkills = useKartonState((s) => s.globalSkills);
  const getContextFiles = useKartonProcedure((p) => p.toolbox.getContextFiles);
  const getContextFilesRef = useRef(getContextFiles);
  getContextFilesRef.current = getContextFiles;

  const [contextFiles, setContextFiles] = useState<ContextFilesResult | null>(
    null,
  );

  const workspaceMdGenerating = useKartonState((s) => s.workspaceMdGenerating);
  const prevGeneratingRef = useRef<Record<string, boolean>>({});

  const mountPathsKey = useMemo(
    () => workspaceMounts.map((m) => m.path).join('\0'),
    [workspaceMounts],
  );

  useEffect(() => {
    void getContextFilesRef.current().then((files) => {
      setContextFiles(files);
    });
  }, [mountPathsKey]);

  useEffect(() => {
    const prev = prevGeneratingRef.current;
    const justFinished = Object.keys(prev).some(
      (path) => prev[path] && !workspaceMdGenerating[path],
    );
    prevGeneratingRef.current = { ...workspaceMdGenerating };

    if (justFinished) {
      void getContextFilesRef.current().then((files) => {
        setContextFiles(files);
      });
    }
  }, [workspaceMdGenerating]);

  const GLOBAL_TAB_ID = '__global__';

  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);

  // Build the tab list: "Global" first, then workspace tabs.
  const tabItems = useMemo(
    () => [
      { id: GLOBAL_TAB_ID, label: 'Global' },
      ...workspaceMounts.map((mount) => {
        const display = getWorkspaceDisplayInfo({
          path: mount.path,
          git: mount.git,
        });
        return {
          id: mount.path,
          label: display.title,
          subLabel: mount.path,
        };
      }),
    ],
    [workspaceMounts],
  );

  const selectedMount = useMemo(
    () =>
      workspaceMounts.find((m) => m.path === selectedTabId) ??
      workspaceMounts[0] ??
      null,
    [workspaceMounts, selectedTabId],
  );

  // Compute the effective tab ID: when the user hasn't clicked
  // anything yet (or the previously selected tab no longer exists),
  // fall back to the first tab ("Global").
  const effectiveTabId =
    selectedTabId != null && tabItems.some((t) => t.id === selectedTabId)
      ? selectedTabId
      : (tabItems[0]?.id ?? null);
  const isGlobalTab = effectiveTabId === GLOBAL_TAB_ID;
  const visibleSkillCount = useMemo(() => {
    if (!isGlobalTab) {
      return (selectedMount?.skills ?? []).filter((skill) =>
        skillMatchesQuery(skill, query),
      ).length;
    }

    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return globalSkills.length;

    return globalSkills.filter((skill) => {
      const meta = GLOBAL_SKILL_DIR_META[skill.mountPrefix];
      return (
        skillMatchesQuery(skill, query) ||
        meta?.label.toLocaleLowerCase().includes(normalizedQuery) ||
        meta?.dir.toLocaleLowerCase().includes(normalizedQuery)
      );
    }).length;
  }, [globalSkills, isGlobalTab, query, selectedMount]);

  return (
    <SettingsPage
      eyebrow="Agent context"
      title="Skills & Context"
      description="Control the reusable instructions and workspace context available to the agent."
      toolbar={
        <div className="rounded-2xl border border-token-border-light bg-token-main-surface-primary/68 p-3 shadow-codex-sm">
          <label className="flex h-9 min-w-0 items-center gap-2 rounded-xl border border-token-border-light bg-token-input-background px-3 transition-colors focus-within:border-token-focus-border">
            <SearchIcon className="size-3.5 shrink-0 text-token-text-tertiary" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search skills…"
              className="min-w-0 flex-1 bg-transparent text-sm text-token-text-primary outline-none placeholder:text-token-text-tertiary"
            />
          </label>
        </div>
      }
    >
      <div className="space-y-7">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <SettingsSummaryCard
            label="Global skills"
            value={globalSkills.length}
            icon={<Globe2Icon className="size-4" />}
            accent={isGlobalTab}
          />
          <SettingsSummaryCard
            label="Connected workspaces"
            value={workspaceMounts.length}
            icon={<FolderIcon className="size-4" />}
            accent={!isGlobalTab}
          />
          <SettingsSummaryCard
            label={query.trim() ? 'Matching skills' : 'Skills in this scope'}
            value={visibleSkillCount}
            icon={<SparklesIcon className="size-4" />}
          />
        </div>

        <SettingsPanel className="p-2">
          <SettingsScrollTabs
            selectedId={effectiveTabId}
            onSelect={setSelectedTabId}
            truncateSubLabelFromStart
            items={tabItems}
          />
        </SettingsPanel>

        {isGlobalTab ? (
          <GlobalSkillsDetails query={query} />
        ) : selectedMount ? (
          <WorkspaceDetails
            mount={selectedMount}
            contextFiles={contextFiles}
            query={query}
          />
        ) : (
          <SettingsPanel className="px-4 py-10 text-center">
            <p className="text-sm text-token-text-secondary">
              Connect a workspace to configure its skills and context files.
            </p>
          </SettingsPanel>
        )}
      </div>
    </SettingsPage>
  );
}
