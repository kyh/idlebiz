import { describe, expect, it } from "vitest";

import { aboutPage } from "./site-content";
import { homeGraph, organization, pageGraph, serializeJsonLd } from "./structured-data";

describe("homeGraph", () => {
  it("identifies the organization, the site and the app", () => {
    const types = homeGraph["@graph"].map((node) => node["@type"]);
    expect(types).toEqual(["Organization", "WebSite", "SoftwareApplication"]);
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
});

describe("serializeJsonLd", () => {
  it("cannot close its script tag early", () => {
    const json = serializeJsonLd({ name: "</script><script>alert(1)</script>" });
    expect(json).not.toContain("<");
    expect(JSON.parse(json)).toEqual({ name: "</script><script>alert(1)</script>" });
  });
});
