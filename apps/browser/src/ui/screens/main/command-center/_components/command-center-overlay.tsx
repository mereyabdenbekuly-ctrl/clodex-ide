import type { ReactNode } from 'react';

export function CommandCenterOverlay({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command center"
      data-command-center-modal-root=""
      className="app-no-drag fixed inset-0 z-100 flex items-start justify-center bg-overlay/45 px-3 pt-[clamp(3.5rem,11vh,8rem)] pb-3 backdrop-blur-[2px] sm:px-6"
    >
      <button
        type="button"
        aria-label="Close command center"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-[720px]">{children}</div>
    </div>
  );
}
