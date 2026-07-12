import { Suspense } from 'react';
import type { RendererProps } from '../types';
import { ExpandedShell } from '../shared/expanded-shell';
import { imagePreview } from '@ui/components/file-preview/previews/image';

const ImageExpandedPreview = imagePreview.variants.expanded!;

export default function ImageExpanded({
  blobUrl,
  fileName,
  mediaType,
}: RendererProps) {
  return (
    <ExpandedShell fileName={fileName}>
      <Suspense fallback={null}>
        <ImageExpandedPreview
          src={blobUrl}
          fileName={fileName}
          mediaType={mediaType}
        />
      </Suspense>
    </ExpandedShell>
  );
}
