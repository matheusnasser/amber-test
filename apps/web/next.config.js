/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@supplier-negotiation/database",
    "@supplier-negotiation/shared",
  ],
  output: 'standalone',
};

module.exports = nextConfig;
