/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // Remotion's bundler/renderer use native binaries and their own webpack —
  // keep them out of Next's server bundle.
  experimental: {
    serverComponentsExternalPackages: [
      "@remotion/bundler",
      "@remotion/renderer",
    ],
  },
};

export default nextConfig;
