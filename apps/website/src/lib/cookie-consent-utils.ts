'use client';

const COOKIE_NAME = 'clodex-cookie-consent';
const COOKIE_DOMAIN = '.clodex.xyz';
const COOKIE_MAX_AGE = 31536000; // 1 year in seconds

export type ConsentStatus = 'accepted' | 'denied' | null;

export const COOKIE_CONSENT_CHANGE_EVENT = 'clodex-cookie-consent-change';
export const OPEN_COOKIE_PREFERENCES_EVENT = 'clodex-open-cookie-preferences';

export function parseCookieConsentValue(value: unknown): ConsentStatus {
  return value === 'accepted' || value === 'denied' ? value : null;
}

/**
 * Get the current cookie consent status
 */
export function getCookieConsent(): ConsentStatus {
  if (typeof window === 'undefined') return null;

  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const normalized = cookie.trim();
    const separatorIndex = normalized.indexOf('=');
    if (separatorIndex === -1) continue;
    const name = normalized.slice(0, separatorIndex);
    const value = normalized.slice(separatorIndex + 1);
    if (name === COOKIE_NAME) {
      return parseCookieConsentValue(value);
    }
  }
  return null;
}

export function notifyCookieConsentChange(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(COOKIE_CONSENT_CHANGE_EVENT));
}

export function openCookiePreferences(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(OPEN_COOKIE_PREFERENCES_EVENT));
}

/**
 * Set the cookie consent status
 */
export function setCookieConsent(status: 'accepted' | 'denied'): void {
  if (typeof window === 'undefined') return;

  // Only add domain attribute for actual clodex.xyz domains
  const domainAttribute =
    window.location.hostname === 'clodex.xyz' ||
    window.location.hostname.endsWith('.clodex.xyz')
      ? `; domain=${COOKIE_DOMAIN}`
      : '';

  // Add Secure flag when using HTTPS
  const secureAttribute =
    window.location.protocol === 'https:' ? '; Secure' : '';

  const cookieString = `${COOKIE_NAME}=${status}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax${domainAttribute}${secureAttribute}`;
  document.cookie = cookieString;
  notifyCookieConsentChange();
}

/**
 * Remove the cookie consent
 */
export function removeCookieConsent(): void {
  if (typeof window === 'undefined') return;

  // Only add domain attribute for actual clodex.xyz domains
  const domainAttribute =
    window.location.hostname === 'clodex.xyz' ||
    window.location.hostname.endsWith('.clodex.xyz')
      ? `; domain=${COOKIE_DOMAIN}`
      : '';

  // Add Secure flag when using HTTPS
  const secureAttribute =
    window.location.protocol === 'https:' ? '; Secure' : '';

  // Set cookie with max-age=0 to delete it
  const cookieString = `${COOKIE_NAME}=; path=/; max-age=0; SameSite=Lax${domainAttribute}${secureAttribute}`;
  document.cookie = cookieString;
  notifyCookieConsentChange();
}
