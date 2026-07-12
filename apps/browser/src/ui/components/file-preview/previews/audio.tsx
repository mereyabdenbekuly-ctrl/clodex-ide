import { lazy } from 'react';
import { Music2Icon } from 'lucide-react';
import type { FilePreviewEntry, FilePreviewProps } from '../types';
import { cn } from '@ui/utils';

function AudioCompact({ fileName, className }: FilePreviewProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-sm px-2 py-1.5',
        className,
      )}
    >
      <Music2Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate text-foreground text-xs">{fileName}</span>
    </div>
  );
}

export const audioPreview: FilePreviewEntry = {
  id: 'audio',
  mimePatterns: ['audio/*'],
  variants: {
    compact: AudioCompact,
    expanded: lazy(() => import('./audio-expanded')),
  },
};
