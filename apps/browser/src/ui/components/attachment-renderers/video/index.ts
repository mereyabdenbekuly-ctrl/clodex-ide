import { lazy } from 'react';
import type { AttachmentRendererEntry } from '../types';
import { VideoBadge } from './badge';

export const videoRenderer: AttachmentRendererEntry = {
  id: 'video',
  mimePatterns: ['video/*'],
  params: [
    {
      name: 't',
      type: 'number',
      description: 'Start time in seconds',
      example: '30',
    },
  ],
  Badge: VideoBadge,
  Expanded: lazy(() => import('./expanded')),
};
