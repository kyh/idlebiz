import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { siteConfig } from "@/lib/site-config";

import "./globals.css";

export const metadata: Metadata = {
  description: siteConfig.description,
  metadataBase: new URL(siteConfig.url),
  openGraph: {
    description: siteConfig.description,
    locale: "en-US",
    siteName: siteConfig.name,
    title: siteConfig.name,
    type: "website",
    url: siteConfig.url,
  },
  other: {
    "apple-mobile-web-app-title": siteConfig.name,
  },
  title: {
    default: siteConfig.name,
    template: `%s | ${siteConfig.name}`,
  },
  twitter: {
    card: "summary",
    creator: siteConfig.twitter,
    description: siteConfig.description,
    title: siteConfig.name,
  },
};

export const viewport: Viewport = {
  themeColor: "#12141c",
};

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang="en">
    <body>{children}</body>
  </html>
);

export default RootLayout;
