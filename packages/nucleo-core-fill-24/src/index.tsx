import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

const createIcon =
  (label: string) =>
  ({ size = 24, width, height, children: _children, ...props }: IconProps) => (
    <svg
      aria-hidden="true"
      data-icon={label}
      fill="currentColor"
      height={height ?? size}
      viewBox="0 0 24 24"
      width={width ?? size}
      {...props}
    >
      <circle cx="12" cy="12" r="9" />
    </svg>
  );

export const IconPlaceholderCoreFill24 = createIcon(
  'IconPlaceholderCoreFill24',
);
