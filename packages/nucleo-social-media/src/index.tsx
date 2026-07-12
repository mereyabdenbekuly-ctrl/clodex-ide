import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

export const IconGithub = ({
  size = 18,
  width,
  height,
  children: _children,
  ...props
}: IconProps) => (
  <svg
    aria-hidden="true"
    data-icon="IconGithub"
    fill="none"
    height={height ?? size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth="1.8"
    viewBox="0 0 24 24"
    width={width ?? size}
    {...props}
  >
    <path d="M9 19c-4 1.5-4-2-5-2.5" />
    <path d="M15 22v-3.5c0-1 .3-1.8.8-2.3 2.7-.3 5.6-1.3 5.6-6A4.7 4.7 0 0 0 20 6.6c.1-.4.6-1.8-.2-3.6 0 0-1.2-.4-3.8 1.4a13 13 0 0 0-7 0C6.4 2.6 5.2 3 5.2 3 4.4 4.8 4.9 6.2 5 6.6a4.7 4.7 0 0 0-1.4 3.6c0 4.7 2.9 5.7 5.6 6 .5.5.8 1.2.8 2.3V22" />
  </svg>
);
