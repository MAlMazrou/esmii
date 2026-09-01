import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { AppVersion } from "../components/app-version";

import "./globals.css";

export const metadata: Metadata = {
  description: "Esmii account and organization account",
  title: {
    default: "Esmii",
    template: "%s · Esmii",
  },
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#fbfaf7",
};

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {children}
        <AppVersion />
      </body>
    </html>
  );
}
