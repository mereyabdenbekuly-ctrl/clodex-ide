export const cloudTaskDogfoodChannels = [
  'dev',
  'prerelease',
  'nightly',
] as const;

export function isCloudTaskKillSwitchActive(
  value: string | undefined,
): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}
