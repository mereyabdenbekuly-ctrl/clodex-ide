import { Button } from '@clodex/stage-ui/components/button';
import { useKartonProcedure, useKartonState } from '@ui/hooks/use-karton';
import { MonitorUpIcon, OctagonIcon } from 'lucide-react';

export function DesktopAutomationIndicator() {
  const state = useKartonState((item) => item.agentOs.desktopAutomation);
  const engageKillSwitch = useKartonProcedure(
    (procedures) => procedures.agentOs.desktop.engageKillSwitch,
  );

  if (!state.active) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[80] flex justify-center px-4">
      <section
        role="status"
        aria-live="polite"
        className="app-no-drag pointer-events-auto flex items-center gap-3 rounded-full border border-danger-solid/35 bg-background/94 px-3 py-2 shadow-codex-2xl backdrop-blur-xl"
      >
        <span className="relative flex size-7 items-center justify-center rounded-full bg-danger-solid/14 text-danger-solid">
          <span className="absolute inset-0 animate-ping rounded-full bg-danger-solid/10" />
          <MonitorUpIcon className="relative size-4" />
        </span>
        <div className="leading-tight">
          <p className="font-semibold text-foreground text-xs">
            Desktop automation active
          </p>
          <p className="text-[10px] text-muted-foreground">
            Kill switch: {state.killSwitchAccelerator}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void engageKillSwitch()}
        >
          <OctagonIcon className="size-3.5" />
          Stop
        </Button>
      </section>
    </div>
  );
}
