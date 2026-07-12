import { HotkeyActions } from '@shared/hotkeys';
import { Button } from '@clodex/stage-ui/components/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@clodex/stage-ui/components/tooltip';
import {
  IconSidebarRightHideOutline18,
  IconSidebarRightShowOutline18,
} from 'nucleo-ui-outline-18';
import { HotkeyCombo } from '@ui/components/hotkey-combo';
import { useSwarmSidebarCollapsed } from './swarm-sidebar-collapsed-context';

export function SwarmSidebarToggleButton() {
  const { collapsed, toggle } = useSwarmSidebarCollapsed();
  const label = collapsed ? 'Show background tasks' : 'Hide background tasks';
  const Icon = collapsed
    ? IconSidebarRightShowOutline18
    : IconSidebarRightHideOutline18;
  return (
    <Tooltip>
      <TooltipTrigger>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={toggle}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <span className="flex items-center gap-1.5">
          <span>{label}</span>
          <HotkeyCombo action={HotkeyActions.TOGGLE_SWARM_SIDEBAR} size="xs" />
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
