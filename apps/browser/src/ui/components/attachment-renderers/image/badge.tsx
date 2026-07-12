import { useState, useCallback, useRef, useEffect } from 'react';
import { ImageIcon } from 'lucide-react';
import { PreviewCardContent } from '@clodex/stage-ui/components/preview-card';
import type { BadgeProps } from '../types';
import { BadgeShell } from '../shared/badge-shell';
import { imagePreview } from '@ui/components/file-preview/previews/image';

const MAX_RETRIES = 8;
const RETRY_DELAY_MS = 10;

function RetryingThumbnail({
  src,
  alt,
}: {
  src: string;
  alt: string | undefined;
}) {
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleError = useCallback(() => {
    if (retry >= MAX_RETRIES) return;
    timerRef.current = setTimeout(() => setRetry((r) => r + 1), RETRY_DELAY_MS);
  }, [retry]);

  const handleLoad = useCallback(() => setLoaded(true), []);

  const gaveUp = retry >= MAX_RETRIES && !loaded;
  const cacheBustedSrc = retry > 0 ? `${src}?r=${retry}` : src;

  return (
    <div className="relative size-3 shrink-0 overflow-hidden rounded">
      {!loaded && <ImageIcon className="size-3 shrink-0" />}
      {!gaveUp && (
        <img
          src={cacheBustedSrc}
          alt={alt}
          className={`absolute inset-0 size-full object-cover ${loaded ? '' : 'invisible'}`}
          onError={handleError}
          onLoad={handleLoad}
        />
      )}
    </div>
  );
}

const ImageCompact = imagePreview.variants.compact;

export function ImageBadge(props: BadgeProps) {
  const { blobUrl, fileName, mediaType } = props;

  const icon = blobUrl ? (
    <RetryingThumbnail src={blobUrl} alt={fileName} />
  ) : (
    <ImageIcon className="size-3 shrink-0" />
  );

  const previewContent = blobUrl ? (
    <PreviewCardContent className="flex max-w-64 flex-col items-stretch gap-2">
      <ImageCompact src={blobUrl} fileName={fileName} mediaType={mediaType} />
      <span className="font-medium text-foreground text-xs">{fileName}</span>
    </PreviewCardContent>
  ) : undefined;

  return <BadgeShell {...props} icon={icon} previewContent={previewContent} />;
}
