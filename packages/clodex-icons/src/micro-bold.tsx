import type { SVGProps } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  RotateCcw,
  TriangleAlert,
  WandSparkles,
  X,
  type LucideIcon,
} from 'lucide-react';

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

const createIcon =
  (label: string, Icon: LucideIcon) =>
  ({ size = 16, width, height, children: _children, ...props }: IconProps) => (
    <Icon
      aria-hidden="true"
      data-icon={label}
      height={height ?? size}
      strokeWidth={2.4}
      width={width ?? size}
      {...props}
    />
  );

export const IconArrowLeft = createIcon('IconArrowLeft', ArrowLeft);
export const IconArrowRight = createIcon('IconArrowRight', ArrowRight);
export const IconArrowRotateAnticlockwise = createIcon(
  'IconArrowRotateAnticlockwise',
  RotateCcw,
);
export const IconChevronLeft = createIcon('IconChevronLeft', ChevronLeft);
export const IconChevronRight = createIcon('IconChevronRight', ChevronRight);
export const IconClipboardContent = createIcon(
  'IconClipboardContent',
  ClipboardList,
);
export const IconMagicWandSparkle = createIcon(
  'IconMagicWandSparkle',
  WandSparkles,
);
export const IconTriangleWarning = createIcon(
  'IconTriangleWarning',
  TriangleAlert,
);
export const IconXmark = createIcon('IconXmark', X);
