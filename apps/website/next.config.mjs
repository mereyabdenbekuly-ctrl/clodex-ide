import { fileURLToPath } from 'node:url';

const monorepoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingRoot: monorepoRoot,
  pageExtensions: ['js', 'jsx', 'ts', 'tsx', 'md', 'mdx'],
  images: {
    unoptimized: true,
    deviceSizes: [360, 414, 640, 768, 1024, 1280, 1536, 1920, 2560],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    formats: ['image/avif', 'image/webp'],
    qualities: [70, 75, 80, 85],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'github.com',
      },
      {
        protocol: 'https',
        hostname: 'pbs.twimg.com',
      },
      {
        protocol: 'https',
        hostname: 'i.ytimg.com',
      },
      {
        protocol: 'https',
        hostname: 'img.youtube.com',
      },
      {
        protocol: 'https',
        hostname: 'media.licdn.com',
      },
    ],
  },
  async redirects() {
    return [
      {
        source: '/downloads/clodex-1.16.0-arm64.dmg',
        destination: '/download',
        permanent: false,
      },
      {
        source: '/docs/:path*',
        destination: 'https://docs.clodex.io/:path*',
        permanent: true,
      },
      {
        source: '/pricing',
        destination: '/',
        permanent: true,
      },
      {
        source: '/enterprise',
        destination: '/',
        permanent: true,
      },
      {
        source: '/company',
        destination: '/',
        permanent: true,
      },
      {
        source: '/careers/:path*',
        destination: '/',
        permanent: true,
      },
      {
        source: '/news/:path*',
        destination: '/',
        permanent: true,
      },
      {
        source: '/use-cases/:path*',
        destination: '/',
        permanent: true,
      },
      {
        source: '/vscode-extension/:path*',
        destination: '/',
        permanent: true,
      },
      {
        source: '/team',
        destination: '/',
        permanent: true,
      },
      {
        source: '/mission',
        destination: '/',
        permanent: true,
      },
      {
        source: '/trademark-policy',
        destination: '/',
        permanent: true,
      },
      {
        source: '/legal-notice',
        destination: '/',
        permanent: true,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/api/auth/:path*',
        destination: 'https://api.clodex.io/v1/auth/:path*',
      },
      {
        source: '/ingest/static/:path*',
        destination: 'https://us-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/ingest/:path*',
        destination: 'https://us.i.posthog.com/:path*',
      },
      {
        source: '/ingest/decide',
        destination: 'https://us.i.posthog.com/decide',
      },
      {
        source: '/imprint',
        destination: '/',
      },
      {
        source: '/socials/x',
        destination: 'https://x.com/CLODEx_lab',
      },
    ];
  },
  // This is required to support PostHog trailing slash API requests
  skipTrailingSlashRedirect: true,
};

export default config;
