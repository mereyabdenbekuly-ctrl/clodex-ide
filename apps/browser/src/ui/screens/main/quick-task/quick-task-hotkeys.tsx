import { HotkeyActions } from '@shared/hotkeys';
import { useHotKeyListener } from '@ui/hooks/use-hotkey-listener';
import { useQuickTask } from './quick-task-context';

export function QuickTaskHotkeys() {
  const { toggle } = useQuickTask();

  useHotKeyListener(() => {
    toggle();
  }, HotkeyActions.OPEN_QUICK_TASK);

  return null;
}
