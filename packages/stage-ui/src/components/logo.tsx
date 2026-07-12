import type { FC, ImgHTMLAttributes } from 'react';
import { cn } from '../lib/utils';

export interface LogoProps
  extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt'> {
  /** Additional className applied to the brand mark. */
  pathClassName?: string;
}

const clodexMarkUrl = new URL('./clodex-mark.png', import.meta.url).href;

export const Logo: FC<LogoProps> = ({ className, pathClassName, ...props }) => {
  return (
    <img
      src={clodexMarkUrl}
      alt=""
      aria-hidden="true"
      className={cn('size-full object-contain', pathClassName, className)}
      {...props}
    />
  );
};
