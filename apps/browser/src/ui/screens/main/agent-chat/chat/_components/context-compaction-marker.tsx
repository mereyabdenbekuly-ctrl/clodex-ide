import { WandSparklesIcon } from 'lucide-react';

export function ContextCompactionMarker() {
  return (
    <div
      className="mt-2 flex w-full flex-row items-center gap-2 text-xs"
      data-context-compaction-boundary
    >
      <WandSparklesIcon className="size-3 text-muted-foreground" />
      <span className="shimmer-duration-1500 shimmer-from-muted-foreground shimmer-text-once shimmer-to-foreground font-normal">
        Compressed previous conversation
      </span>
    </div>
  );
}
