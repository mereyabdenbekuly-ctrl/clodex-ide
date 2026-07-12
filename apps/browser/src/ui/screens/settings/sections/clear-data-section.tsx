import { Button } from '@clodex/stage-ui/components/button';
import { Checkbox } from '@clodex/stage-ui/components/checkbox';
import { useKartonProcedure } from '@ui/hooks/use-karton';
import { cn } from '@ui/utils';
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  DatabaseIcon,
  Loader2Icon,
  ShieldAlertIcon,
} from 'lucide-react';
import { useState } from 'react';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSectionHeader,
  SettingsSummaryCard,
} from '../_components/settings-page';

type DataType =
  | 'history'
  | 'favicons'
  | 'downloads'
  | 'cookies'
  | 'cache'
  | 'storage'
  | 'indexedDB'
  | 'serviceWorkers'
  | 'cacheStorage'
  | 'permissionExceptions';

interface DataOption {
  id: DataType;
  label: string;
  description: string;
}

const dataOptions: DataOption[] = [
  {
    id: 'history',
    label: 'Browsing history',
    description: 'URLs, visits, and search terms',
  },
  {
    id: 'downloads',
    label: 'Download history',
    description: 'List of downloaded files (not the files themselves)',
  },
  {
    id: 'cookies',
    label: 'Cookies',
    description: 'Site cookies and login sessions',
  },
  {
    id: 'cache',
    label: 'Cached images and files',
    description: 'HTTP cache for faster page loading',
  },
  {
    id: 'storage',
    label: 'Local storage',
    description: 'localStorage and sessionStorage data',
  },
  {
    id: 'indexedDB',
    label: 'IndexedDB',
    description: 'Structured data stored by websites',
  },
  {
    id: 'cacheStorage',
    label: 'Cache Storage',
    description: 'Cache API storage used by web apps',
  },
  {
    id: 'serviceWorkers',
    label: 'Service Workers',
    description: 'Background scripts that power offline functionality',
  },
  {
    id: 'favicons',
    label: 'Cached favicons',
    description: 'Site icons and images',
  },
  {
    id: 'permissionExceptions',
    label: 'Site permission settings',
    description: 'Saved Allow/Block choices for camera, location, etc.',
  },
];

export function ClearDataSection() {
  const [selectedTypes, setSelectedTypes] = useState<Set<DataType>>(
    new Set([
      'history',
      'downloads',
      'cookies',
      'cache',
      'storage',
      'indexedDB',
      'cacheStorage',
      'serviceWorkers',
      'favicons',
    ] as const),
  );
  const [clearingRange, setClearingRange] = useState<
    'last24h' | 'allTime' | null
  >(null);
  const [result, setResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const clearBrowsingData = useKartonProcedure(
    (p) => p.browser.clearBrowsingData,
  );

  const toggleDataType = (type: DataType) => {
    setSelectedTypes((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(type)) {
        newSet.delete(type);
      } else {
        newSet.add(type);
      }
      return newSet;
    });
  };

  const selectAll = () => {
    setSelectedTypes(new Set(dataOptions.map((option) => option.id)));
    setResult(null);
  };

  const selectNone = () => {
    setSelectedTypes(new Set());
    setResult(null);
  };

  const handleClearData = async (timeRange: 'last24h' | 'allTime') => {
    if (selectedTypes.size === 0) {
      setResult({
        success: false,
        message: 'Please select at least one data type to clear',
      });
      return;
    }

    setClearingRange(timeRange);
    setResult(null);

    try {
      const now = new Date();
      const options = {
        history: selectedTypes.has('history'),
        favicons: selectedTypes.has('favicons'),
        downloads: selectedTypes.has('downloads'),
        cookies: selectedTypes.has('cookies'),
        cache: selectedTypes.has('cache'),
        storage: selectedTypes.has('storage'),
        indexedDB: selectedTypes.has('indexedDB'),
        serviceWorkers: selectedTypes.has('serviceWorkers'),
        cacheStorage: selectedTypes.has('cacheStorage'),
        permissionExceptions: selectedTypes.has('permissionExceptions'),
        timeRange:
          timeRange === 'last24h'
            ? {
                start: new Date(now.getTime() - 24 * 60 * 60 * 1000),
                end: now,
              }
            : undefined,
        vacuum: true,
      };

      const response = await clearBrowsingData(options);

      if (response.success) {
        const clearedItems: string[] = [];
        if (response.historyEntriesCleared) {
          clearedItems.push(
            `${response.historyEntriesCleared} history ${response.historyEntriesCleared === 1 ? 'entry' : 'entries'}`,
          );
        }
        if (response.downloadsCleared === true) {
          clearedItems.push('downloads');
        }
        if (response.faviconsCleared) {
          clearedItems.push(`${response.faviconsCleared} favicons`);
        }
        if (response.cookiesCleared) {
          clearedItems.push('cookies');
        }
        if (response.cacheCleared) {
          clearedItems.push('cache');
        }
        if (response.storageCleared) {
          clearedItems.push('storage');
        }
        if (response.permissionExceptionsCleared) {
          clearedItems.push('site permission settings');
        }

        setResult({
          success: true,
          message:
            clearedItems.length > 0
              ? `Successfully cleared ${clearedItems.join(', ')}`
              : 'Data cleared successfully',
        });
      } else {
        setResult({
          success: false,
          message: response.error || 'Failed to clear data',
        });
      }
    } catch (error) {
      setResult({
        success: false,
        message:
          error instanceof Error ? error.message : 'Failed to clear data',
      });
    } finally {
      setClearingRange(null);
    }
  };

  const isClearing = clearingRange !== null;

  return (
    <SettingsPage
      eyebrow="Privacy"
      title="Clear data"
      description="Remove browsing records stored by Clodex. This does not delete downloaded files or your agent task history."
      toolbar={
        <div className="max-w-xs">
          <SettingsSummaryCard
            accent={selectedTypes.size > 0}
            label="data categories selected"
            value={`${selectedTypes.size} / ${dataOptions.length}`}
            icon={<DatabaseIcon className="size-4" />}
          />
        </div>
      }
    >
      <div className="space-y-6">
        <section className="space-y-3">
          <SettingsSectionHeader
            title="Select data to clear"
            description="Choose exactly which browser data categories should be removed."
            trailing={
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={
                    isClearing || selectedTypes.size === dataOptions.length
                  }
                  onClick={selectAll}
                >
                  Select all
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={isClearing || selectedTypes.size === 0}
                  onClick={selectNone}
                >
                  Select none
                </Button>
              </div>
            }
          />

          <div className="grid gap-3 sm:grid-cols-2">
            {dataOptions.map((option) => {
              const isSelected = selectedTypes.has(option.id);
              return (
                <label
                  key={option.id}
                  className={cn(
                    'flex min-h-20 cursor-pointer select-none items-start gap-3 rounded-2xl border bg-token-main-surface-primary/72 p-3.5 shadow-codex-sm transition-[border-color,background-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-token-border-default hover:bg-token-main-surface-primary hover:shadow-codex-md',
                    isSelected
                      ? 'border-codex-blue-400/28 bg-codex-blue-400/5'
                      : 'border-token-border-light',
                  )}
                  htmlFor={`clear-data-${option.id}`}
                >
                  <Checkbox
                    id={`clear-data-${option.id}`}
                    checked={isSelected}
                    onCheckedChange={() => toggleDataType(option.id)}
                    disabled={isClearing}
                    className="mt-0.5"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium text-sm text-token-text-primary">
                      {option.label}
                    </span>
                    <span className="mt-0.5 text-token-text-secondary text-xs leading-5">
                      {option.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </section>

        <SettingsPanel className="overflow-hidden border-error-solid/15">
          <div className="flex items-start gap-3 p-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-error-solid/18 bg-error-solid/7 text-error-solid">
              <ShieldAlertIcon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="font-medium text-sm text-token-text-primary">
                Permanently clear selected browser data
              </h3>
              <p className="mt-1 text-token-text-secondary text-xs leading-5">
                Clearing cookies or site storage may sign you out of websites.
                This action cannot be undone.
              </p>
            </div>
          </div>
          <div className="flex flex-col-reverse gap-2 border-token-border-light border-t bg-token-bg-secondary/35 p-4 sm:flex-row sm:justify-end">
            <Button
              onClick={() => handleClearData('last24h')}
              disabled={isClearing || selectedTypes.size === 0}
              variant="secondary"
              size="sm"
              className="rounded-xl"
            >
              {clearingRange === 'last24h' && (
                <Loader2Icon className="size-4 animate-spin" />
              )}
              {clearingRange === 'last24h'
                ? 'Clearing last 24 hours…'
                : 'Clear last 24 hours'}
            </Button>

            <Button
              onClick={() => handleClearData('allTime')}
              disabled={isClearing || selectedTypes.size === 0}
              variant="destructive"
              size="sm"
              className="rounded-xl"
            >
              {clearingRange === 'allTime' && (
                <Loader2Icon className="size-4 animate-spin" />
              )}
              {clearingRange === 'allTime'
                ? 'Clearing all data…'
                : 'Clear all time'}
            </Button>
          </div>
        </SettingsPanel>

        {result && (
          <div
            role="status"
            className={cn(
              'flex items-start gap-3 rounded-2xl border px-4 py-3.5',
              result.success
                ? 'border-success-solid/20 bg-success-solid/7'
                : 'border-error-solid/20 bg-error-solid/7',
            )}
          >
            {result.success ? (
              <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success-solid" />
            ) : (
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-error-solid" />
            )}
            <p className="text-sm text-token-text-primary">{result.message}</p>
          </div>
        )}
      </div>
    </SettingsPage>
  );
}
