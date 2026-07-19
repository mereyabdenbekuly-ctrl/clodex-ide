import { buttonVariants } from '@clodex/stage-ui/components/button';
import { cn } from '@clodex/stage-ui/lib/utils';
import Link from 'next/link';

export function DownloadButtons({
  className,
  locale = 'en',
}: {
  className?: string;
  locale?: 'ru' | 'en';
}) {
  const isRussian = locale === 'ru';
  return (
    <Link
      href={`/download?lang=${locale}`}
      className={cn(
        buttonVariants({ size: 'lg', variant: 'primary' }),
        className,
      )}
    >
      {isRussian ? 'Скачать Free-сборку' : 'Download Free build'}
    </Link>
  );
}
