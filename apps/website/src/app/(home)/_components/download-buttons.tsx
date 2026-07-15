'use client';

import { useState, useEffect } from 'react';
import { Button } from '@clodex/stage-ui/components/button';
import { DownloadUnavailableButton } from '@/components/download-unavailable-button';

export function DownloadButtons({
  className,
  locale = 'en',
}: {
  className?: string;
  locale?: 'ru' | 'en';
}) {
  const isRussian = locale === 'ru';
  const [isMobile, setIsMobile] = useState(false);
  const [isOsSupported, setIsOsSupported] = useState(true);
  const [hasDetected, setHasDetected] = useState(false);

  useEffect(() => {
    const platform =
      (
        navigator as Navigator & {
          userAgentData?: { platform?: string };
        }
      ).userAgentData?.platform?.toLowerCase() ?? '';
    const userAgent = navigator.userAgent.toLowerCase();

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
    setHasDetected(true);
  }, []);

  if (!hasDetected) {
    return (
      <Button size="lg" variant="primary" disabled className={className}>
        {isRussian ? 'Загрузка...' : 'Loading...'}
      </Button>
    );
  }

  if (isMobile) {
    return (
      <Button size="lg" variant="primary" disabled className={className}>
        {isRussian ? 'Откройте на компьютере' : 'Download on Desktop'}
      </Button>
    );
  }

  if (!isOsSupported) {
    return (
      <Button size="lg" variant="primary" disabled className={className}>
        {isRussian ? 'ОС не поддерживается' : 'OS not supported'}
      </Button>
    );
  }

  return (
    <DownloadUnavailableButton
      className={className}
      locale={locale}
      size="lg"
      title={
        isRussian
          ? 'Загрузка временно недоступна'
          : 'Download temporarily unavailable'
      }
    />
  );
}
