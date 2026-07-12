import { lazy } from 'react';
import type { FilePreviewEntry, FilePreviewProps } from '../types';
import { cn } from '@ui/utils';

function VideoCompact({ src, className }: FilePreviewProps) {
  return (
    <video
      src={src}
      muted
      playsInline
      className={cn('max-h-36 max-w-full rounded object-contain', className)}
    />
  );
}

export const videoPreview: FilePreviewEntry = {
  id: 'video',
  mimePatterns: ['video/*'],
  variants: {
    compact: VideoCompact,
    expanded: lazy(() => import('./video-expanded')),
  },
};
