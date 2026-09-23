import { describe, expect, it } from "vitest";
import { autonomousBrief } from "./briefs";
import type { Company, Employee, Product, RunMetrics } from "@/shared/domain";

const company: Company = {
  autopilot: true,
  budget: { mode: "infinite" },
  businessType: "software",
  createdAt: 0,
  founderName: "Ada",
  founderSpriteSeed: "s",
  id: "acme",
  leaderId: "lead",
  maxAgents: 12,
  mission: "a to-do app",
  name: "Acme",
  revenueUsd: null,
  ships: 0,
  spentUsd: 0,
  users: null,
  workspaceDir: "/tmp/acme",
};
const employee: Employee = {
  companyId: "acme",
  createdAt: 0,
  deskIndex: 0,
  id: "lead",
  lastRunMetrics: null,
  lastShip: null,
  name: "Priya",
  persona: "",
  role: "engineer",
  runner: "claude",
  sessionId: null,
  spriteSeed: "s",
  status: "idle",
  title: "Founding Engineer",
};
const product: Product = {
  companyId: "acme",
  createdAt: 0,
  description: "the app",
  id: "app",
  lastShipAt: null,
  name: "App",
  revenueUsd: null,
  ships: 0,
  users: null,
  vercel: null,
  workspaceDir: "/tmp/acme",
};

const briefFor = (co: Company, products: Product[], lastRunMetrics: RunMetrics | null = null) =>
  autonomousBrief({
    assignment: { kind: "propose", product: products[0] ?? null, widen: false },
    bets: [],
    company: co,
    employee: { ...employee, lastRunMetrics },
    employees: [employee],
    nameOf: () => "Priya",
    problems: [],
    products,
    room: [],
    ships: [],
  }).description;

describe("the brief's real numbers", () => {
  it("names the missing source rather than reporting zero", () => {
    const text = briefFor(company, [product]);
    expect(text).toContain("Revenue: no source connected");
    expect(text).toContain("Users: no source connected");
    expect(text).not.toContain("Revenue: $0.00");
  });

  it("reports live figures, per product where a deploy reports them", () => {
    const text = briefFor({ ...company, revenueUsd: 12.5, users: 340 }, [
      { ...product, users: 300 },
      { ...product, id: "site", name: "Site", users: null },
    ]);
    expect(text).toContain("Revenue: $12.50 lifetime");
    expect(text).toContain("Users: 340 visitors");
    expect(text).toContain("- App: 300 visitors");
    expect(text).not.toContain("- Site:");
  });

  it("says how the numbers moved since the employee's last run", () => {
    const text = briefFor({ ...company, revenueUsd: 12.5, users: 340 }, [product], {
      at: 0,
      revenueUsd: 10,
      users: 340,
    });
    expect(text).toContain("+$2.50 since your last run");
    expect(text).toContain("unchanged since your last run");
  });
});
