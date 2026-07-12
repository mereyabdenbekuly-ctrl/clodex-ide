import type { FC, SVGAttributes } from 'react';
import { cn } from '../lib/utils';

export interface LogoTextProps extends SVGAttributes<SVGSVGElement> {
  /** className applied to the wordmark. */
  pathClassName?: string;
}

export const LogoText: FC<LogoTextProps> = ({
  className,
  pathClassName,
  ...props
}) => {
  return (
    <svg
      viewBox="0 0 168 32"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('h-auto w-auto', className)}
      aria-hidden="true"
      {...props}
    >
      <text
        x="2"
        y="25"
        className={cn('fill-current text-foreground', pathClassName)}
        fontFamily="Arial Black, Arial, sans-serif"
        fontSize="25"
        fontWeight="900"
        letterSpacing="2.8"
      >
        CLODEX
      </text>
    </svg>
  );
};
