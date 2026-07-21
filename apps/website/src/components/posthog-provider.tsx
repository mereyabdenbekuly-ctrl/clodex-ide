'use client';

import posthog from 'posthog-js';
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import {
  COOKIE_CONSENT_CHANGE_EVENT,
  getCookieConsent,
} from '@/lib/cookie-consent-utils';
import {
  createWebsiteAnalyticsController,
  type WebsiteAnalyticsController,
} from '@/lib/posthog-privacy';

let analyticsController: WebsiteAnalyticsController | null = null;

function getAnalyticsController(): WebsiteAnalyticsController | null {
  if (typeof window === 'undefined') return null;
  if (!analyticsController) {
    analyticsController = createWebsiteAnalyticsController({
      client: posthog,
      apiKey: process.env.NEXT_PUBLIC_POSTHOG_KEY,
      getConsent: getCookieConsent,
      getCurrentUrl: () => window.location.href,
      debug: process.env.NODE_ENV === 'development',
    });
  }
  return analyticsController;
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const controller = getAnalyticsController();
    controller?.syncConsent();

    const handleConsentChange = () => controller?.syncConsent();
    window.addEventListener(COOKIE_CONSENT_CHANGE_EVENT, handleConsentChange);
    return () =>
      window.removeEventListener(
        COOKIE_CONSENT_CHANGE_EVENT,
        handleConsentChange,
      );
  }, []);

  return (
    <>
      <PostHogPageView />
      {children}
    </>
  );
}

function PostHogPageView() {
  const pathname = usePathname();
  const lastPathname = useRef(pathname);

  // The controller captures the accepted landing page. Only a real pathname
  // transition is eligible here, so Strict Mode effect replay stays a no-op.
  useEffect(() => {
    if (!pathname || pathname === lastPathname.current) return;
    lastPathname.current = pathname;
    getAnalyticsController()?.capturePageView(
      `${window.location.origin}${pathname}`,
    );
  }, [pathname]);

  return null;
}
