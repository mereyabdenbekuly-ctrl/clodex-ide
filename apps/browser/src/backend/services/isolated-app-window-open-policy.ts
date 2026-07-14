import {
  parseAppUrlIdentity,
  parseIsolatedAppOrigin,
} from '@shared/isolated-app-origin';

export type IsolatedAppWindowOpenContext = Readonly<{
  targetUrl: string;
  referrerUrl?: string | null;
  topLevelUrl?: string | null;
  frameUrls?: readonly string[];
  frameOrigins?: readonly string[];
  sourceInspectionFailed?: boolean;
}>;

function isIsolatedAppUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  return parseAppUrlIdentity(value)?.classification === 'isolated';
}

function isGeneratedAppPreview(value: string | null | undefined): boolean {
  if (!value?.startsWith('clodex://internal/')) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'clodex:' &&
      url.hostname === 'internal' &&
      url.host === 'internal' &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname.startsWith('/preview/')
    );
  } catch {
    return false;
  }
}

/**
 * Electron does not identify the source frame in setWindowOpenHandler, and a
 * no-referrer policy can erase the only source URL. When a tab is hosting an
 * isolated generated app, every ambiguous popup is therefore denied before
 * reveal-file, external-protocol, or normal tab-opening handlers can run.
 */
export function shouldBlockIsolatedAppWindowOpen(
  context: IsolatedAppWindowOpenContext,
): boolean {
  if (context.sourceInspectionFailed) return true;
  if (isIsolatedAppUrl(context.referrerUrl)) return true;
  if (isGeneratedAppPreview(context.topLevelUrl)) return true;
  if (context.frameUrls?.some(isIsolatedAppUrl)) return true;
  return Boolean(
    context.frameOrigins?.some(
      (origin) => parseIsolatedAppOrigin(origin) !== null,
    ),
  );
}
