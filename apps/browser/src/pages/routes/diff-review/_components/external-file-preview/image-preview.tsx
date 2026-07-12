import { memo, type FC } from 'react';
import { Loader2Icon } from 'lucide-react';
import { inferImageMimeType } from '@ui/utils/file-type-utils';

export interface ImagePreviewProps {
  base64Content: string | null;
  mimeType: string | null;
  filePath: string;
  isLoading: boolean;
  error: string | null;
}

export const ImagePreview: FC<ImagePreviewProps> = memo(
  ({ base64Content, mimeType, filePath, isLoading, error }) => {
    if (isLoading) {
      return (
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-32 w-full items-center justify-center rounded-md border border-border bg-surface-1">
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </div>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-32 w-full items-center justify-center rounded-md border border-error border-dashed bg-error/5 text-error-foreground text-sm">
            {error}
          </div>
        </div>
      );
    }

    if (base64Content === null) {
      return (
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-32 w-full items-center justify-center rounded-md border border-border border-dashed bg-surface-1 text-muted-foreground text-sm">
            No file
          </div>
        </div>
      );
    }

    const resolvedMime = mimeType ?? inferImageMimeType(filePath);
    const dataUrl = `data:${resolvedMime};base64,${base64Content}`;

    return (
      <div className="flex flex-col items-center gap-2">
        <div className="flex max-h-64 items-center justify-center overflow-hidden rounded-md border border-border bg-surface-1">
          <img
            src={dataUrl}
            className="max-h-64 max-w-full object-contain"
            alt="Preview"
          />
        </div>
      </div>
    );
  },
);
