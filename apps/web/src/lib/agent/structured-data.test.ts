import { describe, expect, it } from "vitest";

import { aboutPage, privacyPage, termsPage } from "./site-content";
import { homeGraph, organization, pageGraph, serializeJsonLd } from "./structured-data";

describe("homeGraph", () => {
  it("identifies the organization, the site and the app", () => {
    const types = homeGraph["@graph"].map((node) => node["@type"]);
    expect(types).toEqual(["Organization", "WebSite", "SoftwareApplication", "VideoObject"]);
  });

  it("describes the office clip with absolute URLs and an ISO duration", () => {
    const app = homeGraph["@graph"].find((node) => node["@type"] === "SoftwareApplication");
    const video = homeGraph["@graph"].find((node) => node["@type"] === "VideoObject");
    expect(app).toHaveProperty("video", { "@id": "https://idlebiz.com/#video" });
    expect(app).toHaveProperty("operatingSystem", "macOS");
    expect(video).toMatchObject({
      contentUrl: "https://idlebiz.com/og/og.mp4",
      duration: "PT8S",
      thumbnailUrl: "https://idlebiz.com/og/og.jpg",
    });
  });

  it("requires Apple silicon, since every released .dmg is arm64", () => {
    expect(homeGraph["@graph"][2]).toHaveProperty(
      "softwareRequirements",
      expect.stringMatching(/^An Apple silicon Mac/u),
    );
  });

  it("gives the organization a contact point and no invented address", () => {
    expect(organization.contactPoint[0]?.email).toBe("kai@kyh.io");
    expect(organization).not.toHaveProperty("address");
    expect(organization).not.toHaveProperty("telephone");
  });
});

describe("pageGraph", () => {
  it("types the page from its content", () => {
    const [, page] = pageGraph(aboutPage)["@graph"];
    expect(page?.["@type"]).toBe("AboutPage");
    expect(page?.url).toBe("https://idlebiz.com/about");
  });

  it("types each legal document as a WebPage at its own URL", () => {
    for (const legal of [privacyPage, termsPage]) {
      const [, page] = pageGraph(legal)["@graph"];
      expect(page?.["@type"]).toBe("WebPage");
      expect(page?.name).toBe(legal.title);
      expect(page?.url).toBe(`https://idlebiz.com${legal.path}`);
      expect(page).toHaveProperty("dateModified", "2026-10-29");
    }
  });

  it("places each page under the home page in a breadcrumb", () => {
    const breadcrumb = pageGraph(aboutPage)["@graph"].find(
      (node) => node["@type"] === "BreadcrumbList",
    );
    expect(breadcrumb?.["@type"]).toBe("BreadcrumbList");
    expect(breadcrumb).toHaveProperty("itemListElement", [
      { "@type": "ListItem", item: "https://idlebiz.com", name: "IdleBiz", position: 1 },
      { "@type": "ListItem", item: "https://idlebiz.com/about", name: "About", position: 2 },
    ]);
  });
});

describe("serializeJsonLd", () => {
  it("cannot close its script tag early", () => {
    const json = serializeJsonLd({ name: "</script><script>alert(1)</script>" });
    expect(json).not.toContain("<");
    expect(JSON.parse(json)).toEqual({ name: "</script><script>alert(1)</script>" });
  });
});
