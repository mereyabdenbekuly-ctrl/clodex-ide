import type { FC, HTMLAttributes } from 'react';
import { cn } from '@ui/utils';
import { Logo } from '@clodex/stage-ui/components/logo';
import { LogoText } from '@clodex/stage-ui/components/logo-text';

export interface LogoWithTextProps extends HTMLAttributes<HTMLDivElement> {
  textClassName?: string;
}

/**
 * clodex logo with text.
 * Combines the Logo SVG component with the LogoText SVG component.
 * The colors use design system defaults (primary for logo, foreground for text).
 */
export const LogoWithText: FC<LogoWithTextProps> = ({
  className,
  textClassName,
  ...props
}) => {
  return (
    <div className={cn('flex h-10 items-center gap-2', className)} {...props}>
      <Logo className="h-full w-auto" />
      <LogoText className={cn('h-[60%] w-auto fill-current', textClassName)} />
    </div>
  );
};
