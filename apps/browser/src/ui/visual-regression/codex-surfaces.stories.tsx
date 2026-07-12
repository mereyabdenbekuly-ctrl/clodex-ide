import { Button } from '@clodex/stage-ui/components/button';
import { Switch } from '@clodex/stage-ui/components/switch';
import { TooltipProvider } from '@clodex/stage-ui/components/tooltip';
import type { Meta, StoryObj } from '@storybook/react';
import { withMockKarton } from '@sb/decorators/with-mock-karton';
import type { HostedPullRequest as HostedPullRequestData } from '@shared/hosted-pull-request';
import { buildHostedPullRequestMergePolicy } from '@shared/hosted-pull-request-merge';
import type { GeneratedApp } from '@shared/generated-apps';
import type { ChatProject } from '@shared/karton-contracts/ui/agent';
import { AgentTypes } from '@shared/karton-contracts/ui/agent';
import type { PluginLibrarySnapshot } from '@shared/plugin-library';
import { cn } from '@ui/utils';
import {
  BellIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleGaugeIcon,
  DatabaseIcon,
  GitBranchIcon,
  KeyRoundIcon,
  PaletteIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from 'lucide-react';
import { SidebarCollapsedProvider } from '../screens/main/_components/sidebar-collapsed-context';
import { ProjectsIndex } from '../screens/projects';
import {
  GeneratedAppDetail,
  GeneratedAppsCatalog,
  type GeneratedAppsNotice,
} from '../screens/generated-apps';
import { getGeneratedAppsSummary } from '../screens/generated-apps/generated-apps-model';
import {
  PluginLibraryCatalog,
  PluginLibraryDetail,
  type PluginLibraryActionState,
  type PluginLibraryNotice,
} from '../screens/plugin-library';
import { createPluginLibraryItems } from '../screens/plugin-library/plugin-library-model';
import { HostedPullRequestReview } from '../screens/pull-request/hosted-pull-request-review';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSectionHeader,
  SettingsSummaryCard,
} from '../screens/settings/_components/settings-page';
import { QuickTaskComposer } from '../screens/main/quick-task/quick-task-composer';
import { useState } from 'react';

const FIXED_NOW = '2026-07-10T12:00:00.000Z';

const projects: ChatProject[] = [
  {
    id: '/workspace/clodex',
    rootPath: '/workspace/clodex',
    name: 'clodex',
    createdAt: new Date('2026-06-28T09:00:00.000Z'),
    updatedAt: new Date('2026-07-10T11:42:00.000Z'),
    sessions: [
      {
        id: 'task-current',
        type: AgentTypes.CHAT,
        title: 'Finish the Codex UI visual regression pass',
        createdAt: new Date('2026-07-10T09:10:00.000Z'),
        lastMessageAt: new Date('2026-07-10T11:42:00.000Z'),
        messageCount: 18,
        parentAgentInstanceId: null,
      },
      {
        id: 'task-pr-review',
        type: AgentTypes.CHAT,
        title: 'Implement hosted pull request review',
        createdAt: new Date('2026-07-09T07:30:00.000Z'),
        lastMessageAt: new Date('2026-07-09T16:25:00.000Z'),
        messageCount: 27,
        parentAgentInstanceId: null,
      },
      {
        id: 'task-remote',
        type: AgentTypes.CHAT,
        title: 'Add remote SSH connections',
        createdAt: new Date('2026-07-08T08:00:00.000Z'),
        lastMessageAt: new Date('2026-07-08T14:05:00.000Z'),
        messageCount: 31,
        parentAgentInstanceId: null,
      },
    ],
  },
  {
    id: '/workspace/design-system',
    rootPath: '/workspace/design-system',
    name: 'design-system',
    createdAt: new Date('2026-06-10T08:15:00.000Z'),
    updatedAt: new Date('2026-07-09T10:20:00.000Z'),
    sessions: [
      {
        id: 'task-tokens',
        type: AgentTypes.CHAT,
        title: 'Normalize Codex color tokens',
        createdAt: new Date('2026-07-09T08:00:00.000Z'),
        lastMessageAt: new Date('2026-07-09T10:20:00.000Z'),
        messageCount: 14,
        parentAgentInstanceId: null,
      },
      {
        id: 'task-dark-mode',
        type: AgentTypes.CHAT,
        title: 'Audit dark mode contrast',
        createdAt: new Date('2026-07-07T11:45:00.000Z'),
        lastMessageAt: new Date('2026-07-07T15:10:00.000Z'),
        messageCount: 9,
        parentAgentInstanceId: null,
      },
    ],
  },
];

const hostedPullRequestChecks: HostedPullRequestData['checks'] = {
  total: 3,
  pending: 0,
  successful: 3,
  failed: 0,
  neutral: 0,
  checks: [
    {
      id: 'check-typecheck',
      name: 'Typecheck',
      state: 'success',
      detailsUrl: 'https://github.com/openai/clodex/actions/runs/1',
      description: 'TypeScript checks passed',
    },
    {
      id: 'check-unit',
      name: 'Unit tests',
      state: 'success',
      detailsUrl: 'https://github.com/openai/clodex/actions/runs/2',
      description: 'All unit tests passed',
    },
    {
      id: 'check-visual',
      name: 'Visual regression',
      state: 'success',
      detailsUrl: 'https://github.com/openai/clodex/actions/runs/3',
      description: 'Browser snapshots passed',
    },
  ],
};

const hostedPullRequest: HostedPullRequestData = {
  provider: 'github',
  repository: {
    owner: 'openai',
    name: 'clodex',
    fullName: 'openai/clodex',
    url: 'https://github.com/openai/clodex',
  },
  number: 418,
  url: 'https://github.com/openai/clodex/pull/418',
  title: 'Add stable visual regression coverage for core desktop surfaces',
  body: 'Adds deterministic Storybook fixtures and screenshot coverage for Settings, Projects, hosted pull request review, and Quick Task.',
  state: 'open',
  draft: false,
  mergeable: true,
  mergeState: 'clean',
  author: {
    login: 'codex-bot',
    avatarUrl: null,
    profileUrl: 'https://github.com/codex-bot',
  },
  head: {
    label: 'codex-bot:visual-regression',
    branch: 'visual-regression',
    sha: '7a9bc30',
    repositoryFullName: 'openai/clodex',
  },
  base: {
    label: 'openai:main',
    branch: 'main',
    sha: '2f61d83',
    repositoryFullName: 'openai/clodex',
  },
  createdAt: '2026-07-09T08:00:00.000Z',
  updatedAt: '2026-07-10T10:15:00.000Z',
  additions: 284,
  deletions: 37,
  changedFiles: 4,
  commits: 3,
  comments: 4,
  reviewComments: 2,
  checks: hostedPullRequestChecks,
  files: [
    {
      sha: 'file-1',
      path: 'apps/browser/src/ui/visual-regression/codex-surfaces.stories.tsx',
      previousPath: null,
      status: 'added',
      additions: 116,
      deletions: 0,
      changes: 116,
      patch: [
        '@@ -0,0 +1,8 @@',
        '+import type { Meta } from "@storybook/react";',
        '+',
        '+export const visualFixtures = [',
        '+  "settings",',
        '+  "projects",',
        '+  "pull-request",',
        '+  "quick-task",',
        '+];',
      ].join('\n'),
      blobUrl:
        'https://github.com/openai/clodex/blob/7a9bc30/apps/browser/src/ui/visual-regression/codex-surfaces.stories.tsx',
      rawUrl:
        'https://raw.githubusercontent.com/openai/clodex/7a9bc30/apps/browser/src/ui/visual-regression/codex-surfaces.stories.tsx',
    },
    {
      sha: 'file-2',
      path: 'apps/browser/playwright.visual.config.ts',
      previousPath: null,
      status: 'added',
      additions: 52,
      deletions: 0,
      changes: 52,
      patch: [
        '@@ -0,0 +1,7 @@',
        '+export default defineConfig({',
        '+  use: {',
        '+    colorScheme: "light",',
        '+    reducedMotion: "reduce",',
        '+  },',
        '+});',
      ].join('\n'),
      blobUrl:
        'https://github.com/openai/clodex/blob/7a9bc30/apps/browser/playwright.visual.config.ts',
      rawUrl:
        'https://raw.githubusercontent.com/openai/clodex/7a9bc30/apps/browser/playwright.visual.config.ts',
    },
    {
      sha: 'file-3',
      path: '.github/workflows/monorepo-ci.yml',
      previousPath: null,
      status: 'modified',
      additions: 34,
      deletions: 4,
      changes: 38,
      patch: [
        '@@ -52,6 +52,10 @@ jobs:',
        '+  visual-regression:',
        '+    name: Visual regression',
        '+    runs-on: ubuntu-latest',
        '+    steps:',
        '+      - run: pnpm --dir apps/browser visual:test',
      ].join('\n'),
      blobUrl:
        'https://github.com/openai/clodex/blob/7a9bc30/.github/workflows/monorepo-ci.yml',
      rawUrl:
        'https://raw.githubusercontent.com/openai/clodex/7a9bc30/.github/workflows/monorepo-ci.yml',
    },
    {
      sha: 'file-4',
      path: 'apps/browser/package.json',
      previousPath: null,
      status: 'modified',
      additions: 6,
      deletions: 1,
      changes: 7,
      patch: null,
      blobUrl:
        'https://github.com/openai/clodex/blob/7a9bc30/apps/browser/package.json',
      rawUrl:
        'https://raw.githubusercontent.com/openai/clodex/7a9bc30/apps/browser/package.json',
    },
  ],
  filesTruncated: false,
  detectedFromWorkspace: '/workspace/clodex',
  mergePolicy: buildHostedPullRequestMergePolicy({
    authenticated: true,
    repositoryFullName: 'openai/clodex',
    number: 418,
    state: 'open',
    draft: false,
    mergeable: true,
    mergeState: 'clean',
    checks: hostedPullRequestChecks,
    filesTruncated: false,
    repositorySettings: {
      canPush: true,
      allowedMethods: ['merge', 'squash', 'rebase'],
    },
    branchRuleTypes: ['pull_request', 'required_status_checks'],
  }),
};

const generatedApps: GeneratedApp[] = [
  {
    key: 'app-analytics',
    appId: 'analytics-pulse',
    owner: {
      kind: 'agent',
      agentId: 'task-analytics',
      taskTitle: 'Build an executive analytics dashboard',
      workspacePath: '/workspace/clodex',
    },
    title: 'Analytics Pulse',
    description:
      'A focused operations dashboard for activation, retention, and revenue trends.',
    status: 'ready',
    entryPath: 'index.html',
    previewUrl:
      'clodex://internal/preview/analytics-pulse?agentId=task-analytics',
    createdAt: '2026-07-04T08:00:00.000Z',
    updatedAt: '2026-07-10T11:24:00.000Z',
    lastOpenedAt: '2026-07-10T10:08:00.000Z',
    regenerationRequestedAt: null,
    fileCount: 14,
    totalBytes: 184_320,
    error: null,
  },
  {
    key: 'app-launch-plan',
    appId: 'launch-plan',
    owner: {
      kind: 'agent',
      agentId: 'task-launch',
      taskTitle: 'Design the product launch workspace',
      workspacePath: '/workspace/design-system',
    },
    title: 'Launch Plan',
    description:
      'Interactive launch checklist with ownership, dependencies, and milestone tracking.',
    status: 'regenerating',
    entryPath: 'index.html',
    previewUrl: 'clodex://internal/preview/launch-plan?agentId=task-launch',
    createdAt: '2026-07-06T08:00:00.000Z',
    updatedAt: '2026-07-10T09:18:00.000Z',
    lastOpenedAt: '2026-07-09T16:40:00.000Z',
    regenerationRequestedAt: '2026-07-10T11:35:00.000Z',
    fileCount: 9,
    totalBytes: 92_160,
    error: null,
  },
  {
    key: 'app-onboarding',
    appId: 'onboarding-map',
    owner: {
      kind: 'agent',
      agentId: 'task-onboarding',
      taskTitle: 'Prototype the onboarding journey',
      workspacePath: '/workspace/design-system',
    },
    title: 'Onboarding Map',
    description:
      'A visual onboarding flow used to review copy, branching, and completion states.',
    status: 'broken',
    entryPath: 'index.html',
    previewUrl:
      'clodex://internal/preview/onboarding-map?agentId=task-onboarding',
    createdAt: '2026-07-02T08:00:00.000Z',
    updatedAt: '2026-07-08T12:30:00.000Z',
    lastOpenedAt: null,
    regenerationRequestedAt: null,
    fileCount: 6,
    totalBytes: 47_104,
    error: 'index.html is missing.',
  },
];

const pluginLibrarySnapshot: PluginLibrarySnapshot = {
  plugins: [
    {
      id: 'open-code-review',
      displayName: 'Open Code Review',
      description:
        'Review local changes with structured findings, repository context, and actionable follow-up.',
      requiredCredentials: [],
      logoSvg: null,
      skills: [
        {
          name: 'Review local changes',
          description:
            'Inspect the current diff and report prioritized correctness findings.',
        },
        {
          name: 'Prepare review summary',
          description:
            'Summarize risk, validation evidence, and recommended next steps.',
        },
      ],
      source: 'bundled',
      version: '1.0.0',
      permissions: ['skills', 'filesystem'],
    },
    {
      id: 'github-workflow',
      displayName: 'GitHub Workflow Assistant',
      description:
        'Investigate failed checks, inspect workflow runs, and prepare focused CI fixes.',
      requiredCredentials: ['github-pat'],
      logoSvg: null,
      skills: [
        {
          name: 'Review CI failures',
          description:
            'Inspect failed GitHub Actions jobs and identify the first actionable failure.',
        },
        {
          name: 'Prepare workflow fix',
          description:
            'Draft a minimal workflow or source change and explain its validation plan.',
        },
      ],
      source: 'marketplace',
      version: '1.2.0',
      permissions: ['skills', 'network', 'credentials'],
    },
  ],
  marketplace: {
    enabled: true,
    status: 'ready',
    keyId: 'clodex-official-2026',
    generatedAt: Date.parse('2026-07-10T08:00:00.000Z'),
    expiresAt: Date.parse('2026-07-17T08:00:00.000Z'),
    refreshedAt: Date.parse('2026-07-10T11:30:00.000Z'),
    error: null,
    warnings: [],
    catalog: [
      {
        manifest: {
          schemaVersion: 1,
          id: 'github-workflow',
          version: '1.3.0',
          displayName: 'GitHub Workflow Assistant',
          description:
            'Investigate failed checks, inspect workflow runs, and prepare focused CI fixes.',
          publisher: 'Clodex Labs',
          publisherId: 'clodex-labs',
          compatibility: {
            minAppVersion: '1.12.0',
          },
          permissions: ['skills', 'network', 'credentials'],
          requiredCredentials: ['github-pat'],
        },
        sha256: 'a'.repeat(64),
        publisherVerified: true,
        publisherKeyId: 'clodex-labs-2026',
        compatible: true,
        compatibilityError: null,
        installedVersion: '1.2.0',
        updateAvailable: true,
      },
      {
        manifest: {
          schemaVersion: 1,
          id: 'figma-handoff',
          version: '1.0.0',
          displayName: 'Figma Handoff',
          description:
            'Turn approved Figma frames into implementation-ready context and asset notes.',
          publisher: 'Design Systems Co.',
          publisherId: 'design-systems-co',
          compatibility: {
            minAppVersion: '1.10.0',
          },
          permissions: ['skills', 'network', 'credentials'],
          requiredCredentials: ['figma-pat'],
        },
        sha256: 'b'.repeat(64),
        publisherVerified: true,
        publisherKeyId: 'design-systems-co-2026',
        compatible: true,
        compatibilityError: null,
        installedVersion: null,
        updateAvailable: false,
      },
      {
        manifest: {
          schemaVersion: 1,
          id: 'deployment-pilot',
          version: '2.0.0',
          displayName: 'Deployment Pilot',
          description:
            'Coordinate deployment checks and release verification across hosted environments.',
          publisher: 'Release Works',
          publisherId: 'release-works',
          compatibility: {
            minAppVersion: '2.0.0',
          },
          permissions: ['skills', 'network', 'credentials'],
          requiredCredentials: ['vercel-pat'],
        },
        sha256: 'c'.repeat(64),
        publisherVerified: true,
        publisherKeyId: 'release-works-2026',
        compatible: false,
        compatibilityError: 'Requires Clodex 2.0.0 or newer.',
        installedVersion: null,
        updateAvailable: false,
      },
    ],
    installed: [
      {
        id: 'github-workflow',
        version: '1.2.0',
        sha256: 'd'.repeat(64),
        source: 'official',
        installedAt: Date.parse('2026-07-02T09:00:00.000Z'),
        updatedAt: Date.parse('2026-07-02T09:00:00.000Z'),
        manifest: {
          schemaVersion: 1,
          id: 'github-workflow',
          version: '1.2.0',
          displayName: 'GitHub Workflow Assistant',
          description:
            'Investigate failed checks, inspect workflow runs, and prepare focused CI fixes.',
          publisher: 'Clodex Labs',
          publisherId: 'clodex-labs',
          compatibility: {
            minAppVersion: '1.12.0',
          },
          permissions: ['skills', 'network', 'credentials'],
          requiredCredentials: ['github-pat'],
        },
        publisherKeyId: 'clodex-labs-2026',
        publisherSignature: 'visual-regression-signature',
      },
    ],
  },
  disabledPluginIds: [],
  configuredCredentialIds: ['github-pat'],
};

const settingsNavigation = [
  { label: 'General', icon: SettingsIcon, active: true },
  { label: 'Agent OS', icon: BotIcon },
  { label: 'Memory', icon: DatabaseIcon },
  { label: 'Models & providers', icon: SparklesIcon },
  { label: 'Worktree setup', icon: GitBranchIcon },
  { label: 'Personalization', icon: PaletteIcon },
];

function VisualSurface({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="h-screen w-screen overflow-hidden bg-token-main-surface-primary text-token-text-primary"
      data-visual-fixture={name}
    >
      {children}
    </div>
  );
}

function SettingsFixture() {
  return (
    <VisualSurface name="settings">
      <div className="grid h-full grid-cols-[248px_minmax(0,1fr)]">
        <aside className="flex h-full flex-col border-token-border-light border-r bg-token-bg-secondary/55 p-3">
          <div className="px-2 pt-2 pb-4">
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-xl bg-clodex-green-400 text-white shadow-codex-md">
                <SparklesIcon className="size-4" />
              </span>
              <div>
                <div className="font-semibold text-sm">Clodex</div>
                <div className="text-[11px] text-token-text-tertiary">
                  Settings
                </div>
              </div>
            </div>
            <div className="mt-4 flex h-9 items-center gap-2 rounded-xl border border-token-border-light bg-token-main-surface-primary/75 px-3 text-token-text-tertiary text-xs shadow-codex-sm">
              <SearchIcon className="size-3.5" />
              Search settings…
            </div>
          </div>

          <nav className="flex flex-1 flex-col gap-1">
            <div className="px-2 pb-1 font-medium text-[10px] text-token-text-tertiary uppercase tracking-[0.1em]">
              Agent
            </div>
            {settingsNavigation.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  type="button"
                  className={cn(
                    'relative flex h-9 items-center gap-2.5 rounded-xl px-2.5 text-left text-sm',
                    item.active
                      ? 'bg-token-main-surface-primary text-token-text-primary shadow-codex-hairline'
                      : 'text-token-text-secondary',
                  )}
                >
                  {item.active && (
                    <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-clodex-green-400" />
                  )}
                  <Icon
                    className={cn(
                      'size-4',
                      item.active && 'text-clodex-green-400',
                    )}
                  />
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="rounded-xl border border-token-border-light bg-token-main-surface-primary/65 p-3">
            <div className="font-medium text-xs">Clodex Pro</div>
            <div className="mt-1 text-[11px] text-token-text-tertiary">
              Desktop build 0.0.0
            </div>
          </div>
        </aside>

        <SettingsPage
          eyebrow="Agent"
          title="General settings"
          description="Control how Clodex runs tasks, requests approval, and notifies you when work is ready."
          actions={
            <Button variant="primary" size="sm" className="rounded-xl">
              <PlusIcon className="size-3.5" />
              New profile
            </Button>
          }
          toolbar={
            <div className="grid grid-cols-3 gap-3">
              <SettingsSummaryCard
                accent
                label="active profile"
                value="Default"
                icon={<BotIcon className="size-4" />}
              />
              <SettingsSummaryCard
                label="approval policy"
                value="On request"
                icon={<ShieldCheckIcon className="size-4" />}
              />
              <SettingsSummaryCard
                label="notification pack"
                value="Bubble pops"
                icon={<BellIcon className="size-4" />}
              />
            </div>
          }
        >
          <div className="space-y-5">
            <SettingsPanel className="p-5">
              <SettingsSectionHeader
                title="Task behavior"
                description="Defaults used when a new task starts."
              />
              <div className="mt-5 divide-y divide-token-border-light">
                <div className="flex items-start justify-between gap-6 pb-4">
                  <div>
                    <h3 className="font-medium text-sm">Keep app awake</h3>
                    <p className="mt-1 text-token-text-secondary text-xs leading-5">
                      Prevent system sleep while an agent is actively running.
                    </p>
                  </div>
                  <Switch checked size="xs" onCheckedChange={() => undefined} />
                </div>
                <div className="flex items-start justify-between gap-6 pt-4">
                  <div>
                    <h3 className="font-medium text-sm">
                      Require approval for commands
                    </h3>
                    <p className="mt-1 text-token-text-secondary text-xs leading-5">
                      Pause before commands that can change files or external
                      state.
                    </p>
                  </div>
                  <Switch checked size="xs" onCheckedChange={() => undefined} />
                </div>
              </div>
            </SettingsPanel>

            <div className="grid grid-cols-2 gap-4">
              <SettingsPanel interactive className="p-5">
                <span className="flex size-9 items-center justify-center rounded-xl bg-clodex-green-400/10 text-clodex-green-400">
                  <CircleGaugeIcon className="size-4" />
                </span>
                <h3 className="mt-4 font-medium text-sm">Reasoning effort</h3>
                <p className="mt-1 text-token-text-secondary text-xs leading-5">
                  Balanced reasoning for implementation and review tasks.
                </p>
                <div className="mt-4 rounded-lg bg-token-bg-secondary px-3 py-2 text-xs">
                  Medium
                </div>
              </SettingsPanel>
              <SettingsPanel interactive className="p-5">
                <span className="flex size-9 items-center justify-center rounded-xl bg-token-bg-tertiary text-token-text-secondary">
                  <KeyRoundIcon className="size-4" />
                </span>
                <h3 className="mt-4 font-medium text-sm">Credentials</h3>
                <p className="mt-1 text-token-text-secondary text-xs leading-5">
                  Secrets stay encrypted and are never exposed to task output.
                </p>
                <div className="mt-4 flex items-center gap-2 text-success-foreground text-xs">
                  <CheckCircle2Icon className="size-3.5" />
                  Secure storage available
                </div>
              </SettingsPanel>
            </div>
          </div>
        </SettingsPage>
      </div>
    </VisualSurface>
  );
}

function ProjectsFixture() {
  return (
    <VisualSurface name="projects">
      <SidebarCollapsedProvider>
        <ProjectsIndex />
      </SidebarCollapsedProvider>
    </VisualSurface>
  );
}

function PullRequestFixture() {
  return (
    <VisualSurface name="hosted-pull-request">
      <HostedPullRequestReview
        pullRequest={hostedPullRequest}
        authenticated
        relativeNow={FIXED_NOW}
        onRefresh={() => undefined}
        onOpenExternal={() => undefined}
        onSubmitReview={async () => ({
          ok: true,
          reviewId: 91,
          reviewUrl:
            'https://github.com/openai/clodex/pull/418#pullrequestreview-91',
          state: 'COMMENTED',
          submittedAt: FIXED_NOW,
        })}
        onMerge={async () => ({
          ok: true,
          merged: true,
          mergeCommitSha: 'f49c2de',
          message: 'Pull request merged on GitHub.',
        })}
      />
    </VisualSurface>
  );
}

function QuickTaskFixture() {
  return (
    <VisualSurface name="quick-task">
      <QuickTaskComposer
        initialPrompt="Review the current changes, run the relevant tests, and summarize any remaining risks."
        hasCurrentWorkspace
        workspaceLabels={['clodex', 'design-system']}
        modelLabel="GPT-5 Codex"
        approvalLabel="On request"
        mode="window"
        shortcut={
          <span className="rounded-md border border-token-border-light bg-token-bg-secondary/60 px-1.5 py-0.5 font-mono text-[10px] text-token-text-tertiary">
            Esc
          </span>
        }
        onClose={() => undefined}
        onSubmit={async () => ({ ok: true })}
      />
    </VisualSurface>
  );
}

function GeneratedAppsFixture() {
  const [apps, setApps] = useState(generatedApps);
  const [selectedAppKey, setSelectedAppKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<GeneratedAppsNotice>(null);
  const selectedApp = apps.find((app) => app.key === selectedAppKey) ?? null;

  const launch = async (app: GeneratedApp) => {
    setNotice({
      tone: 'success',
      message: `Opened “${app.title}” in a new preview tab.`,
    });
  };
  const remove = async (app: GeneratedApp) => {
    setApps((current) =>
      current.filter((candidate) => candidate.key !== app.key),
    );
    setSelectedAppKey(null);
    setNotice({
      tone: 'success',
      message: `Deleted “${app.title}”. The owner task was preserved.`,
    });
    return true;
  };
  const regenerate = async (app: GeneratedApp) => {
    const updated: GeneratedApp = {
      ...app,
      status: 'regenerating',
      regenerationRequestedAt: FIXED_NOW,
    };
    setApps((current) =>
      current.map((candidate) =>
        candidate.key === app.key ? updated : candidate,
      ),
    );
    setNotice({
      tone: 'info',
      message:
        'Regeneration was sent to the owner task. Existing files stay available until replacements are ready.',
    });
    return true;
  };

  return (
    <VisualSurface name="generated-apps">
      {selectedApp ? (
        <GeneratedAppDetail
          app={selectedApp}
          isLoading={false}
          error={null}
          notice={notice}
          actionState={null}
          previewEnabled={false}
          onBack={() => setSelectedAppKey(null)}
          onRefresh={() => undefined}
          onLaunch={launch}
          onDelete={remove}
          onRegenerate={regenerate}
        />
      ) : (
        <GeneratedAppsCatalog
          apps={apps}
          summary={getGeneratedAppsSummary(apps)}
          isLoading={false}
          error={null}
          notice={notice}
          actionState={null}
          onRefresh={() => undefined}
          onOpenDetails={(app) => setSelectedAppKey(app.key)}
          onLaunch={launch}
          onDelete={remove}
          onRegenerate={regenerate}
        />
      )}
    </VisualSurface>
  );
}

function PluginLibraryFixture() {
  const [snapshot, setSnapshot] = useState(pluginLibrarySnapshot);
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [notice, setNotice] = useState<PluginLibraryNotice>(null);
  const [actionState, setActionState] =
    useState<PluginLibraryActionState>(null);
  const selectedItem =
    createPluginLibraryItems(snapshot).find(
      (item) => item.id === selectedPluginId,
    ) ?? null;

  const runMarketplaceAction = async (
    kind: 'install' | 'update' | 'uninstall',
    pluginId: string,
  ) => {
    setActionState({ kind, pluginId });
    setSnapshot((current) => {
      const catalogItem = current.marketplace.catalog.find(
        (item) => item.manifest.id === pluginId,
      );
      if (!catalogItem) return current;

      if (kind === 'uninstall') {
        return {
          ...current,
          plugins: current.plugins.filter(
            (plugin) => plugin.id !== pluginId || plugin.source === 'bundled',
          ),
          marketplace: {
            ...current.marketplace,
            catalog: current.marketplace.catalog.map((item) =>
              item.manifest.id === pluginId
                ? {
                    ...item,
                    installedVersion: null,
                    updateAvailable: false,
                  }
                : item,
            ),
            installed: current.marketplace.installed.filter(
              (entry) => entry.id !== pluginId,
            ),
          },
        };
      }

      const installedEntry = {
        id: pluginId,
        version: catalogItem.manifest.version,
        sha256: catalogItem.sha256,
        source: 'official' as const,
        installedAt: Date.parse(FIXED_NOW),
        updatedAt: Date.parse(FIXED_NOW),
        manifest: catalogItem.manifest,
        publisherKeyId: catalogItem.publisherKeyId ?? undefined,
      };
      return {
        ...current,
        marketplace: {
          ...current.marketplace,
          catalog: current.marketplace.catalog.map((item) =>
            item.manifest.id === pluginId
              ? {
                  ...item,
                  installedVersion: item.manifest.version,
                  updateAvailable: false,
                }
              : item,
          ),
          installed: [
            ...current.marketplace.installed.filter(
              (entry) => entry.id !== pluginId,
            ),
            installedEntry,
          ],
        },
        plugins: current.plugins.map((plugin) =>
          plugin.id === pluginId
            ? { ...plugin, version: catalogItem.manifest.version }
            : plugin,
        ),
      };
    });
    setNotice({
      tone: 'success',
      message:
        kind === 'uninstall'
          ? `Uninstalled ${catalogItemLabel(pluginId)}.`
          : kind === 'update'
            ? `Updated ${catalogItemLabel(pluginId)} to the latest signed version.`
            : `Installed ${catalogItemLabel(pluginId)}.`,
    });
    if (kind === 'uninstall') setSelectedPluginId(null);
    setActionState(null);
  };

  const togglePlugin = async (pluginId: string, enabled: boolean) => {
    setActionState({ kind: 'toggle', pluginId });
    setSnapshot((current) => ({
      ...current,
      disabledPluginIds: enabled
        ? current.disabledPluginIds.filter((id) => id !== pluginId)
        : Array.from(new Set([...current.disabledPluginIds, pluginId])),
    }));
    setNotice({
      tone: 'info',
      message: `${catalogItemLabel(pluginId)} is now ${
        enabled ? 'available to agents' : 'disabled'
      }.`,
    });
    setActionState(null);
  };

  const saveCredential = async (typeId: string) => {
    setSnapshot((current) => ({
      ...current,
      configuredCredentialIds: Array.from(
        new Set([...current.configuredCredentialIds, typeId]),
      ),
    }));
    setNotice({
      tone: 'success',
      message: 'Credential saved in encrypted local storage.',
    });
  };

  const deleteCredential = async (typeId: string) => {
    setSnapshot((current) => ({
      ...current,
      configuredCredentialIds: current.configuredCredentialIds.filter(
        (id) => id !== typeId,
      ),
    }));
    setNotice({
      tone: 'info',
      message: 'Credential removed from encrypted local storage.',
    });
  };

  return (
    <VisualSurface name="plugin-library">
      {selectedPluginId ? (
        <PluginLibraryDetail
          item={selectedItem}
          snapshot={snapshot}
          isLoading={false}
          error={null}
          notice={notice}
          actionState={actionState}
          onBack={() => setSelectedPluginId(null)}
          onRefresh={() => undefined}
          onMarketplaceAction={runMarketplaceAction}
          onToggle={togglePlugin}
          onSaveCredential={saveCredential}
          onDeleteCredential={deleteCredential}
        />
      ) : (
        <PluginLibraryCatalog
          snapshot={snapshot}
          isLoading={false}
          error={null}
          notice={notice}
          actionState={actionState}
          onRefresh={() => undefined}
          onOpenPlugin={setSelectedPluginId}
          onMarketplaceAction={runMarketplaceAction}
          onToggle={togglePlugin}
        />
      )}
    </VisualSurface>
  );
}

function catalogItemLabel(pluginId: string): string {
  return (
    pluginLibrarySnapshot.marketplace.catalog.find(
      (item) => item.manifest.id === pluginId,
    )?.manifest.displayName ??
    pluginLibrarySnapshot.plugins.find((plugin) => plugin.id === pluginId)
      ?.displayName ??
    pluginId
  );
}

const meta = {
  title: 'Visual Regression/Codex Surfaces',
  parameters: {
    layout: 'fullscreen',
    visualRegression: true,
  },
  decorators: [
    (Story) => (
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj;

export const Settings: Story = {
  render: () => <SettingsFixture />,
};

export const Projects: Story = {
  decorators: [withMockKarton],
  parameters: {
    agentInstanceId: 'task-current',
    mockKartonProcedures: {
      agents: {
        getChatProjects: async (offset: number) =>
          offset === 0 ? projects : [],
        create: async () => 'task-created',
        resume: async () => undefined,
      },
      browser: {
        setLastOpenAgentId: async () => undefined,
      },
      appScreen: {
        closeProjects: async () => undefined,
      },
    },
  },
  render: () => <ProjectsFixture />,
};

export const HostedPullRequest: Story = {
  render: () => <PullRequestFixture />,
};

export const QuickTask: Story = {
  render: () => <QuickTaskFixture />,
};

export const GeneratedApps: Story = {
  decorators: [withMockKarton],
  render: () => <GeneratedAppsFixture />,
};

export const PluginLibrary: Story = {
  render: () => <PluginLibraryFixture />,
};
