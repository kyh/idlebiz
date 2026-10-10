import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@repo/domain/activity";
import type { Employee, RunOutcome, TeamMessage } from "@repo/domain/domain";
import { feedKey, joinFeed, newestRoomLine, reduceActivity, roomLines } from "./activity-reducer";

const stamp = { createdAt: 0, id: 1 };
const inRun = { employeeId: "priya", runId: "r1", taskId: "t1" };

const employee = (id: string): Employee => ({
  companyId: "co",
  createdAt: 0,
  deskIndex: 0,
  id,
  instructionsDigest: null,
  lastRunMetrics: null,
  lastShip: null,
  name: id,
  persona: "",
  role: "engineer",
  runner: "claude",
  session: null,
  spriteSeed: id,
  status: "idle",
  title: "Engineer",
});

const shipped = (id: number): Extract<ActivityEvent, { kind: "ship" }> => ({
  ...inRun,
  createdAt: 0,
  id,
  kind: "ship",
  message: `ship ${id}`,
});

const roomLine = (id: number, createdAt: number, text: string): TeamMessage => ({
  companyId: "co",
  createdAt,
  from: { kind: "founder" },
  id,
  text,
});

const held = {
  activity: [],
  employees: [employee("priya"), employee("mae")],
  feed: [],
  resting: {},
};
const working: Employee = { ...employee("priya"), status: "working" };
const busy = { ...held, employees: [working] };

const endedOn = (outcome: RunOutcome): ActivityEvent => ({
  ...stamp,
  ...inRun,
  kind: "run.end",
  payload: { outcome, settled: "queued", summary: "" },
});

describe("reduceActivity", () => {
  it("raises an ask in the inbox the moment the office shows it", () => {
    const ask: ActivityEvent = {
      ...stamp,
      ...inRun,
      kind: "run.ask",
      payload: { ask: { question: "Ship it?", type: "question" } },
    };
    expect(reduceActivity(held, ask).reload).toEqual(["tasks"]);
  });

  it("says in #team what a teammate waits on the founder for", () => {
    const ask: ActivityEvent = {
      ...stamp,
      ...inRun,
      kind: "run.ask",
      payload: {
        ask: {
          action: "Buy acme.dev",
          draft: null,
          instructions: "Any registrar.",
          type: "action",
        },
      },
    };
    expect(reduceActivity(held, ask).patch.feed).toEqual([{ event: ask, kind: "news" }]);
  });

  it("clears a resolved ask from the inbox the moment it resumes", () => {
    const resumed: ActivityEvent = {
      ...stamp,
      employeeId: "priya",
      kind: "status",
      message: "queued",
      taskId: "t1",
    };
    expect(reduceActivity(held, resumed).reload).toEqual(["tasks"]);
  });

  it("refetches only what an event moved", () => {
    const pulse: ActivityEvent = {
      ...stamp,
      kind: "metrics.pulse",
      payload: { revenue: 1, users: 2 },
    };
    const killed: ActivityEvent = {
      ...stamp,
      employeeId: null,
      kind: "product.killed",
      message: "Side",
      payload: { productId: "side", reason: "dud" },
    };
    expect(reduceActivity(held, pulse).reload).toEqual(["company", "products", "bets"]);
    expect(reduceActivity(held, killed).reload).toEqual(["products", "bets", "tasks"]);
    const named: ActivityEvent = {
      ...stamp,
      employeeId: "mae",
      kind: "product.named",
      message: "Ledgerly",
      payload: { productId: "side" },
    };
    expect(reduceActivity(held, named).reload).toEqual(["products"]);
    const said: ActivityEvent = { ...stamp, ...inRun, kind: "message", message: "On it" };
    expect(reduceActivity(held, said).reload).toEqual([]);
  });

  it("fetches again what it patched, for what a refused refresh carried", () => {
    const started: ActivityEvent = { ...stamp, ...inRun, kind: "run.start" };
    const napping: ActivityEvent = {
      ...stamp,
      ...inRun,
      kind: "runner.resting",
      payload: { cause: "usage-limit", error: "You've hit your limit", runner: "claude", until: 5 },
    };
    expect(reduceActivity(held, started).reload).toEqual(["employees"]);
    expect(reduceActivity(held, napping)).toMatchObject({
      patch: { resting: { claude: 5 } },
      reload: ["resting"],
    });
  });

  it("refetches the work a bet dropped when it stopped taking any", () => {
    const measured: ActivityEvent = {
      ...stamp,
      kind: "bet.changed",
      message: "Launch post",
      payload: { betId: "launch-post", state: { kind: "measuring", until: 1 } },
    };
    expect(reduceActivity(held, measured).reload).toEqual(["bets", "tasks"]);
  });

  it("sets to work the one employee a run starts for, and nobody else", () => {
    const started: ActivityEvent = { ...stamp, ...inRun, kind: "run.start" };
    const { patch } = reduceActivity(held, started);
    expect(patch.employees?.map((e) => e.status)).toEqual(["working", "idle"]);
  });

  it("idles an employee whose run ended", () => {
    const ended: ActivityEvent = {
      ...stamp,
      ...inRun,
      kind: "run.end",
      payload: { outcome: { kind: "done" }, settled: "done", summary: "" },
    };
    expect(reduceActivity(busy, ended).patch.employees?.map((e) => e.status)).toEqual(["idle"]);
  });

  it("asks again whether any CLI is signed in once a run found its runner signed out", () => {
    const refused = endedOn({ error: "Failed to authenticate", kind: "signedOut" });
    expect(reduceActivity(busy, refused).recheckAuth).toBe(true);
    expect(reduceActivity(busy, endedOn({ error: "boom", kind: "failed" })).recheckAuth).toBe(
      false,
    );
  });

  it("keeps working someone handed more work mid-run", () => {
    const queued: ActivityEvent = {
      ...stamp,
      employeeId: "priya",
      kind: "status",
      message: "queued",
      taskId: "t2",
    };
    expect(reduceActivity(busy, queued).patch.employees).toBeUndefined();
  });

  it("walks a hire in only after the roster is fresh", () => {
    const hired: ActivityEvent = {
      ...stamp,
      employeeId: "sam",
      kind: "org.hired",
      payload: { by: "mae", name: "Sam", title: "Engineer" },
    };
    expect(reduceActivity(held, hired)).toMatchObject({
      reload: ["all"],
      roster: { employeeId: "sam", hired: true },
    });
  });

  it("keeps the feed to its last three hundred", () => {
    const full = Array.from({ length: 300 }, (_, id) => ({
      ...inRun,
      createdAt: 0,
      id,
      kind: "run.start" as const,
    }));
    const { patch } = reduceActivity(
      { ...held, activity: full },
      { ...stamp, ...inRun, id: 999, kind: "run.start" },
    );
    expect(patch.activity).toHaveLength(300);
    expect(patch.activity.at(-1)?.id).toBe(999);
    expect(patch.activity[0]?.id).toBe(1);
  });

  it("keeps the team's lines in the feed while tool calls churn the ring", () => {
    const line: ActivityEvent = {
      ...stamp,
      employeeId: null,
      kind: "chat",
      message: "ship it",
      payload: { from: { kind: "founder" }, line: 7, to: null },
    };
    const posted = reduceActivity(held, line).patch;
    let { activity } = posted;
    const feed = posted.feed ?? [];
    for (let id = 2; id <= 301; id += 1) {
      const call: ActivityEvent = {
        ...inRun,
        createdAt: 0,
        id,
        kind: "tool_call",
        message: "Read",
        payload: {},
      };
      const { patch } = reduceActivity({ ...held, activity, feed }, call);
      expect(patch.feed).toBeUndefined();
      ({ activity } = patch);
    }
    expect(activity.map((e) => e.id)).not.toContain(line.id);
    expect(feed).toEqual([
      { createdAt: 0, from: { kind: "founder" }, id: 7, kind: "room", text: "ship it" },
    ]);
  });

  it("shows the room a window opened on, beside the news it hears live, each line once", () => {
    const news = { ...shipped(1), createdAt: 20 };
    const heard = reduceActivity(held, news).patch.feed ?? [];
    const opened = joinFeed(
      heard,
      roomLines([roomLine(3, 10, "before"), roomLine(4, 30, "after")]),
    );
    const echoed: ActivityEvent = {
      createdAt: 31,
      employeeId: null,
      id: 2,
      kind: "chat",
      message: "after",
      payload: { from: { kind: "founder" }, line: 4, to: null },
    };
    const feed = reduceActivity({ ...held, feed: opened }, echoed).patch.feed ?? [];
    expect(feed.map(feedKey)).toEqual(["room 3", "news 1", "room 4"]);
  });

  it("names the room's newest line, past the news heard after it", () => {
    const heard = joinFeed(
      [{ event: { ...shipped(1), createdAt: 40 }, kind: "news" }],
      roomLines([roomLine(3, 10, "before"), roomLine(4, 30, "after")]),
    );
    expect(newestRoomLine(heard)).toBe(4);
    expect(newestRoomLine([{ event: shipped(1), kind: "news" }])).toBeNull();
  });

  it("keeps the feed to its last thirty lines", () => {
    const full = {
      ...held,
      feed: Array.from({ length: 30 }, (_, id) => ({ event: shipped(id), kind: "news" as const })),
    };
    const feed = reduceActivity(full, shipped(30)).patch.feed ?? [];
    expect(feed).toHaveLength(30);
    expect(feed.map((line) => (line.kind === "news" ? line.event.id : null))).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
  });
});
