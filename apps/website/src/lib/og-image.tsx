import { ImageResponse } from 'next/og';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = 'image/png';

const LOGO_MARK_DATA_URI = `data:image/png;base64,${readFileSync(
  join(process.cwd(), 'public/clodex-mark.png'),
).toString('base64')}`;

function LogoCombo({ size }: { size: number }) {
  const gap = size * 0.4;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: `${gap}px` }}>
      <img src={LOGO_MARK_DATA_URI} width={size} height={size} alt="" />
      <div
        style={{
          color: '#161515',
          fontFamily: 'Geist',
          fontSize: `${size * 0.72}px`,
          fontWeight: 700,
          letterSpacing: '0.08em',
        }}
      >
        CLODEX
      </div>
    </div>
  );
}

function generateContentOgImage({
  label,
  title,
  subtitle,
  bottomUrl,
  geistFont,
}: {
  label: string;
  title: string;
  subtitle?: string;
  bottomUrl: string;
  geistFont: Buffer;
}): ImageResponse {
  const logoSize = 40;
  const padding = 56;

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        justifyContent: 'center',
        background: '#fdfcfc',
        padding: `0 0 0 ${padding}px`,
        position: 'relative',
      }}
    >
      {/* Logo mark + label */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: `${logoSize * 0.4}px`,
        }}
      >
        <img
          src={LOGO_MARK_DATA_URI}
          width={logoSize}
          height={logoSize}
          alt=""
        />
        <div
          style={{
            fontSize: `${logoSize * 0.9}px`,
            fontWeight: 500,
            color: '#161515',
            letterSpacing: '-0.025em',
            fontFamily: 'Geist',
          }}
        >
          {label}
        </div>
      </div>
      {/* Title */}
      <div
        style={{
          marginTop: '20px',
          fontSize: '72px',
          fontWeight: 500,
          color: '#161515',
          letterSpacing: '-0.025em',
          fontFamily: 'Geist',
          maxWidth: `${OG_SIZE.width - padding * 2}px`,
          lineHeight: 1.1,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {title}
      </div>
      {/* Subtitle */}
      {subtitle && (
        <div
          style={{
            marginTop: '20px',
            fontSize: '32px',
            fontWeight: 500,
            color: '#595855',
            letterSpacing: '-0.01em',
            fontFamily: 'Geist',
          }}
        >
          {subtitle}
        </div>
      )}
      {/* Bottom-right URL */}
      <div
        style={{
          position: 'absolute',
          bottom: `${padding}px`,
          right: `${padding}px`,
          fontSize: '28px',
          fontWeight: 500,
          color: '#595855',
          letterSpacing: '-0.01em',
          fontFamily: 'Geist',
        }}
      >
        {bottomUrl}
      </div>
    </div>,
    {
      ...OG_SIZE,
      fonts: [
        {
          name: 'Geist',
          data: geistFont,
          style: 'normal',
          weight: 500,
        },
      ],
    },
  );
}

export function generateNewsPostOgImage({
  postTitle,
  postDate,
  geistFont,
}: {
  postTitle: string;
  postDate?: Date;
  geistFont: Buffer;
}): ImageResponse {
  const subtitle = postDate
    ? postDate.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : undefined;

  return generateContentOgImage({
    label: 'Newsroom',
    title: postTitle,
    subtitle,
    bottomUrl: 'ide.clodex.xyz/news',
    geistFont,
  });
}

export function generateJobOgImage({
  jobTitle,
  jobLocation,
  geistFont,
}: {
  jobTitle: string;
  jobLocation?: string;
  geistFont: Buffer;
}): ImageResponse {
  return generateContentOgImage({
    label: 'Career',
    title: jobTitle,
    subtitle: jobLocation,
    bottomUrl: 'ide.clodex.xyz/careers',
    geistFont,
  });
}

export function generateOgImage({
  pageName,
  pageSlug,
  geistFont,
  centered = false,
}: {
  pageName?: string;
  pageSlug?: string;
  geistFont: Buffer;
  centered?: boolean;
}): ImageResponse {
  const logoSize = centered ? 96 : 40;
  const padding = 56;

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: centered ? 'center' : 'flex-start',
        justifyContent: 'center',
        background: '#fdfcfc',
        padding: centered ? '0' : `0 0 0 ${padding}px`,
        position: 'relative',
      }}
    >
      <LogoCombo size={logoSize} />
      {!centered && pageName && (
        <div
          style={{
            position: 'absolute',
            bottom: `${padding}px`,
            right: `${padding}px`,
            fontSize: '28px',
            fontWeight: 500,
            color: '#595855',
            letterSpacing: '-0.01em',
            fontFamily: 'Geist',
          }}
        >
          {`ide.clodex.xyz/${pageSlug ?? pageName?.toLowerCase()}`}
        </div>
      )}
      {pageName && (
        <div
          style={{
            marginTop: centered ? '52px' : '20px',
            fontSize: centered ? '52px' : '84px',
            fontWeight: 500,
            color: '#161515',
            letterSpacing: '-0.025em',
            fontFamily: 'Geist',
          }}
        >
          {pageName}
        </div>
      )}
    </div>,
    {
      ...OG_SIZE,
      fonts: [
        {
          name: 'Geist',
          data: geistFont,
          style: 'normal',
          weight: 500,
        },
      ],
    },
  );
}

export function loadGeistMedium(): Buffer {
  return readFileSync(
    join(
      process.cwd(),
      '../../node_modules/geist/dist/fonts/geist-sans/Geist-Medium.ttf',
    ),
  );
}
