import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

const createIcon =
  (label: string) =>
  ({ size = 12, width, height, children: _children, ...props }: IconProps) => (
    <svg
      aria-hidden="true"
      data-icon={label}
      fill="none"
      height={height ?? size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 12 12"
      width={width ?? size}
      {...props}
    >
      <path d="M3 6h6" />
      <path d="M6 3v6" />
    </svg>
  );

export const IconPlaceholderOutline12 = createIcon('IconPlaceholderOutline12');
