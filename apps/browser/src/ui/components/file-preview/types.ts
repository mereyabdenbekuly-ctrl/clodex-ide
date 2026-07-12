import type { FC, LazyExoticComponent } from 'react';

export interface FilePreviewProps {
  src: string;
  fileName: string;
  mediaType: string;
  className?: string;
  options?: Record<string, unknown>;
}

export type PreviewComponent =
  | FC<FilePreviewProps>
  | LazyExoticComponent<FC<FilePreviewProps>>;

export interface FilePreviewEntry {
  id: string;
  mimePatterns: string[];
  extensionPatterns?: string[];
  variants: {
    compact: FC<FilePreviewProps>;
    [key: string]: PreviewComponent;
  };
}
