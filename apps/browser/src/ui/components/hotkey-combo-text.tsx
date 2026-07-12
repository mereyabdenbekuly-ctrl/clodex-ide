import {
  hotkeyDefinitions,
  getDisplayString,
  getCurrentPlatform,
  type HotkeyActions,
} from '@shared/hotkeys';

export function HotkeyComboText({ action }: { action: HotkeyActions }) {
  const platform = getCurrentPlatform();
  const definition = hotkeyDefinitions[action];

  return getDisplayString(definition, platform);
}
