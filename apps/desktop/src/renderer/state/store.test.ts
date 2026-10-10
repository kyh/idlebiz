import { setImmediate as settle } from "node:timers/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@repo/domain/activity";
import type {
  AgentRunner,
  AuthFlowEvent,
  Company,
  Employee,
  RestingRunners,
  TeamMessage,
} from "@repo/domain/domain";
import { ORPCError } from "@orpc/client";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { contract } from "@repo/contract/contract";
import type { PageEvent } from "@repo/contract/events";
import { RPC_PREFIX } from "@repo/contract/routes";
import type { Office } from "@/renderer/game/office-port";
import { feedKey } from "@/renderer/state/activity-reducer";

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
type Late = "employees.list" | "agents.resting";

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
  /** Main cannot read the company, as when it went away. */
  down: boolean;
}

/** Where the page is served from: the page asks main on its own origin. */
const PAGE_ORIGIN = "http://127.0.0.1:1";

const os = implement(contract);

/**
 * Main as the page reaches it: the procedures these tests let the store call, over oRPC behind the
 * page's fetch. A `late` procedure answers only when the test says, with what main held when it was
 * asked; the rest answer at once.
 */
const fakeMain = (late: readonly Late[]) => {
  const main: MainHolds = {
    authed: true,
    down: false,
    employees: [employee("lead")],
    resting: {},
    room: [],
    signedOut: [],
  };
  const waiting: { method: Late; release: () => void }[] = [];
  const streams: Stream[] = [];
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
    if (!late.includes(method)) {
      return Promise.resolve(value);
    }
    const answer = Promise.withResolvers<T>();
    waiting.push({ method, release: () => answer.resolve(value) });
    return answer.promise;
  };
  const router = {
    agents: {
      hasAuth: os.agents.hasAuth.handler(() => ({ ok: main.authed, signedOut: main.signedOut })),
      resting: os.agents.resting.handler(() => answerOf("agents.resting", main.resting)),
    },
    bets: { list: os.bets.list.handler(() => []) },
    company: {
      get: os.company.get.handler(() => {
        if (main.down) {
          throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "main went away" });
        }
        return company;
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
    products: { list: os.products.list.handler(() => []) },
    save: { report: os.save.report.handler(() => ({ companies: 1, skipped: [] })) },
    stripe: {
      keyStatus: os.stripe.keyStatus.handler(() => ({ state: "unset" as const })),
      status: os.stripe.status.handler(() => ({ state: "disconnected" as const })),
    },
    tasks: { list: os.tasks.list.handler(() => []) },
    team: {
      messages: os.team.messages.handler(({ input }) => main.room.slice(-(input.limit ?? 30))),
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
  return {
    /** Answer the oldest request for `method` still waiting. */
    answer: async (method: Late): Promise<void> => {
      const at = waiting.findIndex((call) => call.method === method);
      const [call] = at === -1 ? [] : waiting.splice(at, 1);
      if (!call) {
        throw new Error(`nothing is waiting on ${method}`);
      }
      call.release();
      await settle();
    },
    api,
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

const freshStore = async (api: FakeMain["api"]) => {
  vi.stubGlobal("fetch", api);
  vi.resetModules();
  const store = await import("@/renderer/state/store");
  store.initStore();
  await settle();
  return store;
};

type Store = Awaited<ReturnType<typeof freshStore>>;
type Seen = Parameters<Parameters<Store["useStore"]>[0]>[0];

const Probe = ({ select, store }: { select: (s: Seen) => string; store: Store }): string =>
  store.useStore(select);

const Screen = ({ store }: { store: Store }): string => store.useBoot().kind;
const screen = (store: Store): string => renderToStaticMarkup(createElement(Screen, { store }));

/** What a component reading the store would show. */
const read = (store: Store, select: (s: Seen) => string): string =>
  renderToStaticMarkup(createElement(Probe, { select, store }));

const feed = (s: Seen): string => s.feed.map(feedKey).join(" ");
const roster = (s: Seen): string => s.employees.map((e) => `${e.id}:${e.status}`).join(" ");
const boot = (s: Seen): string => `${s.booted} ${s.bootFailure ?? "-"}`;
const signedOut = (s: Seen): string => s.signedOut.join(" ");
const resting = (s: Seen): string =>
  Object.entries(s.resting)
    .map(([runner, until]) => `${runner}:${until}`)
    .toSorted()
    .join(" ");

describe("store", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens #team on the room main kept, and shows each line it then hears once", async () => {
    const { api, emit, main } = fakeMain([]);
    main.room = [
      { companyId: "co", createdAt: 1, from: { kind: "founder" }, id: 1, text: "early" },
    ];
    const store = await freshStore(api);
    expect(read(store, feed)).toBe("room 1");
    await emit(said(1, "early"));
    await emit(said(2, "later"));
    expect(read(store, feed)).toBe("room 1 room 2");
  });

  it("keeps a run that starts during the first refresh, and the roster that refresh went for", async () => {
    const { answer, api, emit, main } = fakeMain(["employees.list"]);
    const store = await freshStore(api);
    main.employees = [employee("lead", "working")];
    await emit(started("lead"));
    // asked before the run started, so refused
    await answer("employees.list");
    // the refresh, run once more
    await answer("employees.list");
    expect(read(store, roster)).toBe("lead:working");
  });

  it("keeps the other runner's rest when one lands during the first refresh", async () => {
    const { answer, api, emit, main } = fakeMain(["agents.resting"]);
    main.resting = { codex: 9 };
    const store = await freshStore(api);
    main.resting = { claude: 5, codex: 9 };
    await emit(napping("claude", 5));
    await answer("agents.resting");
    await answer("agents.resting");
    expect(read(store, resting)).toBe("claude:5 codex:9");
  });

  it("keeps an employee working when a refresh asked for before their run started lands after it", async () => {
    const { answer, api, emit, main } = fakeMain(["employees.list"]);
    const store = await freshStore(api);
    await answer("employees.list");
    expect(read(store, roster)).toBe("lead:idle");

    const refreshed = store.refresh();
    await settle();
    main.employees = [employee("lead", "working")];
    await emit(started("lead"));
    await answer("employees.list");
    await refreshed;
    expect(read(store, roster)).toBe("lead:working");
    await answer("employees.list");
    expect(read(store, roster)).toBe("lead:working");
  });

  it("keeps a cap the founder saved while a refresh that read the company earlier is in flight", async () => {
    const { answer, api } = fakeMain(["employees.list"]);
    const store = await freshStore(api);
    await answer("employees.list");

    const refreshed = store.refresh();
    await settle();
    await store.setMaxAgents(6);
    expect(read(store, (s) => String(s.company?.maxAgents))).toBe("6");
    await answer("employees.list");
    await refreshed;
    expect(read(store, (s) => String(s.company?.maxAgents))).toBe("6");
  });

  it("walks a hire in when a run's patch refused the refresh that found them", async () => {
    const { answer, api, emit, main } = fakeMain(["employees.list"]);
    const store = await freshStore(api);
    await answer("employees.list");
    const { game, walkedIn } = fakeOffice();
    store.setGame(game);

    main.employees = [employee("lead"), employee("mae")];
    await emit(hired("mae"));
    main.employees = [employee("lead", "working"), employee("mae")];
    await emit(started("lead"));
    // the hire's refresh, refused: the run's patch is newer
    await answer("employees.list");
    expect(read(store, roster)).toBe("lead:working");
    // what the patch asked for again, then the hire looked up
    await answer("employees.list");
    await answer("employees.list");
    expect(walkedIn()).toEqual([employee("mae")]);
    expect(read(store, roster)).toBe("lead:working mae:idle");
  });

  it("logs an event it could not apply, never leaving its failure unhandled", async () => {
    const { api, emit, main } = fakeMain([]);
    const store = await freshStore(api);
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

  it("opens the office once a login finishes, though the launch probe found no CLI", async () => {
    const { api, login, main } = fakeMain([]);
    main.authed = false;
    const store = await freshStore(api);
    expect(screen(store)).toBe("signed-out");
    await login({ message: "No signed-in coding CLI yet.", type: "error" });
    expect(screen(store)).toBe("signed-out");
    main.authed = true;
    await login({ type: "done" });
    expect(screen(store)).toBe("office");
  });

  it("names a runner a turn found refused while another is still signed in, until a sign-in clears it", async () => {
    const { api, emit, login, main } = fakeMain([]);
    const store = await freshStore(api);
    main.signedOut = ["codex"];
    await emit(refused("lead"));
    expect(screen(store)).toBe("office");
    expect(read(store, signedOut)).toBe("codex");
    await login({ type: "done" });
    expect(read(store, signedOut)).toBe("codex");
    main.signedOut = [];
    await login({ type: "done" });
    expect(read(store, signedOut)).toBe("");
  });

  it("says why the first refresh failed until a retry lands", async () => {
    const { api, main } = fakeMain([]);
    main.down = true;
    const store = await freshStore(api);
    expect(read(store, boot)).toBe("false main went away");
    main.down = false;
    await store.refresh();
    expect(read(store, boot)).toBe("true -");
  });

  it("asks main for everything again once its events come back, since what it sent meanwhile is lost", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { api, drop, main, opened } = fakeMain([]);
      const store = await freshStore(api);
      expect(read(store, roster)).toBe("lead:idle");
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
      expect(read(store, roster)).toBe("lead:working");
      expect(read(store, signedOut)).toBe("codex");
    } finally {
      logged.mockRestore();
      vi.useRealTimers();
    }
  });
});
