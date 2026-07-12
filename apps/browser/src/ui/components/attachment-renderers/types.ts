import type { FC, LazyExoticComponent } from 'react';

export interface ParamDescriptor {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  example?: string;
}

export interface RendererProps {
  attachmentId: string;
  mediaType: string;
  fileName: string;
  sizeBytes: number;
  blobUrl: string;
  params: Record<string, string>;
}

export interface BadgeContext {
  viewOnly?: boolean;
  selected?: boolean;
  onDelete?: () => void;
}

export type BadgeProps = RendererProps & BadgeContext;

export interface AttachmentRendererEntry {
  id: string;
  mimePatterns: string[];
  params?: ParamDescriptor[];
  Badge: FC<BadgeProps>;
  Expanded?: LazyExoticComponent<FC<RendererProps>>;
}
