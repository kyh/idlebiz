import { setImmediate as settle } from "node:timers/promises";
import { QueryObserver } from "@tanstack/react-query";
import type { DataTag, QueryKey, QueryObserverOptions } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@repo/domain/activity";
import type {
  AgentRunner,
  AuthFlowEvent,
  Company,
  Employee,
  RestingRunners,
  Task,
  TeamMessage,
} from "@repo/domain/domain";
import { ORPCError } from "@orpc/client";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { contract } from "@repo/contract/contract";
import type { PageEvent } from "@repo/contract/events";
import { RPC_PREFIX } from "@repo/contract/routes";
import { orpc } from "@/renderer/api";
import type { Office } from "@/renderer/game/office-port";
import { FEED_LINES } from "@/renderer/state/activity-reducer";

const company: Company = {
  autopilot: true,
  budget: { mode: "infinite" },
  businessType: "software",
  createdAt: 0,
  founderName: "Kai",
  founderSpriteSeed: "kai",
  id: "co",
  leaderId: "lead",
  maxAgents: 4,
  mission: "",
  name: "Co",
  revenueUsd: null,
  ships: 0,
  spentUsd: 0,
  users: null,
  workspaceDir: "/tmp/co",
};

const employee = (id: string, status: Employee["status"] = "idle"): Employee => ({
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
  status,
  title: "Engineer",
});

const stamp = { createdAt: 0, id: 1, runId: "r1", taskId: "t1" };
const started = (employeeId: string): ActivityEvent => ({
  ...stamp,
  employeeId,
  kind: "run.start",
});
const napping = (runner: "claude" | "codex", until: number): ActivityEvent => ({
  ...stamp,
  employeeId: "lead",
  kind: "runner.resting",
  payload: { cause: "usage-limit", error: "You've hit your limit", runner, until },
});
const refused = (employeeId: string): ActivityEvent => ({
  ...stamp,
  employeeId,
  kind: "run.end",
  payload: {
    costUsd: 0,
    outcome: { error: "Failed to authenticate", kind: "signedOut" },
    settled: "queued",
    summary: "",
  },
});
const hired = (employeeId: string): ActivityEvent => ({
  createdAt: 0,
  employeeId,
  id: 1,
  kind: "org.hired",
  payload: { by: "lead", name: employeeId, title: "Engineer" },
});

/** A question of `assigneeId`'s awaiting the founder. */
const asking = (assigneeId: string): Task => ({
  artifacts: [],
  assigneeId,
  attempts: 0,
  betId: null,
  companyId: "co",
  completedAt: null,
  createdAt: 0,
  description: null,
  id: `ask-${assigneeId}`,
  origin: "work",
  priority: "medium",
  productId: null,
  startedAt: null,
  state: { ask: { question: "Ship it?", type: "question" }, kind: "blocked", summary: null },
  title: "Ship it",
});
const raised = (employeeId: string): ActivityEvent => ({
  ...stamp,
  employeeId,
  kind: "run.ask",
  payload: { ask: { question: "Ship it?", type: "question" } },
});

/** The chat event of room line `id`, said at `id`. */
const said = (id: number, text: string): ActivityEvent => ({
  createdAt: id,
  employeeId: null,
  id: 100 + id,
  kind: "chat",
  message: text,
  payload: { from: { kind: "founder" }, line: id, to: null },
});

/** What these tests let main answer late. */
type Late = "employees.list" | "agents.resting" | "company.get";

/** One stream of main's events, as main serves it to the page: the test feeds it until it drops it. */
interface Stream {
  events: AsyncGenerator<PageEvent>;
  push: (event: PageEvent) => void;
  drop: () => void;
}

const openStream = (): Stream => {
  const queue: (PageEvent | "dropped")[] = [];
  let wake: (() => void) | null = null;
  const push = (next: PageEvent | "dropped"): void => {
    queue.push(next);
    wake?.();
    wake = null;
  };
  const arrival = (): Promise<void> =>
    // oxlint-disable-next-line promise/avoid-new -- the test feeds the stream by hand
    new Promise((resolve) => {
      wake = resolve;
    });
  const events = async function* events(): AsyncGenerator<PageEvent> {
    for (;;) {
      const next = queue.shift();
      if (next === "dropped") {
        throw new Error("main went away");
      }
      if (next === undefined) {
        await arrival();
      } else {
        yield next;
      }
    }
  };
  return { drop: () => push("dropped"), events: events(), push };
};

interface MainHolds {
  authed: boolean;
  signedOut: AgentRunner[];
  employees: Employee[];
  resting: RestingRunners;
  room: TeamMessage[];
  tasks: Task[];
  /** Main cannot read the company, as when it went away. */
  down: boolean;
}

/** Where the page is served from: the page asks main on its own origin. */
const PAGE_ORIGIN = "http://127.0.0.1:1";

const os = implement(contract);

/**
 * Main as the page reaches it: the procedures these tests let the store call, over oRPC behind the
 * page's fetch. A `late` procedure answers only when the test says, with what main held when it was
 * asked; the rest answer at once. It counts what it was asked.
 */
const fakeMain = (late: readonly Late[]) => {
  const main: MainHolds = {
    authed: true,
    down: false,
    employees: [employee("lead")],
    resting: {},
    room: [],
    signedOut: [],
    tasks: [],
  };
  const waiting: { method: Late; release: () => void }[] = [];
  const streams: Stream[] = [];
  const asked = new Map<string, number>();
  const count = (method: string): void => {
    asked.set(method, (asked.get(method) ?? 0) + 1);
  };
  /** The stream the page has open: the last it opened. */
  const open = async (event: PageEvent | "dropped"): Promise<void> => {
    const stream = streams.at(-1);
    if (!stream) {
      throw new Error("the page opened no stream of main's events");
    }
    if (event === "dropped") {
      stream.drop();
    } else {
      stream.push(event);
    }
    await settle();
  };
  const answerOf = <T>(method: Late, value: T): Promise<T> => {
    count(method);
    if (!late.includes(method)) {
      return Promise.resolve(value);
    }
    const answer = Promise.withResolvers<T>();
    waiting.push({ method, release: () => answer.resolve(value) });
    return answer.promise;
  };
  const counted = <T>(method: string, value: T): T => {
    count(method);
    return value;
  };
  const router = {
    agents: {
      hasAuth: os.agents.hasAuth.handler(() =>
        counted("agents.hasAuth", { ok: main.authed, signedOut: main.signedOut }),
      ),
      resting: os.agents.resting.handler(() => answerOf("agents.resting", main.resting)),
    },
    bets: { list: os.bets.list.handler(() => counted("bets.list", [])) },
    company: {
      get: os.company.get.handler(async () => {
        if (main.down) {
          throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "main went away" });
        }
        return await answerOf("company.get", company);
      }),
      setMaxAgents: os.company.setMaxAgents.handler(({ input }) => ({
        ...company,
        maxAgents: input.maxAgents,
      })),
    },
    employees: {
      list: os.employees.list.handler(() => answerOf("employees.list", main.employees)),
    },
    events: os.events.handler(() => {
      const stream = openStream();
      streams.push(stream);
      return stream.events;
    }),
    products: { list: os.products.list.handler(() => counted("products.list", [])) },
    save: {
      report: os.save.report.handler(() => counted("save.report", { companies: 1, skipped: [] })),
    },
    stripe: {
      keyStatus: os.stripe.keyStatus.handler(() => ({ state: "unset" as const })),
      status: os.stripe.status.handler(() => ({ state: "disconnected" as const })),
    },
    tasks: { list: os.tasks.list.handler(() => counted("tasks.list", main.tasks)) },
    team: {
      messages: os.team.messages.handler(({ input }) =>
        counted("team.messages", main.room.slice(-(input.limit ?? 30))),
      ),
    },
  };
  // no pings: a test's stream is fed by hand, and a timer would outlive it
  const handler = new RPCHandler(router, {
    toFetchResponse: { eventStream: { keepAlive: { enabled: false } } },
  });
  /** The page's fetch, answered by this main. */
  const api = async (url: string, init: RequestInit): Promise<Response> => {
    const { response } = await handler.handle(new Request(new URL(url, PAGE_ORIGIN), init), {
      context: {},
      prefix: RPC_PREFIX,
    });
    return response ?? new Response(null, { status: 404 });
  };
  /** Answer the oldest request for `method` still waiting, once what the page asked has reached main. */
  const answer = async (method: Late): Promise<void> => {
    await settle();
    const at = waiting.findIndex((call) => call.method === method);
    const [call] = at === -1 ? [] : waiting.splice(at, 1);
    if (!call) {
      throw new Error(`nothing is waiting on ${method}`);
    }
    call.release();
    await settle();
  };
  return {
    answer,
    /** Answer every request for `method`, those its answers ask for included. */
    answerAll: async (method: Late): Promise<void> => {
      while (waiting.some((call) => call.method === method)) {
        await answer(method);
      }
    },
    api,
    /** How many times the page asked main for `method`. */
    asked: (method: string): number => asked.get(method) ?? 0,
    /** The open stream ends, as it does when the connection to main drops. */
    drop: () => open("dropped"),
    emit: (e: ActivityEvent): Promise<void> => open({ data: e, name: "activity" }),
    /** A step of a login the founder started. */
    login: (e: AuthFlowEvent): Promise<void> => open({ data: e, name: "auth" }),
    main,
    /** How many streams of main's events the page has opened. */
    opened: (): number => streams.length,
  };
};

type FakeMain = ReturnType<typeof fakeMain>;

/** An office that only records what it is told. */
const fakeOffice = () => {
  const told: { message: string; payload: unknown }[] = [];
  const game: Office = {
    events: {
      emit: (message, payload) => told.push({ message, payload }),
      off: () => {},
      on: () => {},
    },
  };
  const walkedIn = (): unknown[] =>
    told.filter((m) => m.message === "spawn-employee").map((m) => m.payload);
  return { game, walkedIn };
};

const stops: (() => void)[] = [];

/** The page with main's procedures behind its fetch, before its store hears main. */
const freshPage = async (api: FakeMain["api"]) => {
  vi.stubGlobal("fetch", api);
  vi.resetModules();
  const store = await import("@/renderer/state/store");
  const queries = await import("@/renderer/state/queries");
  /** What a component showing the query shows, as useQuery mounts it. */
  const shown = <T, E>(
    options: QueryObserverOptions<T, E, T, T, DataTag<QueryKey, T, E>>,
  ): (() => T | undefined) => {
    const observer = new QueryObserver(queries.queryClient, options);
    stops.push(observer.subscribe(() => {}));
    return () => observer.getCurrentResult().data;
  };
  return { queries, shown, store };
};

/** The page, its store hearing main. */
const freshStore = async (api: FakeMain["api"]) => {
  const page = await freshPage(api);
  page.store.initStore();
  await settle();
  return page;
};

const askersOf = (tasks: Task[]): string => tasks.map((t) => t.assigneeId).join(" ");
const rosterOf = (employees: Employee[] | undefined): string =>
  (employees ?? []).map((e) => `${e.id}:${e.status}`).join(" ");
const restOf = (resting: RestingRunners | undefined): string =>
  Object.entries(resting ?? {})
    .map(([runner, until]) => `${runner}:${until}`)
    .toSorted()
    .join(" ");

describe("store", () => {
  afterEach(() => {
    for (const stop of stops.splice(0)) {
      stop();
    }
    vi.unstubAllGlobals();
  });

  it("asks main once for the company, the roster and the tasks as the window and the office boot", async () => {
    const { api, asked } = fakeMain([]);
    const { queries, shown, store } = await freshPage(api);
    // the window mounts what it shows, then its store hears main, while the office boots alongside
    shown(queries.companyQuery);
    store.initStore();
    const read = await queries.read(queries.companyQuery);
    expect(read?.id).toBe("co");
    shown(queries.employeesQuery);
    shown(queries.openTasksQuery);
    await settle();
    await Promise.all([queries.read(queries.employeesQuery), queries.read(queries.openTasksQuery)]);
    expect(asked("company.get")).toBe(1);
    expect(asked("employees.list")).toBe(1);
    expect(asked("tasks.list")).toBe(1);
  });

  it("keeps a run's patch when a read of the roster asked for before it lands after it", async () => {
    const { answer, api, emit, main } = fakeMain(["employees.list"]);
    const { queries, shown, store } = await freshStore(api);
    const roster = shown(queries.employeesQuery);
    await answer("employees.list");
    expect(rosterOf(roster())).toBe("lead:idle");

    const refreshed = store.refresh();
    await settle();
    main.employees = [employee("lead", "working")];
    await emit(started("lead"));
    expect(rosterOf(roster())).toBe("lead:working");
    // the read asked for before the run started lands, and changes nothing
    await answer("employees.list");
    await refreshed;
    expect(rosterOf(roster())).toBe("lead:working");
    // what the patch asked for again
    await answer("employees.list");
    expect(rosterOf(roster())).toBe("lead:working");
  });

  it("answers a rest heard during the first read of it with the read the rest asked for", async () => {
    const { answer, api, emit, main } = fakeMain(["agents.resting"]);
    main.resting = { codex: 9 };
    const { queries, shown } = await freshStore(api);
    const resting = shown(queries.restingQuery);
    main.resting = { claude: 5, codex: 9 };
    await emit(napping("claude", 5));
    await answer("agents.resting");
    expect(restOf(resting())).toBe("");
    await answer("agents.resting");
    expect(restOf(resting())).toBe("claude:5 codex:9");
  });

  it("keeps a cap the founder saved while a read of the company asked for earlier is in flight", async () => {
    const { answer, api } = fakeMain(["company.get"]);
    const { queries, shown, store } = await freshStore(api);
    const held = shown(queries.companyQuery);
    await answer("company.get");

    const refreshed = store.refresh();
    await settle();
    await store.setMaxAgents(6);
    expect(held()?.maxAgents).toBe(6);
    await answer("company.get");
    await refreshed;
    expect(held()?.maxAgents).toBe(6);
  });

  it("walks a hire in when a run's patch cancelled the read that found them", async () => {
    const { answer, answerAll, api, emit, main } = fakeMain(["employees.list"]);
    const { queries, shown, store } = await freshStore(api);
    const roster = shown(queries.employeesQuery);
    await answer("employees.list");
    const { game, walkedIn } = fakeOffice();
    store.setGame(game);

    main.employees = [employee("lead"), employee("mae")];
    await emit(hired("mae"));
    main.employees = [employee("lead", "working"), employee("mae")];
    await emit(started("lead"));
    expect(rosterOf(roster())).toBe("lead:working");
    await answerAll("employees.list");
    expect(walkedIn()).toEqual([employee("mae")]);
    expect(rosterOf(roster())).toBe("lead:working mae:idle");
  });

  it("logs an event it could not apply, never leaving its failure unhandled", async () => {
    const { api, emit, main } = fakeMain([]);
    const { store } = await freshStore(api);
    const fault = new Error("the scene is gone");
    store.setGame({
      events: {
        emit: (message) => {
          if (message === "spawn-employee") {
            throw fault;
          }
        },
        off: () => {},
        on: () => {},
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      main.employees = [employee("lead"), employee("mae")];
      await emit(hired("mae"));
      expect(logged).toHaveBeenCalledWith("Could not apply an activity event", fault);
    } finally {
      logged.mockRestore();
    }
  });

  it("reads the room again for each line said, so the team panel shows it whole", async () => {
    const { api, emit, main } = fakeMain([]);
    const { shown } = await freshStore(api);
    const room = shown(orpc.team.messages.queryOptions({ input: { limit: FEED_LINES } }));
    await settle();
    expect(room()).toEqual([]);
    main.room = [{ companyId: "co", createdAt: 1, from: { kind: "founder" }, id: 1, text: "hi" }];
    await emit(said(1, "hi"));
    expect(room()?.map((m) => m.text)).toEqual(["hi"]);
  });

  it("tells the office who waits on the founder each time an event moves the tasks", async () => {
    const { api, emit, main } = fakeMain([]);
    const { queries } = await freshStore(api);
    const heard: string[] = [];
    stops.push(queries.watch(queries.openTasksQuery, askersOf, (now) => heard.push(now)));
    await settle();
    main.tasks = [asking("lead")];
    await emit(raised("lead"));
    main.tasks = [];
    await emit({ ...stamp, employeeId: "lead", kind: "status", message: "queued" });
    expect(heard).toEqual(["", "lead", ""]);
  });

  it("opens the office once a login finishes, though the launch probe found no CLI", async () => {
    const { api, login, main } = fakeMain([]);
    main.authed = false;
    const { queries, shown } = await freshStore(api);
    const auth = shown(queries.authQuery);
    await settle();
    expect(auth()?.ok).toBe(false);
    await login({ message: "No signed-in coding CLI yet.", type: "error" });
    expect(auth()?.ok).toBe(false);
    main.authed = true;
    await login({ type: "done" });
    expect(auth()?.ok).toBe(true);
  });

  it("names a runner a turn found refused while another is still signed in, until a sign-in clears it", async () => {
    const { api, emit, login, main } = fakeMain([]);
    const { queries, shown } = await freshStore(api);
    const auth = shown(queries.authQuery);
    main.signedOut = ["codex"];
    await emit(refused("lead"));
    expect(auth()).toEqual({ ok: true, signedOut: ["codex"] });
    await login({ type: "done" });
    expect(auth()?.signedOut).toEqual(["codex"]);
    main.signedOut = [];
    await login({ type: "done" });
    expect(auth()?.signedOut).toEqual([]);
  });

  it("refuses a retry while main still cannot read the company, and holds it once one lands", async () => {
    const { api, main } = fakeMain([]);
    main.down = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { queries, shown, store } = await freshStore(api);
      const held = shown(queries.companyQuery);
      await settle();
      expect(held()).toBeUndefined();
      await expect(store.refresh()).rejects.toThrow("main went away");
      main.down = false;
      await store.refresh();
      expect(held()?.id).toBe("co");
    } finally {
      logged.mockRestore();
    }
  });

  it("asks main for everything again once its events come back, since what it sent meanwhile is lost", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { api, drop, main, opened } = fakeMain([]);
      const { queries, shown } = await freshStore(api);
      const roster = shown(queries.employeesQuery);
      const auth = shown(queries.authQuery);
      await settle();
      expect(rosterOf(roster())).toBe("lead:idle");
      await drop();
      expect(logged).toHaveBeenCalledWith("Lost main's events", expect.any(Error));
      // a run started and a sign-in lapsed while the page heard nothing
      main.employees = [employee("lead", "working")];
      main.signedOut = ["codex"];
      await vi.advanceTimersByTimeAsync(999);
      expect(opened()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(opened()).toBe(2);
      expect(rosterOf(roster())).toBe("lead:working");
      expect(auth()?.signedOut).toEqual(["codex"]);
    } finally {
      logged.mockRestore();
      vi.useRealTimers();
    }
  });
});
