import type { AttachmentRendererEntry } from '../types';
import { FallbackBadge } from './badge';

export const fallbackRenderer: AttachmentRendererEntry = {
  id: 'fallback',
  mimePatterns: ['*/*'],
  Badge: FallbackBadge,
};
