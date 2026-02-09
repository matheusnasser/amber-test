/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@supplier-negotiation/database",
    "@supplier-negotiation/shared",
  ],
};

module.exports = nextConfig;
