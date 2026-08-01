import path from 'path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '4mb',
    },
  },
  allowedDevOrigins: ['*.ngrok-free.app', 'localhost:3000'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "script-src 'self' 'unsafe-eval' 'unsafe-inline' https: blob:; frame-src *; connect-src *; img-src * data: blob:;",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
