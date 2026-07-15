import { useKartonState, useKartonProcedure } from '@ui/hooks/use-karton';
import {
  RadioGroup,
  Radio,
  RadioLabel,
} from '@clodex/stage-ui/components/radio';
import { produceWithPatches, enablePatches } from 'immer';
import type { UpdateChannel } from '@shared/karton-contracts/ui/shared-types';
import { cn } from '@clodex/stage-ui/lib/utils';
import { buttonVariants } from '@clodex/stage-ui/components/button';
import { Button } from '@clodex/stage-ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogClose,
  DialogHeader,
} from '@clodex/stage-ui/components/dialog';
import { Input } from '@clodex/stage-ui/components/input';
import {
  AppWindowIcon,
  CpuIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  ScrollTextIcon,
} from 'lucide-react';
import { IconGithub, IconRefreshAnticlockwiseOutline18 } from '@clodex/icons';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import agplLicenseText from '@assets/agpl-3.0-license.txt?raw';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@clodex/stage-ui/components/tooltip';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSectionHeader,
  SettingsSummaryCard,
} from '../_components/settings-page';

enablePatches();

interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  repository: string;
  publisher: string;
  licenseText: string;
}

function AppUpdateStatus() {
  const autoUpdate = useKartonState((s) => s.autoUpdate);
  const checkForUpdates = useKartonProcedure(
    (p) => p.autoUpdate.checkForUpdates,
  );
  const quitAndInstall = useKartonProcedure((p) => p.autoUpdate.quitAndInstall);

  if (autoUpdate.status === 'unsupported') {
    return null;
  }

  const renderButton = () => {
    switch (autoUpdate.status) {
      case 'checking':
        return (
          <Button variant="ghost" size="sm" className="rounded-lg" disabled>
            <IconRefreshAnticlockwiseOutline18 className="size-3 animate-spin" />
            Checking for Updates
          </Button>
        );
      case 'downloading':
        return (
          <Button variant="secondary" size="sm" className="rounded-xl" disabled>
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            Downloading Update...
          </Button>
        );
      case 'not-available':
        return (
          <>
            <span className="rounded-full border border-success-solid/20 bg-success-solid/7 px-2.5 py-1 font-medium text-[10px] text-success-solid uppercase tracking-[0.06em]">
              Up to date
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-lg"
              onClick={() => checkForUpdates()}
            >
              <IconRefreshAnticlockwiseOutline18 className="size-3" />
              Check Again
            </Button>
          </>
        );
      case 'ready':
        return (
          <Button
            size="sm"
            className="rounded-xl"
            onClick={() => quitAndInstall()}
          >
            Install Update & Restart
          </Button>
        );
      case 'error':
      case 'idle':
      default:
        return (
          <Button
            variant="ghost"
            size="sm"
            className="rounded-lg"
            onClick={() => checkForUpdates()}
          >
            <IconRefreshAnticlockwiseOutline18 className="size-3" />
            Check for Updates
          </Button>
        );
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {autoUpdate.status === 'ready' && autoUpdate.updateInfo?.releaseName && (
        <p className="text-token-text-secondary text-xs">
          Version {autoUpdate.updateInfo.releaseName} available
        </p>
      )}
      {autoUpdate.status === 'error' && autoUpdate.errorMessage && (
        <p className="text-error-solid text-xs">{autoUpdate.errorMessage}</p>
      )}
      <div className="flex items-center gap-3">{renderButton()}</div>
    </div>
  );
}

function UpdateChannelSetting() {
  const preferences = useKartonState((s) => s.preferences);
  const appInfo = useKartonState((s) => s.appInfo);
  const updatePreferences = useKartonProcedure((p) => p.preferences.update);

  const inferredChannel: UpdateChannel = appInfo.version.includes('-alpha')
    ? 'alpha'
    : 'beta';

  const currentChannel = preferences.updateChannel ?? inferredChannel;

  const handleChannelChange = async (value: unknown) => {
    const channel = value as UpdateChannel;
    const [, patches] = produceWithPatches(preferences, (draft) => {
      draft.updateChannel = channel;
    });
    await updatePreferences(patches);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium text-sm text-token-text-primary">
          Update Channel
        </h3>
        <p className="text-token-text-secondary text-xs leading-5">
          Choose which pre-release channel to receive updates from.
        </p>
      </div>

      <RadioGroup
        value={currentChannel}
        onValueChange={handleChannelChange}
        className="grid gap-3 sm:grid-cols-2"
      >
        <RadioLabel className="rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3">
          <Radio value="beta" />
          <div className="flex flex-col">
            <span className="font-medium text-sm text-token-text-primary">
              Beta
            </span>
            <span className="text-token-text-secondary text-xs">
              More stable pre-release updates
            </span>
          </div>
        </RadioLabel>

        <RadioLabel className="rounded-xl border border-token-border-light bg-token-bg-secondary/35 p-3">
          <Radio value="alpha" />
          <div className="flex flex-col">
            <span className="font-medium text-sm text-token-text-primary">
              Alpha
            </span>
            <span className="text-token-text-secondary text-xs">
              Bleeding-edge updates including alpha and beta releases
            </span>
          </div>
        </RadioLabel>
      </RadioGroup>
    </div>
  );
}

function LicenseTextDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: LicenseEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!entry) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-2xl gap-4.5 overflow-hidden">
        <DialogClose />
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3 pt-1">
            {entry.name}@{entry.version}
            <span className="rounded-md bg-surface-1 px-2 py-0.5 font-mono text-muted-foreground text-xs">
              {entry.license}
            </span>
            {entry.repository && (
              <Tooltip>
                <TooltipTrigger>
                  <a
                    href={entry.repository}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      buttonVariants({ variant: 'ghost', size: 'icon-md' }),
                      'w-min p-0',
                    )}
                    aria-label="GitHub Repository"
                  >
                    <IconGithub className="size-4" />
                  </a>
                </TooltipTrigger>
                <TooltipContent>{entry.repository}</TooltipContent>
              </Tooltip>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto rounded-lg bg-surface-1 p-4">
          {entry.licenseText ? (
            <pre className="whitespace-pre-wrap font-mono text-foreground text-xs leading-relaxed">
              {entry.licenseText}
            </pre>
          ) : (
            <p className="text-muted-foreground text-sm italic">
              No license text available for this package.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OpenSourceLicenses() {
  const [licenses, setLicenses] = useState<LicenseEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<LicenseEntry | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const loadLicenses = useCallback(async () => {
    if (licenses) {
      setExpanded(true);
      return;
    }
    setLoading(true);
    try {
      const data = await import('@pages/generated/licenses.json');
      setLicenses(data.default as LicenseEntry[]);
      setExpanded(true);
    } catch {
      console.error('Failed to load license data');
    } finally {
      setLoading(false);
    }
  }, [licenses]);

  const filteredLicenses = useMemo(() => {
    if (!licenses) return [];
    if (!search.trim()) return licenses;
    const q = search.toLowerCase();
    return licenses.filter(
      (e) =>
        e.name.toLowerCase().includes(q) || e.license.toLowerCase().includes(q),
    );
  }, [licenses, search]);

  const licenseSummary = useMemo(() => {
    if (!licenses) return null;
    const counts: Record<string, number> = {};
    for (const entry of licenses) {
      counts[entry.license] = (counts[entry.license] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [licenses]);

  useEffect(() => {
    if (expanded && listRef.current) {
      listRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [expanded]);

  const handleViewLicense = useCallback((entry: LicenseEntry) => {
    setSelectedEntry(entry);
    setDialogOpen(true);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="font-medium text-sm text-token-text-primary">
            Open Source Licenses
          </h3>
          <p className="text-token-text-secondary text-xs leading-5">
            This software incorporates open source packages. View their licenses
            below.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0 rounded-xl"
          onClick={expanded ? () => setExpanded(false) : loadLicenses}
          disabled={loading}
        >
          {loading ? 'Loading...' : expanded ? 'Collapse' : 'View All'}
        </Button>
      </div>

      {expanded && licenses && (
        <div ref={listRef} className="flex flex-col gap-3">
          {licenseSummary && (
            <div className="flex flex-wrap gap-2">
              {licenseSummary.map(([license, count]) => (
                <span
                  key={license}
                  className="rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2.5 py-1 text-token-text-secondary text-xs"
                >
                  {license}{' '}
                  <span className="font-medium text-token-text-primary">
                    {count}
                  </span>
                </span>
              ))}
              <span className="rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2.5 py-1 text-token-text-secondary text-xs">
                Total{' '}
                <span className="font-medium text-token-text-primary">
                  {licenses.length}
                </span>
              </span>
            </div>
          )}

          <Input
            size="sm"
            value={search}
            onValueChange={(val) => setSearch(val as string)}
            debounce={150}
            placeholder="Search packages or licenses..."
            className="rounded-xl"
          />

          <div className="scrollbar-subtle h-[400px] overflow-y-auto rounded-xl border border-token-border-light">
            {filteredLicenses.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-token-text-secondary">
                No packages found matching &ldquo;{search}&rdquo;
              </div>
            ) : (
              filteredLicenses.map((entry) => (
                <div
                  key={`${entry.name}@${entry.version}`}
                  className="flex items-center justify-between border-token-border-light border-b px-4 py-2.5 transition-colors last:border-b-0 hover:bg-token-list-hover-background"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium text-sm text-token-text-primary">
                        {entry.name}
                      </span>
                      <span className="text-token-text-tertiary text-xs">
                        {entry.version}
                        {entry.publisher && ` · ${entry.publisher}`}
                      </span>
                    </div>
                    <span className="shrink-0 rounded-full border border-token-border-light bg-token-bg-secondary/55 px-2 py-0.5 font-mono text-[10px] text-token-text-secondary">
                      {entry.license}
                    </span>
                  </div>
                  <div className="ml-3 flex shrink-0 items-center gap-1">
                    {entry.repository && (
                      <a
                        href={entry.repository}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(
                          buttonVariants({
                            variant: 'ghost',
                            size: 'icon-xs',
                          }),
                        )}
                        title="View repository"
                      >
                        <ExternalLinkIcon className="size-3.5" />
                      </a>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => handleViewLicense(entry)}
                      title="View license text"
                    >
                      <ScrollTextIcon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <LicenseTextDialog
        entry={selectedEntry}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
}

function AboutDetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4">
      <span className="font-medium text-token-text-tertiary text-xs">
        {label}
      </span>
      <div className="min-w-0 break-all text-sm text-token-text-primary">
        {children}
      </div>
    </div>
  );
}

export function AboutSection() {
  const appInfo = useKartonState((s) => s.appInfo);
  const [appLicenseOpen, setAppLicenseOpen] = useState(false);

  return (
    <>
      <SettingsPage
        eyebrow="Application"
        title="About Clodex"
        description="Version, update channel, runtime details, licensing, and open-source acknowledgements."
        toolbar={
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <SettingsSummaryCard
              accent
              label="installed version"
              value={appInfo.version}
              icon={<AppWindowIcon className="size-4" />}
            />
            <SettingsSummaryCard
              label="release channel"
              value={
                <span className="capitalize">{appInfo.releaseChannel}</span>
              }
              icon={<GitBranchIcon className="size-4" />}
            />
            <SettingsSummaryCard
              label="runtime target"
              value={`${appInfo.platform} · ${appInfo.arch}`}
              icon={<CpuIcon className="size-4" />}
            />
          </div>
        }
      >
        <div className="space-y-8">
          <SettingsPanel className="divide-y divide-token-border-light overflow-hidden">
            <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h2 className="font-bold text-3xl text-token-text-primary leading-none tracking-[-0.04em]">
                    clodex
                  </h2>
                  <p className="text-base text-token-text-tertiary leading-none">
                    {appInfo.version}
                    {appInfo.name !== 'clodex' && (
                      <span>
                        {' ('}
                        {appInfo.name
                          .replace(/^clodex\s*/, '')
                          .replace(/[()]/g, '')}
                        {')'}
                      </span>
                    )}
                  </p>
                </div>
                <p className="mt-2 max-w-xl text-token-text-secondary text-xs leading-5">
                  The local-first agentic workspace for browser research, coding
                  tasks, and tool-assisted execution.
                </p>
              </div>
              <div className="shrink-0">
                <AppUpdateStatus />
              </div>
            </div>

            {appInfo.releaseChannel === 'prerelease' && (
              <div className="p-5">
                <UpdateChannelSetting />
              </div>
            )}

            <div className="flex flex-col gap-4 p-5">
              <SettingsSectionHeader
                title="Build details"
                description="Technical metadata reported by the running desktop build."
              />
              <div className="flex flex-col gap-y-3">
                <AboutDetailRow label="Bundle ID">
                  {appInfo.bundleId}
                </AboutDetailRow>
                <AboutDetailRow label="Release channel">
                  <span className="capitalize">{appInfo.releaseChannel}</span>
                </AboutDetailRow>
                <AboutDetailRow label="Platform">
                  <span className="capitalize">{appInfo.platform}</span>
                </AboutDetailRow>
                <AboutDetailRow label="Architecture">
                  {appInfo.arch}
                </AboutDetailRow>
                <AboutDetailRow label="Author">{appInfo.author}</AboutDetailRow>
                <AboutDetailRow label="Copyright">
                  {appInfo.copyright}
                </AboutDetailRow>
                <AboutDetailRow label="License">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-token-text-primary">
                      AGPL-3.0
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => {
                        setAppLicenseOpen(true);
                      }}
                      title="View full license text"
                    >
                      <ScrollTextIcon className="size-3.5" />
                    </Button>
                  </div>
                </AboutDetailRow>
                <AboutDetailRow label="Homepage">
                  <a
                    href={appInfo.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      buttonVariants({ variant: 'link', size: 'sm' }),
                      'inline-flex h-auto max-w-full justify-start truncate p-0 text-clodex-green-400',
                    )}
                  >
                    {appInfo.homepage}
                  </a>
                </AboutDetailRow>
                <AboutDetailRow label="Other versions">
                  {Object.entries(appInfo.otherVersions).map(([key, value]) => (
                    <div key={key}>
                      {key}: {value ?? 'N/A'}
                    </div>
                  ))}
                </AboutDetailRow>
              </div>
            </div>
          </SettingsPanel>

          <section className="space-y-3">
            <SettingsSectionHeader
              title="Licenses"
              description="Review open-source packages distributed with this Clodex build."
            />
            <SettingsPanel className="p-5">
              <OpenSourceLicenses />
            </SettingsPanel>
          </section>
        </div>
      </SettingsPage>

      <LicenseTextDialog
        entry={{
          name: appInfo.name,
          version: appInfo.version,
          license: 'AGPL-3.0',
          repository: 'https://github.com/mereyabdenbekuly-ctrl/clodex-ide',
          publisher: 'Clodex Labs',
          licenseText: agplLicenseText,
        }}
        open={appLicenseOpen}
        onOpenChange={setAppLicenseOpen}
      />
    </>
  );
}
