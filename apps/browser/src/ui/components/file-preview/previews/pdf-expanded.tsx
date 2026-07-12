import type { FilePreviewProps } from '../types';
import { cn } from '@ui/utils';

export default function PdfExpanded({ src, className }: FilePreviewProps) {
  return (
    <embed
      src={src}
      type="application/pdf"
      className={cn('h-80 w-full rounded', className)}
    />
  );
}
