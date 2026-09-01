import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { NextConfig } from "next";

const rootPackage = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../..", "package.json"), "utf8"),
) as { version?: unknown };
if (
  typeof rootPackage.version !== "string" ||
  !/^0\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(rootPackage.version)
) {
  throw new Error("The root package must contain a valid pre-1.0 application version.");
}

const appVersion = `v${rootPackage.version}`;
const suppliedAppVersion = process.env.NEXT_PUBLIC_APP_VERSION;
if (suppliedAppVersion !== undefined && suppliedAppVersion !== appVersion) {
  throw new Error(
    `NEXT_PUBLIC_APP_VERSION=${suppliedAppVersion} does not match package.json ${appVersion}.`,
  );
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion,
  },
  images: {
    unoptimized: true,
  },
  output: "standalone",
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
