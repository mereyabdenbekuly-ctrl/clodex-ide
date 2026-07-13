'use client';

const COOKIE_NAME = 'clodex-cookie-consent';
const COOKIE_DOMAIN = '.clodex.xyz';
const COOKIE_MAX_AGE = 31536000; // 1 year in seconds

export type ConsentStatus = 'accepted' | 'denied' | null;

/**
 * Get the current cookie consent status
 */
export function getCookieConsent(): ConsentStatus {
  if (typeof window === 'undefined') return null;

  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === COOKIE_NAME) {
      return value as ConsentStatus;
    }
  }
  return null;
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
}
