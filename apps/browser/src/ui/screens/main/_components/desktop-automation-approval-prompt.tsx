import { useState } from 'react';
import { Button } from '@clodex/stage-ui/components/button';
import type { DesktopAutomationApprovalResponse } from '@shared/desktop-automation';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { ShieldAlertIcon } from 'lucide-react';

const OPERATION_LABELS = {
  inspect: 'inspect accessibility controls',
  capture: 'capture the frontmost window',
  press: 'press a desktop control',
} as const;

export function DesktopAutomationApprovalPrompt() {
  const approval = useKartonState(
    (state) => state.agentOs.desktopAutomation.pendingApprovals[0],
  );
  const resolveApproval = useKartonProcedure(
    (procedures) => procedures.agentOs.desktop.resolveApproval,
  );
  const [resolving, setResolving] = useState(false);

  if (!approval) return null;

  const respond = async (response: DesktopAutomationApprovalResponse) => {
    if (resolving) return;
    setResolving(true);
    try {
      await resolveApproval(approval.id, response);
    } catch (error) {
      console.error('Failed to resolve desktop automation approval', error);
    } finally {
      setResolving(false);
    }
  };

  const persistentChoiceAllowed = approval.risk === 'normal';

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[80] flex justify-center px-4">
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="desktop-automation-approval-title"
        aria-describedby="desktop-automation-approval-description"
        className="app-no-drag pointer-events-auto w-full max-w-xl rounded-2xl border border-danger-solid/30 bg-background/94 p-4 shadow-codex-2xl backdrop-blur-xl"
      >
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-danger-solid/12 p-2 text-danger-solid">
            <ShieldAlertIcon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2
              id="desktop-automation-approval-title"
              className="font-semibold text-foreground text-sm"
            >
              Allow desktop automation?
            </h2>
            <p
              id="desktop-automation-approval-description"
              className="mt-1 text-muted-foreground text-xs"
            >
              The agent wants to {OPERATION_LABELS[approval.operation]} in{' '}
              <strong className="text-foreground">{approval.app.name}</strong>.
            </p>
            <p className="mt-2 rounded-lg bg-surface-1 px-2.5 py-2 text-muted-foreground text-xs">
              {approval.description}
            </p>
            {approval.risk !== 'normal' && (
              <p className="mt-2 font-medium text-danger-solid text-xs">
                {approval.risk === 'irreversible'
                  ? 'This control may be irreversible. Persistent approval is disabled.'
                  : 'This is a system application. Persistent approval is disabled.'}
              </p>
            )}
          </div>
        </div>
        <div
          className={
            persistentChoiceAllowed
              ? 'mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4'
              : 'mt-4 grid grid-cols-2 gap-2'
          }
        >
          <Button
            variant="primary"
            size="sm"
            disabled={resolving}
            onClick={() => void respond('allow-once')}
          >
            Allow once
          </Button>
          {persistentChoiceAllowed && (
            <Button
              variant="secondary"
              size="sm"
              disabled={resolving}
              onClick={() => void respond('always-allow')}
            >
              Always allow
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={resolving}
            onClick={() => void respond('block-once')}
          >
            Block once
          </Button>
          {persistentChoiceAllowed && (
            <Button
              variant="ghost"
              size="sm"
              disabled={resolving}
              onClick={() => void respond('always-block')}
            >
              Always block
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
