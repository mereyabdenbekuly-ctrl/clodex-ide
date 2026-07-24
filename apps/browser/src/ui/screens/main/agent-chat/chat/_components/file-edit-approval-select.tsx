import { Select } from '@clodex/stage-ui/components/select';
import {
  DEFAULT_FILE_EDIT_APPROVAL_MODE,
  type FileEditApprovalMode,
} from '@shared/karton-contracts/ui/shared-types';
import { IconFilePenOutline18 } from '@clodex/icons';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { useOpenAgent } from '@ui/hooks/use-open-chat';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

interface FileEditApprovalSelectProps {
  onFileEditApprovalChange?: () => void;
}

function isFileEditApprovalMode(value: unknown): value is FileEditApprovalMode {
  return value === 'manual' || value === 'autoWorkspace';
}

export const FileEditApprovalSelect = memo(function FileEditApprovalSelect({
  onFileEditApprovalChange,
}: FileEditApprovalSelectProps) {
  const { t } = useTranslation('task');
  const [openAgent] = useOpenAgent();
  const currentMode = useKartonState((state) =>
    openAgent
      ? (state.agents.instances[openAgent]?.state.fileEditApprovalMode ??
        DEFAULT_FILE_EDIT_APPROVAL_MODE)
      : DEFAULT_FILE_EDIT_APPROVAL_MODE,
  );
  const setFileEditApprovalMode = useKartonProcedure(
    (procedures) => procedures.agents.setFileEditApprovalMode,
  );

  const items = useMemo(
    () => [
      {
        value: 'manual' satisfies FileEditApprovalMode,
        label: t('approval.fileEdits.mode.manual.label'),
        triggerLabel: t('approval.fileEdits.mode.manual.label'),
        description: t('approval.fileEdits.mode.manual.description'),
      },
      {
        value: 'autoWorkspace' satisfies FileEditApprovalMode,
        label: t('approval.fileEdits.mode.autoWorkspace.label'),
        triggerLabel: t('approval.fileEdits.mode.autoWorkspace.label'),
        description: t('approval.fileEdits.mode.autoWorkspace.description'),
      },
    ],
    [t],
  );

  const handleValueChange = useCallback(
    (value: unknown) => {
      if (
        !openAgent ||
        !isFileEditApprovalMode(value) ||
        value === currentMode
      ) {
        return;
      }

      void setFileEditApprovalMode(openAgent, value).catch((error) => {
        console.warn('[FileEditApprovalSelect] Failed to set mode', error);
      });
      onFileEditApprovalChange?.();
    },
    [currentMode, onFileEditApprovalChange, openAgent, setFileEditApprovalMode],
  );

  return (
    <Select
      value={currentMode}
      onValueChange={handleValueChange}
      items={items}
      disabled={!openAgent}
      size="xs"
      triggerVariant="ghost"
      triggerClassName="h-4 min-h-0 w-auto gap-1 p-0 text-xs text-muted-foreground hover:text-foreground"
      popupClassName="max-w-80"
      icon={<IconFilePenOutline18 className="size-3" />}
      side="top"
      align="start"
    />
  );
});
