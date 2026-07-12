import { OverlayScrollbar } from '@clodex/stage-ui/components/overlay-scrollbar';
import { cn } from '@ui/utils';
import type { ReactNode } from 'react';

export function SettingsPage({
  title,
  description,
  eyebrow,
  actions,
  toolbar,
  children,
  className,
  contentClassName,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <div className={cn('settings-page h-full w-full', className)}>
      <OverlayScrollbar
        className="h-full"
        contentClassName={cn(
          'px-4 pt-16 pb-24 sm:px-6 sm:pt-20 lg:px-8',
          contentClassName,
        )}
      >
        <div className="mx-auto w-full max-w-4xl">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 max-w-2xl">
              {eyebrow && (
                <p className="mb-1.5 font-medium text-codex-blue-400 text-xs uppercase tracking-[0.12em]">
                  {eyebrow}
                </p>
              )}
              <h1 className="font-semibold text-2xl text-token-text-primary tracking-[-0.02em]">
                {title}
              </h1>
              {description && (
                <p className="mt-1.5 text-sm text-token-text-secondary leading-6">
                  {description}
                </p>
              )}
            </div>
            {actions && (
              <div className="flex shrink-0 items-center gap-2">{actions}</div>
            )}
          </header>

          {toolbar && <div className="mt-6">{toolbar}</div>}

          <div className="mt-8">{children}</div>
        </div>
      </OverlayScrollbar>
    </div>
  );
}

export function SettingsPanel({
  children,
  className,
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-token-border-light bg-token-main-surface-primary/75 shadow-codex-sm',
        interactive &&
          'transition-[border-color,background-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-token-border-default hover:bg-token-main-surface-primary hover:shadow-codex-md',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SettingsSectionHeader({
  title,
  description,
  trailing,
  className,
}: {
  title: string;
  description?: string;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-start justify-between gap-4',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="font-medium text-base text-token-text-primary">
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-sm text-token-text-secondary leading-5">
            {description}
          </p>
        )}
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </div>
  );
}

export function SettingsSummaryCard({
  label,
  value,
  icon,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-3 rounded-xl border px-3.5 py-3',
        accent
          ? 'border-codex-blue-400/20 bg-codex-blue-400/6'
          : 'border-token-border-light bg-token-bg-secondary/45',
      )}
    >
      {icon && (
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg',
            accent
              ? 'bg-codex-blue-400/12 text-codex-blue-400'
              : 'bg-token-bg-tertiary text-token-text-secondary',
          )}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <div className="font-semibold text-base text-token-text-primary leading-5">
          {value}
        </div>
        <div className="truncate text-token-text-tertiary text-xs">{label}</div>
      </div>
    </div>
  );
}
