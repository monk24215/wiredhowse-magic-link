import type { NextConfig } from 'next';

const config: NextConfig = {
  // API calls from server components go to the internal API service URL.
  // Client-side calls use NEXT_PUBLIC_API_URL.
  async rewrites() {
    return [
      {
        source: '/api/v1/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/v1/:path*`,
      },
    ];
  },
};

export default config;
