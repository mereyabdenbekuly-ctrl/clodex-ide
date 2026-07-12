/**
 * Internal URLs used by the browser.
 * These URLs are handled specially by the browser and don't navigate to external sites.
 */

/** The home page URL - displayed when opening a new tab or on startup */
export const HOME_PAGE_URL = 'clodex://internal/home';

/**
 * Checks if a URL is an internal clodex URL.
 */
export function isInternalUrl(url: string): boolean {
  return url.startsWith('clodex://');
}

/**
 * Checks if a URL is the home page.
 */
export function isHomePage(url: string): boolean {
  return url === HOME_PAGE_URL;
}
