import { cn } from '@clodex/stage-ui/lib/utils';
import { memo } from 'react';
import { getIcon } from 'seti-icons';

const setiColors: Record<string, string> = {
  blue: 'var(--color-primary-foreground)',
  grey: 'var(--color-muted-foreground)',
  'grey-light': 'var(--color-subtle-foreground)',
  green: 'var(--color-success-foreground)',
  orange:
    'light-dark(var(--color-syntax-orange-light), var(--color-syntax-orange-dark))',
  pink: 'light-dark(var(--color-syntax-pink-light), var(--color-syntax-pink-dark))',
  purple:
    'light-dark(var(--color-syntax-purple-light), var(--color-syntax-purple-dark))',
  red: 'var(--color-error-foreground)',
  white: 'var(--color-foreground)',
  yellow: 'var(--color-warning-foreground)',
  ignore: 'transparent',
};

export const FileIcon = memo(
  ({ filePath, className }: { filePath: string; className?: string }) => {
    const fileIcon = getIcon(filePath);
    const color =
      setiColors[fileIcon.color] ?? fileIcon.color ?? 'var(--color-foreground)';

    return (
      <span
        className={cn(
          'seti-icon flex size-4 shrink-0 items-center justify-center',
          className,
        )}
        style={{ color }}
        dangerouslySetInnerHTML={{ __html: fileIcon.svg }}
      />
    );
  },
  (prevProps, nextProps) =>
    prevProps.filePath === nextProps.filePath &&
    prevProps.className === nextProps.className,
);
