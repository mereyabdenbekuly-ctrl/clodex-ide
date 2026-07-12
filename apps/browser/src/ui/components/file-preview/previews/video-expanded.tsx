import { useRef, useEffect } from 'react';
import type { FilePreviewProps } from '../types';
import { cn } from '@ui/utils';

export default function VideoExpanded({
  src,
  className,
  options,
}: FilePreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const raw = options?.t;
    const t =
      typeof raw === 'string' ? Number.parseFloat(raw) : (raw as number);
    if (t && Number.isFinite(t) && videoRef.current) {
      videoRef.current.currentTime = t;
    }
  }, [options?.t]);

  return (
    <video
      ref={videoRef}
      src={src}
      controls
      className={cn('max-h-56 max-w-72 rounded', className)}
    />
  );
}
