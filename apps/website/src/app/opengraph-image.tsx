import {
  OG_SIZE,
  OG_CONTENT_TYPE,
  generateOgImage,
  loadGeistMedium,
} from '@/lib/og-image';

export const runtime = 'nodejs';
export const alt = 'Clodex - Agentic IDE for the complete development loop';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  const geistMedium = loadGeistMedium();
  return generateOgImage({
    pageName: 'Agentic IDE for the complete development loop',
    geistFont: geistMedium,
    centered: true,
  });
}
