import { resolve } from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    unoptimized: true,
  },
  output: "standalone",
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
