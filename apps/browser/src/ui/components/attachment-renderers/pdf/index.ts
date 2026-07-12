import { lazy } from 'react';
import type { AttachmentRendererEntry } from '../types';
import { PdfBadge } from './badge';

export const pdfRenderer: AttachmentRendererEntry = {
  id: 'pdf',
  mimePatterns: ['application/pdf'],
  Badge: PdfBadge,
  Expanded: lazy(() => import('./expanded')),
};
