import { Button, type ButtonProps } from '@clodex/stage-ui/components/button';

interface DownloadUnavailableButtonProps {
  className?: string;
  locale?: 'en' | 'ru';
  size?: ButtonProps['size'];
  title?: string;
}

export function DownloadUnavailableButton({
  className,
  locale = 'en',
  size = 'lg',
  title,
}: DownloadUnavailableButtonProps) {
  return (
    <Button
      size={size}
      variant="primary"
      disabled
      className={className}
      title={title}
    >
      {locale === 'ru'
        ? 'Загрузка временно недоступна'
        : 'Download temporarily unavailable'}
    </Button>
  );
}
