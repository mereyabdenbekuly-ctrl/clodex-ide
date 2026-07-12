import type { UserPreferences } from './karton-contracts/ui/shared-types';

/**
 * Clodex network features are enabled only when the user selected a Clodex
 * provider profile. `legacyClodexConfigured` is a one-release compatibility
 * bridge for installations that already had a persisted Clodex session before
 * provider profiles existed.
 */
export function isClodexCloudSelected(
  preferences: Pick<
    UserPreferences,
    'providerProfiles' | 'defaultProviderProfileId'
  >,
  legacyClodexConfigured = false,
): boolean {
  const selected = preferences.providerProfiles.find(
    (profile) => profile.id === preferences.defaultProviderProfileId,
  );
  if (selected) return selected.enabled && selected.providerType === 'clodex';
  return preferences.providerProfiles.length === 0 && legacyClodexConfigured;
}
