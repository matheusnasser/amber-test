/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@supplier-negotiation/database",
    "@supplier-negotiation/shared",
  ],
  output: 'standalone',
  async rewrites() {
    // In production, NEXT_PUBLIC_API_URL points to the Express API service.
    // In dev, it falls back to localhost:4000.
    const apiDest = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
    return [
      {
        source: '/api/:path*',
        destination: `${apiDest}/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
