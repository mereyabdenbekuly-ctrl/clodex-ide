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
      <circle
        cx="9"
        cy="9"
        r="6"
        stroke="currentColor"
        strokeOpacity="0.4"
        strokeWidth="1.5"
      />
      <path
        d="M6 9h6M9 6v6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </svg>
  );

export const IconPlaceholderOutlineDuo18 = createIcon(
  'IconPlaceholderOutlineDuo18',
);
