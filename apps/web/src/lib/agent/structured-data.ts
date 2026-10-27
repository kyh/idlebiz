import { siteConfig } from "@/lib/site-config";

import { pageRevisedOn, siteSummary } from "@/lib/agent/site-content";
import type { ProsePage } from "@/lib/agent/site-content";

type JsonLdValue =
  | string
  | number
  | boolean
  | null
  | JsonLdValue[]
  | { [key: string]: JsonLdValue };

export interface JsonLdNode {
  [key: string]: JsonLdValue;
}

const ORGANIZATION_ID = `${siteConfig.url}/#organization`;
const WEBSITE_ID = `${siteConfig.url}/#website`;

const VIDEO_ID = `${siteConfig.url}/#video`;

const sameAs = [siteConfig.repository, "https://x.com/kaiyuhsu"];

/**
 * No `address` or `telephone`: IdleBiz is one developer's project with no
 * premises, and a made-up PostalAddress would be worse than none.
 */
export const organization = {
  "@id": ORGANIZATION_ID,
  "@type": "Organization",
  contactPoint: [
    {
      "@type": "ContactPoint",
      availableLanguage: ["en"],
      contactType: "customer support",
      email: siteConfig.email,
      url: `${siteConfig.url}/contact`,
    },
    {
      "@type": "ContactPoint",
      availableLanguage: ["en"],
      contactType: "technical support",
      email: siteConfig.email,
      url: `${siteConfig.repository}/issues`,
    },
  ],
  description: siteSummary,
  email: siteConfig.email,
  founder: { "@type": "Person", name: siteConfig.author.name, url: siteConfig.author.url },
  logo: `${siteConfig.url}/icon.png`,
  name: siteConfig.name,
  sameAs,
  url: siteConfig.url,
} satisfies JsonLdNode;

const website = {
  "@id": WEBSITE_ID,
  "@type": "WebSite",
  description: siteConfig.description,
  inLanguage: "en-US",
  name: siteConfig.name,
  publisher: { "@id": ORGANIZATION_ID },
  url: siteConfig.url,
} satisfies JsonLdNode;

const application = {
  "@id": `${siteConfig.url}/#application`,
  "@type": "SoftwareApplication",
  applicationCategory: "GameApplication",
  applicationSubCategory: "Idle business simulation",
  description: siteSummary,
  downloadUrl: `${siteConfig.repository}/releases/latest`,
  isAccessibleForFree: true,
  name: siteConfig.name,
  offers: {
    "@type": "Offer",
    availability: "https://schema.org/InStock",
    price: "0",
    priceCurrency: "USD",
  },
  operatingSystem: "macOS",
  publisher: { "@id": ORGANIZATION_ID },
  sameAs,
  screenshot: `${siteConfig.url}${siteConfig.video.poster}`,
  softwareRequirements:
    "An Apple silicon Mac and a signed-in Claude Code (claude) or Codex (codex) CLI",
  url: siteConfig.url,
  video: { "@id": VIDEO_ID },
} satisfies JsonLdNode;

/** The office clip the home page shares as og:video. */
const video = {
  "@id": VIDEO_ID,
  "@type": "VideoObject",
  contentUrl: `${siteConfig.url}${siteConfig.video.url}`,
  description: `The ${siteConfig.name} office filling the frame as the camera drifts over the desks: the team typing and walking to the cooler and along the corridors, while the revenue plate in the top left counts up each sale and the logo sits in the bottom right.`,
  duration: `PT${siteConfig.video.durationSeconds}S`,
  height: siteConfig.video.height,
  name: `${siteConfig.name} — the office at work`,
  publisher: { "@id": ORGANIZATION_ID },
  thumbnailUrl: `${siteConfig.url}${siteConfig.video.poster}`,
  uploadDate: siteConfig.video.uploadDate,
  width: siteConfig.video.width,
} satisfies JsonLdNode;

export const homeGraph = {
  "@context": "https://schema.org",
  "@graph": [organization, website, application, video],
} satisfies JsonLdNode;

export const pageGraph = (page: ProsePage) =>
  ({
    "@context": "https://schema.org",
    "@graph": [
      organization,
      {
        "@id": `${siteConfig.url}${page.path}#webpage`,
        "@type": page.schemaType,
        about: { "@id": ORGANIZATION_ID },
        breadcrumb: { "@id": `${siteConfig.url}${page.path}#breadcrumb` },
        dateModified: pageRevisedOn(page),
        description: page.description,
        inLanguage: "en-US",
        isPartOf: { "@id": WEBSITE_ID },
        name: page.title,
        url: `${siteConfig.url}${page.path}`,
      },
      {
        "@id": `${siteConfig.url}${page.path}#breadcrumb`,
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", item: siteConfig.url, name: siteConfig.name, position: 1 },
          {
            "@type": "ListItem",
            item: `${siteConfig.url}${page.path}`,
            name: page.title,
            position: 2,
          },
        ],
      },
    ],
  }) satisfies JsonLdNode;

/** Escapes `<` so no value can close the surrounding `<script>` early. */
export const serializeJsonLd = (node: JsonLdNode): string =>
  JSON.stringify(node).replaceAll("<", "\\u003c");
