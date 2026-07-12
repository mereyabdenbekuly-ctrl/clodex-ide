import { Tabs as TabsBase } from '@base-ui/react/tabs';
import { cn } from '../lib/utils';

export type TabsProps = React.ComponentProps<typeof TabsBase.Root>;
export const Tabs = ({ className, ...props }: TabsProps) => {
  return (
    <TabsBase.Root
      {...props}
      className={cn('flex flex-col items-start gap-2', className)}
    />
  );
};

export type TabsListProps = React.ComponentProps<typeof TabsBase.List>;
export const TabsList = ({ className, children, ...props }: TabsListProps) => {
  return (
    <TabsBase.List
      {...props}
      className={cn(
        'grid w-full auto-cols-fr grid-flow-col justify-center rounded-full border border-derived bg-background p-0.5',
        className,
      )}
    >
      {children}
    </TabsBase.List>
  );
};

export type TabsTriggerProps = React.ComponentProps<typeof TabsBase.Tab>;
export const TabsTrigger = ({
  className,
  children,
  ...props
}: TabsTriggerProps) => {
  return (
    <TabsBase.Tab
      {...props}
      className={(state) =>
        cn(
          'h-full rounded-full bg-background px-2 py-1 font-medium text-xs transition-colors',
          state.active
            ? 'bg-active-derived! bg-background text-primary-foreground'
            : 'text-muted-foreground hover:text-foreground',
          typeof className === 'function' ? className(state) : className,
        )
      }
    >
      {children}
    </TabsBase.Tab>
  );
};

export type TabsContentProps = React.ComponentProps<typeof TabsBase.Panel>;
export const TabsContent = ({ className, ...props }: TabsContentProps) => {
  return (
    <TabsBase.Panel
      {...props}
      className={cn(
        'transition-all duration-300 ease-out',
        'data-ending-style:opacity-0 data-starting-style:opacity-0',
        'data-ending-style:blur-sm data-starting-style:blur-sm',
        className,
      )}
    />
  );
};
