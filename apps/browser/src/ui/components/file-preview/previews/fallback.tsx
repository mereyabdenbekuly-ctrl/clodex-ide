import { FileIcon } from 'lucide-react';
import type { FilePreviewEntry, FilePreviewProps } from '../types';
import { cn } from '@ui/utils';

function FallbackCompact({ fileName, className }: FilePreviewProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-sm px-2 py-1.5',
        className,
      )}
    >
      <FileIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate text-foreground text-xs">{fileName}</span>
    </div>
  );
}

export const fallbackPreview: FilePreviewEntry = {
  id: 'fallback',
  mimePatterns: ['*/*'],
  variants: {
    compact: FallbackCompact,
  },
};
