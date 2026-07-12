import * as React from 'react';
import { Collapsible as CollapsibleBase } from '@base-ui/react/collapsible';
import { cn } from '../lib/utils';

export const Collapsible = CollapsibleBase.Root;

type CollapsibleTriggerProps = React.ComponentProps<
  typeof CollapsibleBase.Trigger
> & {
  children: React.ReactNode;
  size: 'default' | 'condensed';
};

export const CollapsibleTrigger = ({
  children,
  size,
  render,
  ...props
}: CollapsibleTriggerProps) => {
  const paddingClass = size === 'default' ? 'py-3 px-1' : 'px-1 py-1';
  const gapClass = size === 'default' ? 'gap-2' : 'gap-1';

  return (
    <CollapsibleBase.Trigger
      {...props}
      render={render}
      className={cn(
        'group flex w-full cursor-pointer flex-row items-center justify-between rounded-lg font-medium text-muted-foreground text-sm hover:text-foreground active:text-foreground',
        paddingClass,
        gapClass,
        props.className,
      )}
    >
      <div className="flex flex-1 flex-row items-center gap-1">{children}</div>
    </CollapsibleBase.Trigger>
  );
};

type CollapsibleContentProps = Omit<
  React.ComponentProps<typeof CollapsibleBase.Panel>,
  'render'
> & {
  children: React.ReactNode;
};
export const CollapsibleContent = ({
  children,
  ...props
}: CollapsibleContentProps) => {
  return (
    <CollapsibleBase.Panel
      {...props}
      className={cn(
        'flex h-(--collapsible-panel-height) flex-col overflow-hidden px-2 text-foreground text-sm transition-all duration-150 ease-out data-ending-style:h-0! data-starting-style:h-0! data-ending-style:opacity-0! data-starting-style:opacity-0!',
        props.className,
      )}
    >
      {children}
    </CollapsibleBase.Panel>
  );
};
