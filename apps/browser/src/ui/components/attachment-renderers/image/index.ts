import { lazy } from 'react';
import type { AttachmentRendererEntry } from '../types';
import { ImageBadge } from './badge';

export const imageRenderer: AttachmentRendererEntry = {
  id: 'image',
  mimePatterns: ['image/*'],
  Badge: ImageBadge,
  Expanded: lazy(() => import('./expanded')),
};
