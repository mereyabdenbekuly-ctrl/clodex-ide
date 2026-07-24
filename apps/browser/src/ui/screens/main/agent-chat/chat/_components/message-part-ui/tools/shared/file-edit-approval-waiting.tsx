import { getBaseName } from '@shared/path-utils';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@clodex/stage-ui/components/tooltip';
import { IconFilePenOutline18 } from '@clodex/icons';
import { PauseIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FileEditApprovalVisualState } from '../../../file-edit-approval-state';

export function FileEditApprovalStatus({
  relativePath,
  state,
}: {
  relativePath?: string | null;
  state: Exclude<FileEditApprovalVisualState, null>;
}) {
  const { t } = useTranslation('task');
  const fileName = relativePath ? getBaseName(relativePath) : null;
  const applying = state === 'applying';

  return (
    <div className="flex min-w-0 flex-row items-center justify-start gap-1 text-muted-foreground text-xs">
      {applying ? (
        <IconFilePenOutline18 className="size-3 shrink-0 text-primary-foreground" />
      ) : (
        <PauseIcon className="size-3 shrink-0 text-warning-foreground" />
      )}
      <span className="shrink-0">
        {t(
          applying
            ? 'approval.fileEdits.applyingChanges'
            : 'approval.fileEdits.waitingForApproval',
        )}
      </span>
      {fileName && (
        <Tooltip>
          <TooltipTrigger>
            <span className="min-w-0 truncate opacity-75">{fileName}</span>
          </TooltipTrigger>
          <TooltipContent>{relativePath}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
