import type { SVGProps } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Globe,
  Link,
  Pin,
  Plus,
  Square,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
} from 'lucide-react';

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

const createIcon =
  (label: string, Icon: LucideIcon) =>
  ({ size = 18, width, height, children: _children, ...props }: IconProps) => (
    <Icon
      aria-hidden="true"
      data-icon={label}
      fill="currentColor"
      height={height ?? size}
      strokeWidth={1.8}
      width={width ?? size}
      {...props}
    />
  );

export const IconArrowLeftFill18 = createIcon('IconArrowLeftFill18', ArrowLeft);
export const IconArrowRightFill18 = createIcon(
  'IconArrowRightFill18',
  ArrowRight,
);
export const IconCheckFill18 = createIcon('IconCheckFill18', Check);
export const IconChevronDownFill18 = createIcon(
  'IconChevronDownFill18',
  ChevronDown,
);
export const IconGlobe2Fill18 = createIcon('IconGlobe2Fill18', Globe);
export const IconLinkFill18 = createIcon('IconLinkFill18', Link);
export const IconMediaStopFill18 = createIcon('IconMediaStopFill18', Square);
export const IconPinTackFill18 = createIcon('IconPinTackFill18', Pin);
export const IconPlusFill18 = createIcon('IconPlusFill18', Plus);
export const IconVolumeUpFill18 = createIcon('IconVolumeUpFill18', Volume2);
export const IconVolumeXmarkFill18 = createIcon(
  'IconVolumeXmarkFill18',
  VolumeX,
);
export const IconXmarkFill18 = createIcon('IconXmarkFill18', X);
