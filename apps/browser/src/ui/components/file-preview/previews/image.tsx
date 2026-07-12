import { lazy } from 'react';
import type { FilePreviewEntry, FilePreviewProps } from '../types';
import { cn } from '@ui/utils';

function ImageCompact({ src, fileName, className }: FilePreviewProps) {
  return (
    <div
      className={cn(
        'flex min-h-24 w-full items-center justify-center overflow-hidden rounded-sm bg-background ring-1 ring-border-subtle',
        className,
      )}
    >
      <img
        src={src}
        className="max-h-36 max-w-full object-contain"
        alt={fileName}
      />
    </div>
  );
}

export const imagePreview: FilePreviewEntry = {
  id: 'image',
  mimePatterns: ['image/*'],
  variants: {
    compact: ImageCompact,
    expanded: lazy(() => import('./image-expanded')),
  },
};
