'use client';

import { useState, useEffect } from 'react';
import { Button, buttonVariants } from '@clodex/stage-ui/components/button';
import { IconDownload4FillDuo18 } from '@clodex/icons';
import { cn } from '@clodex/stage-ui/lib/utils';

export function DownloadButtons({
  className,
  locale = 'en',
}: {
  className?: string;
  locale?: 'ru' | 'en';
}) {
  const isRussian = locale === 'ru';
  const [userOS, setUserOS] = useState<string>(
    isRussian ? 'вашей ОС' : 'your OS',
  );
  const [downloadUrl, setDownloadUrl] = useState<string>('#');
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

    if (platform.includes('mac') || userAgent.includes('mac')) {
      setUserOS('macOS · Apple Silicon');
      setDownloadUrl(
        'https://ide.clodex.xyz/downloads/clodex-1.16.0-arm64.dmg',
      );
    } else if (platform.includes('win') || userAgent.includes('win')) {
      setUserOS('Windows · x64 Preview');
      setDownloadUrl(
        'https://github.com/mereyabdenbekuly-ctrl/clodex-ide/releases/download/v1.16.0-preview.1-windows-x64/clodex-1.16.0-x64-setup.exe',
      );
    } else if (platform.includes('linux') || userAgent.includes('linux')) {
      setUserOS('Linux');
      setDownloadUrl(
        'https://dl.clodex.io/download/clodex/release/linux/deb/x86_64',
      );
    } else {
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
    <a
      href={downloadUrl}
      className={cn(
        buttonVariants({ size: 'lg', variant: 'primary' }),
        className,
      )}
    >
      {isRussian ? 'Скачать для' : 'Download for'} {userOS}
      <IconDownload4FillDuo18 className="size-4" />
    </a>
  );
}
