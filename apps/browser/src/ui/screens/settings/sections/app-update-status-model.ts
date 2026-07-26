import type { AppState } from '@shared/karton-contracts/ui';

export const COMMUNITY_RELEASES_PAGE_URL =
  'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases';
export const MANUAL_UPDATE_CURRENT_LABEL = 'No newer release found';
export const MANUAL_UPDATE_RELEASE_ACTION_LABEL = 'Open GitHub Release';

export type ManualAppUpdateStatus = Extract<
  AppState['autoUpdate']['status'],
  `manual-${string}`
>;

export type ManualAppUpdateState = Readonly<AppState['autoUpdate']>;

export type ManualAppUpdateViewModel =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | {
      kind: 'available';
      releaseName: string;
      releasePageUrl: string | null;
    }
  | { kind: 'error'; errorMessage: string };

function assertNever(value: never): never {
  throw new Error(`Unhandled manual update status: ${String(value)}`);
}

function optionalText(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

/**
 * Maps the manual Community release-discovery states to renderer-safe copy.
 * Automatic updater states intentionally return null and retain their existing
 * UI. A missing release URL stays null so the renderer fails closed instead of
 * inventing a download target.
 */
export function getManualAppUpdateViewModel(
  state: ManualAppUpdateState,
): ManualAppUpdateViewModel | null {
  switch (state.status) {
    case 'manual-idle':
      return { kind: 'idle' };
    case 'manual-checking':
      return { kind: 'checking' };
    case 'manual-current':
      return { kind: 'current' };
    case 'manual-available':
      return {
        kind: 'available',
        releaseName:
          optionalText(state.updateInfo?.releaseName) ?? 'New Community build',
        releasePageUrl: optionalText(state.updateInfo?.releasePageUrl),
      };
    case 'manual-error':
      return {
        kind: 'error',
        errorMessage:
          optionalText(state.errorMessage ?? undefined) ??
          'Could not check for Community updates.',
      };
    case 'idle':
    case 'checking':
    case 'downloading':
    case 'ready':
    case 'not-available':
    case 'error':
    case 'unsupported':
      return null;
    default:
      return assertNever(state.status);
  }
}
