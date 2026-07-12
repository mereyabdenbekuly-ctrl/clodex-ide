import { Suspense } from 'react';
import type { RendererProps } from '../types';
import { ExpandedShell } from '../shared/expanded-shell';
import { pdfPreview } from '@ui/components/file-preview/previews/pdf';

const PdfExpandedPreview = pdfPreview.variants.expanded!;

export default function PdfExpanded({
  blobUrl,
  fileName,
  mediaType,
}: RendererProps) {
  return (
    <ExpandedShell fileName={fileName} className="min-w-72">
      <Suspense fallback={null}>
        <PdfExpandedPreview
          src={blobUrl}
          fileName={fileName}
          mediaType={mediaType}
        />
      </Suspense>
    </ExpandedShell>
  );
}
