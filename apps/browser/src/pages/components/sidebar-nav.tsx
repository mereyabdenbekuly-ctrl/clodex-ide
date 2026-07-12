import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@clodex/stage-ui/components/button';
import { cn } from '@ui/utils';
import type { ReactNode } from 'react';

interface SidebarNavItemProps {
  to: string;
  icon: ReactNode;
  children: ReactNode;
  exact?: boolean;
}

function SidebarNavItem({
  to,
  icon,
  children,
  exact = true,
}: SidebarNavItemProps) {
  return (
    <Link
      to={to}
      className={cn(
        buttonVariants({ variant: 'ghost', size: 'sm' }),
        'w-full justify-start gap-2 bg-base-100 font-normal text-sm dark:bg-base-900',
        'not-data-[active=true]:hover:bg-hover-derived data-[active=true]:bg-background data-[active=true]:text-foreground',
      )}
      activeProps={{
        'data-active': 'true',
      }}
      activeOptions={{ exact, includeSearch: false }}
    >
      {icon}
      {children}
    </Link>
  );
}

interface SidebarNavGroupProps {
  label: string;
  children: ReactNode;
}

function SidebarNavGroup({ label, children }: SidebarNavGroupProps) {
  return (
    <div className="flex w-full flex-col items-stretch justify-start gap-2">
      <span className="ml-1 text-sm text-subtle-foreground">{label}</span>
      {children}
    </div>
  );
}

interface SidebarNavProps {
  children: ReactNode;
}

export function SidebarNav({ children }: SidebarNavProps) {
  return (
    <div className="flex w-full flex-col items-stretch justify-start gap-4">
      {children}
    </div>
  );
}

SidebarNav.Item = SidebarNavItem;
SidebarNav.Group = SidebarNavGroup;
