import { Select } from '@clodex/stage-ui/components/select';
import {
  COLLABORATION_MODES,
  collaborationModeIds,
  type CollaborationMode,
} from '@shared/collaboration-modes';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { enablePatches, produceWithPatches } from 'immer';
import { ListChecksIcon } from 'lucide-react';
import { memo, useCallback } from 'react';

enablePatches();

const COLLABORATION_MODE_ITEMS = collaborationModeIds.map((id) => {
  const definition = COLLABORATION_MODES[id];
  return {
    value: id,
    label: definition.name,
    triggerLabel: definition.shortName,
    description: definition.description,
  };
});

function isCollaborationMode(value: unknown): value is CollaborationMode {
  return (
    typeof value === 'string' &&
    collaborationModeIds.some((mode) => mode === value)
  );
}

interface CollaborationModeSelectProps {
  disabled?: boolean;
  onCollaborationModeChange?: () => void;
}

export const CollaborationModeSelect = memo(function CollaborationModeSelect({
  disabled = false,
  onCollaborationModeChange,
}: CollaborationModeSelectProps) {
  const preferences = useKartonState((s) => s.preferences);
  const updatePreferences = useKartonProcedure((p) => p.preferences.update);
  const currentMode = preferences.agent.collaborationMode;

  const handleValueChange = useCallback(
    (value: unknown) => {
      if (!isCollaborationMode(value) || value === currentMode) return;

      const [, patches] = produceWithPatches(preferences, (draft) => {
        draft.agent.collaborationMode = value;
      });
      void updatePreferences(patches)
        .then(() => onCollaborationModeChange?.())
        .catch((error) => {
          console.warn(
            '[CollaborationModeSelect] Failed to update collaboration mode',
            error,
          );
        });
    },
    [currentMode, onCollaborationModeChange, preferences, updatePreferences],
  );

  return (
    <Select
      value={currentMode}
      onValueChange={handleValueChange}
      items={COLLABORATION_MODE_ITEMS}
      disabled={disabled}
      size="xs"
      triggerVariant="ghost"
      triggerClassName="h-4 min-h-0 w-auto gap-1 p-0 text-xs text-muted-foreground hover:text-foreground"
      popupClassName="max-w-80"
      icon={<ListChecksIcon className="size-3" />}
      side="top"
      align="start"
    />
  );
});
