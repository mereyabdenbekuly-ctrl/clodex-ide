import type { FilePreviewProps } from '../types';
import { cn } from '@ui/utils';

export default function AudioExpanded({ src, className }: FilePreviewProps) {
  return <audio src={src} controls className={cn('w-64', className)} />;
}
