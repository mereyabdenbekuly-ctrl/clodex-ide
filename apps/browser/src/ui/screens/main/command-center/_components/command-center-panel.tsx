import type { ReactNode } from 'react';

export function CommandCenterPanel({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[22px] border border-token-border-light bg-token-main-surface-primary/95 text-token-text-primary shadow-codex-2xl ring-1 ring-black/5 backdrop-blur-2xl dark:ring-white/5">
      {children}
    </div>
  );
}
