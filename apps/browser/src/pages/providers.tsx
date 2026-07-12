import { KartonProvider } from './hooks/use-karton';
import { TooltipProvider } from '@clodex/stage-ui/components/tooltip';
import { ThemeSyncer } from './theme-syncer';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <KartonProvider>
        <ThemeSyncer />
        {children}
      </KartonProvider>
    </TooltipProvider>
  );
}
