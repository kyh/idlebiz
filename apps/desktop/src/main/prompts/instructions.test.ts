import { describe, expect, it } from "vitest";
import { standingInstructions } from "./instructions";
import { BUSINESS_TYPE_IDS } from "@/shared/domain";
import type { BusinessTypeId, Company, Employee } from "@/shared/domain";

const company = (businessType: BusinessTypeId): Company => ({
  autopilot: true,
  budget: { mode: "infinite" },
  businessType,
  createdAt: 0,
  founderName: "Ada",
  founderSpriteSeed: "s",
  id: "acme",
  leaderId: "lead",
  maxAgents: 12,
  mission: "a deal-flow newsletter",
  name: "Acme",
  revenueUsd: null,
  ships: 0,
  spentUsd: 0,
  users: null,
  workspaceDir: "/tmp/acme",
});
const employee: Employee = {
  companyId: "acme",
  createdAt: 0,
  deskIndex: 0,
  id: "lead",
  instructionsDigest: null,
  lastRunMetrics: null,
  lastShip: null,
  name: "Priya",
  persona: "",
  role: "analyst",
  runner: "claude",
  sessionId: null,
  spriteSeed: "s",
  status: "idle",
  title: "Analyst",
};
const instructionsFor = (businessType: BusinessTypeId, lead = false): string =>
  standingInstructions({
    company: company(businessType),
    employee,
    lead,
    memoryDir: "/tmp/memory",
    products: [],
  });

describe("standingInstructions", () => {
  it("keeps a VC to selling information, and says why it never takes investment money", () => {
    const text = instructionsFor("vc");
    expect(text).toContain("sells information, never investment");
    expect(text).toContain("Stripe's terms forbid");
  });

  it("points a shop at Printful's tools, to US buyers", () => {
    const text = instructionsFor("ecommerce");
    expect(text).toMatch(/printful_catalog[\s\S]*sell_print[\s\S]*US addresses only/u);
    expect(text).toContain("read_orders");
  });

  it("tells every kind of business how it earns", () => {
    const sections = BUSINESS_TYPE_IDS.map(
      (type) => /## How Acme makes money\n(?<how>.+)\n/u.exec(instructionsFor(type))?.groups?.how,
    );
    for (const how of sections) {
      expect(how).toMatch(/create_payment_link/u);
    }
    expect(new Set(sections).size).toBe(BUSINESS_TYPE_IDS.length);
  });

  it("never tells a run to push, only that the founder does", () => {
    for (const type of BUSINESS_TYPE_IDS) {
      for (const lead of [false, true]) {
        const pushing = instructionsFor(type, lead)
          .split("\n")
          .filter((line) => /\bpush/iu.test(line));
        expect(pushing).toEqual([
          expect.stringMatching(/^- Pushing code: nobody on the team pushes\./u),
        ]);
      }
    }
  });

  it("has a game's paid unlock checked on its server, with a key of the product's own the founder makes", () => {
    const text = instructionsFor("game-studio");
    expect(text).toMatch(/paid unlock[^\n]*afterPaymentUrl[^\n]*Checking who paid/u);
    expect(text).toContain('its `payment_status` is `"paid"` and its `payment_link` is the id');
    expect(text).toContain("Create restricted key");
    expect(text).toContain("granting only Checkout Sessions: Read");
    expect(text).toContain("set_env as `STRIPE_CHECKOUT_READ_KEY`");
  });

  it("has the founder deliver what a link sold through its cards, never through ask_boss", () => {
    const text = instructionsFor("software");
    expect(text).toContain("create_payment_link's `delivery`");
    expect(text).toContain("Never ask_boss the founder to deliver");
  });
});
