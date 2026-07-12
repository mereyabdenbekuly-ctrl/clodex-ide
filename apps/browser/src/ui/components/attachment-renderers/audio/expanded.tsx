import { Suspense } from 'react';
import type { RendererProps } from '../types';
import { ExpandedShell } from '../shared/expanded-shell';
import { audioPreview } from '@ui/components/file-preview/previews/audio';

const AudioExpandedPreview = audioPreview.variants.expanded!;

export default function AudioExpanded({
  blobUrl,
  fileName,
  mediaType,
}: RendererProps) {
  return (
    <ExpandedShell fileName={fileName}>
      <Suspense fallback={null}>
        <AudioExpandedPreview
          src={blobUrl}
          fileName={fileName}
          mediaType={mediaType}
        />
      </Suspense>
    </ExpandedShell>
  );
}
