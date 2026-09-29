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
  session: null,
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

  it("says a run can make no git repository, and how to fetch a repository's code instead", () => {
    const text = instructionsFor("software");
    expect(text).toMatch(/cannot make a git repository[^\n]*`git clone`[^\n]*`git init`[^\n]*tar/u);
  });

  it("has the team keep a product's notes in its workspace's AGENTS.md, a CLAUDE.md folded in", () => {
    const text = instructionsFor("software");
    expect(text).toContain("in `AGENTS.md` at the root of its workspace");
    expect(text).toContain("fold any you find into `AGENTS.md`");
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
    expect(text).toContain(
      'only `payment_status` `"paid"` on the id create_payment_link answered with unlocks',
    );
    expect(text).toContain(
      "Create restricted key, in live mode unless create_payment_link said Stripe is in test mode; start from no permissions, set only Checkout Sessions to Read, then Create key",
    );
    expect(text).toContain("set_env as `STRIPE_CHECKOUT_READ_KEY`");
  });

  it("has a purchase read from Stripe once, then trusted on a signed cookie, with a payment still clearing kept", () => {
    const text = instructionsFor("game-studio");
    expect(text).toContain("Ask Stripe once per purchase");
    expect(text).toContain("keep it with set_env too");
    expect(text).toContain('createHmac("sha256", secret)');
    expect(text).toContain('if (res === null || !res.ok) return "retry";');
    expect(text).toContain('return session.status === "complete" ? "processing" : "refused";');
    expect(text).toContain('A Stripe 429 or 5xx means ask again later, never "not paid".');
  });

  it("says a paid session id unlocks for whoever holds it, and how to tie a purchase to one buyer", () => {
    const text = instructionsFor("game-studio");
    expect(text).toContain("anyone who has one unlocks");
    expect(text).toContain("nothing may show, log or link it");
    expect(text).toContain("`customer_details.email`");
  });

  it("has the founder deliver what a link sold through its cards, never through ask_boss", () => {
    const text = instructionsFor("software");
    expect(text).toContain("create_payment_link's `delivery`");
    expect(text).toContain("Never ask_boss the founder to deliver");
  });
});
