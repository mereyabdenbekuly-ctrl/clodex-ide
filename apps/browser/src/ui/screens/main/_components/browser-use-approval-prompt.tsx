import { useState } from 'react';
import { Button } from '@clodex/stage-ui/components/button';
import type { BrowserUseApprovalResponse } from '@shared/agent-os';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { GlobeLockIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function BrowserUseApprovalPrompt() {
  const { t } = useTranslation('task');
  const approval = useKartonState(
    (state) => state.agentOs.browserUse.pendingApprovals[0],
  );
  const resolveApproval = useKartonProcedure(
    (procedures) => procedures.agentOs.browserUse.resolveApproval,
  );
  const [resolving, setResolving] = useState(false);

  if (!approval) return null;

  const respond = async (response: BrowserUseApprovalResponse) => {
    if (resolving) return;
    setResolving(true);
    try {
      await resolveApproval(approval.id, response);
    } catch (error) {
      console.error('Failed to resolve browser use approval', error);
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[70] flex justify-center px-4">
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="browser-use-approval-title"
        aria-describedby="browser-use-approval-description"
        className="app-no-drag pointer-events-auto w-full max-w-xl rounded-2xl border border-warning-solid/30 bg-background/92 p-4 shadow-codex-2xl backdrop-blur-xl"
      >
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-warning-solid/12 p-2 text-warning-solid">
            <GlobeLockIcon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2
              id="browser-use-approval-title"
              className="font-semibold text-foreground text-sm"
            >
              {t('approval.browser.title')}
            </h2>
            <p
              id="browser-use-approval-description"
              className="mt-1 text-muted-foreground text-xs"
            >
              {t('approval.browser.requestPrefix')}{' '}
              {t(`approval.browser.capabilities.${approval.capability}`)}{' '}
              {t('approval.browser.requestOrigin')}{' '}
              <code className="break-all text-foreground">
                {approval.origin}
              </code>
              .
            </p>
            {approval.description && (
              <p className="mt-2 rounded-lg bg-surface-1 px-2.5 py-2 text-muted-foreground text-xs">
                {approval.description}
              </p>
            )}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Button
            variant="primary"
            size="sm"
            disabled={resolving}
            onClick={() => void respond('allow-once')}
          >
            {t('approval.actions.allowOnce')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={resolving}
            onClick={() => void respond('always-allow')}
          >
            {t('approval.actions.alwaysAllow')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={resolving}
            onClick={() => void respond('block-once')}
          >
            {t('approval.actions.blockOnce')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={resolving}
            onClick={() => void respond('always-block')}
          >
            {t('approval.actions.alwaysBlock')}
          </Button>
        </div>
      </section>
    </div>
  );
}
