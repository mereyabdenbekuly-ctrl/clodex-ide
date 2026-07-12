import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import type { ComponentProps, ReactElement, ReactNode } from 'react';

export const TooltipProvider = BaseTooltip.Provider;

export const Tooltip = ({
  children,
  open,
  onOpenChange,
}: {
  children: ReactElement | ReactNode | ReactNode[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) => {
  return (
    <BaseTooltip.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </BaseTooltip.Root>
  );
};

type TooltipTriggerProps = ComponentProps<typeof BaseTooltip.Trigger> & {
  children?: ReactElement;
};

export const TooltipTrigger = ({
  children,
  delay = 300,
  ...props
}: TooltipTriggerProps) => {
  return (
    <BaseTooltip.Trigger
      render={
        props.render ||
        (children as ReactElement<Record<string, unknown>, string>)
      }
      delay={delay}
      {...props}
    />
  );
};

export const TooltipContent = ({
  children,
  side = 'top',
  align = 'center',
  alignOffset = 0,
  sideOffset = 2,
}: {
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  alignOffset?: number;
  sideOffset?: number;
}) => {
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        side={side}
        align={align}
        className="z-50"
      >
        <BaseTooltip.Popup
          className={`origin-(--transform-origin) rounded-md bg-background px-1.5 py-0.5 text-foreground text-xs shadow-md ring-1 ring-border-subtle transition-[transform,scale,opacity] duration-150 ease-out data-ending-style:scale-90 data-starting-style:scale-90 data-ending-style:opacity-0 data-starting-style:opacity-0`}
        >
          {children}
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  );
};
