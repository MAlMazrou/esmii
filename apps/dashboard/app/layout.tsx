import type { Metadata } from "next";

import { parsePublicDashboardConfig } from "../lib/config/server.ts";

import "./globals.css";

// One immutable image serves both environments. Keep environment identity and
// metadata request-time so the build cannot bake staging values into production.
export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  const environment = parsePublicDashboardConfig().environment.toUpperCase();
  return {
    description: `Private Esmii ${environment.toLowerCase()} infrastructure monitoring`,
    icons: { icon: "/environment-icon.svg" },
    robots: { follow: false, index: false },
    title: `${environment} · Esmii monitoring`,
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const config = parsePublicDashboardConfig();
  return (
    <html data-theme={config.themeFixture ?? undefined} lang="en">
      <body>{children}</body>
    </html>
  );
}
