import { siteConfig } from "@/lib/site-config";

import { siteSummary } from "@/lib/agent/site-content";
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
  softwareRequirements: "A signed-in Claude Code (claude) or Codex (codex) CLI",
  url: siteConfig.url,
} satisfies JsonLdNode;

export const homeGraph = {
  "@context": "https://schema.org",
  "@graph": [organization, website, application],
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
        description: page.description,
        isPartOf: { "@id": WEBSITE_ID },
        name: page.title,
        url: `${siteConfig.url}${page.path}`,
      },
    ],
  }) satisfies JsonLdNode;

/** Escapes `<` so no value can close the surrounding `<script>` early. */
export const serializeJsonLd = (node: JsonLdNode): string =>
  JSON.stringify(node).replaceAll("<", "\\u003c");
