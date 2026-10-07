import { describe, expect, it } from "vitest";
import { actionAnswer, autonomousBrief, continuationBrief, roomTranscript } from "./briefs";
import { RUN_COST_ESTIMATE_USD } from "@repo/domain/bets";
import type {
  BlockedAsk,
  Company,
  Employee,
  Product,
  RunMetrics,
  Task,
  TeamMessage,
} from "@repo/domain/domain";
import { UNNAMED_PRODUCT_DESCRIPTION } from "@repo/domain/domain";
import { formatUsd } from "@repo/domain/format";

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
  instructionsDigest: null,
  lastRunMetrics: null,
  lastShip: null,
  name: "Priya",
  persona: "",
  role: "engineer",
  runner: "claude",
  session: null,
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

const briefFor = (
  co: Company,
  products: Product[],
  lastRunMetrics: RunMetrics | null = null,
  stripeTestMode = false,
) =>
  autonomousBrief({
    assignment: { kind: "propose", newProduct: true, product: products[0] ?? null, widen: false },
    bets: [],
    company: co,
    employee: { ...employee, lastRunMetrics },
    employees: [employee],
    nameOf: () => "Priya",
    problems: [],
    products,
    room: [],
    ships: [],
    stripeTestMode,
  }).description;

const line = (from: TeamMessage["from"], text: string): TeamMessage => ({
  companyId: "acme",
  createdAt: 0,
  from,
  id: 0,
  text,
});

describe("the team room as the team reads it", () => {
  it("names the founder and a teammate, and gives the office's news no speaker", () => {
    const room = roomTranscript(
      [
        line({ kind: "office" }, "🎲 New bet: Launch post"),
        line({ kind: "founder" }, "ship it"),
        line({ id: "lead", kind: "employee" }, "on it"),
      ],
      (id) => (id === "lead" ? "Priya" : "someone"),
    );
    expect(room).toBe("- 🎲 New bet: Launch post\n- founder: ship it\n- Priya: on it");
  });
});

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

  it("says a test-mode Stripe counts no charge rather than reporting zero", () => {
    const text = briefFor({ ...company, revenueUsd: 0 }, [product], null, true);
    expect(text).toContain("Revenue: Stripe is in test mode — no charge counts");
    expect(text).not.toContain("Revenue: $0.00");
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

const proposal = (
  widen: boolean,
  newProduct: boolean,
  co: Company = company,
  focus: Product = product,
): string =>
  autonomousBrief({
    assignment: { kind: "propose", newProduct, product: focus, widen },
    bets: [],
    company: co,
    employee,
    employees: [employee],
    nameOf: () => "Priya",
    problems: [],
    products: [focus],
    room: [],
    ships: [],
    stripeTestMode: false,
  }).description;

describe("the brief that asks for the next bet", () => {
  it("offers a new product as new ground only while the portfolio has room for one", () => {
    expect(proposal(true, true)).toContain("create_product, then bet on it");
    const full = proposal(true, false);
    expect(full).not.toContain("create_product");
    expect(full).toContain("a channel it has never tried — App (app) has room for one.");
    expect(full).toContain("already runs 5 products, all it can: a new one needs kill_product");
  });

  it("leaves what to build to the lead when the founder gave no pitch", () => {
    const text = proposal(false, true, { ...company, mission: null });
    expect(text).toContain("Mission: none given — the lead picks what to build");
    expect(text).toContain("The founder gave no pitch: what Acme builds is your pick.");
    expect(text).not.toContain("name_product");
    expect(text).toContain("say in the team room what the team will try and why");
    expect(text).toContain("Call open_bet");
    expect(proposal(false, true)).not.toContain("gave no pitch");
  });

  it("has the lead name the first product with name_product while it still waits on that pick", () => {
    const unnamed = { ...product, description: UNNAMED_PRODUCT_DESCRIPTION };
    const text = proposal(false, true, { ...company, mission: null }, unnamed);
    expect(text).toContain(
      `give ${product.name} (${product.id}) its name and a one-line description of it with name_product`,
    );
  });

  it("says why no open bet takes a run, rather than that none has budget left", () => {
    const text = proposal(false, true);
    expect(text).not.toContain("no open bet has budget left");
    expect(text).toContain(
      "no open bet can take another run: each is spent out, waiting on the founder, or has what is left covered by runs already going.",
    );
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

  it("quotes every line of the ask and the answer", () => {
    const ask: BlockedAsk = {
      action: "Post the launch thread",
      draft: "Run it:\n```\nnpx acme\n```",
      instructions: "Post it.\nSend me its URL.",
      type: "action",
    };
    const text = continuationBrief(task, ask, "Done.\nhttps://x.dev/1").description;
    expect(text).toContain("> Post it.\n> Send me its URL.");
    expect(text).toContain("> ````\n> Run it:\n> ```\n> npx acme\n> ```\n> ````");
    expect(text).toContain("The founder answered:\n> Done.\n> https://x.dev/1");
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
      { integration: "stripe", productId: null, reason: "to take payments", type: "integration" },
      "> a Stripe connection: to take payments",
      "[connect:stripe]",
    ],
    [
      {
        action: "Post the launch thread",
        draft: "We built a thing.",
        instructions: "Post it on r/SideProject.",
        type: "action",
      },
      "> a step only a human could take: Post the launch thread\n> Post it on r/SideProject.\n> The draft they were handed:\n> ```\n> We built a thing.\n> ```",
      "[action]",
    ],
  ])("reads a %j ask in words, not as TASK.md stores it", (ask, words, stored) => {
    const text = briefOn(ask);
    expect(text).toContain(words);
    expect(text).not.toContain(stored);
  });
});

describe("the founder's reply to an action", () => {
  it.each([
    [{ kind: "done", note: "" }, "Done."],
    [
      { kind: "done", note: "https://reddit.com/r/x/1" },
      "Done. They sent back: https://reddit.com/r/x/1",
    ],
    [{ kind: "cant", reason: "no account there" }, "They could not: no account there."],
  ] as const)("reads %j as %j", (reply, words) => {
    expect(actionAnswer(reply)).toContain(words);
  });
});
