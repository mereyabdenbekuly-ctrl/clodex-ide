import type { SVGProps } from 'react';
import { ArrowUp, Bluetooth, Trash2, Usb, type LucideIcon } from 'lucide-react';

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

const createIcon =
  (label: string, Icon: LucideIcon) =>
  ({ size = 24, width, height, children: _children, ...props }: IconProps) => (
    <Icon
      aria-hidden="true"
      data-icon={label}
      height={height ?? size}
      strokeWidth={1.8}
      width={width ?? size}
      {...props}
    />
  );

export const IconArrowUpOutline24 = createIcon('IconArrowUpOutline24', ArrowUp);
export const IconBluetoothOutline24 = createIcon(
  'IconBluetoothOutline24',
  Bluetooth,
);
export const IconTrash2Outline24 = createIcon('IconTrash2Outline24', Trash2);
export const IconUsbOutline24 = createIcon('IconUsbOutline24', Usb);
