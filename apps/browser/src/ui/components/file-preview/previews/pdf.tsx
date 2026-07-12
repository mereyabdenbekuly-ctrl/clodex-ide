import { lazy } from 'react';
import type { FilePreviewEntry, FilePreviewProps } from '../types';
import { cn } from '@ui/utils';

function PdfCompact({ src, className }: FilePreviewProps) {
  return (
    <embed
      src={src}
      type="application/pdf"
      className={cn('pointer-events-none h-36 w-full', className)}
    />
  );
}

export const pdfPreview: FilePreviewEntry = {
  id: 'pdf',
  mimePatterns: ['application/pdf'],
  variants: {
    compact: PdfCompact,
    expanded: lazy(() => import('./pdf-expanded')),
  },
};
