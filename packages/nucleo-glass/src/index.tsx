import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

const createIcon =
  (label: string) =>
  ({ size = 18, width, height, children: _children, ...props }: IconProps) => (
    <svg
      aria-hidden="true"
      data-icon={label}
      fill="none"
      height={height ?? size}
      viewBox="0 0 18 18"
      width={width ?? size}
      {...props}
    >
      <rect
        fill="currentColor"
        height="12"
        opacity="0.18"
        rx="4"
        width="12"
        x="3"
        y="3"
      />
      <path d="M6 6h6v6H6z" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );

export const IconPlaceholderGlass18 = createIcon('IconPlaceholderGlass18');
