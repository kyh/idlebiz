import { describe, expect, it } from "vitest";
import { autonomousBrief, continuationBrief } from "./briefs";
import { RUN_COST_ESTIMATE_USD } from "@/shared/bets";
import type { BlockedAsk, Company, Employee, Product, RunMetrics, Task } from "@/shared/domain";
import { formatUsd } from "@/shared/format";

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

describe("the brief's budget", () => {
  it("states a capped budget as a fact, with no advice about how close it is", () => {
    const text = briefFor({ ...company, budget: { capUsd: 10, mode: "capped" }, spentUsd: 9 }, [
      product,
    ]);
    expect(text).toContain("AI budget: $9.00 of $10.00 spent.");
    expect(text).not.toContain("critical work only");
  });

  it("prices a run at the estimate the allocator counts runs in flight at, with no sizing advice", () => {
    const text = briefFor(company, [product]);
    expect(text).toContain(`One teammate run costs about ${formatUsd(RUN_COST_ESTIMATE_USD)};`);
    expect(text).not.toContain("buys almost nothing");
  });
});

describe("the brief that carries the founder's answer", () => {
  const task: Task = {
    artifacts: [],
    assigneeId: "lead",
    attempts: 0,
    betId: null,
    companyId: "acme",
    completedAt: null,
    createdAt: 0,
    description: "Wire checkout to the pricing page.",
    id: "checkout",
    origin: "work",
    priority: "medium",
    productId: "app",
    startedAt: null,
    state: { kind: "todo" },
    title: "Add checkout",
  };
  const briefOn = (ask: BlockedAsk, t: Task = task) =>
    continuationBrief(t, ask, "Yes, go ahead.").description;

  it("never says who asked: a leaver's ask may reach the lead", () => {
    const text = briefOn({ question: "Monthly or yearly?", type: "question" });
    expect(text).toContain("This task was waiting on the founder for:\n> Monthly or yearly?");
    expect(text).toContain("The founder answered:\n> Yes, go ahead.");
    expect(text).not.toContain("You previously asked");
  });

  it("carries the original task's description, when it has one", () => {
    const ask: BlockedAsk = { question: "Monthly or yearly?", type: "question" };
    expect(briefOn(ask)).toContain(
      "Original task: Add checkout\n\nWire checkout to the pricing page.",
    );
    expect(briefOn(ask, { ...task, description: null })).toMatch(/Original task: Add checkout$/u);
  });

  it.each<[BlockedAsk, string, string]>([
    [
      { question: "[connect:stripe] should I set up billing?", type: "question" },
      "> [connect:stripe] should I set up billing?",
      "[ask]",
    ],
    [
      { command: "npx vercel deploy --prod", rule: "deploy", type: "approval" },
      "> permission to run `npx vercel deploy --prod`",
      "[approve:deploy]",
    ],
    [
      { integration: "stripe", reason: "to take payments", type: "integration" },
      "> a Stripe connection: to take payments",
      "[connect:stripe]",
    ],
  ])("reads a %j ask in words, not as TASK.md stores it", (ask, words, stored) => {
    const text = briefOn(ask);
    expect(text).toContain(words);
    expect(text).not.toContain(stored);
  });
});
