import { partialMatchKey } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@repo/domain/activity";
import type { Employee, RunOutcome, TeamMessage } from "@repo/domain/domain";
import { orpc } from "@/renderer/api";
import { FEED_LINES, feedKey, joinFeed, reduceActivity, roomLines } from "./activity-reducer";
import type { ActivityStep } from "./activity-reducer";

const stamp = { createdAt: 0, id: 1 };
const inRun = { employeeId: "priya", runId: "r1", taskId: "t1" };

const employee = (id: string): Employee => ({
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
  createdAt,
  from: { kind: "founder" },
  id,
  text,
});

const held = { activity: [], feed: [] };
const roster = [employee("priya"), employee("mae")];
const working: Employee = { ...employee("priya"), status: "working" };

/** The tasks the inbox, the office and an employee's dialogue show, and what they can be asked. */
const TASKS = [orpc.tasks.key(), orpc.employees.options.key()];

/** Whether the step reads again the answer held under `queryKey`. */
const refetches = (step: ActivityStep, queryKey: QueryKey): boolean =>
  step.refetch.some((filter) => partialMatchKey(queryKey, filter));

const endedOn = (outcome: RunOutcome): ActivityEvent => ({
  ...stamp,
  ...inRun,
  kind: "run.end",
  payload: { costUsd: 0, outcome, settled: "queued", summary: "" },
});

describe("reduceActivity", () => {
  it("raises an ask in the inbox the moment the office shows it", () => {
    const ask: ActivityEvent = {
      ...stamp,
      ...inRun,
      kind: "run.ask",
      payload: { ask: { question: "Ship it?", type: "question" } },
    };
    expect(reduceActivity(held, ask).refetch).toEqual(TASKS);
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
    expect(reduceActivity(held, ask).heard.feed).toEqual([{ event: ask, kind: "news" }]);
  });

  it("clears a resolved ask from the inbox the moment it resumes", () => {
    const resumed: ActivityEvent = {
      ...stamp,
      employeeId: "priya",
      kind: "status",
      message: "queued",
      taskId: "t1",
    };
    expect(reduceActivity(held, resumed).refetch).toEqual(TASKS);
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
    expect(reduceActivity(held, pulse).refetch).toEqual([
      orpc.company.key(),
      orpc.products.key(),
      orpc.bets.key(),
      orpc.stripe.keyStatus.key(),
    ]);
    expect(reduceActivity(held, killed).refetch).toEqual([
      orpc.products.key(),
      orpc.bets.key(),
      ...TASKS,
    ]);
    const named: ActivityEvent = {
      ...stamp,
      employeeId: "mae",
      kind: "product.named",
      message: "Ledgerly",
      payload: { productId: "side" },
    };
    expect(reduceActivity(held, named).refetch).toEqual([orpc.products.key()]);
    const said: ActivityEvent = { ...stamp, ...inRun, kind: "message", message: "On it" };
    expect(reduceActivity(held, said).refetch).toEqual([]);
  });

  it("fetches again what it patched, for what the read it cancelled carried", () => {
    const started: ActivityEvent = { ...stamp, ...inRun, kind: "run.start" };
    const napping: ActivityEvent = {
      ...stamp,
      ...inRun,
      kind: "runner.resting",
      payload: { cause: "usage-limit", error: "You've hit your limit", runner: "claude", until: 5 },
    };
    expect(reduceActivity(held, started).refetch).toEqual([orpc.employees.list.key()]);
    const rested = reduceActivity(held, napping);
    expect(rested.patch.resting?.({ codex: 9 })).toEqual({ claude: 5, codex: 9 });
    expect(rested.refetch).toEqual([orpc.agents.resting.key()]);
  });

  it("refetches the work a bet dropped when it stopped taking any", () => {
    const measured: ActivityEvent = {
      ...stamp,
      kind: "bet.changed",
      message: "Launch post",
      payload: { betId: "launch-post", state: { kind: "measuring", until: 1 } },
    };
    expect(reduceActivity(held, measured).refetch).toEqual([orpc.bets.key(), ...TASKS]);
  });

  it("reads an employee's open work again on any event that can move it, theirs or the company's", () => {
    const dialogue = orpc.tasks.list.queryKey({
      input: { assigneeId: "priya", status: ["queued", "running", "blocked"] },
    });
    const options = orpc.employees.options.queryKey({ input: { employeeId: "priya" } });
    const moves: ActivityEvent[] = [
      { ...stamp, employeeId: "priya", kind: "status", message: "running", taskId: "t1" },
      {
        ...stamp,
        kind: "bet.changed",
        message: "Launch",
        payload: { betId: "b1", state: { closedAt: 0, kind: "killed", moved: 0, reason: "" } },
      },
      {
        ...stamp,
        employeeId: "ada",
        kind: "product.killed",
        message: "Retired",
        payload: { productId: "p1", reason: "flat" },
      },
      {
        ...stamp,
        employeeId: "ada",
        kind: "org.released",
        payload: { by: "founder", name: "Ada", reason: "" },
      },
    ];
    for (const moved of moves) {
      const step = reduceActivity(held, moved);
      expect(refetches(step, dialogue), moved.kind).toBe(true);
      expect(refetches(step, options), moved.kind).toBe(true);
    }
  });

  it("reads the room again for a line said, which the team panel shows in full", () => {
    const line: ActivityEvent = {
      ...stamp,
      employeeId: null,
      kind: "chat",
      message: "ship it",
      payload: { from: { kind: "founder" }, line: 7, to: null },
    };
    const step = reduceActivity(held, line);
    expect(refetches(step, orpc.team.messages.queryKey({ input: { limit: FEED_LINES } }))).toBe(
      true,
    );
    expect(refetches(step, orpc.tasks.shipped.queryKey())).toBe(false);
  });

  it("sets to work the one employee a run starts for, and nobody else", () => {
    const started: ActivityEvent = { ...stamp, ...inRun, kind: "run.start" };
    const { patch } = reduceActivity(held, started);
    expect(patch.employees?.(roster).map((e) => e.status)).toEqual(["working", "idle"]);
  });

  it("idles an employee whose run ended", () => {
    const ended: ActivityEvent = {
      ...stamp,
      ...inRun,
      kind: "run.end",
      payload: { costUsd: 0, outcome: { kind: "done" }, settled: "done", summary: "" },
    };
    const { patch } = reduceActivity(held, ended);
    expect(patch.employees?.([working]).map((e) => e.status)).toEqual(["idle"]);
  });

  it("asks again whether any CLI is signed in once a run found its runner signed out", () => {
    const refused = endedOn({ error: "Failed to authenticate", kind: "signedOut" });
    expect(reduceActivity(held, refused).recheckAuth).toBe(true);
    expect(reduceActivity(held, endedOn({ error: "boom", kind: "failed" })).recheckAuth).toBe(
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
    expect(reduceActivity(held, queued).patch.employees).toBeUndefined();
  });

  it("walks a hire in only after the roster is fresh", () => {
    const hired: ActivityEvent = {
      ...stamp,
      employeeId: "sam",
      kind: "org.hired",
      payload: { by: "mae", name: "Sam", title: "Engineer" },
    };
    const step = reduceActivity(held, hired);
    expect(refetches(step, orpc.employees.list.queryKey())).toBe(true);
    expect(step.roster).toEqual({ employeeId: "sam", hired: true });
  });

  it("keeps the feed to its last three hundred", () => {
    const full = Array.from({ length: 300 }, (_, id) => ({
      ...inRun,
      createdAt: 0,
      id,
      kind: "run.start" as const,
    }));
    const { heard } = reduceActivity(
      { ...held, activity: full },
      { ...stamp, ...inRun, id: 999, kind: "run.start" },
    );
    expect(heard.activity).toHaveLength(300);
    expect(heard.activity.at(-1)?.id).toBe(999);
    expect(heard.activity[0]?.id).toBe(1);
  });

  it("keeps the team's lines in the feed while tool calls churn the ring", () => {
    const line: ActivityEvent = {
      ...stamp,
      employeeId: null,
      kind: "chat",
      message: "ship it",
      payload: { from: { kind: "founder" }, line: 7, to: null },
    };
    const posted = reduceActivity(held, line).heard;
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
      const { heard } = reduceActivity({ ...held, activity, feed }, call);
      expect(heard.feed).toBeUndefined();
      ({ activity } = heard);
    }
    expect(activity.map((e) => e.id)).not.toContain(line.id);
    expect(feed).toEqual([
      { createdAt: 0, from: { kind: "founder" }, id: 7, kind: "room", text: "ship it" },
    ]);
  });

  it("shows the room a window opened on, beside the news it hears live, each line once", () => {
    const news = { ...shipped(1), createdAt: 20 };
    const heard = reduceActivity(held, news).heard.feed ?? [];
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
    const feed = reduceActivity({ ...held, feed: opened }, echoed).heard.feed ?? [];
    expect(feed.map(feedKey)).toEqual(["room 3", "news 1", "room 4"]);
  });

  it("keeps the feed to its last thirty lines", () => {
    const full = {
      ...held,
      feed: Array.from({ length: 30 }, (_, id) => ({ event: shipped(id), kind: "news" as const })),
    };
    const feed = reduceActivity(full, shipped(30)).heard.feed ?? [];
    expect(feed).toHaveLength(30);
    expect(feed.map((line) => (line.kind === "news" ? line.event.id : null))).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
  });
});
