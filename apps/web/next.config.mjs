/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The shared package builds to CJS and lives outside node_modules — Next has
  // to run it through its own pipeline, otherwise the import fails at build.
  transpilePackages: ['@caseforge/shared'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'community.cloudflare.steamstatic.com' },
      { protocol: 'https', hostname: 'avatars.steamstatic.com' },
      { protocol: 'https', hostname: 'steamcdn-a.akamaihd.net' },
    ],
  },
};

export default nextConfig;
