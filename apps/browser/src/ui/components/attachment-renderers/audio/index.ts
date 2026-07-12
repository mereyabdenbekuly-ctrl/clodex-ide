import { lazy } from 'react';
import type { AttachmentRendererEntry } from '../types';
import { AudioBadge } from './badge';

export const audioRenderer: AttachmentRendererEntry = {
  id: 'audio',
  mimePatterns: ['audio/*'],
  Badge: AudioBadge,
  Expanded: lazy(() => import('./expanded')),
};
