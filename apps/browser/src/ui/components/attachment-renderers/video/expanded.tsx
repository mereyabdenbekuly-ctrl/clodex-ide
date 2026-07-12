import { Suspense } from 'react';
import type { RendererProps } from '../types';
import { ExpandedShell } from '../shared/expanded-shell';
import { videoPreview } from '@ui/components/file-preview/previews/video';

const VideoExpandedPreview = videoPreview.variants.expanded!;

export default function VideoExpanded({
  blobUrl,
  fileName,
  mediaType,
  params,
}: RendererProps) {
  return (
    <ExpandedShell fileName={fileName}>
      <Suspense fallback={null}>
        <VideoExpandedPreview
          src={blobUrl}
          fileName={fileName}
          mediaType={mediaType}
          options={params.t ? { t: params.t } : undefined}
        />
      </Suspense>
    </ExpandedShell>
  );
}
