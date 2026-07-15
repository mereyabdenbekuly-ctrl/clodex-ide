'use client';
import Link from 'next/link';
import { Suspense, useState, useEffect } from 'react';
import { IconDownload4FillDuo18 } from '@clodex/icons';
import { Button, buttonVariants } from '@clodex/stage-ui/components/button';
import { cn } from '@clodex/stage-ui/lib/utils';
import { Navbar } from '../(home)/navbar';
import { Footer } from '../(home)/_components/footer';

export default function DownloadPage() {
  const [userOS, setUserOS] = useState<string>('your OS');
  const [downloadUrl, setDownloadUrl] = useState<string>('#');
  const [isMobile, setIsMobile] = useState(false);
  const [isOsSupported, setIsOsSupported] = useState(true);

  // Detect user OS and set download URL
  useEffect(() => {
    const platform = navigator.platform.toLowerCase();
    const userAgent = navigator.userAgent.toLowerCase();

    // Detect mobile devices
    const mobileCheck =
      /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
        userAgent,
      );
    setIsMobile(mobileCheck);

    if (platform.includes('mac') || userAgent.includes('mac')) {
      setUserOS('macOS');
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
              <Link
                href={downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  buttonVariants({ size: 'lg', variant: 'primary' }),
                )}
              >
                Download for {userOS}
                <IconDownload4FillDuo18 className="size-4" />
              </Link>
            )}
          </div>
        </div>
      </div>
      <Footer />
    </div>
  );
}
