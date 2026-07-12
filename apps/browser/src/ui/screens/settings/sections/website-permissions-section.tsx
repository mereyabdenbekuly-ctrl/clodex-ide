import { useCallback } from 'react';
import { Button } from '@clodex/stage-ui/components/button';
import { Select } from '@clodex/stage-ui/components/select';
import { useKartonState, useKartonProcedure } from '@ui/hooks/use-karton';
import { cn } from '@ui/utils';
import { produceWithPatches, enablePatches } from 'immer';
import { ChevronLeftIcon, GlobeLockIcon } from 'lucide-react';
import type { ConfigurablePermissionType } from '@shared/karton-contracts/ui/shared-types';
import {
  PermissionSetting,
  configurablePermissionTypes,
} from '@shared/karton-contracts/ui/shared-types';
import {
  SettingsPage,
  SettingsPanel,
  SettingsSectionHeader,
  SettingsSummaryCard,
} from '../_components/settings-page';

enablePatches();

/** Human-readable labels for permission types */
const permissionTypeLabels: Record<ConfigurablePermissionType, string> = {
  media: 'Camera & Microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
  fullscreen: 'Fullscreen',
  bluetooth: 'Bluetooth',
  hid: 'HID Devices',
  serial: 'Serial Ports',
  usb: 'USB Devices',
  'clipboard-read': 'Clipboard Read',
  'display-capture': 'Screen Capture',
  midi: 'MIDI Devices',
  'idle-detection': 'Idle Detection',
  'speaker-selection': 'Speaker Selection',
  'storage-access': 'Storage Access',
};

/** Human-readable labels for permission settings */
const permissionSettingLabels: Record<PermissionSetting | -1, string> = {
  [-1]: 'Default',
  [PermissionSetting.Ask]: 'Ask',
  [PermissionSetting.Allow]: 'Allow',
  [PermissionSetting.Block]: 'Block',
};

export function WebsitePermissionsSection() {
  const settingsRoute = useKartonState((s) => s.appScreen.settingsRoute);
  const host =
    settingsRoute.section === 'website-permissions' ? settingsRoute.host : '';
  const setSettingsRoute = useKartonProcedure(
    (p) => p.appScreen.setSettingsRoute,
  );
  const preferences = useKartonState((s) => s.preferences);
  const updatePreferences = useKartonProcedure((p) => p.preferences.update);

  // Get the current setting for a permission type for this host
  const getHostSetting = useCallback(
    (permissionType: ConfigurablePermissionType): PermissionSetting | -1 => {
      const exception =
        preferences.permissions?.exceptions?.[permissionType]?.[host];
      if (exception !== undefined) {
        return exception.setting;
      }
      return -1; // Default (no override)
    },
    [preferences, host],
  );

  // Get the effective default setting for a permission type
  const getDefaultSetting = useCallback(
    (permissionType: ConfigurablePermissionType): PermissionSetting => {
      return (
        preferences.permissions?.defaults?.[permissionType] ??
        PermissionSetting.Ask
      );
    },
    [preferences],
  );

  const handlePermissionChange = useCallback(
    async (permissionType: ConfigurablePermissionType, value: string) => {
      const settingValue = Number.parseInt(value, 10);

      const [, patches] = produceWithPatches(preferences, (draft) => {
        // Ensure structure exists
        if (!draft.permissions) {
          draft.permissions = {
            defaults: {},
            exceptions: {},
          } as typeof draft.permissions;
        }
        if (!draft.permissions.exceptions) {
          draft.permissions.exceptions =
            {} as typeof draft.permissions.exceptions;
        }
        if (!draft.permissions.exceptions[permissionType]) {
          draft.permissions.exceptions[permissionType] = {};
        }

        if (settingValue === -1) {
          // Remove the override (set to default)
          delete draft.permissions.exceptions[permissionType][host];
        } else {
          // Set the override
          draft.permissions.exceptions[permissionType][host] = {
            setting: settingValue as PermissionSetting,
            lastModified: Date.now(),
          };
        }
      });

      await updatePreferences(patches);
    },
    [preferences, updatePreferences, host],
  );

  // Permissions that require device selection - "Allow" doesn't make sense
  const deviceSelectionPermissions: ConfigurablePermissionType[] = [
    'bluetooth',
    'hid',
    'serial',
    'usb',
  ];

  // Options for the select dropdown
  const getSettingOptions = useCallback(
    (permissionType: ConfigurablePermissionType) => {
      const defaultSetting = getDefaultSetting(permissionType);
      const defaultLabel = permissionSettingLabels[defaultSetting];
      const isDevicePermission =
        deviceSelectionPermissions.includes(permissionType);

      const options = [
        {
          value: '-1',
          label: 'Default',
          description: `Use global default (${defaultLabel})`,
        },
        {
          value: String(PermissionSetting.Ask),
          label: 'Ask',
          description: 'Ask every time',
        },
      ];

      // Only add "Allow" for non-device permissions
      if (!isDevicePermission) {
        options.push({
          value: String(PermissionSetting.Allow),
          label: 'Allow',
          description: 'Always allow for this site',
        });
      }

      options.push({
        value: String(PermissionSetting.Block),
        label: 'Block',
        description: 'Always block for this site',
      });

      return options;
    },
    [getDefaultSetting],
  );

  // Count how many overrides are set for this host
  const overrideCount = configurablePermissionTypes.filter(
    (type) => getHostSetting(type) !== -1,
  ).length;

  if (!host) {
    return (
      <SettingsPage
        eyebrow="Browser"
        title="Website permissions"
        description="Inspect and change the permission overrides for a specific website."
        actions={
          <Button
            variant="secondary"
            size="sm"
            className="rounded-xl"
            onClick={() => setSettingsRoute({ section: 'browsing' })}
          >
            <ChevronLeftIcon className="size-4" />
            Back to Browsing
          </Button>
        }
      >
        <SettingsPanel className="flex min-h-56 items-center justify-center p-6 text-center">
          <div className="max-w-md">
            <span className="mx-auto flex size-10 items-center justify-center rounded-xl bg-token-bg-tertiary text-token-text-secondary">
              <GlobeLockIcon className="size-4.5" />
            </span>
            <h2 className="mt-3 font-medium text-sm text-token-text-primary">
              No website selected
            </h2>
            <p className="mt-1 text-token-text-secondary text-xs leading-5">
              Select a site with custom permission settings from the Browsing
              page.
            </p>
          </div>
        </SettingsPanel>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      eyebrow="Browser"
      title="Website permissions"
      description={`Configure how ${host} can access browser features.`}
      actions={
        <Button
          variant="secondary"
          size="sm"
          className="rounded-xl"
          onClick={() => setSettingsRoute({ section: 'browsing' })}
        >
          <ChevronLeftIcon className="size-4" />
          Back to Browsing
        </Button>
      }
      toolbar={
        <div className="max-w-xs">
          <SettingsSummaryCard
            accent={overrideCount > 0}
            label={`of ${configurablePermissionTypes.length} permissions customized`}
            value={overrideCount}
            icon={<GlobeLockIcon className="size-4" />}
          />
        </div>
      }
    >
      <section className="space-y-3">
        <SettingsSectionHeader
          title="Permission settings"
          description={
            overrideCount === 0
              ? 'All permissions currently use the global defaults.'
              : 'Custom settings override the global defaults only for this site.'
          }
        />

        <SettingsPanel className="divide-y divide-token-border-light overflow-hidden">
          {configurablePermissionTypes.map((permissionType) => {
            const currentSetting = getHostSetting(permissionType);
            const isOverridden = currentSetting !== -1;

            return (
              <div
                key={permissionType}
                className={cn(
                  'flex items-center justify-between gap-4 px-4 py-3.5 transition-colors',
                  isOverridden
                    ? 'bg-codex-blue-400/5'
                    : 'hover:bg-token-list-hover-background',
                )}
              >
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium text-sm text-token-text-primary">
                    {permissionTypeLabels[permissionType]}
                  </span>
                  <span
                    className={cn(
                      'mt-0.5 text-xs',
                      isOverridden
                        ? 'text-codex-blue-400'
                        : 'text-token-text-tertiary',
                    )}
                  >
                    {isOverridden ? 'Custom setting' : 'Uses global default'}
                  </span>
                </div>
                <Select
                  value={String(currentSetting)}
                  onValueChange={(value) =>
                    handlePermissionChange(permissionType, value)
                  }
                  triggerVariant="secondary"
                  size="sm"
                  triggerClassName="w-32 rounded-lg"
                  items={getSettingOptions(permissionType)}
                />
              </div>
            );
          })}
        </SettingsPanel>
      </section>
    </SettingsPage>
  );
}
