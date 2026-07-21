'use client';

import { useEffect, useState } from 'react';
import { Button } from '@clodex/stage-ui/components/button';
import {
  getCookieConsent,
  OPEN_COOKIE_PREFERENCES_EVENT,
  setCookieConsent,
} from '@/lib/cookie-consent-utils';

export function CookieBanner() {
  const [showBanner, setShowBanner] = useState(false);

  useEffect(() => {
    if (getCookieConsent() === null) {
      setShowBanner(true);
    }

    const handleOpenPreferences = () => setShowBanner(true);
    window.addEventListener(
      OPEN_COOKIE_PREFERENCES_EVENT,
      handleOpenPreferences,
    );
    return () =>
      window.removeEventListener(
        OPEN_COOKIE_PREFERENCES_EVENT,
        handleOpenPreferences,
      );
  }, []);

  const handleAccept = () => {
    setCookieConsent('accepted');
    setShowBanner(false);
  };

  const handleDeny = () => {
    setCookieConsent('denied');
    setShowBanner(false);
  };

  if (!showBanner) {
    return null;
  }

  return (
    // Non-blocking: fixed overlay in the corner, page stays fully interactive.
    <div className="slide-in-from-bottom fixed right-4 bottom-4 z-50 w-full max-w-[calc(100%-2rem)] animate-in duration-300 sm:w-sm">
      <div className="flex flex-col items-start gap-3 rounded-2xl border border-border bg-background/80 p-4 backdrop-blur-lg dark:bg-background/80">
        <div className="flex flex-col items-start gap-1">
          <h2 className="font-semibold text-base text-foreground">
            Cookie preferences
          </h2>
          <p className="text-muted-foreground text-sm">
            Optional analytics are off until you allow them. If enabled, we send
            only sanitized anonymous page views—never form text, query strings,
            session recordings, or account identifiers. Deny keeps PostHog
            analytics off.{' '}
            <a
              href="/privacy"
              className="underline transition-colors hover:text-foreground"
            >
              Privacy Policy
            </a>
          </p>
        </div>
        <div className="flex w-full flex-row-reverse items-start justify-start gap-2">
          <Button size="sm" onClick={handleAccept}>
            Allow analytics
          </Button>
          <Button size="sm" variant="secondary" onClick={handleDeny}>
            Keep analytics off
          </Button>
        </div>
      </div>
    </div>
  );
}
