import type { FilePreviewProps } from '../types';
import { cn } from '@ui/utils';

export default function ImageExpanded({
  src,
  fileName,
  className,
}: FilePreviewProps) {
  return (
    <img
      src={src}
      alt={fileName}
      className={cn('max-h-56 max-w-72 rounded object-contain', className)}
    />
  );
}
