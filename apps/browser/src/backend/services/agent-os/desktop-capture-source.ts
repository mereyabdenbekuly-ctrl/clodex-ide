import type { DesktopAutomationApp } from '@shared/desktop-automation';

export function selectUniqueDesktopCaptureSource<T extends { name: string }>(
  sources: readonly T[],
  app: DesktopAutomationApp,
): T | undefined {
  const normalize = (value: string): string => value.trim().toLocaleLowerCase();
  const normalizedTitle = normalize(app.windowTitle ?? '');
  const normalizedName = normalize(app.name);

  if (normalizedTitle) {
    const titleMatches = sources.filter(
      (candidate) => normalize(candidate.name) === normalizedTitle,
    );
    if (titleMatches.length === 1) return titleMatches[0];
    if (titleMatches.length > 1) {
      throw new Error('Frontmost application window capture is ambiguous');
    }
  }

  const appNameMatches = sources.filter(
    (candidate) => normalize(candidate.name) === normalizedName,
  );
  if (appNameMatches.length === 1) return appNameMatches[0];
  if (appNameMatches.length > 1) {
    throw new Error('Frontmost application window capture is ambiguous');
  }
  return undefined;
}
