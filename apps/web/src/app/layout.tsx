import type { Metadata, Viewport } from "next";

import { siteConfig } from "@/lib/site-config";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: siteConfig.name,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
  openGraph: {
    locale: "en-US",
    type: "website",
    url: siteConfig.url,
    title: siteConfig.name,
    description: siteConfig.description,
    siteName: siteConfig.name,
  },
  twitter: {
    card: "summary",
    title: siteConfig.name,
    description: siteConfig.description,
    creator: siteConfig.twitter,
  },
  other: {
    "apple-mobile-web-app-title": siteConfig.name,
  },
};

export const viewport: Viewport = {
  themeColor: "#12141c",
};

type LayoutProps = {
  children: React.ReactNode;
};

const RootLayout = (props: LayoutProps) => {
  return (
    <html lang="en">
      <body>{props.children}</body>
    </html>
  );
};

export default RootLayout;
