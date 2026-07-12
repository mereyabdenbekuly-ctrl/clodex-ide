import type { FC, HTMLAttributes } from 'react';

export type LogoColor =
  | 'default'
  | 'black'
  | 'white'
  | 'zinc'
  | 'current'
  | 'gradient';

export type LoadingSpeed = 'slow' | 'fast';

export interface LogoProps extends HTMLAttributes<HTMLDivElement> {
  color?: LogoColor;
  loading?: boolean;
  loadingSpeed?: LoadingSpeed;
}

export const Logo: FC<LogoProps> = ({
  color = 'default',
  loading = false,
  loadingSpeed: _loadingSpeed = 'slow',
  className,
  ...props
}) => {
  const toneClass: Record<LogoColor, string> = {
    default: '',
    black: 'brightness-0',
    white: 'brightness-0 invert',
    zinc: 'grayscale opacity-55',
    current: '',
    gradient: '',
  };

  return (
    <div className={`relative aspect-square ${className ?? ''}`} {...props}>
      <img
        src="/clodex-mark.png"
        alt=""
        aria-hidden="true"
        className={`size-full object-contain ${toneClass[color]} ${
          loading ? 'animate-pulse drop-shadow-xl' : ''
        }`}
      />
    </div>
  );
};
