'use client';
import { Suspense, useState, useEffect } from 'react';
import { Button } from '@clodex/stage-ui/components/button';
import { Navbar } from '../(home)/navbar';
import { Footer } from '../(home)/_components/footer';
import { DownloadUnavailableButton } from '@/components/download-unavailable-button';

export default function DownloadPage() {
  const [isMobile, setIsMobile] = useState(false);
  const [isOsSupported, setIsOsSupported] = useState(true);

  // Detect mobile and supported desktop platforms without enabling downloads.
  useEffect(() => {
    const platform = navigator.platform.toLowerCase();
    const userAgent = navigator.userAgent.toLowerCase();

    // Detect mobile devices
    const mobileCheck =
      /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
        userAgent,
      );
    setIsMobile(mobileCheck);

    const isSupportedDesktop =
      platform.includes('mac') ||
      userAgent.includes('mac') ||
      platform.includes('win') ||
      userAgent.includes('win') ||
      platform.includes('linux') ||
      userAgent.includes('linux');
    if (!isSupportedDesktop) {
      setIsOsSupported(false);
    }
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center gap-12 bg-background pt-32 text-foreground">
      <Suspense>
        <Navbar />
      </Suspense>
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="text-center">
          <p className="mb-4 text-lg text-muted-foreground">Are you ready?</p>
          <h1 className="mb-8 font-medium text-3xl tracking-tight md:text-5xl">
            Download clodex
          </h1>

          <div className="flex justify-center">
            {!isOsSupported ? (
              <Button size="lg" variant="primary" disabled>
                OS not supported
              </Button>
            ) : isMobile ? (
              <Button size="lg" variant="primary" disabled>
                Download on Desktop
              </Button>
            ) : (
              <DownloadUnavailableButton
                size="lg"
                title="Download temporarily unavailable"
              />
            )}
          </div>
        </div>
      </div>
      <Footer />
    </div>
  );
}
