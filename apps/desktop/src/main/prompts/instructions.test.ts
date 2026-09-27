import { describe, expect, it } from "vitest";
import { standingInstructions } from "./instructions";
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
const instructionsFor = (businessType: BusinessTypeId): string =>
  standingInstructions({
    company: company(businessType),
    employee,
    lead: false,
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
});
